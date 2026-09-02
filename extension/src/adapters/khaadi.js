// Khaadi (pk.khaadi.com) — Salesforce Commerce Cloud.
//
// Every selector here was read off a live page rather than guessed, but a
// marketplace redesign will break them anyway. So each field is read by
// several independent strategies and the adapter records what it could not
// find in `warnings` instead of throwing: a page that yields images but no
// weave is still worth a colour verdict, and a silent partial failure is far
// worse than a noted one.

/** Khaadi's image CDN takes the output size as query parameters, so the
 *  delivered resolution is a URL rewrite rather than a fixed asset.
 *
 *  760px, not 1200. Colour sampling does want real pixels - the 400px
 *  thumbnails carry JPEG artefacts heavy enough to shift a measured dominant
 *  colour - but the analysis downsamples to 480 anyway, so everything above
 *  that was bytes fetched and thrown away. Downloading 1200x1800 cost 946ms
 *  of a 1.2s measurement.
 */
function upscale(url, width = 760, height = 1140) {
  if (!url) return url;
  const abs = url.startsWith("http") ? url : `https://pk.khaadi.com${url}`;
  try {
    const u = new URL(abs);
    if (u.searchParams.has("sw") || u.searchParams.has("sh")) {
      u.searchParams.set("sw", String(width));
      u.searchParams.set("sh", String(height));
      return u.toString();
    }
    // A bare demandware.static path serves the original.
    return abs;
  } catch {
    return abs;
  }
}

function text(sel, root = document) {
  const el = root.querySelector(sel);
  return el ? el.textContent.trim() : undefined;
}

function attr(sel, name, root = document) {
  const el = root.querySelector(sel);
  return el ? el.getAttribute(name) || undefined : undefined;
}

/** SKU. The URL is the most stable source — /fabrics-3-piece/{PID}.html — with
 *  the tile attribute as backup for listing pages. */
function readSku() {
  const fromUrl = location.pathname.match(/\/([A-Z0-9][A-Z0-9\-_]{6,})\.html/i);
  if (fromUrl) return fromUrl[1];
  return attr("[data-productid]", "data-productid")
      || attr("[data-pid]", "data-pid");
}

/** The filename stem shared by every photograph of one product.
 *
 *  SKU  A22-26-201FC1-VG_MULTI
 *  file a22-26-201fc1_multi_1.jpg
 *
 *  Needed because scraping the page for image URLs also catches the Einstein
 *  recommendation carousels, which Khaadi injects client-side after load. The
 *  server HTML contains only this product; the live DOM does not. Without
 *  filtering, the extension confidently measured a recommended product and
 *  showed a verdict for a fabric the shopper was not looking at.
 */
function skuStems(sku) {
  if (!sku) return [];
  const low = sku.toLowerCase();

  // Several candidates rather than one, because the SKU and the filenames do
  // not always agree on prefixes. T-A22-26-202FD2-VG_MULTI is photographed as
  // a22-26-202fd2_multi_1.jpg: the leading type marker exists in the SKU and
  // not in the filename, so a single stem matched nothing and the panel
  // reported no photograph at all.
  const candidates = new Set();
  const add = (s) => { if (s && s.length >= 6) candidates.add(s); };

  const trim = (s) => {
    // Drop the colourway suffix: -VG_MULTI, -BL_BLUE and similar.
    const m = s.match(/^(.*?)-[a-z]{2}[_-]/);
    return m ? m[1] : s.split("_")[0];
  };

  add(trim(low));
  // Same again with a leading single-letter type marker removed.
  add(trim(low.replace(/^[a-z]-/, "")));

  return [...candidates];
}

/** Images. The tile carries several resolutions as data attributes; the PDP
 *  exposes hi-res paths inline. Collect both, dedupe, prefer larger. */
