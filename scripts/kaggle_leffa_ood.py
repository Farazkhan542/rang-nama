"""Does Leffa handle Pakistani ethnic wear? Run this on a free Kaggle GPU.

Paste each `# %%` block into its own Kaggle cell. Kaggle gives roughly 30 GPU
hours a week free, which is far more than Colab or HF ZeroGPU, and Leffa is MIT
so nothing here forecloses commercial use later.

WHAT THIS TESTS, AND THE PREDICTION IT CHECKS
---------------------------------------------
Leffa builds its inpainting region with `get_agnostic_mask_hd(parse, keypoints,
garment_type)`, where the parse comes from SCHP - trained on ATR and LIP, whose
clothing label is "upper clothes" and ends at the waist. A kurta reaches
mid-thigh.

Prediction: with `garment_type="upper_body"` the mask stops around 45% of frame
height and the output is a kurta-*top* over the wearer's original trousers.
`garment_type="dresses"` should mask a longer region and do better.

If that holds, the fix is not prompt tuning or more diffusion steps - it is the
mask, and it is fixable without retraining anything.

The eval measures three things separately so a failure names its own cause:
mask reach, print colour drift (CIEDE2000), and motif rescaling.
"""

# %% [markdown]
# ## 1. Setup — Leffa, dependencies, checkpoints
#
# Runs on Kaggle or Colab. Kaggle is the better fit here for three reasons that
# only bite on a job like this one:
#
# * **Quota is guaranteed.** Kaggle gives a fixed 30 GPU-hours a week that reset
#   on schedule. Colab's 15–30 is dynamic and unpublished, and at peak times a
#   GPU request can silently return CPU.
# * **The 90-minute idle disconnect.** Colab reclaims the VM if you stop
#   interacting, which on this job means losing a ~10 GB download you already
#   waited for. Kaggle sessions run 9 hours without babysitting.
# * **Checkpoint caching is easier.** Kaggle datasets attach instantly; on Colab
#   you cache to Drive, and the free 15 GB is tight against ~10 GB of weights.
#
# Colab is still perfectly usable, and running both gets you ~60 GPU-hours a
# week free. The cells below detect the platform.

# %%
import os
import sys
from pathlib import Path

# Detect Kaggle FIRST, and never test for Colab by the presence of the
# google.colab package or a /content directory: Kaggle images ship both, so
# either test misfires there. /var/colab/hostname is the marker google.colab
# itself checks before mounting Drive, which makes it the honest signal.
IS_KAGGLE = os.path.exists("/kaggle/working") or "KAGGLE_KERNEL_RUN_TYPE" in os.environ
IS_COLAB = not IS_KAGGLE and os.path.exists("/var/colab/hostname")

if IS_KAGGLE:
    ROOT = Path("/kaggle/working/Leffa")
    CKPT_CACHE = None          # attach the weights as a Kaggle dataset instead
    WORK = Path("/kaggle/working/out")
elif IS_COLAB:
    from google.colab import drive
    drive.mount("/content/drive")
    # Cache weights on Drive so a disconnect does not cost another 10 GB pull.
    ROOT = Path("/content/Leffa")
    CKPT_CACHE = Path("/content/drive/MyDrive/leffa_ckpts")
    WORK = Path("/content/out")
else:
    ROOT = Path("./Leffa")
    CKPT_CACHE = Path("./leffa_ckpts")
    WORK = Path("./out")

WORK.mkdir(parents=True, exist_ok=True)
print(f"colab={IS_COLAB} kaggle={IS_KAGGLE}  root={ROOT}")

# %%
# Kaggle: Settings -> Accelerator -> GPU T4 x2, Internet -> On.
# Colab:  Runtime -> Change runtime type -> T4 GPU.
!nvidia-smi --query-gpu=name,memory.total --format=csv
!git clone -q https://github.com/franciszzj/Leffa.git {ROOT} || echo "already cloned"
%cd {ROOT}
!pip install -q -r requirements.txt

