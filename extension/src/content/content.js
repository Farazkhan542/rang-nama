// Entry point. Runs on a Khaadi page, decides whether it is a product worth
// advising on, reads it, measures the fabric, and shows a verdict.
//
// Nothing here contacts a server. The only network request is for an image the
// page had already loaded, which is why the extension asks for no host
// permissions beyond the site it runs on and no API key exists to leak.

import * as khaadi from "../adapters/khaadi.js";
import * as shopify from "../adapters/shopify.js";
import { dominantColours, loadImageData, scoreForFabric } from "../lib/extract.js";
import { intersectMask, locateGarment } from "../lib/gemini.js";
import { loadSettings } from "../lib/settings.js";
import { DEFAULT_PROFILE, loadProfile } from "../lib/storage.js";
import { Panel } from "./panel.js";

const ADAPTERS = [khaadi, shopify];

/** Is this a single product, rather than a listing or a homepage?
 *
 *  Each adapter decides for itself: Salesforce Commerce Cloud puts an
 *  upper-case SKU in the path, Shopify uses /products/{handle}. A single
 *  regular expression cannot serve both.
 */
function isProductPage(adapter) {
  if (typeof adapter.isProductPage === "function") return adapter.isProductPage();
  return /\/[A-Z0-9][A-Z0-9\-_]{6,}\.html/i.test(location.pathname);
}

/** Choose which photograph to measure.
 *
 *  This started as "take the first one", on the assumption that an unstitched
 *  listing leads with the fabric laid flat. It does not. Khaadi has no flat-lay
 *  photographs at all - every frame is a model wearing the stitched suit, on a
 *  graded studio backdrop - and the first image is typically the full-body
 *  shot, where the cloth is under a fifth of the frame and the rest is wall,
 *  skin, hair and shoes. The panel confidently reported the studio wall as the
 *  fabric colour.
 *
 *  So score the candidates instead: how much of the frame is subject rather
 *  than backdrop, and how little of that subject is skin. Scoring happens at
 *  low resolution because only the ranking matters, then the winner is
 *  re-read at working resolution.
 */
async function pickFabricImage(images) {
  const candidates = images.slice(0, 4);
  const scored = [];

  for (const url of candidates) {
    try {
      const small = await loadImageData(url, 200);
      const s = scoreForFabric(small);
      scored.push({ url, ...s });
      console.log(`[rangnama] candidate ${url.split("/").pop().split("?")[0]}: ` +
                  `coverage ${(s.coverage * 100).toFixed(0)}% ` +
                  `skin ${(s.skinFraction * 100).toFixed(0)}% ` +
                  `score ${s.score.toFixed(3)}${s.maskFailed ? " (mask failed)" : ""}`);
    } catch {
      // A candidate that will not load is not a candidate. Keep going.
    }
  }
  if (!scored.length) return images[0] || null;

  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

async function measure(product) {
  const url = await pickFabricImage(product.images);
  if (!url) throw new Error("no product photograph found on this page");

  const t = (label, fn) => {
    const started = performance.now();
    const out = fn();
    console.log(`[rangnama] ${label}: ${(performance.now() - started).toFixed(0)}ms`);
    return out;
  };

  console.log("[rangnama] measuring:", url.split("/").pop().split("?")[0]);

  const started = performance.now();
  const imageData = await loadImageData(url, 480);
  console.log(`[rangnama] image load+decode: ${(performance.now() - started).toFixed(0)}ms`,
              `${imageData.width}x${imageData.height}`);

  const scored = t("background mask", () => scoreForFabric(imageData));
  let mask = scored.mask;
  let located = null;

  // Optional, and only with a key. The local mask separates subject from
  // backdrop well; what it cannot do is tell which part of the subject is the
  // garment rather than her hair, her arms or the dupatta. That is a judgement,
  // and it is the one thing worth asking a model for.
  const settings = await loadSettings();
  if (settings.geminiApiKey && settings.useGeminiSegmentation) {
    const started = performance.now();
    try {
      located = await locateGarment(imageData, settings.geminiApiKey);
      if (located) {
        mask = intersectMask(mask, imageData, located.rect);
        console.log(`[rangnama] garment located by ${located.model} ` +
                    `(confidence ${located.confidence}): ${located.note} ` +
                    `[${(performance.now() - started).toFixed(0)}ms]`);
      }
    } catch (err) {
      console.warn("[rangnama] garment location failed, using local mask:", err.message);
    }
  }

  const colours = t("dominant colours", () => dominantColours(imageData, { k: 3, mask }));

  if (colours.length === 0) {
    throw new Error("could not read colours from the product photograph");
  }
  // Same mask for the render, so the patch comes from cloth rather than from
  // the studio background beside it.
  return {
    colours,
    located,
    cutout: { imageData, mask, rect: located?.rect ?? null,
              located: Boolean(located), sourceUrl: url },
  };
}

async function run() {
  const adapter = ADAPTERS.find((a) => a.matches());
  if (!adapter) return;

  if (!isProductPage(adapter)) {
    console.log("[rangnama] not a product page, standing down:", location.pathname);
    return;
  }

  // Panel first, before any measurement. If extraction is slow or throws, the
  // shopper sees something rather than wondering whether it is installed.
  const panel = new Panel();
  panel.message("Reading this fabric…");

  const product = await adapter.extract();
  console.log("[rangnama] product:", product.sku, "|", product.images.length,
              "images | warnings:", product.warnings);

  if (!product.images.length) {
    panel.error("No product photograph found on this page.");
    return;
  }

  let measured;
  try {
    measured = await measure(product);
  } catch (err) {
    // Say what failed. A panel that silently shows nothing is indistinguishable
    // from an extension that is not installed.
    panel.error(err.message);
    return;
  }

  const show = (profile) => panel.verdict(
    product, measured.colours, profile,
    () => panel.onboarding(profile, show),
    measured.cutout
  );

  const saved = await loadProfile();
  if (saved) {
    // Open, not collapsed. Starting as a pill in the corner made a working
    // panel indistinguishable from a broken one - the verdict was computed
    // correctly and simply never seen. The minimise control is right there for
    // anyone who wants it out of the way.
    show(saved);
  } else {
    panel.onboarding(DEFAULT_PROFILE, show);
  }
}

// Marketplaces on SFCC swap product content without a full navigation, so a
// one-shot run on load misses every subsequent product the shopper views.
//
// Watching the whole subtree for mutations was too blunt: Khaadi's carousels,
// lazy images and analytics fire constantly, so the callback ran thousands of
// times a second to check a string. Poll the path instead - once a second is
// far more responsive than a shopper can click, and costs nothing.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  document.getElementById("rangnama-root")?.remove();
  run();
}, 1000);

// Any uncaught error here means no panel at all, which is indistinguishable
// from the extension not being installed. Say so in the console at least.
run().catch((err) => {
  console.error("[rangnama] failed to start:", err);
});
