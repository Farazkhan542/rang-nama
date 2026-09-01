// Render the fabric as a stitched kurta, using the real print off the page.
//
// This is the piece nothing else does. An unstitched product photo is a flat
// bolt of cloth: the shopper is asked to buy fabric and imagine the garment.
// Lifting a patch of the actual print and mapping it onto a kurta silhouette
// shows what she is actually buying.
//
// No generative model. A diffusion model redraws a print, and redrawn florals
// drift in motif scale and hue, which would contradict the CIEDE2000 numbers
// shown beside it. Tiling the real pixels preserves the print by construction,
// costs nothing, and finishes in a few milliseconds.

/** Front width of a stitched kurta in centimetres, by frame.
 *  Motif scale is meaningless without a real-world reference: the same print
 *  covers proportionally more of a petite garment than a tall one. */
const KURTA_CM = { petite: 44, average: 49, tall: 54 };

/**
 * Find a square of mostly-garment pixels to tile from.
 *
 * Scans on a coarse grid for the window with the highest garment coverage,
 * preferring the centre of the cloth. Sampling a fixed spot instead would land
 * on a fold, a label or the background about as often as not.
 */
export function fabricPatch(imageData, mask, patchSize = 96) {
  const { data, width, height } = imageData;
  const size = Math.min(patchSize, Math.floor(Math.min(width, height) / 2));
  if (size < 8) return null;

  let best = null, bestScore = -1;
  const step = Math.max(4, Math.floor(size / 3));

  for (let y = 0; y + size <= height; y += step) {
    for (let x = 0; x + size <= width; x += step) {
      let inside = 0;
      // Sample the window rather than reading every pixel: this runs over a
      // few hundred windows and only the ranking matters.
      for (let dy = 0; dy < size; dy += 6) {
        for (let dx = 0; dx < size; dx += 6) {
          if (!mask || mask[(y + dy) * width + (x + dx)]) inside++;
        }
      }
      const cx = (x + size / 2) / width - 0.5;
      const cy = (y + size / 2) / height - 0.5;
      // Mild centre bias: edges of a garment carry shadow and hem.
      const score = inside * (1 - 0.35 * Math.hypot(cx, cy));
      if (score > bestScore) { bestScore = score; best = { x, y, size }; }
    }
  }
  if (!best) return null;

  const canvas = document.createElement("canvas");
  canvas.width = best.size;
  canvas.height = best.size;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(best.size, best.size);
  for (let dy = 0; dy < best.size; dy++) {
    for (let dx = 0; dx < best.size; dx++) {
      const src = ((best.y + dy) * width + (best.x + dx)) * 4;
      const dst = (dy * best.size + dx) * 4;
      out.data[dst] = data[src];
      out.data[dst + 1] = data[src + 1];
      out.data[dst + 2] = data[src + 2];
      out.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * Show the garment as photographed, background removed.
 *
 * This replaces a renderer that tiled a small patch of fabric across a generic
 * kurta outline. That works for an all-over repeat print and is wrong for this
 * category: Pakistani lawn is largely *placement* print - a floral cascade
 * down the centre front, embroidery at the neckline, a scalloped hem, printed
 * sleeve borders. Tiling a patch reproduced the colours and destroyed the
 * design, so the panel showed the right palette on a garment that did not
 * exist.
 *
 * Khaadi also photographs every piece on a model, including the unstitched
 * ones, so "what does this look like made up?" is already answered by the
 * page. Cutting the garment out of that photograph keeps the real design
 * intact and claims nothing the picture does not support.
 */
export function renderGarment(canvas, imageData, mask, rect = null) {
  const { data, width, height } = imageData;

  // Crop to the garment's actual extent so the card is not mostly empty studio.
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let p = 0; p < width * height; p++) {
    if (!mask[p]) continue;
    const x = p % width, y = (p - x) / width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }

  // Prefer the model's box when it gave one: it knows which part of the
  // subject is the garment rather than her hair or the dupatta.
  if (rect) {
    x0 = Math.max(x0, Math.floor(rect.x0 * width));
    x1 = Math.min(x1, Math.ceil(rect.x1 * width));
    y0 = Math.max(y0, Math.floor(rect.y0 * height));
    y1 = Math.min(y1, Math.ceil(rect.y1 * height));
  }

  const cw = Math.max(1, x1 - x0 + 1);
  const ch = Math.max(1, y1 - y0 + 1);

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const outW = 290;
  const outH = Math.round((ch / cw) * outW);
  canvas.width = outW * dpr;
  canvas.height = outH * dpr;
  canvas.style.width = outW + "px";
  canvas.style.height = outH + "px";

  const cut = document.createElement("canvas");
  cut.width = cw;
  cut.height = ch;
  const cx = cut.getContext("2d");
  const out = cx.createImageData(cw, ch);

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = ((y0 + y) * width + (x0 + x)) * 4;
      const dst = (y * cw + x) * 4;
      out.data[dst] = data[src];
      out.data[dst + 1] = data[src + 1];
      out.data[dst + 2] = data[src + 2];
      // Background becomes transparent rather than being painted over, so the
      // cut-out sits on the card instead of carrying a studio wall with it.
      out.data[dst + 3] = mask[(y0 + y) * width + (x0 + x)] ? 255 : 0;
    }
  }
  cx.putImageData(out, 0, 0);

  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, outW, outH);
  g.imageSmoothingQuality = "high";
  g.drawImage(cut, 0, 0, outW, outH);
}
