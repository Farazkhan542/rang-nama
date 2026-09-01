"""The mirror: you, wearing a Khaadi outfit.

Paste each `# %%` block into a Kaggle cell. GPU T4 x2, Internet on.

WHAT THIS DOES, AND WHY IT IS NOT IN THE EXTENSION

Given a Khaadi product URL and a photograph of you, this produces an image of
you wearing that outfit. It takes about 80 seconds per garment on a T4, which
is why it cannot live in a browser: there is no free, keyless, in-page way to
run a diffusion model, and a paid key shipped inside an extension is a public
key.

WHAT CHANGED FROM THE EARLIER NOTEBOOK

The first version synthesised a flat-lay from a fabric print, on the premise
that unstitched cloth is photographed flat and a garment has to be manufactured
from it before a try-on model can use it.

That premise is wrong for Khaadi. They photograph every piece on a model,
including the unstitched ones - so the product image is already a
garment-on-model shot, which is exactly what Leffa wants as its reference. The
flat-lay synthesiser solves a problem this retailer does not have.

So: their photograph is the garment, yours is the person.
"""

# %% [markdown]
# ## 1. Setup
#
# Same as the evaluation notebook. If you have already run that in this
# session, skip to section 2.

# %%
import os
import subprocess
import sys
from pathlib import Path

IS_KAGGLE = os.path.exists("/kaggle/working") or "KAGGLE_KERNEL_RUN_TYPE" in os.environ
ROOT = Path("/kaggle/working/Leffa") if IS_KAGGLE else Path("./Leffa")
WORK = Path("/kaggle/working/mirror") if IS_KAGGLE else Path("./mirror")
WORK.mkdir(parents=True, exist_ok=True)
print(f"kaggle={IS_KAGGLE} root={ROOT}")

# %%
!nvidia-smi --query-gpu=name,memory.total --format=csv

import torch
if torch.cuda.is_available():
    major, minor = torch.cuda.get_device_capability(0)
    arches = torch.cuda.get_arch_list()
    print(f"gpu {torch.cuda.get_device_name(0)} | sm_{major}{minor}")
    if f"sm_{major}{minor}" not in arches:
        print("This torch build has no kernels for that GPU.")
        print("Settings -> Accelerator -> GPU T4 x2, then re-run from cell 1.")
        raise SystemExit("unsupported GPU architecture")
else:
    raise SystemExit("No GPU. Settings -> Accelerator -> GPU T4 x2.")

# %%
!git clone -q https://github.com/franciszzj/Leffa.git {ROOT} || echo "already cloned"
%cd {ROOT}
!pip install -q -r requirements.txt
!pip install -q "git+https://github.com/facebookresearch/detectron2.git"

# %%
from huggingface_hub import snapshot_download

CKPTS = ROOT / "ckpts"
ALLOW = [
    "virtual_tryon.pth", "humanparsing/*", "densepose/*", "openpose/*",
    "stable-diffusion-inpainting/*", "examples/*",
]
if (CKPTS / "virtual_tryon.pth").exists():
    print(f"checkpoints already present at {CKPTS}")
else:
    snapshot_download(repo_id="franciszzj/Leffa", local_dir=str(CKPTS),
                      allow_patterns=ALLOW, max_workers=4)
!du -sh {CKPTS}/ 2>/dev/null || true

# %%
CODE = Path("/kaggle/working/code")
if not (CODE / "src" / "fabric_advisor" / "__init__.py").exists():
    subprocess.run(["git", "clone", "--depth", "1",
                    "https://github.com/Farazkhan542/rang-nama.git", str(CODE)],
                   check=False)
sys.path.insert(0, str(CODE / "src"))
!pip install -q numpy scipy pillow
print("code loaded")

# %% [markdown]
# ## 2. Your photograph
#
# **This needs a full-body, front-facing photo** - not a selfie. The model has
# to see your torso, arms and hips to place a garment on them; from a
# head-and-shoulders shot there is nowhere for a kurta to go.
#
# Stand square to the camera, arms slightly away from your sides, against a
# plain wall, in even light. Attach it as a private Kaggle dataset called
# `me-photo` (Add Input -> Upload).

# %%
from PIL import Image

