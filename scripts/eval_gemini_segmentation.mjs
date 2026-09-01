// Does asking Gemini where the garment is beat measuring the whole frame?
//
// Needs a key and real photographs, so it is run by hand rather than in CI:
//
//   node scripts/fetch_khaadi_images.mjs          (once, to get fixtures)
//   GEMINI_KEY=... node scripts/eval_gemini_segmentation.mjs
//
// Measured on five Khaadi photographs of one mint garment, distance from the
// true colour:
//
//   image           local only   with box
//   _1 full body        26.1        6.1
//   _2 torso crop       17.5        8.1
//   _3                   4.4        4.3
//   _4                   3.9        4.4
//   _5                   5.2        6.5
//
// The model rescues the frames where the local mask fails and is neutral to
// marginally worse where it already worked. What matters is the worst case:
// 26.1 to 8.1, so the reading stops depending on which photograph gets picked.

import { readFileSync, readdirSync } from "node:fs";
import jpeg from "jpeg-js";
import { deltaE2000 } from "../extension/src/engine/colour.js";
import { dominantColours, scoreForFabric } from "../extension/src/lib/extract.js";
import { intersectMask } from "../extension/src/lib/gemini.js";

const KEY = process.env.GEMINI_KEY;
if (!KEY) {
  console.error("Set GEMINI_KEY to run this. It calls the live API.");
  process.exit(1);
}
const DIR = "C:/Users/subha/AppData/Local/Temp/claude/c--Users-subha-OneDrive-Desktop-clothing/2ae36d6a-b3cc-4e2f-a2b4-b215a8465e66/scratchpad/khaadi";

const PROMPT = `This is a fashion product photograph from a Pakistani clothing retailer.

Return the bounding box of the MAIN GARMENT FABRIC only - the kurta or shirt
being sold.

Exclude, strictly:
- the model's face, neck, hands and any visible skin
- her hair
- the dupatta or scarf, if it is a separate draped piece
- the trousers
- the studio background
- any jewellery or footwear

Choose the largest region that is unambiguously the main garment's cloth, so
that its colours can be measured. Prefer the torso where the fabric is flat
and well lit.

Respond with JSON only:
{"box_2d": [ymin, xmin, ymax, xmax], "confidence": 0.0-1.0, "note": "short reason"}

Coordinates normalised 0-1000, origin top-left.`;

const labToHex = ({ L, a, b }) => {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const [X, Y, Z] = [inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883];
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  const enc = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return "#" + lin.map(enc).map((v) => v.toString(16).padStart(2, "0")).join("");
};

// The garment in these photographs is mint/aqua. Distance to it is the score
// that matters: a reading dominated by the beige backdrop lands far away.
const TRUTH = { L: 79.5, a: -9.5, b: -2.5 };  // approx #bfd0d1

const files = readdirSync(DIR).filter((f) => f.endsWith(".jpg")).sort();
console.log("file        local dominant      dE→mint   gemini box              dominant in box   dE→mint");
console.log("-".repeat(104));

for (const f of files) {
  const raw = jpeg.decode(readFileSync(`${DIR}/${f}`), { useTArray: true });
  const img = { data: raw.data, width: raw.width, height: raw.height };

  const scored = scoreForFabric(img);
  const localCols = dominantColours(img, { k: 3, mask: scored.mask });
  const localHex = labToHex(localCols[0].lab);
  const localDe = deltaE2000(TRUTH, localCols[0].lab);

  let boxStr = "-", boxHex = "-", boxDe = NaN;
  try {
    const b64 = readFileSync(`${DIR}/${f}`).toString("base64");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: "image/jpeg", data: b64 } },
            { text: PROMPT },
          ] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      }
    );
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text);
    const [ymin, xmin, ymax, xmax] = parsed.box_2d.map(Number);
    boxStr = `[${ymin},${xmin},${ymax},${xmax}]`;

    const rect = { x0: xmin / 1000, y0: ymin / 1000, x1: xmax / 1000, y1: ymax / 1000 };
    const narrowed = intersectMask(scored.mask, img, rect);
    const boxCols = dominantColours(img, { k: 3, mask: narrowed });
    boxHex = labToHex(boxCols[0].lab);
    boxDe = deltaE2000(TRUTH, boxCols[0].lab);
  } catch (e) {
    boxStr = "ERR " + e.message.slice(0, 30);
  }

  console.log(
    f.replace("a22-26-201fc1_", "").padEnd(12) +
    localHex.padEnd(20) + localDe.toFixed(1).padStart(6) + "   " +
    boxStr.padEnd(24) + boxHex.padEnd(18) +
    (Number.isNaN(boxDe) ? "  -" : boxDe.toFixed(1).padStart(6))
  );
}
