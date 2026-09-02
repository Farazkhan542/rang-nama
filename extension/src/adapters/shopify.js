// Shopify stores: J. (junaidjamshed.com) and Gul Ahmed (gulahmedshop.com).
//
// One adapter covers both, and any other Shopify store, because Shopify serves
// the product as JSON at /products/{handle}.js. That is a different situation
// from Khaadi entirely.
//
// The Khaadi adapter reads rendered HTML with regular expressions, and every
// bug in it came from that: a character class that matched nothing, images
// belonging to recommendation carousels, a t- prefix that meant "thumbnail" on
// one page and "tailored" on another. None of those failure modes exist here.
// The store hands over a structured record with an images array, and the only
// judgement left is which image to measure.
//
// Same origin as the page, so the fetch needs no host permission beyond the
// one that already lets the content script run.

const STORES = {
  "junaidjamshed.com": { brand: "J.", currency: "PKR" },
  "gulahmedshop.com": { brand: "Gul Ahmed", currency: "PKR" },
};

/** Shopify resizes on demand through a width parameter, so full resolution is
 *  a URL edit rather than a separate asset. 760 matches what the analysis
 *  actually consumes - it downsamples to 480, and anything larger is bytes
 *  fetched and discarded. */
function atWidth(src, width = 760) {
  if (!src) return src;
  const abs = src.startsWith("//") ? `https:${src}` : src;
  try {
    const u = new URL(abs, location.origin);
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return abs;
  }
}

function storeFor(host) {
  const key = Object.keys(STORES).find((h) => host.endsWith(h));
  return key ? { host: key, ...STORES[key] } : null;
}

export function matches() {
  return Boolean(storeFor(location.hostname));
}

/** Product handle from /products/{handle}. Shopify keeps this stable even
 *  when the path is prefixed by a collection. */
function handleFrom(pathname) {
  const m = pathname.match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

export function isProductPage() {
  return Boolean(handleFrom(location.pathname));
}

/**
 * Fabric and weave, read from the description.
 *
 * Shopify has no dedicated field for it, but these stores state it in prose -
 * "100% Cotton", "Blended", "Wash n Wear". Worth pulling out because it is a
 * stated fact on the page rather than something to infer from a photograph.
 */
function fabricFrom(text) {
  if (!text) return {};
  const plain = text.replace(/<[^>]+>/g, " ");
  const WEAVES = [
    "lawn", "cambric", "chiffon", "khaddar", "latha", "karandi", "jacquard",
    "linen", "silk", "cotton", "wash n wear", "washnwear", "blended", "mesuri",
    "boski", "poly viscose",
  ];
  const low = plain.toLowerCase();
  const weave = WEAVES.find((w) => low.includes(w));

  const emb = ["printed", "embroidered", "dyed", "block print", "digital print"]
    .find((e) => low.includes(e));

  return {
    weave: weave ? weave.replace(/\b\w/g, (c) => c.toUpperCase()) : undefined,
    embellishment: emb ? emb.replace(/\b\w/g, (c) => c.toUpperCase()) : undefined,
  };
}

export async function extract() {
  const store = storeFor(location.hostname);
  const handle = handleFrom(location.pathname);
  const warnings = [];

  if (!store || !handle) {
    return { url: location.href, images: [], adapter: "shopify",
             warnings: ["not a Shopify product page"] };
  }

  let product = null;
  try {
    const res = await fetch(`/products/${handle}.js`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (res.ok) product = await res.json();
    else warnings.push(`product JSON returned HTTP ${res.status}`);
  } catch (err) {
    warnings.push(`product JSON unavailable: ${err.message}`);
  }

  if (!product) {
    return { url: location.href, images: [], adapter: "shopify", warnings };
  }

  // Shopify gives the images already ordered as the merchant arranged them,
  // and every one belongs to this product - so no filtering by SKU and no
  // guarding against recommendation carousels, which is most of what the
  // Khaadi adapter has to do.
  const images = (product.images || []).map((src) => atWidth(src));
  if (!images.length) warnings.push("product has no images");

  const { weave, embellishment } = fabricFrom(product.description);
  if (!weave) warnings.push("fabric not stated in the description");

  return {
    url: `${location.origin}/products/${handle}`,
    sku: product.handle,
    title: product.title,
    // Shopify prices are in minor units.
    price: product.price != null ? (product.price / 100).toFixed(0) : undefined,
    currency: store.currency,
    images,
    weave,
    embellishment,
    pieces: /(\d+)\s*piece/i.exec(product.title || "")?.[0],
    brand: store.brand,
    productType: product.type,
    adapter: "shopify",
    warnings,
  };
}
