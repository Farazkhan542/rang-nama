// Face detection across people, not one idealised portrait.
//
// The extension is meant to work for a whole family, so the scenes below are
// the ones that actually occur: spectacles cutting a bar across the face, a
// beard covering the lower half, a headscarf, a cream wall behind, a hand in
// frame. Each of these broke an earlier version.

import { deltaE2000, hexToLab } from "../extension/src/engine/colour.js";
import { detectColouring } from "../extension/src/lib/colouring.js";

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function portrait({ skin, hair, wall, glasses = false, beard = false,
                    scarf = null, extras = [] }) {
  const w = 380, h = 500;
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 9;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const jit = (v) => Math.max(0, Math.min(255, v + (rand() - 0.5) * 10));

  const C = { wall: hexRgb(wall), skin: hexRgb(skin), hair: hexRgb(hair) };
  const cx = w * 0.5, cy = h * 0.40, rx = w * 0.20, ry = h * 0.21;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = C.wall;
      for (const e of extras) {
        if (x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h) c = hexRgb(e.hex);
      }
      const inHair = ((x - cx) / (rx * 1.28)) ** 2 +
                     ((y - (cy - ry * 0.34)) / (ry * 1.28)) ** 2 <= 1;
      const inFace = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

      if (inHair && !inFace) c = C.hair;
      if (scarf && inHair && !inFace) c = hexRgb(scarf);
      if (inFace) {
        c = C.skin;
        // Spectacles: a dark bar across the eye line, splitting the face.
        if (glasses && y > cy - ry * 0.22 && y < cy - ry * 0.02) c = hexRgb("#241f22");
        // Beard: the lower third.
        if (beard && y > cy + ry * 0.20) c = C.hair;
      }
      data[i] = jit(c[0]); data[i + 1] = jit(c[1]); data[i + 2] = jit(c[2]); data[i + 3] = 255;
    }
  }
  return { data, w, h };
}

const CASES = [
  ["clear face, grey wall",     { skin: "#b07a52", hair: "#0d0b0a", wall: "#e8e8ea" }],
  ["glasses",                   { skin: "#b07a52", hair: "#0d0b0a", wall: "#e8e8ea", glasses: true }],
  ["beard",                     { skin: "#b07a52", hair: "#0d0b0a", wall: "#e8e8ea", beard: true }],
  ["glasses + beard",           { skin: "#b07a52", hair: "#0d0b0a", wall: "#e8e8ea", glasses: true, beard: true }],
  ["glasses + beard, cream wall",{ skin: "#a4785f", hair: "#141010", wall: "#efe9e0", glasses: true, beard: true }],
  ["deep skin, glasses",        { skin: "#6b4a35", hair: "#0a0908", wall: "#eceef0", glasses: true }],
  ["fair skin, beard",          { skin: "#e8c4a0", hair: "#3d2b1f", wall: "#dfe3e6", beard: true }],
  ["headscarf",                 { skin: "#b07a52", hair: "#0d0b0a", wall: "#e8e8ea", scarf: "#0f8f8a" }],
  ["hand in frame",             { skin: "#9a7b52", hair: "#161110", wall: "#eceef0",
                                  extras: [{ x: 290, y: 380, w: 80, h: 110, hex: "#9a7b52" }] }],
  ["wooden door behind",        { skin: "#b07a52", hair: "#0d0b0a", wall: "#eceef0",
                                  extras: [{ x: 0, y: 0, w: 110, h: 500, hex: "#9c6b42" }] }],
];

let correct = 0, declined = 0, wrong = 0;
console.log("scene                          skin dE   outcome");
console.log("-".repeat(66));

for (const [label, opts] of CASES) {
  const img = portrait(opts);
  const r = detectColouring(img.data, img.w, img.h);

  if (!r.ok) {
    declined++;
    console.log(`  SAY  ${label.padEnd(28)}     -    declined`);
    continue;
  }
  const de = deltaE2000(hexToLab(opts.skin), hexToLab(r.skinHex));
  if (de < 8) {
    correct++;
    console.log(`  OK   ${label.padEnd(28)}${de.toFixed(2).padStart(6)}   ` +
                `hair ${r.hairFound ? "found" : "not visible"}`);
  } else {
    wrong++;
    console.log(`  BAD  ${label.padEnd(28)}${de.toFixed(2).padStart(6)}   reported ${r.skinHex}`);
  }
}

console.log();
console.log(`${correct} correct, ${declined} declined, ${wrong} silently wrong`);
// Declining is acceptable; being confidently wrong is not.
process.exit(wrong === 0 ? 0 : 1);
