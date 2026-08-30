# Unstitched Fabric Advisor

Colour and print-scale advice for unstitched Pakistani fabric, delivered at the
moment of purchase and free for the shopper.

---

## The gap

Every virtual try-on product fails on the largest category in Pakistani women's
fashion, for a structural reason: **unstitched fabric has no garment to warp.**

The product photo is a flat bolt of printed cloth, not a shirt on a model. There
is nothing to segment, align or drape, so image-based try-on has no purchase on
it. There is no dataset for it, and searching the literature turns up no
published work on shalwar kameez, kurta or dupatta at all — try-on benchmarks
are overwhelmingly Western, top-garment and slim-model.

Meanwhile the category is enormous. Khaadi, Sapphire, Gul Ahmed, Sana Safinaz,
Maria B and Asim Jofa all sell unstitched 3-piece suits as their core line.

## The insight

**For unstitched fabric, fit is solved by the tailor.**

The hardest and riskiest part of a conventional try-on product — estimating body
measurements from a photo accurately enough to recommend a size — simply does
not apply. Your *darzi* measures you in person.

That leaves exactly two open questions, and both are arithmetic:

1. **Does this colour suit my complexion?**
2. **Is this print the right scale for my frame?**

## Architecture: compute the verdict, don't generate it

The verdict is arithmetic. The image, when there is one, is only ever
illustration.

This is deliberate, and there is evidence behind it. Deployed virtual try-on
sees 15–25% adoption before users abandon the novelty; shoppers admire it but
rarely use it to decide. Worse, Google/UW's own fit-aware model has a physics
engine that "distinguishes loose from fitted, but not tight from very tight" —
**a generated image cannot reliably tell you whether something fits.**

So the expensive generative step is demoted, and four consequences follow:

| | |
|---|---|
| **Free** | Runs on every product view at zero marginal cost |
| **Instant** | No spinner, no "generating…" |
| **Explainable** | Every score decomposes into a stated reason |
| **Testable** | Deterministic in, deterministic out |

### Why it stays free at any scale

Almost everything expensive is **user-independent**:

| Tier | Work | Depends on | Cost |
|---|---|---|---|
| 0 | Colour + print-scale verdict | user profile | **zero** — arithmetic |
| 1 | Fabric extraction | **SKU only** | once, cached forever |
| 2 | Garment render | **(SKU, silhouette)** | once, cached forever |
| 3 | Personal try-on | user + SKU | opt-in, rate-limited |

Fabric extraction depends only on the SKU; the render depends only on
(SKU, silhouette). Neither depends on who is looking. Both are computed once
for the whole catalogue and served from cache, so cost per user falls toward
zero as users grow — the reverse of normal generative-AI economics.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Agent framework | **OpenAI Agents SDK** (`openai-agents`) | Agents, tools, handoffs, sessions |
| Inference | **Gemini free tier** via OpenAI-compatible endpoint | `gemini-3.7-flash` — free, multimodal |
| Verdict engine | Plain Python, zero dependencies | Free hot path; ports to TS for client-side |
| Fabric/image work | numpy + Pillow + scipy | Deterministic, local, free |
| Extension | TypeScript, Chrome MV3 | Reads the DOM of a page you're already on |

Gemini exposes an OpenAI-compatible endpoint, so the Agents SDK drives it
directly. Two required settings: `set_tracing_disabled(True)` (traces otherwise
upload to OpenAI and 401), and `OpenAIChatCompletionsModel` explicitly, because
the compat layer has no Responses API.

> **Note on the Claude Agent SDK.** It was the original plan and is a better
> harness, but it only authenticates against Anthropic API keys — it cannot be
> pointed at Gemini. On a zero-budget portfolio project the Agents SDK + Gemini
> free tier is the combination that actually runs. The agent layer is kept
> behind a provider interface so this can be revisited.

### The free-tier constraint that improved the design

