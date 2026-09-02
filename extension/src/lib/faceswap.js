// Put your face on the model already wearing the garment.
//
// The inversion that makes this tractable: a try-on model has to synthesise
// cloth - drape, folds, how a print falls over a body - which costs tens of
// seconds on a GPU. But the product photograph already contains that garment,
// rendered perfectly, on a person. The only thing wrong with it is whose face
// it is. Replacing a face moves a few thousand pixels over geometry we already
// have, and runs in milliseconds.
//
// This is a similarity warp with a feathered mask and colour matching, not a
// neural swap. It will not survive close inspection, and it is not meant to:
// the effect worth having is "that is my face on the model", at a glance,
// instantly, while browsing.

import { hexToLab, rgbToLab } from "../engine/colour.js";
import { findFace, frontality } from "./facemesh.js";

// MediaPipe's 478-point mesh. These are the stable anchors - the eye corners
// and the chin move least with expression, so a transform fitted to them is
// steadier than one fitted to the mouth or brows.
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const CHIN = 152;
const FOREHEAD = 10;

/** Similarity transform (rotate, scale, translate) taking the source face onto
 *  the target face.
 *
 *  Two eye corners are enough to fix rotation and scale, and they are the
 *  landmarks both faces are most likely to agree on. A full affine fitted to
 *  more points tracks expression differences and shears the face.
 */
function similarityFrom(src, dst) {
  const s1 = src.points[LEFT_EYE_OUTER], s2 = src.points[RIGHT_EYE_OUTER];
  const d1 = dst.points[LEFT_EYE_OUTER], d2 = dst.points[RIGHT_EYE_OUTER];

  const sdx = s2.x - s1.x, sdy = s2.y - s1.y;
  const ddx = d2.x - d1.x, ddy = d2.y - d1.y;

  const srcLen = Math.hypot(sdx, sdy) || 1;
  const dstLen = Math.hypot(ddx, ddy) || 1;
  const scale = dstLen / srcLen;
  const angle = Math.atan2(ddy, ddx) - Math.atan2(sdy, sdx);

  const cos = Math.cos(angle) * scale;
  const sin = Math.sin(angle) * scale;

  // Map the source eye midpoint onto the target's.
  const sMid = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
  const dMid = { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };

  return {
    a: cos, b: sin, c: -sin, d: cos,
    e: dMid.x - (cos * sMid.x - sin * sMid.y),
    f: dMid.y - (sin * sMid.x + cos * sMid.y),
  };
}

/** Mean and standard deviation per CIELAB channel inside a mask. */
function labStats(imageData, mask) {
  const { data } = imageData;
  let n = 0;
  let sL = 0, sA = 0, sB = 0, qL = 0, qA = 0, qB = 0;

  for (let p = 0; p < mask.length; p++) {
    if (mask[p] < 128) continue;
    const i = p * 4;
    const c = rgbToLab([data[i], data[i + 1], data[i + 2]]);
    n++;
    sL += c.L; sA += c.a; sB += c.b;
    qL += c.L * c.L; qA += c.a * c.a; qB += c.b * c.b;
  }
  if (!n) return null;

  const mean = { L: sL / n, a: sA / n, b: sB / n };
  const sd = {
    L: Math.sqrt(Math.max(1e-6, qL / n - mean.L ** 2)),
    a: Math.sqrt(Math.max(1e-6, qA / n - mean.a ** 2)),
    b: Math.sqrt(Math.max(1e-6, qB / n - mean.b ** 2)),
  };
  return { mean, sd, n };
}

function labToRgb({ L, a, b }) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const [X, Y, Z] = [inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883];
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  });
}

/**
 * Match one face's colour distribution to another's, in CIELAB.
 *
 * This is what stops the result looking pasted on. Two photographs taken in
 * different light differ in exposure and white balance far more than the two
 * people differ, so a warp without correction leaves a visible disc of the
 * wrong colour. Shifting mean and standard deviation per channel in Lab -
 * where lightness is separate from colour - matches the studio lighting
 * without changing who the face belongs to.
 *
 * Chroma is corrected less than lightness, deliberately: pulling a and b all
 * the way to the target's statistics would replace the person's complexion
 * with the model's, which defeats the point.
 */
