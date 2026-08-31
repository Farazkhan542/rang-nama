// Re-verify the extension's photo path against synthetic portraits.
//
// Same test that caught the original L* floor bug, where a gate of 16 silently
// rejected the two deepest skin tones - reintroducing exactly the bias the
// hue-based approach exists to avoid.

import { deltaE2000, hexToLab } from "../extension/src/engine/colour.js";
import { detectColouring } from "../extension/src/lib/colouring.js";

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function portrait(skinHex, hairHex, bgHex, w = 300, h = 380) {
  const data = new Uint8ClampedArray(w * h * 4);
  const [br, bg, bb] = hexRgb(bgHex);
  const [sr, sg, sb] = hexRgb(skinHex);
  const [hr, hg, hb] = hexRgb(hairHex);
  const cx = w / 2, cy = h * 0.55, rx = w * 0.24, ry = h * 0.26;

  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const jit = (v) => Math.max(0, Math.min(255, v + (rand() - 0.5) * 8));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inFace = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const inHair = !inFace &&
        ((x - cx) / (rx * 1.32)) ** 2 + ((y - (cy - ry * 0.3)) / (ry * 1.3)) ** 2 <= 1;
      const c = inFace ? [sr, sg, sb] : inHair ? [hr, hg, hb] : [br, bg, bb];
      data[i] = jit(c[0]); data[i + 1] = jit(c[1]); data[i + 2] = jit(c[2]); data[i + 3] = 255;
    }
  }
  return { data, w, h };
}

let failures = 0;
console.log("SKIN + HAIR RECOVERY");
const CASES = [
  ["fair pink / brown", "#f2d7cf", "#4a3728"],
  ["fair peach / black", "#e8c4a0", "#141010"],
  ["medium warm / black", "#b07a52", "#0d0b0a"],
  ["medium olive / dk brn", "#9a7b52", "#2b1f16"],
  ["deep warm / black", "#6b4a35", "#0d0b0a"],
  ["very deep / black", "#4a3324", "#0a0908"],
  ["deepest / black", "#33231a", "#090807"],
];
for (const [label, skinHex, hairHex] of CASES) {
  const p = portrait(skinHex, hairHex, "#e9eaec");
  const r = detectColouring(p.data, p.w, p.h);
  if (!r.ok) { console.log(`  FAIL ${label}: ${r.error}`); failures++; continue; }
  const dSkin = deltaE2000(hexToLab(skinHex), hexToLab(r.skinHex));
  const dHair = deltaE2000(hexToLab(hairHex), hexToLab(r.hairHex));
  const ok = dSkin < 4;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(22)} skin dE ${dSkin.toFixed(2)}, ` +
              `hair dE ${dHair.toFixed(2)}${r.hairFound ? "" : " (hair not found)"}`);
}

console.log("\nCOVERED HAIR (dupatta or hijab - must decline, not sample the scarf)");
for (const [label, skinHex, scarfHex] of [
  ["teal dupatta", "#b07a52", "#0f8f8a"],
  ["red dupatta", "#9a7b52", "#c0342a"],
  ["cream dupatta", "#6b4a35", "#f0e6d2"],
]) {
  const p = portrait(skinHex, scarfHex, "#e9eaec");
  const r = detectColouring(p.data, p.w, p.h);
  const declined = r.ok && !r.hairFound;
  if (!declined) failures++;
  console.log(`  ${declined ? "OK  " : "FAIL"} ${label.padEnd(16)} hairFound=${r.ok && r.hairFound}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