Gemini's **image generation models have no free tier** — Nano Banana
(`gemini-2.5-flash-image`), Nano Banana 2 (`gemini-3.1-flash-image`) and Nano
Banana Pro are all paid-only. Text and vision *input* are free; image *output*
is not.

That rules out diffusion for the garment render — and it turns out to be the
right answer anyway. **For fabric, deterministic texture-mapping beats
diffusion**, because the print must be preserved *exactly* and diffusion models
are known to drift patterns. So the render is compositing: seamless tile →
garment template → displacement and shading. Free, fast, and print-exact.

The constraint pushed the design toward the technically better technique.

### Where agents earn their place

Agents are used where judgment is needed, not where arithmetic will do:

- **Catalogue ingestion** — deciding *which* of a SKU's six photos is the usable
  fabric shot, retrying when segmentation returns nonsense, handling the messy
  long tail. Genuine judgment.
- **Self-healing adapters** — when a marketplace redesign breaks the selector
  map, an agent inspects the live page and repairs the adapter.
- **Eval harness** — running the suite and writing up regressions.

Agents never touch the per-user hot path. That would cost money and latency and
would make the verdict non-deterministic.

## Status

**Built and verified**

- `core/colour.py` — CIELAB conversions, CIEDE2000, WCAG contrast. Zero deps.
- `core/palette.py` — 12 seasonal palettes, ITA depth, hue-angle undertone.
- `core/verdict.py` — colour, contrast and print-scale scoring with reasons.
- `render/flatlay.py` — **synthesises a kurta flat-lay from unstitched fabric.**
  Tile → displace → multiply → mask. Print-exact, CPU-only, ~0.4 s.
- `render/ood_eval.py` — motif-period estimation and print-drift measurement.
- `render/tryon.py` — swappable try-on backends (Leffa / FASHN).
- `demo/rang-nama.html` — the engine ported to JS, running client-side.
- **69 tests passing**, including all 30 CIEDE2000 reference pairs from
  Sharma et al. (2005) to 1e-4, and motif-period recovery within 10%.

**Next**

- Review the kurta renders by eye (the controls are reviewed; see Results)
- Replace the procedural garment template with maps from one photograph
- Stage 0/1: Khaadi adapter and fabric extraction (structure already mapped —
  Salesforce Commerce Cloud, `data-productid`, size-parameterised image CDN)
- Browser extension


## Results: does Leffa handle Pakistani ethnic wear?

40 generations on a free Kaggle T4 (~76 s each): 4 people x 5 garments x 2
`garment_type` settings. Four synthesised kurta flat-lays plus one control — a
Western top Leffa was actually trained on — so that a bad result can be told
apart from a broken setup.

### 1. Colour fidelity is not degraded

| Fabric | CIEDE2000 | vs control |
|---|---|---|
| lilac chiffon | 15.0 | **0.76x** |
| maroon khaddar | 18.2 | 0.92x |
| teal cambric | 18.3 | 0.92x |
| rust lawn | 20.7 | 1.05x |
| **all kurtas** | **18.1** | **0.91x** |

Every fabric sits at or within tolerance of the in-distribution control.
Whatever Leffa does to a Western top, it does no worse to a kurta.

### 2. `garment_type` controls garment length, and it matters

`dresses` renders a visibly longer garment than `upper_body` from identical
inputs — the same person, the same garment, the same seed. On the control tee
the difference is the hem sitting at the hip versus mid-thigh.

That is the setting a kurta needs, and it is a configuration change rather
than a retraining problem.

### 3. Print artifacts are the real quality gap

Florals show smeared petals and dropouts on some runs. The model is repainting
the print rather than transferring it — which is precisely the argument for
compositing in `render/flatlay.py`, where the print survives by construction.

## What this run got wrong, and how that surfaced

Worth recording, because the corrections are the useful part.

**The prediction was wrong.** SCHP labels clothing as "upper clothes" ending at
the waist, so `upper_body` was expected to truncate a kurta to a top over the
wearer's original trousers, with the mask reaching ~45% of frame height. It
reached 87-100%. No truncation.

