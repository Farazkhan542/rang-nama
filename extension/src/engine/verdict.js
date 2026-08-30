// Ported from src/fabric_advisor/core/verdict.py. Kept dependency-free so it runs
// unchanged in a content script: no bundler runtime, no polyfills, no imports
// beyond this package. Verified against the Python by running the same
// reference vectors — see tests/test_colour.py and scripts/verify_port.mjs.

import { nearestSwatch } from './palette.js';

const DE_EXCELLENT = 12, DE_GOOD = 22, DE_NEUTRAL = 38, DE_TAU = 26;
const SPREAD_LOW = 18, SPREAD_HIGH = 42;
const WEIGHTS = { colour: 0.55, contrast: 0.25, print_scale: 0.20 };

const bandFromDistance = d =>
  d <= DE_EXCELLENT ? "excellent" : d <= DE_GOOD ? "good" : d <= DE_NEUTRAL ? "neutral" : "poor";

const scoreFromDistance = d => 100 * Math.exp(-Math.max(0, d) / DE_TAU);

function buildFrame(heightCm) {
  if (heightCm < 155) return "petite";
  if (heightCm > 168) return "tall";
  return "average";
}

function valueSpread(colours) {
  if (colours.length < 2) return 0;
  const Ls = colours.map(c => c.lab.L);
  return Math.max(...Ls) - Math.min(...Ls);
}

function scoreColour(fabric, season) {
  const total = fabric.colours.reduce((s, c) => s + c.p, 0) || 1;
  let weighted = 0;
  for (const c of fabric.colours) weighted += nearestSwatch(c.lab, season).distance * (c.p / total);

  const dominant = fabric.colours.reduce((a, b) => (b.p > a.p ? b : a));
  const dom = nearestSwatch(dominant.lab, season);
  const band = bandFromDistance(weighted);

  const phrasing = {
    excellent: "sits right inside",
    good: "sits close to",
    neutral: "sits at the edge of",
    poor: "falls well outside"
  }[band];

  return {
    key: "colour",
    value: scoreFromDistance(weighted),
    band,
    text: `Across the whole print this ${phrasing} your ${season.name} palette ` +
          `(weighted ΔE ${weighted.toFixed(0)}); the dominant colour's nearest match is ` +
          `${dom.hex} at ΔE ${dom.distance.toFixed(0)}.`
  };
}

function scoreContrast(fabric, userContrast) {
  const spread = valueSpread(fabric.colours);
  const level = spread >= SPREAD_HIGH ? "high" : spread <= SPREAD_LOW ? "low" : "medium";
  const order = { low: 0, medium: 1, high: 2 };
  const gap = Math.abs(order[level] - order[userContrast]);

  const [value, band] = gap === 0 ? [100, "excellent"] : gap === 1 ? [68, "good"] : [34, "poor"];

  let text;
  if (gap === 0) text = `The print's ${level} contrast matches your own ${userContrast} colouring.`;
  else if (level === "high" && userContrast === "low")
    text = "This print is much higher contrast than your colouring — it will tend to wear you rather than the other way round.";
  else if (level === "low" && userContrast === "high")
    text = "This print is flatter than your natural contrast, so it may read as washed out next to your colouring.";
  else text = `The print's ${level} contrast is close enough to your ${userContrast} colouring to work.`;

  return { key: "contrast", value, band, text };
}

function scorePrintScale(fabric, frame) {
  if (fabric.motifCm == null) {
    return { key: "print scale", value: 50, band: "neutral",
             text: "This is a plain weave, so there is no motif to scale against your frame." };
  }
  const windows = { petite: [0.8, 7.0], average: [1.2, 11.0], tall: [1.8, 16.0] };
  const [low, high] = windows[frame];
  const s = fabric.motifCm;

  if (s >= low && s <= high) {
    return { key: "print scale", value: 100, band: "excellent",
             text: `A ${s.toFixed(1)} cm motif sits well on a ${frame} frame.` };
  }
  if (s < low) {
    const ratio = s / low;
    return { key: "print scale", value: Math.max(30, 100 * ratio),
             band: ratio > 0.7 ? "good" : "neutral",
             text: `At ${s.toFixed(1)} cm the motif is small for a ${frame} frame and may read as texture rather than pattern from a distance.` };
  }
  const ratio = high / s;
  return { key: "print scale", value: Math.max(25, 100 * ratio),
           band: ratio > 0.75 ? "good" : "poor",
           text: `At ${s.toFixed(1)} cm the motif is large for a ${frame} frame and will dominate the outfit.` };
}

function buildVerdict(fabric, season, userContrast, frame) {
  const scores = [
    scoreColour(fabric, season),
    scoreContrast(fabric, userContrast),
    scorePrintScale(fabric, frame)
  ];
  const keyOf = s => (s.key === "print scale" ? "print_scale" : s.key);
  const total = scores.reduce((acc, s) => acc + s.value * WEIGHTS[keyOf(s)], 0);
  const wsum = scores.reduce((acc, s) => acc + WEIGHTS[keyOf(s)], 0);
  const combined = total / wsum;

  const headline = combined >= 78 ? "excellent" : combined >= 58 ? "good" : combined >= 40 ? "neutral" : "poor";
  return { headline, score: combined, scores };
}

export {
  buildVerdict,
  scoreColour,
  scoreContrast,
  scorePrintScale,
  buildFrame,
  valueSpread,
  bandFromDistance,
  scoreFromDistance,
};
