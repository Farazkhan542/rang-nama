// Confirm the extension's engine modules still agree with the Python core.
//
// The modules are extracted from the demo rather than retyped, so this guards
// the extraction, the import wiring, and any later hand-edit. Run it before
// shipping the extension: a colour engine that silently disagrees with its
// tests is worse than one that obviously fails.

import { deltaE2000, rgbToLab, hexToLab, hueOf, chromaOf } from "../extension/src/engine/colour.js";
import { classifyContrast, classifyDepth, classifyUndertone, ita, selectSeason }
  from "../extension/src/engine/palette.js";
import { buildFrame, buildVerdict } from "../extension/src/engine/verdict.js";

const lab = (L, a, b) => ({ L, a, b });
let failures = 0;

// Sharma et al. (2005) reference pairs — the same set tests/test_colour.py uses.
const SHARMA = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
  [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];
let worst = 0;
for (const [a, b, expected] of SHARMA) {
  worst = Math.max(worst, Math.abs(deltaE2000(lab(...a), lab(...b)) - expected));
}
console.log(`CIEDE2000: ${SHARMA.length} pairs, worst error ${worst.toExponential(2)}`);
if (worst > 1e-4) { console.log("  FAIL"); failures++; }

// Conversion anchors.
const anchors = [
  ["white", rgbToLab([255, 255, 255]).L, 100.0],
  ["grey", rgbToLab([128, 128, 128]).L, 53.585],
  ["red L", rgbToLab([255, 0, 0]).L, 53.2408],
  ["red a", rgbToLab([255, 0, 0]).a, 80.0925],
];
for (const [name, got, want] of anchors) {
  if (Math.abs(got - want) > 0.01) { console.log(`  FAIL ${name}: ${got} != ${want}`); failures++; }
}
console.log(`conversions: ${anchors.length} anchors checked`);

// Classification chain — these exact outputs are in the Python smoke test.
const CHAIN = [
  ["fair pink", "#f2d7cf", "#5a4636", "Light Summer"],
  ["fair peach", "#e8c4a0", "#4a3728", "Soft Autumn"],
  ["medium warm", "#b07a52", "#1a1110", "True Autumn"],
  ["medium olive", "#9a7b52", "#161110", "Deep Autumn"],
  ["tan neutral", "#a4785f", "#1a1412", "Bright Winter"],
  ["deep warm", "#6b4a35", "#0f0d0c", "Deep Autumn"],
];
const seasons = new Set();
for (const [label, skinHex, hairHex, expected] of CHAIN) {
  const skin = hexToLab(skinHex), hair = hexToLab(hairHex);
  const s = selectSeason(classifyUndertone(skin), classifyDepth(skin), classifyContrast(skin, hair));
  seasons.add(s.name);
  if (s.name !== expected) {
    console.log(`  FAIL ${label}: got ${s.name}, Python said ${expected}`);
    failures++;
  }
}
console.log(`classification: ${CHAIN.length} profiles, ${seasons.size} distinct seasons`);

// Frame bands.
for (const [cm, want] of [[150, "petite"], [160, "average"], [175, "tall"]]) {
  if (buildFrame(cm) !== want) { console.log(`  FAIL frame ${cm}`); failures++; }
}

// End-to-end verdict, and the directional check that matters: a warm rust
// should suit deep-warm colouring better than an icy lilac, and vice versa.
const fabric = (hexes, motif) => ({
  colours: hexes.map(([h, p]) => ({ lab: hexToLab(h), p })), motifCm: motif,
});
const rust = fabric([["#b5651d", .45], ["#d4a017", .30], ["#f5e6c8", .25]], 9);
const lilac = fabric([["#cbb8dd", .7], ["#b9a6cc", .3]], null);

const profile = (skinHex, hairHex) => {
  const skin = hexToLab(skinHex), hair = hexToLab(hairHex);
  return {
    season: selectSeason(classifyUndertone(skin), classifyDepth(skin), classifyContrast(skin, hair)),
    contrast: classifyContrast(skin, hair),
  };
};
const warm = profile("#6b4a35", "#0f0d0c");
const fair = profile("#f2d7cf", "#5a4636");

const rw = buildVerdict(rust, warm.season, warm.contrast, "average").score;
const rf = buildVerdict(rust, fair.season, fair.contrast, "average").score;
const lw = buildVerdict(lilac, warm.season, warm.contrast, "average").score;
const lf = buildVerdict(lilac, fair.season, fair.contrast, "average").score;

console.log(`verdict: rust warm=${rw.toFixed(0)} fair=${rf.toFixed(0)} | lilac warm=${lw.toFixed(0)} fair=${lf.toFixed(0)}`);
if (!(rw > rf)) { console.log("  FAIL rust should score higher on deep-warm"); failures++; }
if (!(lf > lw)) { console.log("  FAIL lilac should score higher on fair-cool"); failures++; }

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
