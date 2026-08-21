"""Stage 4b - try-on backends.

Deliberately thin. Try-on is the commodity half of this pipeline: several models
do it competently and they are interchangeable behind one call. The valuable
half is `flatlay`, which manufactures the garment these models require and which
nothing off the shelf provides for unstitched cloth.

Backends are kept swappable because the choice is driven by licensing and
hosting, not by this code:

* **Leffa** - MIT, so commercial use stays open. Needs a GPU; free Kaggle gives
  roughly 30 GPU-hours a week, which is ample for batch work.
* **CatVTON / IDM-VTON** - CC BY-NC-SA. Non-commercial only. Fine for a
  portfolio, a licence breach the moment affiliate revenue appears.
* **FASHN** - hosted API, best print fidelity, ~$0.075 a generation. Server-side
  key, never in client code.

Nothing here runs per user request. See the cost architecture in README.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image


@dataclass(frozen=True)
class TryOnRequest:
    """One try-on: put `garment` on `person`."""

    person: Image.Image
    garment: Image.Image
    # Leffa's agnostic-mask builder takes a garment type. For a kurta this is
    # the crux of the out-of-distribution problem: human parsers label clothing
    # as "upper clothes" ending at the waist, while a kurta reaches mid-thigh.
    # "dresses" usually masks a longer region and is the better starting guess.
    garment_type: str = "dresses"
    steps: int = 30
    guidance_scale: float = 2.5
    seed: int = 42


@dataclass(frozen=True)
class TryOnResult:
    image: Image.Image
    backend: str
    seconds: float
    meta: dict


class TryOnBackend(Protocol):
    name: str

    def run(self, request: TryOnRequest) -> TryOnResult: ...


class LeffaBackend:
    """Leffa (MIT). Requires a CUDA GPU and the Leffa checkpoints.

    Import-time cost is deliberately deferred: this module must stay importable
    on a machine with no GPU and no Leffa checkout, so the heavy imports live
    inside `_load` rather than at the top of the file.
    """

    name = "leffa"

    def __init__(self, repo_root: str | Path, checkpoint: str = "virtual_tryon.pth"):
        self.repo_root = Path(repo_root)
        self.checkpoint = checkpoint
        self._inference = None
        self._parsing = None
        self._openpose = None
        self._densepose = None
        self._transform = None

    def _load(self) -> None:
        if self._inference is not None:
            return

        import sys

        sys.path.insert(0, str(self.repo_root))

        from leffa.inference import LeffaInference
        from leffa.model import LeffaModel
        from leffa.transform import LeffaTransform
        from leffa_utils.densepose_predictor import DensePosePredictor
        from preprocess.humanparsing.run_parsing import Parsing
        from preprocess.openpose.run_openpose import OpenPose

        ckpts = self.repo_root / "ckpts"
        model = LeffaModel(
            pretrained_model_name_or_path=str(ckpts / "stable-diffusion-inpainting"),
            pretrained_model=str(ckpts / self.checkpoint),
            dtype="float16",
        )
        self._inference = LeffaInference(model=model)
        self._transform = LeffaTransform()
        self._parsing = Parsing(atr_path=str(ckpts / "humanparsing/parsing_atr.onnx"),
                                lip_path=str(ckpts / "humanparsing/parsing_lip.onnx"))
        self._openpose = OpenPose(body_model_path=str(ckpts / "openpose/body_pose_model.pth"))
        self._densepose = DensePosePredictor(
            config_path=str(ckpts / "densepose/densepose_rcnn_R_50_FPN_s1x.yaml"),
            weights_path=str(ckpts / "densepose/model_final_162be9.pkl"),
        )

    def run(self, request: TryOnRequest) -> TryOnResult:
        import time

        import numpy as np

        from leffa_utils.utils import get_agnostic_mask_hd, resize_and_center

        self._load()
        started = time.perf_counter()

        person = resize_and_center(request.person, 768, 1024)
        garment = resize_and_center(request.garment, 768, 1024)

        model_parse, _ = self._parsing(person.resize((384, 512)))
        keypoints = self._openpose(person.resize((384, 512)))
        mask = get_agnostic_mask_hd(model_parse, keypoints, request.garment_type)
        mask = mask.resize((768, 1024))

        seg = self._densepose.predict_seg(np.array(person))[:, :, ::-1]
        densepose = Image.fromarray(seg)

        data = self._transform({
            "src_image": [person],
            "ref_image": [garment],
            "mask": [mask],
            "densepose": [densepose],
        })

        output = self._inference(
            data,
            ref_acceleration=False,
            num_inference_steps=request.steps,
            guidance_scale=request.guidance_scale,
            seed=request.seed,
            repaint=False,
        )

        return TryOnResult(
            image=output["generated_image"][0],
            backend=self.name,
            seconds=time.perf_counter() - started,
            # The mask is kept because it is the diagnostic that matters for the
            # kurta problem: if it stops at the waist, the model was never given
            # the chance to render a full-length garment.
            meta={"mask": mask, "garment_type": request.garment_type},
        )


class FashnBackend:
    """Hosted FASHN API. Key must stay server-side, never in client code."""

    name = "fashn"

    def __init__(self, api_key: str, base_url: str = "https://api.fashn.ai/v1"):
        if not api_key:
            raise ValueError("FASHN api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def run(self, request: TryOnRequest) -> TryOnResult:  # pragma: no cover - network
        raise NotImplementedError(
            "FASHN backend is a stub. Wire it only if you decide to pay per generation; "
            "the Leffa path is the free one."
        )
