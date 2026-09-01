// Ask Gemini where the garment is. Nothing more.
//
// The division of labour matters and is deliberate:
//
//   the model  -> WHERE the garment is        (perception, genuinely hard)
//   this code  -> WHAT COLOUR it is           (measurement, exactly solvable)
//
// A vision model asked for a hex code returns a plausible guess, not a
// measurement, and every CIEDE2000 number downstream would inherit that guess.
// Pixels inside a region are measured. So the model returns a box, and the
// arithmetic runs inside it.
//
// This is the only network request the extension ever makes, it happens only
// when a key has been entered, and it goes to Google's endpoint and nowhere
// else.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Tried in order. Free-tier model availability moves around, so a single
// hard-coded name turns into a 404 that reads like a bug in this code.
const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

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

/** Canvas ImageData -> base64 JPEG, for the inline_data part. */
function toBase64Jpeg(imageData, quality = 0.85) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/jpeg", quality).split(",")[1];
}

/**
 * Locate the garment. Returns null when unavailable, so every caller keeps
 * working without a key - the local heuristics remain the default path, and
 * this only ever narrows the region they measure.
 */
export async function locateGarment(imageData, apiKey, { signal } = {}) {
  if (!apiKey) return null;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: "image/jpeg", data: toBase64Jpeg(imageData) } },
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  };

  let lastError = null;
  for (const model of MODELS) {
    try {
      const res = await fetch(
        `${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }
      );

      if (res.status === 404) { lastError = `${model}: not available`; continue; }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // Surface the reason. A 400 here is usually a malformed key and a 429
        // is the free-tier quota; both are actionable, and neither should be
        // reported as "segmentation failed".
        lastError = `${model}: HTTP ${res.status} ${detail.slice(0, 160)}`;
        if (res.status === 400 || res.status === 403) break;
        continue;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastError = `${model}: empty response`; continue; }

      const parsed = JSON.parse(text);
      const box = parsed.box_2d;
      if (!Array.isArray(box) || box.length !== 4) {
        lastError = `${model}: no box in response`;
        continue;
      }

      const [ymin, xmin, ymax, xmax] = box.map(Number);
      // Reject a degenerate or inverted box rather than measuring three pixels.
      if (!(xmax > xmin && ymax > ymin) || (xmax - xmin) * (ymax - ymin) < 2500) {
        lastError = `${model}: box too small (${box.join(",")})`;
        continue;
      }

      return {
        model,
        confidence: Number(parsed.confidence ?? 0),
        note: String(parsed.note ?? ""),
        // Normalised 0-1000, origin top-left, clamped into frame.
        rect: {
          x0: Math.max(0, Math.min(1000, xmin)) / 1000,
          y0: Math.max(0, Math.min(1000, ymin)) / 1000,
          x1: Math.max(0, Math.min(1000, xmax)) / 1000,
          y1: Math.max(0, Math.min(1000, ymax)) / 1000,
        },
      };
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = `${model}: ${err.message}`;
    }
  }

  console.warn("[rangnama] garment location unavailable:", lastError);
  return null;
}

/** Restrict an existing mask to the model's box.
 *
 *  Intersected rather than replaced: the local background fill is good at
 *  edges and gradients, and the box is good at knowing which subject is the
 *  garment. Keeping both means a bad box narrows the reading rather than
 *  replacing a working mask with a rectangle that includes the backdrop.
 */
export function intersectMask(mask, { width, height }, rect) {
  const out = new Uint8Array(mask.length);
  const x0 = Math.floor(rect.x0 * width), x1 = Math.ceil(rect.x1 * width);
  const y0 = Math.floor(rect.y0 * height), y1 = Math.ceil(rect.y1 * height);

  let kept = 0;
  for (let y = y0; y < y1; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = x0; x < x1; x++) {
      if (x < 0 || x >= width) continue;
      const p = y * width + x;
      if (mask[p]) { out[p] = 1; kept++; }
    }
  }
  // Too little left to measure: keep the original rather than report a colour
  // derived from a handful of pixels.
  return kept < 400 ? mask : out;
}