function readImages(sku) {
  const out = new Set();

  for (const el of document.querySelectorAll(".image-container, .product-tile")) {
    for (const a of el.attributes) {
      if (/^data-(hi-res|large|medium)-\d+$/.test(a.name) && a.value) {
        out.add(upscale(a.value));
      }
    }
  }

  // Deliberately loose. A tighter pattern anchored on /on/demandware.static/
  // matched nothing on the live page while a permissive one found 35 URLs, and
  // the difference was a backslash in the character class - the kind of bug
  // that looks correct in review and returns zero results in production. The
  // filter below does the narrowing instead, where it is visible.
  const html = document.documentElement.innerHTML;
  for (const m of html.matchAll(/[^"'\s(]*hi-res[^"'\s)]*\.jpg/gi)) {
    if (m[0].includes("demandware")) out.add(upscale(m[0]));
  }

  const og = attr('meta[property="og:image"]', "content");
  if (og) out.add(upscale(og));

  // Khaadi serves each image under two path prefixes - a bare
  // /on/demandware.static/... and a /dw/image/v2/... variant that accepts sw
  // and sh. They are the same picture, so a URL-keyed Set does not dedupe
  // them; key on the filename and prefer the resizable form.
  const byFile = new Map();
  for (const u of [...out]) {
    const file = u.split("/").pop().split("?")[0];
    const existing = byFile.get(file);
    if (!existing || (!existing.includes("sw=") && u.includes("sw="))) {
      byFile.set(file, u);
    }
  }

  const stems = skuStems(sku);
  let files = [...byFile.entries()];

  // Narrow by SKU first, and let that decide what a "t-" filename means.
  //
  // An earlier version dropped every t-prefixed file as a thumbnail. That is
  // true on an unstitched listing, where t-a11-26-216fa1_multi_1.jpg sits
  // beside the full-size a11-26-216fa1_multi_1.jpg. It is false for tailored
  // products, whose SKU *is* T-A22-26-202FD2-VG_MULTI and whose photographs
  // are named t-a22-26-202fd2_multi_1.jpg. The filter deleted the product's
  // own images and the panel reported no photograph at all.
  //
  // The SKU already distinguishes them, so no filename heuristic is needed:
  // a thumbnail of an unstitched product does not match that product's stem,
  // and a tailored product's photographs do.
  const matched = stems.length
    ? files.filter(([file]) => stems.some((s) => file.startsWith(s)))
    : [];

  if (matched.length) {
    files = matched;
  } else {
    // No SKU match, so fall back to every image on the page - minus the
    // thumbnails, which are too small to sample colour from reliably.
    files = files.filter(([file]) => !/^t-/i.test(file));
  }

  // Khaadi numbers its shots _1.._n, and _1 is the front view. Ordering by
  // that suffix makes "first image" mean the front of the garment rather than
  // whichever URL the regex happened to reach first.
  files.sort(([a], [b]) => {
    const n = (f) => Number(f.match(/_(\d+)\.jpg$/)?.[1] ?? 99);
    return n(a) - n(b);
  });

  return files.map(([, url]) => url);
}

/** Weave and embellishment. Khaadi states these outright in an embedded JSON
 *  blob as e.g. "Embroidered | Lawn", so there is nothing to infer from the
 *  photograph — asking a vision model here would be guessing at a fact the
 *  page already gives you. */
function readFabricDetail() {
  const html = document.documentElement.innerHTML;
  const m = html.match(/"description"\s*:\s*"([^"]{3,80})"/);
  if (!m) return {};

  const parts = m[1].split("|").map((s) => s.trim()).filter(Boolean);
  const WEAVES = ["lawn", "cambric", "chiffon", "khaddar", "linen", "silk", "cotton", "karandi", "jacquard"];

  let weave, embellishment;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (WEAVES.some((w) => low.includes(w))) weave = p;
    else if (/print|embroider|dyed|schiffli|block/i.test(p)) embellishment = p;
  }
  return { weave, embellishment };
}

function readPrice() {
  const el = document.querySelector(".sales .value, .price .value, [class*='cc-price']");
  if (!el) return {};
  const raw = el.getAttribute("content") || el.textContent || "";
  const num = raw.replace(/[^\d.]/g, "");
  return num ? { price: num, currency: "PKR" } : {};
}

/** SFCC puts an upper-case SKU in the path. */
export function isProductPage() {
  return /\/[A-Z0-9][A-Z0-9\-_]{6,}\.html/i.test(location.pathname);
}

export function matches() {
  return location.hostname.endsWith("khaadi.com");
}

export function extract() {
  const warnings = [];

  const sku = readSku();
  if (!sku) warnings.push("sku not found");

  const images = readImages(sku);
  if (!images.length) warnings.push("no product images found");

  const { weave, embellishment } = readFabricDetail();
  if (!weave) warnings.push("weave not stated on page");

  const { price, currency } = readPrice();
  if (!price) warnings.push("price not found");

  const title = attr('meta[property="og:title"]', "content")
             || text("h1.product-name")
             || document.title;

  const pieces = /(\d+)\s*piece/i.exec(title || "")?.[0];

  return {
    url: attr('link[rel="canonical"]', "href") || location.href,
    sku, title, price, currency, images, weave, embellishment, pieces,
    adapter: "khaadi",
    warnings,
  };
}
