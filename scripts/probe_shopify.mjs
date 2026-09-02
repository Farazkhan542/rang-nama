// Check the Shopify adapter's logic against live J. and Gul Ahmed pages.
//
// Runs the same field extraction the extension does, but over fetched JSON
// rather than in a page, so a store redesign or a renamed collection shows up
// here rather than as an empty panel.
//
//   node scripts/probe_shopify.mjs

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

const TARGETS = [
  ["J.", "https://www.junaidjamshed.com", "mens-unstitched"],
  ["Gul Ahmed", "https://www.gulahmedshop.com", "mens-clothes-eastern-gents-kurta"],
  ["Gul Ahmed", "https://www.gulahmedshop.com", "mens-clothes-unstitched-latha-collection"],
];

function fabricFrom(text) {
  if (!text) return {};
  const low = text.replace(/<[^>]+>/g, " ").toLowerCase();
  const WEAVES = ["lawn", "cambric", "chiffon", "khaddar", "latha", "karandi",
                  "jacquard", "linen", "silk", "cotton", "wash n wear",
                  "washnwear", "blended", "mesuri", "boski", "poly viscose"];
  const emb = ["printed", "embroidered", "dyed", "block print", "digital print"];
  return { weave: WEAVES.find((w) => low.includes(w)),
           embellishment: emb.find((e) => low.includes(e)) };
}

let problems = 0;

for (const [brand, origin, collection] of TARGETS) {
  console.log("=".repeat(72));
  console.log(`${brand}  /collections/${collection}`);

  const list = await fetch(`${origin}/collections/${collection}/products.json?limit=3`,
                           { headers: UA });
  if (!list.ok) { console.log(`  HTTP ${list.status} - collection gone?`); problems++; continue; }

  const { products = [] } = await list.json();
  if (!products.length) { console.log("  empty collection"); problems++; continue; }

  for (const p of products) {
    const res = await fetch(`${origin}/products/${p.handle}.js`, { headers: UA });
    if (!res.ok) { console.log(`  ${p.handle}: HTTP ${res.status}`); problems++; continue; }
    const j = await res.json();

    const images = (j.images || []).length;
    const { weave, embellishment } = fabricFrom(j.description);
    const price = j.price != null ? (j.price / 100).toFixed(0) : null;

    const missing = [];
    if (!images) missing.push("images");
    if (!price) missing.push("price");
    if (!weave) missing.push("weave");
    if (missing.length > 1) problems++;

    console.log(`  ${(j.title || "").slice(0, 46)}`);
    console.log(`    ${images} images | PKR ${price} | ${weave ?? "weave?"} | ` +
                `${embellishment ?? "-"} | type "${j.type}"`);
    if (missing.length) console.log(`    missing: ${missing.join(", ")}`);
  }
}

console.log();
console.log(problems ? `${problems} product(s) with problems` : "all fields resolve on both stores");
process.exit(problems > 2 ? 1 : 0);
