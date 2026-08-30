// Ported from src/fabric_advisor/core/palette.py. Kept dependency-free so it runs
// unchanged in a content script: no bundler runtime, no polyfills, no imports
// beyond this package. Verified against the Python by running the same
// reference vectors — see tests/test_colour.py and scripts/verify_port.mjs.

import { deltaE2000, hexToLab, chromaOf, hueOf } from './colour.js';

const SEASONS = {
  bright_spring: { name: "Bright Spring", desc: "Clear, warm and high-chroma. Colour reads as lit from within.",
    sw: ["#ff6f3c","#ffb100","#f7e733","#3fd06a","#00b8a9","#22a7f0","#ff4f81","#ff8c42","#c9e265","#00d1c1"] },
  true_spring: { name: "True Spring", desc: "Warm and fresh, golden rather than fiery.",
    sw: ["#f4a259","#f6bd60","#e9c46a","#8ab17d","#43aa8b","#4cc9c0","#ef8354","#f79d65","#bfd7b3","#7fc8a9"] },
  light_spring: { name: "Light Spring", desc: "Warm but delicate. Tints rather than saturated hues.",
    sw: ["#ffd6a5","#fdffb6","#caffbf","#9bf6ff","#ffc6ff","#ffadad","#f7d6b4","#d0f4de","#a9def9","#fcf6bd"] },
  light_summer: { name: "Light Summer", desc: "Cool and soft, powdery. Blue-based pastels.",
    sw: ["#a8d8ea","#aa96da","#c5fad5","#ffcbcb","#b8b5ff","#d3e0ea","#c7ceea","#e2d5f0","#a2d5f2","#f6dfeb"] },
  true_summer: { name: "True Summer", desc: "Cool and muted, dusty. Blue and rose dominate.",
    sw: ["#6d8fa8","#8e9aaf","#a8869b","#5c7a89","#9a8c98","#7b8fa1","#b0a1ba","#4f6d7a","#c08497","#88a0a8"] },
  soft_summer: { name: "Soft Summer", desc: "Greyed and cool-leaning. Nothing shouts.",
    sw: ["#8d99ae","#a3a3a3","#7d8491","#9c89b8","#6b705c","#a5a58d","#b7b7a4","#7f7f7f","#8e8d8a","#95a5a6"] },
  soft_autumn: { name: "Soft Autumn", desc: "Muted and warm-leaning. Earth tones with the volume down.",
    sw: ["#a68a64","#936639","#7f7f5a","#a4ac86","#b6ad90","#c2c5aa","#997b66","#8a817c","#bfa58a","#8f8073"] },
  true_autumn: { name: "True Autumn", desc: "Warm, rich and earthy. Spice-box colouring.",
    sw: ["#bc6c25","#dda15e","#606c38","#283618","#a53860","#9c6644","#7f4f24","#b08968","#656d4a","#c1121f"] },
  deep_autumn: { name: "Deep Autumn", desc: "Warm and dark. Depth carries the palette, not brightness.",
    sw: ["#5f0f40","#9a031e","#bb3e03","#ae2012","#6a4c93","#3a5a40","#344e41","#7f5539","#582f0e","#8c2f39"] },
  deep_winter: { name: "Deep Winter", desc: "Cool and dark, jewel-toned. Clear rather than dusty.",
    sw: ["#03045e","#023e8a","#3c096c","#5a189a","#006466","#004b23","#6a040f","#370617","#1b263b","#2b2d42"] },
  true_winter: { name: "True Winter", desc: "Cool, saturated and high-contrast. Icy or vivid, never muted.",
    sw: ["#0077b6","#d00000","#7209b7","#0b0b12","#f4f4f8","#0466c8","#c1121f","#5f0f40","#006d77","#14213d"] },
  bright_winter: { name: "Bright Winter", desc: "Cool and electric. Maximum clarity and contrast.",
    sw: ["#0aefff","#ff006e","#8338ec","#3a86ff","#fb5607","#00f5d4","#f20089","#241023","#eef0ff","#04052e"] }
};

const ITA_LIGHT_MIN = 41, ITA_DEEP_MAX = 10;
const HUE_COOL_MAX = 48, HUE_WARM_MIN = 57;
const OLIVE_HUE_MIN = 68, OLIVE_CHROMA_MAX = 28;
const CONTRAST_HIGH_MIN = 38, CONTRAST_LOW_MAX = 18;

function ita(skin) {
  if (skin.b === 0) return skin.L > 50 ? 90 : -90;
  return Math.atan2(skin.L - 50, skin.b) * 180 / Math.PI;
}

function classifyDepth(skin) {
  const v = ita(skin);
  if (v >= ITA_LIGHT_MIN) return "light";
  if (v <= ITA_DEEP_MAX) return "deep";
  return "medium";
}

function classifyUndertone(skin) {
  if (skin.a <= 0) return "neutral";
  const h = hueOf(skin), c = chromaOf(skin);
  if (h >= OLIVE_HUE_MIN && c <= OLIVE_CHROMA_MAX) return "olive";
  if (h >= HUE_WARM_MIN) return "warm";
  if (h <= HUE_COOL_MAX) return "cool";
  return "neutral";
}

function classifyContrast(skin, hair) {
  const spread = Math.abs(skin.L - hair.L);
  if (spread >= CONTRAST_HIGH_MIN) return "high";
  if (spread <= CONTRAST_LOW_MAX) return "low";
  return "medium";
}

function selectSeason(undertone, depth, contrast) {
  const S = SEASONS;
  if (undertone === "olive") {
    if (depth === "deep") return S.deep_autumn;
    if (depth === "light") return S.soft_autumn;
    return contrast === "high" ? S.true_autumn : S.soft_autumn;
  }
  if (undertone === "warm") {
    if (depth === "deep") return S.deep_autumn;
    if (depth === "light") return contrast === "high" ? S.bright_spring : S.light_spring;
    return contrast === "low" ? S.soft_autumn : S.true_autumn;
  }
  if (undertone === "cool") {
    if (depth === "deep") return contrast === "high" ? S.true_winter : S.deep_winter;
    if (depth === "light") return S.light_summer;
    return contrast === "high" ? S.bright_winter : S.true_summer;
  }
  if (depth === "deep") return contrast === "high" ? S.deep_winter : S.deep_autumn;
  if (depth === "light") return contrast === "low" ? S.light_summer : S.light_spring;
  return contrast === "high" ? S.bright_winter : S.soft_summer;
}

function nearestSwatch(garment, season) {
  let best = Infinity, bestHex = season.sw[0];
  for (const hex of season.sw) {
    const d = deltaE2000(garment, hexToLab(hex));
    if (d < best) { best = d; bestHex = hex; }
  }
  return { distance: best, hex: bestHex };
}

export {
  SEASONS,
  ita,
  classifyDepth,
  classifyUndertone,
  classifyContrast,
  selectSeason,
  nearestSwatch,
};
