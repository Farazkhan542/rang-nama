// The panel injected onto a product page.
//
// Rendered inside a shadow root. A content script shares the page with the
// marketplace's own stylesheet, and Khaadi ships Bootstrap: without isolation
// their `.card`, `.chip` and `.value` rules would land on ours and theirs would
// win about half the time. Shadow DOM makes that impossible rather than
// unlikely, which is worth more than the small awkwardness of inlining styles.

import { hexToLab } from "../engine/colour.js";
import {
  classifyContrast, classifyDepth, classifyUndertone, selectSeason,
} from "../engine/palette.js";
import { buildFrame, buildVerdict } from "../engine/verdict.js";
import { HAIR_LADDER, SKIN_LADDER, saveProfile } from "../lib/storage.js";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.wrap {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  width: 330px; max-height: calc(100vh - 36px); overflow-y: auto;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px; line-height: 1.5; color: #191b2e;
  background: #fff; border: 1px solid #dddad2; border-radius: 6px;
  box-shadow: 0 2px 6px rgba(25,27,46,.08), 0 12px 32px -12px rgba(25,27,46,.28);
}
.wrap[hidden] { display: none; }

.head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border-bottom: 1px solid #eeece7;
}
.brand { font-weight: 600; letter-spacing: -.01em; }
.brand small {
  display: block; font-weight: 400; font-size: 11px; color: #8e8fa0;
  letter-spacing: .06em; text-transform: uppercase;
}
.x {
  border: 0; background: none; cursor: pointer; color: #8e8fa0;
  font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 4px;
}
.x:hover { background: #f2f0ec; color: #191b2e; }

.body { padding: 14px; }

.band {
  display: inline-block; font-size: 11px; letter-spacing: .09em;
  text-transform: uppercase; font-weight: 600;
  padding: 4px 9px; border-radius: 3px; margin-bottom: 10px;
}
.band[data-b="excellent"] { background: #e3f2ec; color: #0f7a5a; }
.band[data-b="good"]      { background: #eef2e2; color: #4a6b1f; }
.band[data-b="neutral"]   { background: #f7eeda; color: #8a6314; }
.band[data-b="poor"]      { background: #f8e6df; color: #b0472b; }

.meter { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.track { flex: 1; height: 5px; background: #f0eee8; border-radius: 3px; overflow: hidden; }
.fill { height: 100%; border-radius: 3px; }
.num { font-variant-numeric: tabular-nums; font-size: 12px; color: #5b5d70; min-width: 44px; text-align: right; }

.swatches { display: flex; gap: 0; height: 26px; border-radius: 3px; overflow: hidden; margin-bottom: 12px; }
.swatches i { flex: 1; }

ul.reasons { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.reasons li { font-size: 13px; color: #5b5d70; }
.reasons b {
  display: block; font-size: 10px; letter-spacing: .07em; text-transform: uppercase;
  color: #8e8fa0; font-weight: 600; margin-bottom: 1px;
}

.note {
  margin-top: 12px; padding-top: 10px; border-top: 1px dashed #e4e1db;
  font-size: 12px; color: #8e8fa0;
}
.note a { color: #2f3d8f; cursor: pointer; text-decoration: underline; }

label.lab {
  display: block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
  color: #8e8fa0; margin: 0 0 7px; font-weight: 600;
}
.field { margin-bottom: 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  width: 30px; height: 30px; border-radius: 3px; cursor: pointer; padding: 0;
  border: 1px solid rgba(0,0,0,.15);
}
.chip[aria-pressed="true"] { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #2f3d8f; }
.chip:focus-visible { outline: 2px solid #2f3d8f; outline-offset: 3px; }

input[type=range] { width: 100%; accent-color: #2f3d8f; }
.row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.row span { font-variant-numeric: tabular-nums; font-size: 13px; }

button.go {
  width: 100%; padding: 9px; border-radius: 4px; cursor: pointer;
  background: #2f3d8f; color: #fff; border: 0; font-size: 13px; font-weight: 600;
}
button.go:hover { background: #26327a; }

.msg { font-size: 13px; color: #8e8fa0; }
.err { font-size: 12px; color: #b0472b; background: #f8e6df; padding: 8px 10px; border-radius: 3px; }

.tab {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  border: 1px solid #dddad2; background: #fff; color: #191b2e; cursor: pointer;
  border-radius: 999px; padding: 9px 15px; font-size: 13px; font-weight: 600;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 2px 6px rgba(25,27,46,.08), 0 12px 32px -12px rgba(25,27,46,.28);
}
.tab[hidden] { display: none; }
.tab .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; }
`;

const BAND_COLOUR = {
  excellent: "#0f7a5a", good: "#4a6b1f", neutral: "#8a6314", poor: "#b0472b",
};

export class Panel {
  constructor() {
    this.host = document.createElement("div");
    this.host.id = "rangnama-root";
    this.root = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    this.root.appendChild(style);

    this.tab = document.createElement("button");
    this.tab.className = "tab";
    this.tab.hidden = true;
    this.tab.addEventListener("click", () => this.open());

    this.wrap = document.createElement("div");
    this.wrap.className = "wrap";

    this.root.append(this.tab, this.wrap);
    document.documentElement.appendChild(this.host);

    this.draft = null;
  }

  open() {
    this.wrap.hidden = false;
    this.tab.hidden = true;
  }

  collapse(band, score) {
    this.wrap.hidden = true;
    this.tab.hidden = false;
    this.tab.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = BAND_COLOUR[band] || "#8e8fa0";
    this.tab.append(dot, document.createTextNode(
      score == null ? "Rang Nama" : `${band} · ${score.toFixed(0)}`
    ));
  }

  frame(bodyNodes) {
    this.wrap.replaceChildren();

    const head = document.createElement("div");
    head.className = "head";
    const brand = document.createElement("div");
    brand.className = "brand";
    brand.innerHTML = "Rang Nama<small>colour &amp; print advice</small>";
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "−";
    x.title = "Minimise";
    x.addEventListener("click", () => this.collapse(this.lastBand, this.lastScore));
    head.append(brand, x);

    const body = document.createElement("div");
    body.className = "body";
    body.append(...bodyNodes);

    this.wrap.append(head, body);
    this.open();
  }

  message(text) {
    const p = document.createElement("p");
    p.className = "msg";
    p.textContent = text;
    this.frame([p]);
  }

  error(text) {
    const p = document.createElement("p");
    p.className = "err";
    p.textContent = text;
    this.frame([p]);
  }

  /** Onboarding: the photo-free path. No camera, no upload, no permission. */
  onboarding(profile, onDone) {
    this.draft = { ...profile };
    const nodes = [];

    const intro = document.createElement("p");
    intro.className = "msg";
    intro.style.marginTop = "0";
    intro.textContent = "Pick the closest match. This stays on your device.";
    nodes.push(intro);

    const ladder = (labelText, key, values) => {
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      label.className = "lab";
      label.textContent = labelText;
      const chips = document.createElement("div");
      chips.className = "chips";
      for (const hex of values) {
        const b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.style.background = hex;
        b.setAttribute("aria-label", `${labelText} ${hex}`);
        b.setAttribute("aria-pressed", String(this.draft[key] === hex));
        b.addEventListener("click", () => {
          this.draft[key] = hex;
          [...chips.children].forEach((c) => c.setAttribute("aria-pressed", "false"));
          b.setAttribute("aria-pressed", "true");
        });
        chips.appendChild(b);
      }
      field.append(label, chips);
      return field;
    };

    nodes.push(ladder("Skin tone", "skin", SKIN_LADDER));
    nodes.push(ladder("Hair tone", "hair", HAIR_LADDER));

    const hField = document.createElement("div");
    hField.className = "field";
    const row = document.createElement("div");
    row.className = "row";
    const hLabel = document.createElement("label");
    hLabel.className = "lab";
    hLabel.style.margin = "0";
    hLabel.textContent = "Height";
    const hVal = document.createElement("span");
    hVal.textContent = `${this.draft.heightCm} cm`;
    row.append(hLabel, hVal);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "142";
    slider.max = "182";
    slider.value = String(this.draft.heightCm);
    slider.addEventListener("input", () => {
      this.draft.heightCm = Number(slider.value);
      hVal.textContent = `${slider.value} cm`;
    });
    hField.append(row, slider);
    nodes.push(hField);

    const go = document.createElement("button");
    go.className = "go";
    go.type = "button";
    go.textContent = "Save and check this fabric";
    go.addEventListener("click", async () => {
      go.disabled = true;
      go.textContent = "Saving…";
      await saveProfile(this.draft);
      onDone(this.draft);
    });
    nodes.push(go);

    this.frame(nodes);
  }

  /** The verdict card. */
  verdict(product, colours, profile, onEdit) {
    const skin = hexToLab(profile.skin);
    const hair = hexToLab(profile.hair);
    const season = selectSeason(
      classifyUndertone(skin), classifyDepth(skin), classifyContrast(skin, hair)
    );
    const contrast = classifyContrast(skin, hair);
    const frame = buildFrame(profile.heightCm);

    // Print scale is left null on purpose. Measuring a motif repeat needs the
    // autocorrelation pass, which is not in the extension yet, and the engine
    // already reports an unmeasured dimension rather than inventing one.
    const fabric = { colours, motifCm: null };
    const v = buildVerdict(fabric, season, contrast, frame);

    this.lastBand = v.headline;
    this.lastScore = v.score;

    const nodes = [];

    const band = document.createElement("span");
    band.className = "band";
    band.dataset.b = v.headline;
    band.textContent = v.headline;
    nodes.push(band);

    const meter = document.createElement("div");
    meter.className = "meter";
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = `${v.score.toFixed(0)}%`;
    fill.style.background = BAND_COLOUR[v.headline];
    track.appendChild(fill);
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `${v.score.toFixed(0)}/100`;
    meter.append(track, num);
    nodes.push(meter);

    const sw = document.createElement("div");
    sw.className = "swatches";
    for (const c of colours) {
      const i = document.createElement("i");
      i.style.background = labToCss(c.lab);
      i.style.flexGrow = String(Math.max(0.08, c.p));
      i.title = `${(c.p * 100).toFixed(0)}% of the fabric`;
      sw.appendChild(i);
    }
    nodes.push(sw);

    const ul = document.createElement("ul");
    ul.className = "reasons";
    for (const s of v.scores) {
      if (s.key === "print scale") continue; // unmeasured; do not pad the card
      const li = document.createElement("li");
      const b = document.createElement("b");
      b.textContent = s.key;
      li.append(b, document.createTextNode(s.text));
      ul.appendChild(li);
    }
    nodes.push(ul);

    const note = document.createElement("p");
    note.className = "note";
    const bits = [`Read from this page's photo · ${season.name}`];
    if (product.weave) bits.push(product.weave);
    note.textContent = bits.join(" · ") + " · ";
    const edit = document.createElement("a");
    edit.textContent = "change my colouring";
    edit.addEventListener("click", onEdit);
    note.appendChild(edit);
    nodes.push(note);

    this.frame(nodes);
  }
}

/** Lab back to something CSS can paint. Goes via the same matrices as the
 *  forward conversion so the swatch shows the colour that was measured. */
function labToCss({ L, a, b }) {
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
  const [r, g, bl] = lin.map(enc);
  return `rgb(${r}, ${g}, ${bl})`;
}