function recolour(imageData, mask, from, to, chromaStrength = 0.55) {
  const { data } = imageData;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] < 8) continue;
    const i = p * 4;
    const c = rgbToLab([data[i], data[i + 1], data[i + 2]]);

    const L = to.mean.L + (c.L - from.mean.L) * (to.sd.L / from.sd.L);
    const a = c.a + (to.mean.a - from.mean.a) * chromaStrength;
    const b = c.b + (to.mean.b - from.mean.b) * chromaStrength;

    const [r, g, bl] = labToRgb({ L, a, b });
    data[i] = r; data[i + 1] = g; data[i + 2] = bl;
  }
}

/** Soft elliptical mask over the face, feathered at the edge.
 *
 *  An ellipse rather than the mesh's face oval: the oval hugs the jaw exactly,
 *  and a hard boundary there produces a visible cut. Feathering over a wide
 *  band hides the seam at the cost of including a little hair and background,
 *  which the colour matching then makes unobtrusive.
 */
function faceMask(w, h, face, feather = 0.28) {
  const mask = new Uint8ClampedArray(w * h);
  const p = face.points;
  const cx = (p[LEFT_EYE_OUTER].x + p[RIGHT_EYE_OUTER].x) / 2;
  const eyeY = (p[LEFT_EYE_OUTER].y + p[RIGHT_EYE_OUTER].y) / 2;
  const cy = (eyeY + p[CHIN].y) / 2;

  const rx = Math.hypot(p[RIGHT_EYE_OUTER].x - p[LEFT_EYE_OUTER].x,
                        p[RIGHT_EYE_OUTER].y - p[LEFT_EYE_OUTER].y) * 0.95;
  const ry = Math.hypot(p[CHIN].x - p[FOREHEAD].x, p[CHIN].y - p[FOREHEAD].y) * 0.52;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      let v = 0;
      if (d <= 1 - feather) v = 255;
      else if (d < 1) v = Math.round(255 * (1 - (d - (1 - feather)) / feather));
      mask[y * w + x] = v;
    }
  }
  return mask;
}

/**
 * Replace the face in `targetImg` with the face from `personImg`.
 *
 * Returns a canvas, or throws with a reason a person can act on.
 */
export async function swapFace(personImg, targetImg, { maxWidth = 640 } = {}) {
  const targetFace = await findFace(targetImg);
  if (!targetFace) {
    throw new Error("No face found in the product photo - this shot may be cropped below the neck.");
  }
  const personFace = await findFace(personImg);
  if (!personFace) {
    throw new Error("No face found in your photo. Use a clear, front-facing picture.");
  }

  const front = frontality(targetFace);
  const yours = frontality(personFace);

  const scale = Math.min(1, maxWidth / targetImg.naturalWidth);
  const w = Math.round(targetImg.naturalWidth * scale);
  const h = Math.round(targetImg.naturalHeight * scale);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(targetImg, 0, 0, w, h);

  // Landmarks were measured at full size; the canvas is scaled.
  const scaled = (f) => ({
    ...f,
    points: f.points.map((p) => ({ x: p.x * scale, y: p.y * scale, z: p.z })),
  });
  const tgt = scaled(targetFace);

  // Draw the person, transformed so their eyes land on the model's.
  const warp = document.createElement("canvas");
  warp.width = w;
  warp.height = h;
  const wctx = warp.getContext("2d", { willReadFrequently: true });
  const m = similarityFrom(personFace, tgt);
  wctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  wctx.drawImage(personImg, 0, 0);
  wctx.setTransform(1, 0, 0, 1, 0, 0);

  const mask = faceMask(w, h, tgt);

  // Match the warped face to the studio lighting before blending.
  const warped = wctx.getImageData(0, 0, w, h);
  const base = ctx.getImageData(0, 0, w, h);
  const from = labStats(warped, mask);
  const to = labStats(base, mask);
  if (from && to) recolour(warped, mask, from, to);

  // Feathered composite.
  for (let p = 0; p < mask.length; p++) {
    const alpha = mask[p] / 255;
    if (alpha <= 0) continue;
    const i = p * 4;
    for (let c = 0; c < 3; c++) {
      base.data[i + c] = warped.data[i + c] * alpha + base.data[i + c] * (1 - alpha);
    }
  }
  ctx.putImageData(base, 0, 0);

  return {
    canvas: out,
    // Reported so the panel can warn rather than quietly produce a smear: a
    // warp only holds when both faces are near-frontal.
    frontality: { target: front, person: yours },
    reliable: front > 0.62 && yours > 0.62,
  };
}
