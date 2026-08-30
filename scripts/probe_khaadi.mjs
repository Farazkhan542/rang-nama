// Probe a live Khaadi product page and report what the adapter can read.
//
// Run this whenever the panel starts showing blanks. Selectors written against
// a live page still rot when the site is redesigned, and the useful question
// is never "is it broken" but "which field stopped resolving".
//
//   node scripts/probe_khaadi.mjs [url]

const URL_ = process.argv[2] ||
  "https://pk.khaadi.com/fabrics-3-piece/A11-26-216FA1-VG_MULTI.html";

const res = await fetch(URL_, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
const html = await res.text();
console.log(`${URL_}\n  HTTP ${res.status}, ${(html.length / 1024).toFixed(0)} KB\n`);

const abs = (u) => (u.startsWith("http") ? u : `https://pk.khaadi.com${u}`);
const report = [];

const sku = new URL(URL_).pathname.match(/\/([A-Z0-9][A-Z0-9\-_]{6,})\.html/i);
report.push(["sku", sku ? sku[1] : null]);

const found = new Set();
for (const m of html.matchAll(/[^"'\s(]*hi-res[^"'\s)]*\.jpg/gi)) {
  if (m[0].includes("demandware")) found.add(abs(m[0]));
}
const full = [...found].filter((u) => !/\/t-[a-z0-9_\-]+\.jpg/i.test(u));
const byFile = new Map();
for (const u of full) {
  const f = u.split("/").pop().split("?")[0];
  const e = byFile.get(f);
  if (!e || (!e.includes("sw=") && u.includes("sw="))) byFile.set(f, u);
}
report.push(["images", byFile.size ? `${byFile.size} distinct` : null]);

const desc = html.match(/"description"\s*:\s*"([^"]{3,80})"/);
let weave = null, emb = null;
if (desc) {
  const WEAVES = ["lawn","cambric","chiffon","khaddar","linen","silk","cotton","karandi","jacquard"];
  for (const part of desc[1].split("|").map((s) => s.trim())) {
    const low = part.toLowerCase();
    if (WEAVES.some((w) => low.includes(w))) weave = part;
    else if (/print|embroider|dyed|schiffli|block/i.test(part)) emb = part;
  }
}
report.push(["weave", weave]);
report.push(["embellishment", emb]);

const price = html.match(/class="value cc-price"\s+content="([\d.]+)"/) ||
              html.match(/content="(\d+\.\d{2})"[^>]*>[\s\S]{0,60}?PKR/);
report.push(["price", price ? `PKR ${price[1]}` : null]);

const title = html.match(/<meta property="og:title" content="([^"]+)"/) ||
              html.match(/<title>([^<]+)<\/title>/);
report.push(["title", title ? title[1].trim().slice(0, 50) : null]);

let missing = 0;
for (const [field, value] of report) {
  if (value === null) missing++;
  console.log(`  ${value === null ? "MISS" : "OK  "}  ${field.padEnd(14)} ${value ?? ""}`);
}
console.log(`\n${report.length - missing}/${report.length} fields resolved`);
process.exit(missing > 2 ? 1 : 0);
