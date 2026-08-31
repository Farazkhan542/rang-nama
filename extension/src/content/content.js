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

  const imageData = await loadImageData(url, 640);
  const mask = backgroundMask(imageData);
  const colours = dominantColours(imageData, { k: 3 });

  if (colours.length === 0) {
    throw new Error("could not read colours from the product photograph");
  }
  // Reuse the same mask for the render, so the patch comes from cloth rather
  // than from the studio background beside it.
  return { colours, patch: fabricPatch(imageData, mask) };
}

async function run() {
  if (!isProductPage()) return;

  const adapter = ADAPTERS.find((a) => a.matches());
  if (!adapter) return;

  const product = adapter.extract();
  if (!product.images.length) return;

  const panel = new Panel();
  panel.message("Reading this fabric…");

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
    show(saved);
    // Start collapsed once the profile exists: a shopper who has already told
    // us their colouring wants a glanceable answer, not a panel over the page.
    panel.collapse(panel.lastBand, panel.lastScore);
  } else {
    panel.onboarding(DEFAULT_PROFILE, show);
  }
}

// Marketplaces on SFCC swap product content without a full navigation, so a
// one-shot run on load misses every subsequent product the shopper views.
let lastPath = location.pathname;
const observer = new MutationObserver(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    document.getElementById("rangnama-root")?.remove();
    run();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

run();
