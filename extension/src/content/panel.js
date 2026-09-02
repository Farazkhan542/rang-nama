// The panel injected onto a product page.
//
// Rendered inside a shadow root. A content script shares the page with the
// marketplace's own stylesheet, and Khaadi ships Bootstrap: without isolation
// their `.card`, `.chip` and `.value` rules would land on ours and theirs would
// win about half the time. Shadow DOM makes that impossible rather than
// unlikely, which is worth more than the small awkwardness of inlining styles.

import { deltaE2000, hexToLab } from "../engine/colour.js";
import {
  classifyContrast, classifyDepth, classifyUndertone, selectSeason,
} from "../engine/palette.js";
import { buildFrame, buildVerdict } from "../engine/verdict.js";
import { colouringFromPhoto, readPhoto } from "../lib/colouring.js";
import { renderGarment } from "../lib/garment.js";
import { loadSettings, looksLikeGeminiKey, saveSettings } from "../lib/settings.js";
import { HAIR_LADDER, SKIN_LADDER, loadPhoto, savePhoto, saveProfile } from "../lib/storage.js";

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

.garment { text-align: center; margin: 0 0 12px; }
.garment canvas { max-width: 100%; height: auto; display: inline-block; }
.garment figcaption {
  font-size: 11px; color: #8e8fa0; margin-top: 4px;
}
.mirror { text-align: center; margin: 0 0 12px; }
.mirror canvas { max-width: 100%; height: auto; border-radius: 4px; display: inline-block; }
.mirror figcaption { font-size: 11px; color: #8e8fa0; margin-top: 4px; }
button.tryon {
  width: 100%; padding: 9px; border-radius: 4px; cursor: pointer;
  background: #fff; color: #2f3d8f; border: 1px solid #2f3d8f;
  font-size: 13px; font-weight: 600; margin-bottom: 12px;
}
button.tryon:hover { background: #f4f5fb; }
button.tryon:disabled { opacity: .55; cursor: default; }
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

.photo {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  border: 1.5px dashed #dddad2; border-radius: 5px; padding: 16px 12px;
  cursor: pointer; text-align: center; color: #5b5d70; font-size: 13px;
  margin-bottom: 14px; background: #fbfaf8;
}
.photo:hover { border-color: #2f3d8f; background: #f4f5fb; }
.photo b { font-weight: 600; color: #191b2e; }
.photo small { font-size: 11px; color: #8e8fa0; }
.photo.busy { opacity: .6; pointer-events: none; }

.or {
  text-align: center; font-size: 10px; letter-spacing: .1em; color: #b3b2be;
  text-transform: uppercase; margin: 0 0 12px;
}
.found {
  display: flex; align-items: center; gap: 8px; font-size: 12px;
  color: #0f7a5a; background: #e3f2ec; padding: 7px 10px; border-radius: 4px;
  margin-bottom: 12px;
}
.found i { width: 18px; height: 18px; border-radius: 3px; border: 1px solid rgba(0,0,0,.15); }
.err { font-size: 12px; color: #b0472b; background: #f8e6df; padding: 8px 10px; border-radius: 3px; }
.ok { font-size: 12px; color: #0f7a5a; background: #e3f2ec; padding: 8px 10px; border-radius: 3px; }

input[type=password], input[type=text].key {
  width: 100%; padding: 8px 9px; border: 1px solid #dddad2; border-radius: 4px;
  font-family: ui-monospace, monospace; font-size: 12px; color: #191b2e;
  background: #fff;
}
input[type=password]:focus, input[type=text].key:focus {
  outline: 2px solid #2f3d8f; outline-offset: -1px; border-color: #2f3d8f;
}
.hint { font-size: 11.5px; color: #8e8fa0; margin: 6px 0 0; line-height: 1.45; }
.hint a { color: #2f3d8f; }
.warn {
  font-size: 11.5px; color: #8a6314; background: #f7eeda;
  padding: 8px 10px; border-radius: 3px; margin: 10px 0 0; line-height: 1.45;
}

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

  /** Onboarding.
   *
   *  Photo first, because that is what people ask for, with the swatch ladder
   *  underneath as an equal alternative rather than a fallback. The photo is
   *  read into a canvas, measured, and discarded: it never leaves the machine,
   *  and there is nowhere for it to go, since the extension makes no network
   *  requests at all.
   */
  onboarding(profile, onDone) {
    this.draft = { ...profile };
    const nodes = [];
    const setters = {};

    const drop = document.createElement("label");
    drop.className = "photo";
    // "Use a photo of yourself" read as "see yourself wearing this". It does
    // not do that - it reads two colours off your face and throws the picture
    // away. Say so, because the gap between what a control implies and what it
    // does is the user's problem only until someone writes the label.
    drop.innerHTML =
      "<b>Read my colouring from a photo</b>" +
      "<small>Measures your skin and hair tone, then discards the photo. " +
      "This is not a try-on.</small>";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.hidden = true;
    drop.appendChild(file);
    nodes.push(drop);

    const found = document.createElement("div");
    found.className = "found";
    found.hidden = true;
    nodes.push(found);

    const err = document.createElement("p");
    err.className = "err";
    err.hidden = true;
    nodes.push(err);

    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      drop.classList.add("busy");
      err.hidden = true;
      try {
        const imageData = await readPhoto(f);

        // Save the photo before reading colours from it.
        //
        // These are two independent uses of the same upload, and the colour
        // reading is the one that can legitimately decline - it refuses when
        // skin and background are too close to separate, which a cream wall
        // reliably triggers. Saving afterwards meant a declined reading also
        // silently discarded the photo, so the face swap then reported "no
        // photo saved" straight after a successful upload.
        const keep = document.createElement("canvas");
        keep.width = imageData.width;
        keep.height = imageData.height;
        keep.getContext("2d").putImageData(imageData, 0, 0);
        await savePhoto(keep.toDataURL("image/jpeg", 0.9));

        const r = colouringFromPhoto(imageData);
        if (!r.ok) {
          // The photo is kept and the swap will work; only the colour reading
          // failed, so say that rather than implying nothing happened.
          found.hidden = true;
          err.textContent =
            r.error + " Your photo is saved, so “See it with my face” " +
            "will still work - just pick your skin and hair below.";
          err.hidden = false;
          return;
        }

        this.draft.skin = r.skinHex;
        this.draft.hair = r.hairHex;
        setters.skin?.(r.skinHex);
        setters.hair?.(r.hairHex);

        found.replaceChildren();
        const si = document.createElement("i");
        si.style.background = r.skinHex;
        const hi = document.createElement("i");
        hi.style.background = r.hairHex;
        const label = document.createElement("span");
        label.textContent = r.hairFound
          ? `Read from ${r.skinCount.toLocaleString()} skin pixels`
          : "Skin read. Hair not visible — pick it below if you like";
        found.append(si, hi, label);
        found.hidden = false;
      } catch (e) {
        found.hidden = true;
        err.textContent = `Could not read that photo: ${e.message}`;
        err.hidden = false;
      } finally {
        drop.classList.remove("busy");
      }
    });

    const or = document.createElement("p");
    or.className = "or";
    or.textContent = "or pick the closest match";
    nodes.push(or);

    const ladder = (labelText, key, values) => {
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      label.className = "lab";
      label.textContent = labelText;
      const chips = document.createElement("div");
      chips.className = "chips";
      const buttons = [];
      for (const hex of values) {
        const b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.style.background = hex;
        b.dataset.hex = hex;
        b.setAttribute("aria-label", `${labelText} ${hex}`);
        b.setAttribute("aria-pressed", String(this.draft[key] === hex));
        b.addEventListener("click", () => {
          this.draft[key] = hex;
          buttons.forEach((c) => c.setAttribute("aria-pressed", "false"));
          b.setAttribute("aria-pressed", "true");
        });
        buttons.push(b);
        chips.appendChild(b);
      }
      // A measured colour will not equal a ladder rung, so mark the nearest
      // rather than leaving every chip unselected and the panel looking broken.
      setters[key] = (hex) => {
        const target = hexToLab(hex);
        let best = buttons[0], bestD = Infinity;
        for (const b of buttons) {
          const d = deltaE2000(target, hexToLab(b.dataset.hex));
          if (d < bestD) { bestD = d; best = b; }
        }
        buttons.forEach((c) => c.setAttribute("aria-pressed", "false"));
        best.setAttribute("aria-pressed", "true");
      };
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

  /** Settings: the optional Gemini key.
   *
   *  Entered here rather than committed anywhere. The field is a password
   *  input so it does not end up in a screen recording, which matters given
   *  this exists to be demonstrated.
   */
  async settings(onBack) {
    const s = await loadSettings();
    const nodes = [];

    const label = document.createElement("label");
    label.className = "lab";
    label.textContent = "Gemini API key (optional)";
    nodes.push(label);

    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "AIzaSy…";
    input.value = s.geminiApiKey || "";
    nodes.push(input);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.innerHTML =
      "Without a key everything is measured on your machine and the extension " +
      "makes no network requests at all. With one, the photo is sent to Google " +
      "so the model can point out which part of it is the garment - which is " +
      "the one judgement the local code cannot make well. " +
      '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get a free key</a>.';
    nodes.push(hint);

    const warn = document.createElement("p");
    warn.className = "warn";
    warn.textContent =
      "This key is stored in your browser and is readable by anyone who can " +
      "open this extension's folder. That is fine while you run it yourself. " +
      "If you ever share the extension, move the key behind a server first.";
    nodes.push(warn);

    const status = document.createElement("p");
    status.hidden = true;
    nodes.push(status);

    const save = document.createElement("button");
    save.className = "go";
    save.type = "button";
    save.textContent = "Save";
    save.style.marginTop = "12px";
    save.addEventListener("click", async () => {
      const key = input.value.trim();
      status.hidden = false;
      if (key) {
        const check = looksLikeGeminiKey(key);
        if (!check.ok) {
          status.className = "err";
          status.textContent = check.why;
          return;
        }
      }
      await saveSettings({ geminiApiKey: key });
      status.className = "ok";
      status.textContent = key
        ? "Saved. Reload the page to use it."
        : "Cleared. Everything stays on your machine.";
    });
    nodes.push(save);

    const back = document.createElement("p");
    back.className = "note";
    const a = document.createElement("a");
    a.textContent = "back";
    a.addEventListener("click", onBack);
    back.appendChild(a);
    nodes.push(back);

    this.frame(nodes);
  }

  /** The verdict card. */
  verdict(product, colours, profile, onEdit, cutout = null) {
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

    // Put your face on the model already wearing this garment.
    //
    // The garment in the product photograph is already rendered perfectly - the
    // only thing wrong with it is whose face it is. That makes this milliseconds
    // of canvas work rather than the tens of seconds a try-on model needs to
    // synthesise cloth from scratch.
    const mirrorBtn = document.createElement("button");
    mirrorBtn.className = "tryon";
    mirrorBtn.type = "button";
    mirrorBtn.textContent = "See it with my face";
    nodes.push(mirrorBtn);

    const mirrorFig = document.createElement("figure");
    mirrorFig.className = "mirror";
    mirrorFig.style.margin = "0 0 12px";
    mirrorFig.hidden = true;
    nodes.push(mirrorFig);

    mirrorBtn.addEventListener("click", async () => {
      mirrorBtn.disabled = true;
      mirrorBtn.textContent = "Working…";
      mirrorFig.replaceChildren();
      mirrorFig.hidden = true;

      try {
        const dataUrl = await loadPhoto();
        if (!dataUrl) {
          throw new Error(
            "No photo saved. Use “change my colouring” below and upload one first."
          );
        }
        const me = new Image();
        await new Promise((res, rej) => {
          me.onload = res;
          me.onerror = () => rej(new Error("saved photo could not be read"));
          me.src = dataUrl;
        });

        // The product photo has to cross into the offscreen document, and an
        // extension page cannot read a store's image directly - so it is
        // fetched here, where the host permission applies, and passed as data.
        const asDataUrl = async (src) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error("product photo could not be loaded"));
            img.src = src;
          });
          const cv = document.createElement("canvas");
          cv.width = img.naturalWidth;
          cv.height = img.naturalHeight;
          cv.getContext("2d").drawImage(img, 0, 0);
          return cv.toDataURL("image/jpeg", 0.92);
        };

        // Try the frames most likely to contain a face, best first. A listing
        // often mixes full-body shots, torso crops and flat detail shots, and
        // only some of them show a head at all.
        const candidates = (cutout.faceUrls?.length ? cutout.faceUrls : [cutout.sourceUrl]);
        let reply = null;
        let lastError = "no face found in any photo on this page";

        for (const src of candidates.slice(0, 4)) {
          let targetDataUrl;
          try {
            targetDataUrl = await asDataUrl(src);
          } catch (e) {
            lastError = e.message;
            continue;
          }
          // MediaPipe runs in an offscreen document: its WASM loader injects a
          // script tag, which in a content script lands in the page's world
          // while this code runs isolated, so the module factory is never
          // visible. An extension page has no such split.
          const r = await chrome.runtime.sendMessage({
            target: "background",
            type: "swap",
            personDataUrl: dataUrl,
            targetDataUrl,
          });
          if (r?.ok) { reply = r; break; }
          lastError = r?.error ?? "face swap failed";
        }
        if (!reply) throw new Error(lastError);

        const { ms, frontality, reliable } = reply;
        const canvas = new Image();
        canvas.src = reply.dataUrl;
        canvas.style.maxWidth = "100%";

        mirrorFig.appendChild(canvas);
        const cap = document.createElement("figcaption");
        cap.textContent = reliable
          ? `Your face, on this garment · ${ms}ms`
          : `Your face, on this garment · ${ms}ms · one of the two faces ` +
            `is turned away, so the fit is rough`;
        mirrorFig.appendChild(cap);
        mirrorFig.hidden = false;
        mirrorBtn.textContent = "Redo";
        mirrorBtn.disabled = false;
      } catch (err) {
        const e = document.createElement("p");
        e.className = "err";
        e.textContent = err.message;
        mirrorFig.replaceChildren(e);
        mirrorFig.hidden = false;
        mirrorBtn.textContent = "See it with my face";
        mirrorBtn.disabled = false;
      }
    });

    // The fabric as a stitched kurta, built from the real print on this page.
    // The shopper is being asked to buy cloth and imagine the garment; this is
    // the part of the job the product photograph does not do.
    if (cutout) {
      const fig = document.createElement("figure");
      fig.className = "garment";
      fig.style.margin = "0 0 12px";
      const c = document.createElement("canvas");
      fig.appendChild(c);
      const cap = document.createElement("figcaption");
      cap.textContent = cutout.located
        ? "The garment on this page, background removed"
        : "The garment on this page, background removed (approximate)";
      fig.appendChild(cap);
      nodes.push(fig);
      // Render after the node is in the tree so devicePixelRatio applies.
      queueMicrotask(() =>
        renderGarment(c, cutout.imageData, cutout.mask, cutout.rect));
    }

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
    note.append(edit, document.createTextNode(" · "));

    const cog = document.createElement("a");
    cog.textContent = "settings";
    cog.addEventListener("click", () => this.settings(() => onEdit()));
    note.appendChild(cog);
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
