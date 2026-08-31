// Entry point. Runs on a Khaadi page, decides whether it is a product worth
// advising on, reads it, measures the fabric, and shows a verdict.
//
// Nothing here contacts a server. The only network request is for an image the
// page had already loaded, which is why the extension asks for no host
// permissions beyond the site it runs on and no API key exists to leak.

import * as khaadi from "../adapters/khaadi.js";
import { backgroundMask, dominantColours, loadImageData } from "../lib/extract.js";
import { fabricPatch } from "../lib/garment.js";
import { DEFAULT_PROFILE, loadProfile } from "../lib/storage.js";
import { Panel } from "./panel.js";

const ADAPTERS = [khaadi];

/** Is this a single product, rather than a listing or a homepage?
 *
 *  Checked before anything else so the panel does not appear on a category
 *  page and start measuring whichever photograph happens to be first.
 */
function isProductPage() {
  return /\/[A-Z0-9][A-Z0-9\-_]{6,}\.html/i.test(location.pathname);
}

/** The fabric shot, not the styled shot.
 *
 *  Khaadi ships several photographs per SKU. For unstitched cloth the first is
 *  usually the folded set laid flat, which is the one worth measuring: later
 *  frames are often close-up detail crops or a model in stitched clothing,
 *  and a model contributes her skin and whatever else she is wearing to the
 *  palette. Preferring the first image is a heuristic, not a certainty, which
 *  is why the panel says where the reading came from.
 */
function pickFabricImage(images) {
  return images[0] || null;
}

async function measure(product) {
  const url = pickFabricImage(product.images);
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

  const mask = t("background mask", () => backgroundMask(imageData));
  const colours = t("dominant colours", () => dominantColours(imageData, { k: 3, mask }));

  if (colours.length === 0) {
    throw new Error("could not read colours from the product photograph");
  }
  // Same mask for the render, so the patch comes from cloth rather than from
  // the studio background beside it.
  const patch = t("fabric patch", () => fabricPatch(imageData, mask));
  return { colours, patch };
}

async function run() {
  if (!isProductPage()) {
    console.log("[rangnama] not a product page, standing down:", location.pathname);
    return;
  }

  const adapter = ADAPTERS.find((a) => a.matches());
  if (!adapter) return;

  // Panel first, before any measurement. If extraction is slow or throws, the
  // shopper sees something rather than wondering whether it is installed.
  const panel = new Panel();
  panel.message("Reading this fabric…");

  const product = adapter.extract();
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
    measured.patch
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
