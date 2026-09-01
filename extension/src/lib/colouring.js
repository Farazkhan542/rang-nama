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
  // Skin-coloured pixels, at half resolution: only the region matters here.
  const step = 2;
  const cols = Math.ceil(w / step), rows = Math.ceil(h / step);
  const isSkinPx = new Uint8Array(cols * rows);
  let skinCount = 0;

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const i = (ry * step * w + rx * step) * 4;
      if (data[i + 3] < 200) continue;
      if (isSkinPixel(data[i], data[i + 1], data[i + 2])) {
        isSkinPx[ry * cols + rx] = 1;
        skinCount++;
      }
    }
  }

  if (skinCount < 40) {
    return { ok: false, error: "No face found in this photo." };
  }

  // Largest connected region of skin, not percentiles over every skin pixel.
  //
  // Percentiles assume the only skin-coloured thing in frame is a face. In a
  // real photograph a wooden door, a beige wall, a hand and a forearm all pass
  // a colour gate, and the resulting centroid lands somewhere between them -
  // which is why this worked on synthetic portraits with plain backgrounds and
  // failed on actual photos. A face is one contiguous blob; a wall is another,
  // and blobs can be told apart even when their colours cannot.
  const label = new Int32Array(cols * rows).fill(-1);
  const regions = [];
  const queue = new Int32Array(cols * rows);

  for (let seed = 0; seed < isSkinPx.length; seed++) {
    if (!isSkinPx[seed] || label[seed] !== -1) continue;
    const id = regions.length;
    let head = 0, tail = 0, size = 0;
    let minX = cols, maxX = 0, minY = rows, maxY = 0;

    queue[tail++] = seed;
    label[seed] = id;

    while (head < tail) {
      const p = queue[head++];
      const x = p % cols, y = (p - x) / cols;
      size++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && isSkinPx[p - 1] && label[p - 1] === -1) { label[p - 1] = id; queue[tail++] = p - 1; }
      if (x < cols - 1 && isSkinPx[p + 1] && label[p + 1] === -1) { label[p + 1] = id; queue[tail++] = p + 1; }
      if (y > 0 && isSkinPx[p - cols] && label[p - cols] === -1) { label[p - cols] = id; queue[tail++] = p - cols; }
      if (y < rows - 1 && isSkinPx[p + cols] && label[p + cols] === -1) { label[p + cols] = id; queue[tail++] = p + cols; }
    }
    regions.push({ id, size, minX, maxX, minY, maxY });
  }

  if (!regions.length) {
    return { ok: false, error: "No face found in this photo." };
  }

  // Pick the face among the skin-coloured blobs.
  //
  // Size alone is not enough and gets it wrong in the most common real
  // scenario: a beige wall or a wooden door is skin-coloured, contiguous, and
  // far larger than a head, so it wins on area every time. On a test scene
  // with a warm wall behind a deep-skinned subject the wall was chosen and the
  // reading was 47 dE from the truth.
  //
  // What separates them is the frame edge. A backdrop runs off the picture on
  // several sides; a face is bounded on all four. Counting touched edges is a
  // far stronger signal than area, so it is weighted accordingly.
  let best = null, bestScore = -Infinity;
  const area = cols * rows;

  for (const r of regions) {
    const rw = r.maxX - r.minX + 1, rh = r.maxY - r.minY + 1;
    if (r.size < 30) continue;

    const edges =
      (r.minX === 0 ? 1 : 0) + (r.minY === 0 ? 1 : 0) +
      (r.maxX === cols - 1 ? 1 : 0) + (r.maxY === rows - 1 ? 1 : 0);
    // Two or more edges is scenery. One is a legitimately tight crop.
    const bounded = edges === 0 ? 1 : edges === 1 ? 0.55 : 0.04;

    const aspect = rw / rh;
    const shape = aspect > 0.45 && aspect < 2.2 ? 1 : 0.35;

    const fill = r.size / (rw * rh);
    const solid = fill > 0.4 ? 1 : 0.5;

    const centreY = (r.minY + rh / 2) / rows;
    const height = centreY < 0.6 ? 1 : 0.6;

    // A head occupies a modest share of a portrait. Anything past a third of
    // the frame is scenery whatever else it looks like.
    const frac = r.size / area;
    const plausible = frac > 0.002 && frac < 0.33 ? 1 : 0.1;

    const score = r.size * bounded * shape * solid * height * plausible;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!best) return { ok: false, error: "No face found in this photo." };

  // A chosen region that runs off several edges has almost certainly merged
  // with the background. Fair skin against a cream wall is close enough in
  // colour that the flood fill joins them, and the merged blob's median is the
  // wall, not the face - so the panel would confidently report the paint
  // colour as a complexion. Refuse instead, and say what would fix it.
  const bestEdges =
    (best.minX === 0 ? 1 : 0) + (best.minY === 0 ? 1 : 0) +
    (best.maxX === cols - 1 ? 1 : 0) + (best.maxY === rows - 1 ? 1 : 0);
  if (bestEdges >= 2) {
    return {
      ok: false,
      error: "Couldn't separate you from the background - they are too close " +
             "in colour. Try a photo against a wall that contrasts with your " +
             "skin, or pick the closest swatches below.",
    };
  }

  let faceW = best.maxX - best.minX + 1;
  let faceH = best.maxY - best.minY + 1;

  // Reunite the pieces of a fragmented face.
  //
  // Spectacles cut a dark bar across the middle of a face and a beard covers
  // the lower half, so a real face is frequently not one blob but several -
  // forehead, one cheek, the other cheek. Taking only the largest samples a
  // forehead and throws the cheeks away, and on a bearded face in glasses the
  // largest fragment can be a patch of temple.
  //
  // Any skin region sitting inside a modest expansion of the winner is part of
  // the same face. A hand or a wall is further away, or is disqualified by the
  // frame-edge test above.
  const near = new Set([best.id]);
  const padX = faceW * 0.55, padY = faceH * 0.75;
  for (const r of regions) {
    if (r.id === best.id || r.size < 15) continue;
    const rEdges =
      (r.minX === 0 ? 1 : 0) + (r.minY === 0 ? 1 : 0) +
      (r.maxX === cols - 1 ? 1 : 0) + (r.maxY === rows - 1 ? 1 : 0);
    if (rEdges >= 2) continue;                      // scenery
    if (r.size > best.size * 1.2) continue;         // something else entirely
    const overlapsX = r.minX < best.maxX + padX && r.maxX > best.minX - padX;
    const overlapsY = r.minY < best.maxY + padY && r.maxY > best.minY - padY;
    if (overlapsX && overlapsY) near.add(r.id);
  }

  // Recompute the face box over every accepted fragment.
  let fx0 = best.minX, fx1 = best.maxX, fy0 = best.minY, fy1 = best.maxY;
  for (const r of regions) {
    if (!near.has(r.id)) continue;
    fx0 = Math.min(fx0, r.minX); fx1 = Math.max(fx1, r.maxX);
    fy0 = Math.min(fy0, r.minY); fy1 = Math.max(fy1, r.maxY);
  }
  faceW = fx1 - fx0 + 1;
  faceH = fy1 - fy0 + 1;

  // Sample every accepted fragment, away from hairline, jaw and shadow.
  const sr = [], sg = [], sb = [];
  const inset = 0.12;
  for (let ry = Math.round(fy0 + faceH * inset); ry <= Math.round(fy1 - faceH * inset); ry++) {
    for (let rx = Math.round(fx0 + faceW * inset); rx <= Math.round(fx1 - faceW * inset); rx++) {
      if (rx < 0 || ry < 0 || rx >= cols || ry >= rows) continue;
      if (!near.has(label[ry * cols + rx])) continue;
      const i = (ry * step * w + rx * step) * 4;
      sr.push(data[i]); sg.push(data[i + 1]); sb.push(data[i + 2]);
    }
  }
  if (sr.length < 25) {
    return { ok: false, error: "Face region too small. Try a closer photo." };
  }

  const skinHex = toHex(median(sr), median(sg), median(sb));
  const skinLab = hexToLab(skinHex);

  // Sanity-check the answer, not just the region.
  //
  // The gate that finds candidate pixels has to be wide, because deep skin and
  // dark brown hair are all but identical in CIELAB - #4a3324 skin sits at
  // L 23.5 / chroma 15.9 / hue 58.9 and #3d2b1f hair at L 19.3 / 12.8 / 59.7.
  // No colour test separates those, so the gate lets in things that are not
  // skin, including pale walls.
  //
  // Human skin spans roughly chroma 10-50. A cream wall sits near chroma 8:
  // it passes the gate as a candidate but cannot survive a check on the final
  // measurement. Refusing here is the difference between "I could not read
  // this photo" and confidently reporting a paint colour as a complexion.
  const skinChroma = chromaOf(skinLab);
  if (skinChroma < 10 || skinChroma > 52 || skinLab.L > 92) {
    return {
      ok: false,
      error: "Couldn't separate you from the background - they are too close " +
             "in colour. Try a photo against a wall that contrasts with your " +
             "skin, or pick the closest swatches below.",
    };
  }

  // Hair: a band above and around the face blob.
  const hy0 = Math.max(0, Math.round(fy0 - faceH * 0.95));
  const hy1 = Math.min(rows - 1, Math.round(fy0 + faceH * 0.18));
  const hx0 = Math.max(0, Math.round(fx0 - faceW * 0.38));
  const hx1 = Math.min(cols - 1, Math.round(fx1 + faceW * 0.38));

  const cand = [];
  for (let ry = hy0; ry <= hy1; ry++) {
    for (let rx = hx0; rx <= hx1; rx++) {
      const i = (ry * step * w + rx * step) * 4;
      if (data[i + 3] < 200) continue;
      const lab = rgbToLab([data[i], data[i + 1], data[i + 2]]);
      if (lab.L < skinLab.L - 14 && chromaOf(lab) < 34) {
        cand.push({ L: lab.L, r: data[i], g: data[i + 1], b: data[i + 2] });
      }
    }
  }

  let hairHex = null;
  if (cand.length >= 25) {
    cand.sort((a, b) => a.L - b.L);
    const core = cand.slice(0, Math.max(20, Math.floor(cand.length * 0.55)));
    hairHex = toHex(median(core.map((p) => p.r)), median(core.map((p) => p.g)),
                    median(core.map((p) => p.b)));
  }

  return {
    ok: true,
    skinHex,
    hairHex: hairHex || (skinLab.L > 55 ? "#3d2b1f" : "#0d0b0a"),
    hairFound: Boolean(hairHex),
    skinCount: sr.length,
    hairCount: hairHex ? cand.length : 0,
    regions: regions.length,
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
