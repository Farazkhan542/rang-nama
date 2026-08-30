// Exercise the in-page colour extractor headlessly.
//
// Synthetic images with known colours, so "did it find the right colours" has
// an actual answer rather than an impression. Node has no canvas, which is why
// the extractor takes a plain {data, width, height} and only loadImageData
// touches the DOM.

import { deltaE2000, hexToLab, rgbToLab } from "../extension/src/engine/colour.js";
import { backgroundMask, dominantColours } from "../extension/src/lib/extract.js";

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** A garment shape on a studio ground, optionally with skin showing. */
function synthetic({ bg, garment, skin = null, w = 300, h = 400, noise = 3 }) {
  const data = new Uint8ClampedArray(w * h * 4);
  const bgc = hexRgb(bg);
  const parts = garment.map(([hex, share]) => ({ rgb: hexRgb(hex), share }));
  const skinc = skin ? hexRgb(skin) : null;

  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const jit = (v) => Math.max(0, Math.min(255, v + (rand() - 0.5) * 2 * noise));

  // Garment occupies a centred rectangle; skin (if any) a band above it.
  const gx0 = w * 0.22, gx1 = w * 0.78, gy0 = h * 0.28, gy1 = h * 0.95;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c;
      if (x > gx0 && x < gx1 && y > gy0 && y < gy1) {
        // Deterministic stripes so the area shares are exact.
        const t = ((y - gy0) / (gy1 - gy0));
        let acc = 0, chosen = parts[0];
        for (const p of parts) {
          acc += p.share;
          if (t <= acc) { chosen = p; break; }
        }
        c = chosen.rgb;
      } else if (skinc && y < gy0 && x > w * 0.35 && x < w * 0.65) {
        c = skinc;
      } else {
        c = bgc;
      }
      data[i] = jit(c[0]); data[i + 1] = jit(c[1]); data[i + 2] = jit(c[2]); data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

let failures = 0;
const fail = (msg) => { console.log("  FAIL " + msg); failures++; };

console.log("BACKGROUND EXCLUSION");
for (const bg of ["#f4f3f0", "#ffffff", "#e9eaec"]) {
  const img = synthetic({ bg, garment: [["#b5651d", 1.0]] });
  const mask = backgroundMask(img);
  const kept = mask.reduce((a, b) => a + b, 0) / mask.length;
  // The garment rectangle is 56% wide by 67% tall = ~37.5% of the frame.
  const ok = Math.abs(kept - 0.375) < 0.06;
  console.log(`  ${ok ? "OK  " : "FAIL"} bg ${bg}: kept ${(kept * 100).toFixed(1)}% (garment is 37.5%)`);
  if (!ok) failures++;
}

console.log("\nDOMINANT COLOUR RECOVERY");
const CASES = [
  ["single rust", "#f4f3f0", [["#b5651d", 1.0]]],
  ["rust + gold", "#f4f3f0", [["#b5651d", 0.6], ["#d4a017", 0.4]]],
  ["teal + ivory + navy", "#ffffff", [["#0f6f6c", 0.5], ["#f2efe6", 0.3], ["#123b4a", 0.2]]],
  ["maroon + black + gold", "#e9eaec", [["#5c1a24", 0.45], ["#141013", 0.35], ["#c8a15a", 0.2]]],
];
for (const [label, bg, garment] of CASES) {
  const img = synthetic({ bg, garment });
  const got = dominantColours(img, { k: garment.length, excludeSkin: false });

  if (got.length !== garment.length) {
    fail(`${label}: expected ${garment.length} colours, got ${got.length}`);
    continue;
  }
  // Match each true colour to its nearest recovered centroid.
  let worst = 0;
  for (const [hex] of garment) {
    const truth = hexToLab(hex);
    const best = Math.min(...got.map((g) => deltaE2000(truth, g.lab)));
    worst = Math.max(worst, best);
  }
  // Guarding that no centroid sits near the background only makes sense when
  // the garment itself has no pale colour. An ivory print is legitimately 5.4
  // dE from white, so asserting distance-from-background there fails the very
  // case the flood fill was added to handle. Recovering every true colour
  // within the count already proves the background did not displace one.
  const bgLab = hexToLab(bg);
  const palest = Math.min(...garment.map(([hex]) => deltaE2000(bgLab, hexToLab(hex))));
  const bgDe = Math.min(...got.map((g) => deltaE2000(bgLab, g.lab)));

  let ok = worst < 6;
  let note = `worst dE ${worst.toFixed(1)}`;
  if (palest > 12) {
    ok = ok && bgDe > 12;
    note += `, nearest-to-background dE ${bgDe.toFixed(1)}`;
  } else {
    note += `, palest garment colour is only ${palest.toFixed(1)} dE from the ground`;
  }
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(24)} ${note}`);
  if (!ok) failures++;
}

console.log("\nSKIN EXCLUSION (a model wearing the garment)");
for (const skin of ["#e8c4a0", "#b07a52", "#4a3324"]) {
  const img = synthetic({ bg: "#f4f3f0", garment: [["#0f6f6c", 1.0]], skin });
  const withSkin = dominantColours(img, { k: 2, excludeSkin: false });
  const without = dominantColours(img, { k: 2, excludeSkin: true });

  const skinLab = hexToLab(skin);
  const nearWith = Math.min(...withSkin.map((c) => deltaE2000(skinLab, c.lab)));
  const nearWithout = Math.min(...without.map((c) => deltaE2000(skinLab, c.lab)));
  const ok = nearWithout > nearWith;
  console.log(`  ${ok ? "OK  " : "FAIL"} skin ${skin}: dE to nearest centroid ` +
              `${nearWith.toFixed(1)} -> ${nearWithout.toFixed(1)} when excluded`);
  if (!ok) failures++;
}

console.log("\nDETERMINISM (same input must give the same verdict)");
const img = synthetic({ bg: "#f4f3f0", garment: [["#b5651d", 0.5], ["#d4a017", 0.5]] });
const a = dominantColours(img, { k: 2 });
const b = dominantColours(img, { k: 2 });
const same = a.every((c, i) => deltaE2000(c.lab, b[i].lab) < 1e-9 && Math.abs(c.p - b[i].p) < 1e-12);
console.log(`  ${same ? "OK  " : "FAIL"} two runs identical`);
if (!same) failures++;

console.log("\nPROPORTIONS");
const shares = dominantColours(
  synthetic({ bg: "#f4f3f0", garment: [["#b5651d", 0.7], ["#123b4a", 0.3]] }), { k: 2 });
const sum = shares.reduce((s, c) => s + c.p, 0);
const dominantShare = shares[0].p;
console.log(`  ${Math.abs(sum - 1) < 1e-9 ? "OK  " : "FAIL"} proportions sum to ${sum.toFixed(6)}`);
console.log(`  ${Math.abs(dominantShare - 0.7) < 0.08 ? "OK  " : "FAIL"} dominant share ` +
            `${(dominantShare * 100).toFixed(0)}% (drew 70%)`);
if (Math.abs(sum - 1) > 1e-9) failures++;
if (Math.abs(dominantShare - 0.7) > 0.08) failures++;

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
