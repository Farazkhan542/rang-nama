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

/** Front-view kurta silhouette: body, sleeves, neckline. */
function kurtaPath(g, w, h) {
  const X = (v) => v * w, Y = (v) => v * h;
  g.beginPath();
  g.moveTo(X(0.31), Y(0.085));
  g.quadraticCurveTo(X(0.16), Y(0.10), X(0.115), Y(0.175));
  g.lineTo(X(0.075), Y(0.44));
  g.quadraticCurveTo(X(0.14), Y(0.475), X(0.245), Y(0.455));
  g.lineTo(X(0.275), Y(0.30));
  g.lineTo(X(0.205), Y(0.985));
  g.quadraticCurveTo(X(0.5), Y(1.01), X(0.795), Y(0.985));
  g.lineTo(X(0.725), Y(0.30));
  g.lineTo(X(0.755), Y(0.455));
  g.quadraticCurveTo(X(0.86), Y(0.475), X(0.925), Y(0.44));
  g.lineTo(X(0.885), Y(0.175));
  g.quadraticCurveTo(X(0.84), Y(0.10), X(0.69), Y(0.085));
  g.quadraticCurveTo(X(0.5), Y(0.215), X(0.31), Y(0.085));
  g.closePath();
}

/**
 * Draw the kurta.
 *
 * @param canvas   target
 * @param patch    canvas of real fabric, from fabricPatch
 * @param frame    petite | average | tall
 * @param motifCm  real-world repeat size, if known. When null the patch is
 *                 tiled at a plausible default and the caller should say the
 *                 scale is illustrative rather than measured.
 */
export function renderGarment(canvas, patch, frame = "average", motifCm = null) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = 300, h = 410;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";

  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);

  const bodyPx = w * 0.59;
  const pxPerCm = bodyPx / KURTA_CM[frame];
  // Without a measured repeat, tile the patch at roughly 12 cm. Stated as
  // illustrative in the panel rather than presented as a measurement.
  const tilePx = Math.max(14, (motifCm ?? 12) * pxPerCm);

  g.save();
  kurtaPath(g, w, h);
  g.clip();

  const scaled = document.createElement("canvas");
  scaled.width = Math.round(tilePx);
  scaled.height = Math.round(tilePx);
  scaled.getContext("2d").drawImage(patch, 0, 0, scaled.width, scaled.height);

  g.fillStyle = g.createPattern(scaled, "repeat");
  g.fillRect(0, 0, w, h);

  // Shading, multiplied so it removes light without touching hue. A normal
  // blend would wash grey over the print and shift the colours the verdict
  // just reported.
  g.globalCompositeOperation = "multiply";

  const across = g.createLinearGradient(0, 0, w, 0);
  across.addColorStop(0.00, "rgba(120,120,140,.50)");
  across.addColorStop(0.16, "rgba(255,255,255,1)");
  across.addColorStop(0.46, "rgba(255,255,255,1)");
  across.addColorStop(0.62, "rgba(150,150,168,.40)");
  across.addColorStop(0.84, "rgba(255,255,255,1)");
  across.addColorStop(1.00, "rgba(120,120,140,.50)");
  g.fillStyle = across;
  g.fillRect(0, 0, w, h);

  const down = g.createLinearGradient(0, 0, 0, h);
  down.addColorStop(0.00, "rgba(140,140,158,.38)");
  down.addColorStop(0.14, "rgba(255,255,255,1)");
  down.addColorStop(0.80, "rgba(255,255,255,1)");
  down.addColorStop(1.00, "rgba(160,160,178,.32)");
  g.fillStyle = down;
  g.fillRect(0, 0, w, h);

  for (const [cxr, wr, a] of [[0.34, 0.055, 0.18], [0.66, 0.045, 0.14]]) {
    const fold = g.createLinearGradient((cxr - wr) * w, 0, (cxr + wr) * w, 0);
    fold.addColorStop(0, "rgba(255,255,255,1)");
    fold.addColorStop(0.5, `rgba(120,120,140,${a})`);
    fold.addColorStop(1, "rgba(255,255,255,1)");
    g.fillStyle = fold;
    g.fillRect(0, 0, w, h);
  }

  g.globalCompositeOperation = "source-over";
  g.restore();

  g.strokeStyle = "rgba(0,0,0,.20)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(w * 0.31, h * 0.085);
  g.quadraticCurveTo(w * 0.5, h * 0.215, w * 0.69, h * 0.085);
  g.stroke();

  g.strokeStyle = "rgba(0,0,0,.14)";
  kurtaPath(g, w, h);
  g.stroke();
}
