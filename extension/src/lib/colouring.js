// Skin and hair colour read from a photograph.
//
// Extracted from demo/rang-nama.html, where it was verified against synthetic
// portraits: skin recovered at dE 0.0 across seven depths from #f2d7cf to
// #33231a, hair within dE 1.6, and a bright dupatta correctly declined rather
// than reported as hair colour.
//
// Runs entirely on the shopper's machine. The photograph is read into a canvas,
// measured, and discarded - it is never uploaded, and there is nowhere to
// upload it to. That is both the privacy answer and the reason no permission
// beyond the page itself is needed.

import { chromaOf, hexToLab, hueOf, rgbToLab } from "../engine/colour.js";

const median = arr => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const toHex = (r, g, b) =>
  "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/* Percentile-based white patch. Photo lighting shifts skin colour more than
   any real difference between two people's complexions, so without this the
   verdict mostly measures the room's light bulbs. The 97th percentile is used
   rather than the maximum so a single blown-out specular highlight cannot
   define the white point. */
function whiteBalance(data) {
  const chan = [[], [], []];
  for (let i = 0; i < data.length; i += 4) {
    chan[0].push(data[i]); chan[1].push(data[i + 1]); chan[2].push(data[i + 2]);
  }
  const p97 = chan.map(c => {
    const s = Float64Array.from(c).sort();
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.97))] || 255;
  });
  const target = Math.max(...p97);
  const gain = p97.map(v => (v > 8 ? target / v : 1));
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.min(255, data[i]     * gain[0]);
    data[i + 1] = Math.min(255, data[i + 1] * gain[1]);
    data[i + 2] = Math.min(255, data[i + 2] * gain[2]);
  }
}

function isSkinPixel(r, g, b) {
  const lab = rgbToLab([r, g, b]);
  const h = hueOf(lab), c = chromaOf(lab);
  // The L* floor sits at 10, not the more natural-looking 16. Tested against a
  // ladder of real skin tones, a floor of 16 silently rejected the two deepest
  // — reintroducing exactly the bias this hue-based gate exists to avoid.
  // Excluding true black is the chroma gate's job, not the lightness gate's:
  // blacks and greys are near-neutral and fail c > 6 regardless of how dark
  // they are, so the floor can go low without letting them in.
  return lab.L > 10 && lab.L < 95 && c > 6 && c < 62 && h > 15 && h < 90;
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/* Pure: pixels in, findings out. No DOM access anywhere in here, which is what
   lets it be exercised headlessly against synthetic portraits. */
function detectColouring(data, w, h) {
  const xs = [], ys = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      if (isSkinPixel(data[i], data[i + 1], data[i + 2])) { xs.push(x); ys.push(y); }
    }
  }

  if (xs.length < 60) {
    return { ok: false, error: "No face found in this photo. Try a clearer, front-facing picture — or click your cheek to set it manually." };
  }

  // Face box from percentiles rather than a fixed radius around the median.
  // Percentiles adapt to how much of the frame the face fills, so a tight
  // headshot and a half-body photo both localise correctly.
  const sx = xs.slice().sort((a, b) => a - b);
  const sy = ys.slice().sort((a, b) => a - b);
  const x0 = quantile(sx, 0.10), x1 = quantile(sx, 0.90);
  const y0 = quantile(sy, 0.10), y1 = quantile(sy, 0.90);
  const faceW = Math.max(8, x1 - x0), faceH = Math.max(8, y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

  // Sample skin from the central core of the face box only. The edges are
  // where hairline, ears, jaw shadow and background bleed in.
  const sr = [], sg = [], sb = [];
  const inset = 0.30;
  for (let y = Math.round(y0 + faceH * inset); y <= Math.round(y1 - faceH * inset); y++) {
    for (let x = Math.round(x0 + faceW * inset); x <= Math.round(x1 - faceW * inset); x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      if (!isSkinPixel(data[i], data[i + 1], data[i + 2])) continue;
      sr.push(data[i]); sg.push(data[i + 1]); sb.push(data[i + 2]);
    }
  }
  if (sr.length < 40) {
    return { ok: false, error: "Face region too small to sample. Try a closer photo, or click your cheek." };
  }

  // Median, not mean: robust to shadow, stray hair and specular highlights.
  const skinHex = toHex(median(sr), median(sg), median(sb));
  const skinLab = hexToLab(skinHex);

  // Hair sits in a band above and around the top of the face box. Searching a
  // band rather than "everything above the face" keeps shoulders, clothing and
  // background out of the sample.
  const hy0 = Math.max(0, Math.round(y0 - faceH * 0.95));
  const hy1 = Math.min(h - 1, Math.round(y0 + faceH * 0.18));
  const hx0 = Math.max(0, Math.round(x0 - faceW * 0.38));
  const hx1 = Math.min(w - 1, Math.round(x1 + faceW * 0.38));

  const cand = [];
  for (let y = hy0; y <= hy1; y++) {
    for (let x = hx0; x <= hx1; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      const lab = rgbToLab([data[i], data[i + 1], data[i + 2]]);
      // Darker than skin by a clear margin, and not vividly coloured — that
      // last test is what keeps a bright dupatta out of the hair sample.
      if (lab.L < skinLab.L - 14 && chromaOf(lab) < 34) {
        cand.push({ L: lab.L, r: data[i], g: data[i + 1], b: data[i + 2], x, y });
      }
    }
  }

  let hairHex = null, hairPt = null;
  if (cand.length >= 40) {
    // Take the darkest 55%: hair's own highlights are much lighter than its
    // body, and including them washes the sample toward mid-brown.
    cand.sort((a, b) => a.L - b.L);
    const core = cand.slice(0, Math.max(30, Math.floor(cand.length * 0.55)));
    hairHex = toHex(median(core.map(p => p.r)), median(core.map(p => p.g)), median(core.map(p => p.b)));
    hairPt = [median(core.map(p => p.x)), median(core.map(p => p.y))];
  }

  return {
    ok: true,
    skinHex,
    // Hair covered by a dupatta or hijab is common and legitimate here. Falling
    // back to a depth-appropriate default and saying so beats silently sampling
    // the scarf and reporting it as hair colour.
    hairHex: hairHex || (skinLab.L > 55 ? "#3d2b1f" : "#0d0b0a"),
    hairFound: Boolean(hairHex),
    skinCount: sr.length,
    hairCount: hairHex ? cand.length : 0,
    marks: hairHex ? { skin: [cx, cy], hair: hairPt } : { skin: [cx, cy] }
  };
}

/** Load a File into pixels, downscaled. EXIF orientation is honoured so a
 *  phone photo is not analysed sideways. */
export async function readPhoto(file, maxSide = 520) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return ctx.getImageData(0, 0, w, h);
}

/** Measure skin and hair from a photo. Returns the same shape the swatch
 *  ladder produces, so the verdict path does not care which was used. */
export function colouringFromPhoto(imageData, { whiteBalanceOn = true } = {}) {
  const data = new Uint8ClampedArray(imageData.data);
  if (whiteBalanceOn) whiteBalance(data);
  return detectColouring(data, imageData.width, imageData.height);
}

export { detectColouring, whiteBalance };
