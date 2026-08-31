// Dominant-colour extraction from a product photograph, in the page.
//
// Ported from src/fabric_advisor/render/ood_eval.py. This is what removes the
// backend from v1: the product image is already loaded in the page the shopper
// is looking at, so the colours can be measured right there. No ingestion run,
// no static catalogue, no server, and it works on a SKU nobody has ever seen.
//
// Everything below operates on a plain {data, width, height} so it can be
// exercised in Node against synthetic pixels. Only loadImageData touches the DOM.

import { chromaOf, deltaE2000, hueOf, rgbToLab } from "../engine/colour.js";

/**
 * Fetch an image and get its pixels.
 *
 * Canvas reads throw on a cross-origin image unless the server sends CORS
 * headers. Khaadi serves its photographs from the same host the content script
 * runs on, so this is fine there. The throw is caught rather than assumed away,
 * because it is exactly what will happen first on the next marketplace.
 */
export async function loadImageData(url, maxSide = 640) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("image failed to load: " + url));
    img.src = url;
  });

  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  try {
    return ctx.getImageData(0, 0, w, h);
  } catch {
    throw new Error(
      "canvas is tainted, cannot read pixels from " + new URL(url).host +
      ". The image needs CORS headers, or the extension must fetch it itself."
    );
  }
}

/**
 * Mask marking which pixels are garment rather than studio background.
 *
 * Product photography sits on a near-uniform ground, and counting it as a
 * garment colour is not a small error: on a synthesised flat-lay the cream
 * background came out as the single largest fabric colour at 49% of the image,
 * which was then most of what the measurement reported.
 *
 * Corners are sampled rather than assuming white, because backgrounds differ
 * per marketplace and a hard-coded value fails silently on the next one.
 *
 * The default tolerance of 5 dE is deliberately tight, and only safe because
 * connectivity does the rest of the work. Measured against real pale fabrics:
 *
 *     ivory  #f2efe6  vs white  #ffffff   dE 5.4
 *     sand   #e8e2d5  vs white  #ffffff   dE 8.5
 *     ivory  #f2efe6  vs cream  #f4f3f0   dE 2.9
 *
 * A sweep put the usable band at 4-5: at 6 and above an ivory garment on white
 * was absorbed into the background and its colour vanished from the palette
 * entirely; below 4 the ground survived as a false garment colour.
 *
 * KNOWN LIMIT: a garment within ~5 dE of its own background is still lost, so
 * ivory photographed on cream cannot be separated by this method. It needs
 * shadow or edge detection, not colour. The panel should say so rather than
 * quietly reporting one colour fewer than the fabric has.
 */
