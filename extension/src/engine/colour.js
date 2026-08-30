// Ported from src/fabric_advisor/core/colour.py. Kept dependency-free so it runs
// unchanged in a content script: no bundler runtime, no polyfills, no imports
// beyond this package. Verified against the Python by running the same
// reference vectors — see tests/test_colour.py and scripts/verify_port.mjs.

const D65 = [0.95047, 1.00000, 1.08883];
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

function hexToRgb(hex) {
  let t = hex.trim().replace(/^#/, "");
  if (t.length === 3) t = t.split("").map(c => c + c).join("");
  return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab([r8, g8, b8]) {
  const r = srgbToLinear(r8 / 255), g = srgbToLinear(g8 / 255), b = srgbToLinear(b8 / 255);
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const f = t => t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
  const fx = f(x / D65[0]), fy = f(y / D65[1]), fz = f(z / D65[2]);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const hexToLab = h => rgbToLab(hexToRgb(h));
const chromaOf = c => Math.hypot(c.a, c.b);
const hueOf = c => ((Math.atan2(c.b, c.a) * 180 / Math.PI) % 360 + 360) % 360;

function deltaE2000(c1, c2) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(c1.a, c1.b), C2 = Math.hypot(c2.a, c2.b);
  const meanC = (C1 + C2) / 2;
  const meanC7 = Math.pow(meanC, 7);
  const G = meanC > 0 ? 0.5 * (1 - Math.sqrt(meanC7 / (meanC7 + Math.pow(25, 7)))) : 0;

  const a1p = (1 + G) * c1.a, a2p = (1 + G) * c2.a;
  const C1p = Math.hypot(a1p, c1.b), C2p = Math.hypot(a2p, c2.b);

  const h1p = C1p === 0 ? 0 : ((Math.atan2(c1.b, a1p) * 180 / Math.PI) % 360 + 360) % 360;
  const h2p = C2p === 0 ? 0 : ((Math.atan2(c2.b, a2p) * 180 / Math.PI) % 360 + 360) % 360;

  const dL = c2.L - c1.L;
  const dC = C2p - C1p;

  let dhDeg;
  if (C1p * C2p === 0) dhDeg = 0;
  else {
    let diff = h2p - h1p;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    dhDeg = diff;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhDeg * rad) / 2);

  const meanL = (c1.L + c2.L) / 2;
  const meanCp = (C1p + C2p) / 2;

  let meanHp;
  if (C1p * C2p === 0) meanHp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) meanHp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) meanHp = (h1p + h2p + 360) / 2;
  else meanHp = (h1p + h2p - 360) / 2;

  const T = 1
    - 0.17 * Math.cos((meanHp - 30) * rad)
    + 0.24 * Math.cos((2 * meanHp) * rad)
    + 0.32 * Math.cos((3 * meanHp + 6) * rad)
    - 0.20 * Math.cos((4 * meanHp - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((meanHp - 275) / 25, 2));
  const meanCp7 = Math.pow(meanCp, 7);
  const Rc = meanCp > 0 ? 2 * Math.sqrt(meanCp7 / (meanCp7 + Math.pow(25, 7))) : 0;

  const Sl = 1 + (0.015 * Math.pow(meanL - 50, 2)) / Math.sqrt(20 + Math.pow(meanL - 50, 2));
  const Sc = 1 + 0.045 * meanCp;
  const Sh = 1 + 0.015 * meanCp * T;
  const Rt = -Math.sin((2 * dTheta) * rad) * Rc;

  const tL = dL / Sl, tC = dC / Sc, tH = dH / Sh;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + Rt * tC * tH);
}

export {
  hexToRgb,
  rgbToLab,
  hexToLab,
  deltaE2000,
  chromaOf,
  hueOf,
  srgbToLinear,
  D65,
  EPSILON,
  KAPPA,
};