# %% [markdown]
# ### detectron2 — the single most likely thing to break
#
# DensePose needs detectron2, which is not on PyPI and compiles against whatever
# torch is installed. Colab's preinstalled torch moves faster than detectron2
# supports, so this is where a Colab run usually fails. If the build errors,
# pin torch to the version in Leffa's `requirements.txt` and rebuild — do not
# skip it, DensePose is required and Leffa will not run without it.

# %%
!pip install -q "git+https://github.com/facebookresearch/detectron2.git"

import torch
print("torch", torch.__version__, "| cuda", torch.cuda.is_available())

# Check the GPU architecture against what this torch build actually ships
# kernels for. Kaggle hands out P100s (sm_60, Pascal) as well as T4s (sm_75),
# and recent torch wheels no longer include Pascal kernels. Without this check
# every CUDA op raises "no kernel image is available for execution on the
# device" — and it surfaces inside OpenPose, ten cells and twenty minutes from
# anything that looks like the cause.
if torch.cuda.is_available():
    name = torch.cuda.get_device_name(0)
    major, minor = torch.cuda.get_device_capability(0)
    arches = torch.cuda.get_arch_list()
    print(f"gpu {name} | sm_{major}{minor} | torch builds: {arches}")
    if f"sm_{major}{minor}" not in arches:
        print(f"{name} is sm_{major}{minor}, and this torch build has no")
        print(f"kernels for it. Available: {arches}")
        print("Fix: Settings -> Accelerator -> GPU T4 x2, then re-run from cell 1.")
        print("Checkpoints in /kaggle/working survive the restart.")
        raise SystemExit("unsupported GPU architecture")
else:
    raise SystemExit("No GPU. Settings -> Accelerator -> GPU T4 x2.")

try:
    import detectron2
    print("detectron2", detectron2.__version__, "OK")
except ImportError as exc:
    raise SystemExit(f"detectron2 unavailable — DensePose cannot run: {exc}")

# %%
from huggingface_hub import snapshot_download

CKPTS = ROOT / "ckpts"

# The full repo is 34 GiB and will not fit in Kaggle's 20 GiB /kaggle/working.
# Most of that is weight we never touch:
#
#   pose_transfer.pth      19.4 GiB  - pose transfer, not try-on
#   virtual_tryon_dc.pth    6.7 GiB  - the DressCode variant; we use VITON-HD
#   schp/*.pth              0.5 GiB  - superseded by the ONNX parsers below
#
# Note that stable-diffusion-inpainting/ here is *configs only* - three small
# JSON files. The actual diffusion weights live inside virtual_tryon.pth, so
# there is no separate Stable Diffusion download.
ALLOW = [
    "virtual_tryon.pth",                 # VITON-HD try-on weights (6.7 GiB)
    "humanparsing/*",                    # SCHP parsers, ONNX (0.5 GiB)
    "densepose/*",                       # DensePose weights + configs
    "openpose/*",                        # body pose model
    "stable-diffusion-inpainting/*",     # configs the model loader expects
    "examples/*",                        # bundled people and garments
]

# Check the destination first. On Kaggle CKPT_CACHE is None, so without this
# guard a re-run falls straight through to `rm -rf` and re-downloads 7.7 GiB
# that is already sitting on disk — and attaching a dataset restarts the
# kernel, which makes a re-run of this cell the normal case, not the rare one.
if (CKPTS / "virtual_tryon.pth").exists():
    print(f"checkpoints already present at {CKPTS} — skipping download")
elif CKPT_CACHE and (CKPT_CACHE / "virtual_tryon.pth").exists():
    print(f"reusing cached checkpoints from {CKPT_CACHE}")
    !ln -sfn {CKPT_CACHE} {CKPTS}
else:
    target = CKPT_CACHE or CKPTS
    # Clear any partial download from a previous failed attempt, or its
    # leftovers eat the disk budget this fix is trying to free.
    !rm -rf {target}
    snapshot_download(repo_id="franciszzj/Leffa", local_dir=str(target),
                      allow_patterns=ALLOW, max_workers=4)
    if CKPT_CACHE:
        !ln -sfn {CKPT_CACHE} {CKPTS}