PEOPLE = Path("/kaggle/input/me-photo") if IS_KAGGLE else Path("./me")
photos = sorted(p for p in PEOPLE.glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
assert photos, (
    f"No photo found in {PEOPLE}. Add Input -> Upload -> a full-body photo, "
    "dataset name 'me-photo'."
)

person = Image.open(photos[0]).convert("RGB")
print(f"{photos[0].name}  {person.size[0]}x{person.size[1]}")

w, h = person.size
if h / w < 1.2:
    print("\nWARNING: this looks wide for a full-body shot. A head-and-shoulders")
    print("photo will not work - the model needs to see your torso and hips.")
person.resize((person.width // 2, person.height // 2))

# %% [markdown]
# ## 3. The outfits
#
# Paste Khaadi product URLs. The garment image is taken straight from the page:
# Khaadi already photographs on a model, so nothing needs synthesising.

# %%
import re
import urllib.request

URLS = [
    "https://pk.khaadi.com/fabrics-3-piece/A22-26-201FC1-VG_MULTI.html",
    "https://pk.khaadi.com/fabrics-3-piece/A11-26-216FA1-VG_MULTI.html",
]

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def sku_stems(sku):
    low = sku.lower()
    out = []
    for candidate in (low, re.sub(r"^[a-z]-", "", low)):
        m = re.match(r"^(.*?)-[a-z]{2}[_-]", candidate)
        stem = m.group(1) if m else candidate.split("_")[0]
        if len(stem) >= 6:
            out.append(stem)
    return out


def garment_from(url):
    """Best garment photograph for one product page."""
    req = urllib.request.Request(url, headers=UA)
    html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")

    sku = re.search(r"/([A-Z0-9][A-Z0-9\-_]{6,})\.html", url).group(1)
    stems = sku_stems(sku)

    found = {}
    for m in re.finditer(r"[^\"'\s(]*hi-res[^\"'\s)]*\.jpg", html, re.I):
        u = m.group(0)
        if "demandware" not in u:
            continue
        u = u if u.startswith("http") else "https://pk.khaadi.com" + u
        f = u.split("/")[-1].split("?")[0]
        found.setdefault(f, u)

    mine = {f: u for f, u in found.items() if any(f.startswith(s) for s in stems)}
    if not mine:
        mine = {f: u for f, u in found.items() if not f.startswith("t-")}

    # _2 is usually the torso crop: the garment fills the frame, which is what
    # a try-on model wants as a reference.
    order = sorted(mine, key=lambda f: abs(int(re.search(r"_(\d+)\.jpg$", f).group(1)) - 2)
                   if re.search(r"_(\d+)\.jpg$", f) else 99)
    pick = mine[order[0]]
    pick = re.sub(r"sw=\d+", "sw=768", re.sub(r"sh=\d+", "sh=1024", pick))

    data = urllib.request.urlopen(urllib.request.Request(pick, headers=UA), timeout=60).read()
    from io import BytesIO
    return sku, order[0], Image.open(BytesIO(data)).convert("RGB")


garments = {}
for url in URLS:
    sku, fname, img = garment_from(url)
    garments[sku] = img
    img.save(WORK / f"garment_{sku}.jpg")
    print(f"{sku:<26} {fname:<34} {img.size[0]}x{img.size[1]}")

# %% [markdown]
# ## 4. The mirror
#
# `garment_type="dresses"` rather than `"upper_body"`. Measured in the earlier
# evaluation, `dresses` masks a longer region on every one of 40 generations,
# which is what a kurta needs - `upper_body` stops short and leaves your own
# trousers showing through.

# %%
import time

from fabric_advisor.render.tryon import LeffaBackend, TryOnRequest

backend = LeffaBackend(repo_root=ROOT)

results = []
for sku, garment in garments.items():
    started = time.perf_counter()
    try:
        res = backend.run(TryOnRequest(
            person=person, garment=garment,
            garment_type="dresses", steps=30, seed=42,
        ))
    except Exception:
        import traceback
        print(f"FAILED {sku}")
        traceback.print_exc()
        continue

    out = WORK / f"mirror_{sku}.png"
    res.image.save(out)
    results.append((sku, garment, res.image))
    print(f"  {sku}  {time.perf_counter() - started:.0f}s  -> {out.name}")

print(f"\n{len(results)} images in {WORK}")

# %% [markdown]
# ## 5. Look at them
#
# Three panels each: the garment, you, and you in it.

# %%
import matplotlib.pyplot as plt

if results:
    fig, axes = plt.subplots(len(results), 3, figsize=(11, 5.2 * len(results)))
    if len(results) == 1:
        axes = [axes]
    for row, (sku, garment, out) in zip(axes, results):
        for ax, (img, title) in zip(row, [(garment, "the outfit"),
                                          (person, "you"),
                                          (out, "you in it")]):
            ax.imshow(img)
            ax.set_title(title, fontsize=10)
            ax.axis("off")
        row[0].set_ylabel(sku)
    plt.tight_layout()
    plt.savefig(WORK / "mirror_sheet.png", dpi=110, bbox_inches="tight")
    plt.show()

# %% [markdown]
# ## What to expect
#
# Leffa is trained on VITON-HD and DressCode: Western tops, on slim Western
# models, in studio light. A shalwar kameez is out of distribution on shape,
# length and drape, and a phone photograph of you in a room is out of
# distribution on everything else.
#
# The earlier evaluation measured colour fidelity on ethnic wear as **not
# degraded** relative to that in-distribution baseline, so the print should
# transfer honestly. What no metric there covered was anatomy: hands render
# badly, and a dupatta may fuse to a shoulder. Look for those, and if the
# result is unusable say so rather than shipping it - a documented failure
# reads better than a cherry-picked win.
#
# The single biggest lever on quality is your input photograph: full body,
# facing the camera, arms clear of your sides, plain background, even light.