**And the metric could not have detected it anyway.** `mask_bottom` measured a
fraction of *frame* height, but VITON-HD people are half-body shots cropped at
the upper thigh — 30 of 40 rows saturated at exactly 1.00. There is no frame
below the waist for a kurta to extend into. `mask_extent` now reports
`length_measurable` and refuses to draw a conclusion it cannot support.

**The control caught a threshold that was invented rather than calibrated.**
`delta_e_mean_max` was set to 10.0 on the reasoning that dE > 10 reads as a
different colour. True of two flat swatches; false when comparing a garment
photographed flat against the same garment worn, shaded and lit. The control
scored 19.7 — the in-distribution case failing the threshold that was supposed
to bound it. Absolute CIEDE2000 has no calibrated "good" value here, so
`compare_to_control` measures against the control instead.

**A background bug inflated every reading.** `compare_print` was called without
a source mask, so dominant colours were taken over the whole flat-lay and the
cream ground was the single largest "garment colour" at 49% of the image. The
comparison was substantially measuring backgrounds. `garment_region` now
derives a mask by sampling corner colour.

Two of these were only visible because the run included a control. An
experiment whose in-distribution baseline fails is measuring its instrument,
not its subject.

### Still untested

Whether kurtas truncate at the waist. It needs full-body photographs; the
standard benchmark's own images are cropped above the region where the failure
would appear.

## Why try-on needed a flat-lay synthesiser first

Every try-on model — CatVTON, Leffa, FASHN, Kling — transfers a **garment** onto
a person. An unstitched product photo is a flat bolt of printed cloth: no
garment, nothing to segment, nothing to warp. So the blocker for Tier C was
never the try-on model, which is commodity. It was that no garment existed to
transfer. `render/flatlay.py` manufactures one.

It composites rather than generates, because the print must survive *exactly* —
a generative model redraws it, and redrawn florals drift in motif scale and hue,
which would silently invalidate the CIEDE2000 numbers the verdict engine reports
about that same fabric. Nothing warns you when that happens.

Motif scale is rendered at true relative size, so the same print visibly fills
more of a petite garment than a tall one. The print-scale verdict and the
picture agree because they are computed from the same number.

## Design notes worth reading

Two decisions are documented at length in the source because they are the ones
worth arguing with:

**Seasonal analysis is calibrated on European colouring** (`core/palette.py`).
Applied unmodified to South Asian skin it lands ~80% of users in "Deep Autumn" —
technically defensible, practically useless. Depth therefore uses the
**Individual Typology Angle** (the dermatology standard) rather than raw
lightness, and undertone uses **CIELAB hue angle** rather than a b\*/a\* ratio,
because essentially all human skin sits between 1.5 and 3.0 on that ratio and a
ratio threshold makes "cool" unreachable. Olive is treated as its own undertone.

Before: 2 distinct seasons across 8 test users. After: 5.

**Contrast partially collapses in this market.** Nearly everyone has black hair,
so hair–skin contrast correlates strongly with skin depth rather than carrying
independent information. It is scored separately and weighted modestly, and this
is an open item for the blind-panel eval rather than something to hand-tune.

## Running it

```bash
python -m pip install -e ".[dev]"
python -m pytest tests/ -q
```

The verdict engine needs no API key. Only the agent layer does.

## Evaluation

Stage-level, because errors compound invisibly through a chain like this.

| Stage | Metric | Target |
|---|---|---|
| Colour maths | CIEDE2000 vs Sharma reference | exact to 1e-4 — **passing** |
| Colour extraction | ΔE vs hand-sampled swatches | ΔE < 5, report the distribution |
| Fabric segmentation | IoU vs hand-labelled masks | ~100 SKUs |
| Tiling | edge discontinuity across the wrap | — |
| Colour verdict | blind stylist panel, bad pairings as controls | agreement rate |
| Render | motif scale + dominant colour drift vs source tile | — |
| Cost | simulated 40-product browse | **zero** tier-3 calls |