!du -sh {CKPTS}/ 2>/dev/null || true
!df -h /kaggle/working 2>/dev/null | tail -1 || df -h . | tail -1

# %%
# The fabric_advisor package. Two ways in, tried in order, so a failed dataset
# upload does not strand the run:
#
#   1. A Kaggle dataset  - Add Input -> Upload -> dist/fabric-advisor.zip
#   2. git clone         - only if the GitHub repo is public
#
# No token goes in this notebook either way. Putting a GitHub token in a cell
# is how tokens leak, and notebook outputs are saved with the version.
GITHUB_REPO = "https://github.com/Farazkhan542/rang-nama.git"

CODE = None

# 1. Attached Kaggle dataset. Glob rather than assume a slug: Kaggle normalises
#    dataset names, and the zip may or may not preserve the src/ wrapper.
hits = sorted(Path("/kaggle/input").glob("**/fabric_advisor/__init__.py")) if IS_KAGGLE else []
if hits:
    CODE = hits[0].parents[1]
    print(f"using attached dataset: {hits[0]}")

# 2. Public repo. Run git through subprocess and surface stderr: suppressing
#    it means a clone that failed for an unrelated reason (a full disk, most
#    likely on Kaggle) looks identical to a repo that is simply private, and
#    the error then points at the wrong thing.
if CODE is None:
    import shutil
    import subprocess

    clone_to = Path("/kaggle/working/code" if IS_KAGGLE else "./code")
    if not (clone_to / "src" / "fabric_advisor" / "__init__.py").exists():
        shutil.rmtree(clone_to, ignore_errors=True)
        r = subprocess.run(
            ["git", "clone", "--depth", "1", GITHUB_REPO, str(clone_to)],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print("git clone failed, exit", r.returncode)
            print(r.stderr.strip())
            print(subprocess.run(["df", "-h", "/kaggle/working"],
                                 capture_output=True, text=True).stdout)
    if (clone_to / "src" / "fabric_advisor" / "__init__.py").exists():
        CODE = clone_to / "src"
        print(f"using cloned repo: {CODE}")

if CODE is None:
    print("fabric_advisor not available.")
    print("  Option A: Add Input -> Upload -> dist/fabric-advisor.zip, then re-run.")
    print(f"  Option B: make {GITHUB_REPO} public, then re-run.")
    print(f"  Attached inputs: {[d.name for d in Path('/kaggle/input').glob('*')]}")
    raise SystemExit("fabric_advisor not available")

!pip install -q numpy scipy pillow

sys.path.insert(0, str(CODE))
from fabric_advisor.render.flatlay import synthetic_template  # noqa: F401
print("code loaded from", CODE)

# %% [markdown]
# ## 2. Build kurta flat-lays from fabric prints
#
# This is the step that makes the test possible at all: Leffa needs a *garment*
# image, and unstitched fabric is a flat bolt. Synthesise the garment first.

# %%
from PIL import Image

from fabric_advisor.render.flatlay import (
    seamless_tile_from_colours, synthesise_flatlay, synthetic_template,
)

OUT = WORK
template = synthetic_template(width=768, height=1024)

FABRICS = [
    ("rust_lawn",     [("#b5651d", .45), ("#d4a017", .30), ("#f5e6c8", .25)],  9.0, "floral"),
    ("teal_cambric",  [("#0f6f6c", .50), ("#f2efe6", .35), ("#123b4a", .15)],  2.2, "geometric"),
    ("maroon_khaddar",[("#5c1a24", .42), ("#141013", .33), ("#c8a15a", .25)], 14.5, "floral"),
    ("lilac_chiffon", [("#cbb8dd", .70), ("#b9a6cc", .30)],                   None, "solid"),
]

garments = {}
for name, cols, motif_cm, motif in FABRICS:
    tile = seamless_tile_from_colours(cols, size=256, motif=motif)
    img = synthesise_flatlay(tile, template, motif_cm, frame="average")
    img.save(OUT / f"garment_{name}.png")
    garments[name] = (img, motif_cm)
    print(f"{name:<16} motif={motif_cm} cm -> {img.size}")

# %% [markdown]
# ## 3. People — no personal photos required
#
# Leffa ships its own example people and garments, and they arrive with the
# checkpoints in step 1. Nothing to upload.
#
# This is not merely a privacy convenience, it is the better experiment. The
# inpainting region comes from SCHP parsing the *person* plus `garment_type`;
# whether that region stops at the waist has nothing to do with who is in the
# photograph. So the truncation prediction is fully answerable on stock images,
# and using them removes ethnicity as a confound while we isolate the garment.
#
# Set `USE_OWN_PHOTOS = True` later if you want to check the model holds up on
# South Asian full-body shots specifically. Keep those private and out of git.

# %%
USE_OWN_PHOTOS = False

EXAMPLES = ROOT / "ckpts" / "examples"

if USE_OWN_PHOTOS:
    PEOPLE_DIR = (Path("/content/drive/MyDrive/tryon_people") if IS_COLAB
                  else Path("/kaggle/input/tryon-people"))
    people = sorted(p for p in PEOPLE_DIR.glob("*")
                    if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    assert people, f"No photos in {PEOPLE_DIR}. Add full-body, front-facing images."
else:
    people = sorted(
        p for folder in ("person1", "person2")
        for p in (EXAMPLES / folder).glob("*")
        if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    assert people, (
        f"No bundled examples under {EXAMPLES}. Confirm the checkpoint download "
        "finished — examples/ ships alongside the weights."
    )

print(f"{len(people)} people ({'your own' if USE_OWN_PHOTOS else 'Leffa examples'}):")
for p in people[:8]:
    print("   ", p.relative_to(ROOT) if ROOT in p.parents else p.name)

# Control garment: a Western top Leffa was actually trained on. Running this
# alongside the kurtas is what makes the result interpretable — if the control
# also fails, the problem is the setup, not the garment category.
control_garments = sorted(
    p for p in (EXAMPLES / "garment").glob("*")
    if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
)
print(f"\n{len(control_garments)} control garments:", [p.name for p in control_garments[:4]])

# %% [markdown]
# ## 4. Run try-on
#
# Two variables, changed one at a time:
#
# * **`garment_type`**: `upper_body` vs `dresses`. This is the experiment, not a
#   parameter sweep — it decides whether the kurta problem is a masking bug
#   (fixable today) or a model limitation (needs retraining).
# * **`condition`**: `control` uses a Western top Leffa was trained on; `kurta`
#   uses our synthesised flat-lay. Without the control, a bad result is
#   ambiguous — you cannot tell a garment-category problem from a broken setup.

# %%
from fabric_advisor.render.tryon import LeffaBackend, TryOnRequest

backend = LeffaBackend(repo_root=ROOT)

jobs = [("control", p.stem, Image.open(p).convert("RGB"), None)
        for p in control_garments[:1]]
jobs += [("kurta", name, img, motif_cm)
         for name, (img, motif_cm) in garments.items()]

results = []
failures = 0
for person_path in people[:4]:
    person = Image.open(person_path).convert("RGB")
    for condition, garment_name, garment, motif_cm in jobs:
        for garment_type in ("upper_body", "dresses"):
            req = TryOnRequest(person=person, garment=garment,
                               garment_type=garment_type, steps=30, seed=42)
            try:
                res = backend.run(req)
            except Exception:
                # Print the traceback, not just str(exc). A bare message turns
                # an ImportError deep in a preprocessor into "FAILED", and the
                # run then dies 40 iterations later with an empty DataFrame.
                import traceback
                print(f"FAILED {person_path.stem} {garment_name} {garment_type}")
                traceback.print_exc()
                failures += 1
                if failures >= 3:
                    raise SystemExit(
                        "Three generations failed identically - stopping rather "
                        "than burning GPU time on 37 more. Fix the error above."
                    )
                continue

            stem = f"{person_path.stem}__{condition}_{garment_name}__{garment_type}"
            res.image.save(OUT / f"tryon_{stem}.png")
            res.meta["mask"].save(OUT / f"mask_{stem}.png")
            results.append({
                "person": person_path.stem, "condition": condition,
                "fabric": garment_name, "garment_type": garment_type,
                "motif_cm": motif_cm, "result": res.image,
                "mask": res.meta["mask"], "source": garment, "seconds": res.seconds,
            })
            print(f"  {stem}  {res.seconds:.1f}s")

print(f"\n{len(results)} generations")

# %% [markdown]
# ## 5. Score it
#
# Numbers, not impressions. Each metric names a distinct failure so the fix is
# obvious from the report.

# %%
from fabric_advisor.render.ood_eval import compare_print, mask_extent, verdict

rows = []
for r in results:
    extent = mask_extent(r["mask"])
    metrics = compare_print(r["source"], r["result"], None, r["mask"])
    ok, problems = verdict(metrics, extent)
    rows.append({
        "person": r["person"], "condition": r["condition"],
        "fabric": r["fabric"], "type": r["garment_type"],
        "mask_bottom": round(extent["bottom_fraction"] or 0, 2),
        "dE_mean": metrics.get("delta_e_mean"),
        "scale_ratio": metrics.get("motif_scale_ratio"),
        "pass": ok, "problems": "; ".join(problems),
    })

if not rows:
    raise SystemExit(
        "No results to score - cell 4 produced nothing. Scroll up for the "
        "traceback from the first failed generation; that is the real error."
    )

import pandas as pd

df = pd.DataFrame(rows)
df.to_csv(OUT / "ood_report.csv", index=False)
display(df)

print("\n=== THE PREDICTION: mask reach by garment_type ===")
print(df.groupby("type")["mask_bottom"].agg(["mean", "min", "max"]).round(3))

print("\n=== control vs kurta (is it the garment, or the setup?) ===")
print(df.groupby(["condition", "type"])[["mask_bottom", "dE_mean"]].mean().round(2))

print("\n=== pass rate ===")
print(df.groupby(["condition", "type"])["pass"].agg(["sum", "count"]))

# %% [markdown]
# ## 6. Look at them
#
# The numbers catch colour and scale drift. They do not catch a hand rendered as
# a claw, a dupatta fused to a shoulder, or a face that stopped being yours.
# Eyes are still required.

# %%
import matplotlib.pyplot as plt

show = results[:8]
fig, axes = plt.subplots(3, len(show), figsize=(3.2 * len(show), 10))
for i, r in enumerate(show):
    for j, (img, label) in enumerate((
        (r["source"], "garment"), (r["mask"], "mask"), (r["result"], "try-on"))):
        ax = axes[j, i]
        ax.imshow(img, cmap="gray" if label == "mask" else None)
        ax.set_title(f"{r['fabric']}\n{r['garment_type']}" if j == 0 else label, fontsize=8)
        ax.axis("off")
plt.tight_layout()
plt.savefig(OUT / "contact_sheet.png", dpi=110)
plt.show()

# %% [markdown]
# ## How to read the result
#
# **`mask_bottom` near 0.45 on `upper_body`, materially higher on `dresses`** —
# prediction confirmed. The kurta problem is a masking bug, not a model
# limitation. Use `dresses`, or build a kurta-aware mask from the SCHP parse
# directly. No retraining needed.
#
# **`mask_bottom` low on both** — the parser cannot see a kurta as one garment.
# You need a custom mask: union the "upper clothes" and "skirt/dress" labels,
# extend to the knee line from OpenPose keypoints.
#
# **Masks fine, `dE_mean` above 10** — the model is repainting the print rather
# than transferring it. That directly undermines the colour verdict, and it is
# the case for compositing over generation.
#
# **`scale_ratio` outside 0.75–1.25** — the print is rendered at the wrong
# repeat, so any verdict stated in centimetres is void.
#
# **Everything passes but the images look wrong** — the failure is anatomy or
# dupatta handling, which no metric here captures. Say so plainly in the
# write-up; a documented known-failure list is worth more than a claimed win.