export function backgroundMask({ data, width, height }, tolerance = 5) {
  const patch = Math.max(2, Math.floor(Math.min(width, height) / 40));
  const samples = [];
  const corners = [
    [0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch],
  ];
  for (const [x0, y0] of corners) {
    for (let y = y0; y < y0 + patch; y++) {
      for (let x = x0; x < x0 + patch; x++) {
        const i = (y * width + x) * 4;
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const bg = [0, 1, 2].map((c) => median(samples.map((s) => s[c])));
  const bgLab = rgbToLab(bg);

  const isBg = (p) => {
    const i = p * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // Cheap RGB gate first, CIEDE2000 only where it might matter. A per-pixel
    // dE over half a megapixel is far too slow to run on every product view.
    if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) >= 60) {
      return false;
    }
    return deltaE2000(bgLab, rgbToLab([r, g, b])) < tolerance;
  };

  // Flood fill inward from the frame edge rather than testing every pixel
  // independently. Colour alone cannot separate an ivory garment from a white
  // studio ground - they are within a few dE of each other - but position can:
  // the background is the region connected to the border, and the garment is
  // not. A plain colour test silently deleted a #f2efe6 ivory on white and
  // reported the garment as having one fewer colour than it has.
  const isBackground = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    const p = y * width + x;
    if (!isBackground[p] && isBg(p)) { isBackground[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  while (stack.length) {
    const p = stack.pop();
    const x = p % width, y = (p - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  const keep = new Uint8Array(width * height);
  let kept = 0;
  for (let p = 0; p < keep.length; p++) {
    if (!isBackground[p]) { keep[p] = 1; kept++; }
  }

  // If the fill swallowed almost everything it was wrong about the background.
  // Better to measure the whole frame than to measure forty pixels.
  if (kept < width * height * 0.05) keep.fill(1);
  return keep;
}


/**
 * Skin-coloured pixels.
 *
 * OFF BY DEFAULT, and that is the important part. The intent was to stop a
 * model contributing her arms and face to the fabric palette, but warm fabric
 * and skin occupy the same region of CIELAB: #b5651d rust sits at hue 57 and
 * chroma 50, indistinguishable from a tan forearm by colour alone. Enabling
 * this deleted the rust from a rust-and-navy print and reported the shares as
 * 50/50 instead of 70/30.
 *
 * Warm rust, tan, gold and brown are the dominant palette in Pakistani lawn,
 * so the failure lands hardest on exactly the fabrics this product is for.
 * Separating skin from cloth needs position, not colour.
 */
function isSkin(r, g, b) {
  const lab = rgbToLab([r, g, b]);
  const h = hueOf(lab), c = chromaOf(lab);
  return lab.L > 10 && lab.L < 95 && c > 6 && c < 62 && h > 15 && h < 90;
}

function samplePixels(imageData, mask, maxSamples, excludeSkin) {
  const { data, width, height } = imageData;
  const out = [];
  const total = width * height;
  // Deterministic stride rather than random sampling: the same product must
  // produce the same verdict on every page view.
  const stride = Math.max(1, Math.floor(total / (maxSamples * 1.4)));
  for (let p = 0; p < total; p += stride) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    if (data[i + 3] < 200) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (excludeSkin && isSkin(r, g, b)) continue;
    out.push([r, g, b]);
    if (out.length >= maxSamples) break;
  }
  return out;
}

/**
 * k-means in CIELAB with k-means++ seeding.
 *
 * Lab rather than RGB because Euclidean distance there is roughly perceptual,
 * so centroids land on colours a person would name as distinct; the same
 * clustering in RGB tends to split a highlight off as its own colour. Seeding
 * is k-means++ because random init regularly collapses two centroids onto one
 * dominant colour and under-reports how many colours a print has.
 */
function kmeansLab(pixels, k, iterations = 25) {
  if (!pixels.length) return [];
  const lab = pixels.map(rgbToLab).map((c) => [c.L, c.a, c.b]);
  k = Math.min(k, lab.length);

  // Deterministic PRNG. A verdict that changes between page loads is not a
  // verdict, so this must not be Math.random.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const dist2 = (a, b) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  const centres = [lab[Math.floor(rand() * lab.length)]];
  while (centres.length < k) {
    const d2 = lab.map((p) => Math.min(...centres.map((c) => dist2(p, c))));
    const total = d2.reduce((a, b) => a + b, 0);
    let target = rand() * total, idx = 0;
    while (idx < d2.length - 1 && (target -= d2[idx]) > 0) idx++;
    centres.push(lab[idx]);
  }

  const labels = new Int32Array(lab.length).fill(-1);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let i = 0; i < lab.length; i++) {
      let best = 0, bestD = Infinity;
      for (let j = 0; j < centres.length; j++) {
        const d = dist2(lab[i], centres[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }
    if (!changed) break;
    for (let j = 0; j < centres.length; j++) {
      let n = 0, sL = 0, sA = 0, sB = 0;
      for (let i = 0; i < lab.length; i++) {
        if (labels[i] === j) { n++; sL += lab[i][0]; sA += lab[i][1]; sB += lab[i][2]; }
      }
      if (n) centres[j] = [sL / n, sA / n, sB / n];
    }
  }

  const counts = new Array(centres.length).fill(0);
  for (const l of labels) counts[l]++;

  return centres
    .map((c, j) => ({
      lab: { L: c[0], a: c[1], b: c[2] },
      p: counts[j] / lab.length,
    }))
    .filter((c) => c.p > 0)
    .sort((a, b) => b.p - a.p);
}

/** Dominant colours of a garment photo, shaped as the verdict engine wants. */
export function dominantColours(imageData, {
  k = 3,
  maxSamples = 12000,
  excludeBackground = true,
  excludeSkin = false,
  mask: providedMask = null,
} = {}) {
  // Accept a mask the caller already computed. The flood fill is the most
  // expensive step in the pipeline, and the render needs the same mask, so
  // recomputing it here doubled the work for no benefit.
  const mask = providedMask ?? (excludeBackground ? backgroundMask(imageData) : null);
  const pixels = samplePixels(imageData, mask, maxSamples, excludeSkin);
  if (pixels.length < 50) return [];
  return kmeansLab(pixels, k);
}
