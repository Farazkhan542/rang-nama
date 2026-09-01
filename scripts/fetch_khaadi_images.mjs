import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "C:/Users/subha/AppData/Local/Temp/claude/c--Users-subha-OneDrive-Desktop-clothing/2ae36d6a-b3cc-4e2f-a2b4-b215a8465e66/scratchpad/khaadi";
mkdirSync(OUT, { recursive: true });

const page = process.argv[2] ||
  "https://pk.khaadi.com/fabrics-3-piece/A22-26-201FC1-VG_MULTI.html";

const html = await (await fetch(page, { headers: { "User-Agent": "Mozilla/5.0" } })).text();

const urls = [...new Set(
  [...html.matchAll(/[^"'\s(]*hi-res[^"'\s)]*\.jpg/gi)]
    .map((m) => m[0])
    .filter((u) => u.includes("demandware") && !u.includes("/t-"))
)].map((u) => (u.startsWith("http") ? u : "https://pk.khaadi.com" + u));

const byFile = new Map();
for (const u of urls) {
  const f = u.split("/").pop().split("?")[0];
  if (!byFile.has(f)) byFile.set(f, u);
}

const files = [...byFile.entries()].sort(([a], [b]) => {
  const n = (f) => Number(f.match(/_(\d+)\.jpg$/)?.[1] ?? 99);
  return n(a) - n(b);
});

console.log(`${files.length} images for ${page.split("/").pop()}`);
for (const [f, u] of files.slice(0, 5)) {
  const url = u.includes("?")
    ? u.replace(/sw=\d+/, "sw=400").replace(/sh=\d+/, "sh=600")
    : u + "?sw=400&sh=600";
  const buf = Buffer.from(await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).arrayBuffer());
  writeFileSync(`${OUT}/${f}`, buf);
  console.log(`  ${f}  ${(buf.length / 1024).toFixed(0)} KB`);
}
console.log(`\nsaved to ${OUT}`);
