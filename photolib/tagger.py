"""LiquidAI d1-3B subject tagger: lazy, thread-safe singleton.

d1 answers yes/no ("noul") questions about an image in ONE forward pass: the image is the shared trunk and
each question is a branch that attends to the trunk and itself only, so questions don't compete and the
cost is ~264 ms for the image + ~1.4 ms per question (RTX 4080, bf16, 1600 px input -> 6 tiles + thumbnail).
P(yes) is read off the yes/no logits; nothing is generated.

* Loaded from the local dir `models/d1-3B` (`PHOTOLIB_TAGGER_DIR` overrides) with `trust_remote_code=True`
  (runs the model's own Python files from that dir), bf16 on CUDA, fp32 on CPU. Never fp16.
* ~6.2 GB of VRAM, so the indexer calls `unload()` when a tag pass ends instead of holding it idle.
* `model.engine` is a cached_property and the runner is not re-entrant: every call holds `_lock`.
"""

from __future__ import annotations

import gc
import threading
from pathlib import Path
from typing import Mapping, Sequence

from PIL import Image, ImageOps

from . import config
from .embedder import torch_device
from .labels import questions_for
from .remote import RemoteModelError, image_b64, post_json


def load_for_tagging(path: str | Path, max_side: int = config.TAG_MAX_SIDE) -> Image.Image:
    """Loads an image as d1 should see it.

    d1's runner then bounds it to 1 MP and its processor tiles it (512 px tiles + a thumbnail).

    Args:
        path: The image file.
        max_side: Cap for the long edge, in pixels.

    Returns:
        An EXIF-oriented RGB image at native resolution, downscaled only when it exceeds `max_side`.
    """
    with Image.open(path) as im:
        im.draft("RGB", (max_side, max_side))  # cheap DCT downscale only for JPEGs much larger than max_side
        im = ImageOps.exif_transpose(im).convert("RGB")
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    return im


class Tagger:
    """d1-3B loaded in this process (`--decision-model local`).

    The weights are loaded on first use and can be dropped again with `unload`.

    Attributes:
        device: "cuda" or "cpu" once the model is loaded, else None.
        dtype: The torch dtype name once the model is loaded, else None.
    """

    def __init__(self) -> None:
        """Creates the wrapper without loading the model."""
        self._model = None
        self._lock = threading.RLock()
        self.device: str | None = None
        self.dtype: str | None = None

    @property
    def loaded(self) -> bool:
        """Whether the weights are in memory."""
        return self._model is not None

    def _load_locked(self):
        if self._model is None:
            import torch
            import transformers
            from transformers import AutoModel

            path = config.tagger_dir()
            if not (path / "config.json").is_file():
                raise config.ModelUnavailable(
                    f"d1-3B weights not found in {path} "
                    "(run `uvx hf download LiquidAI/d1-3B --local-dir models/d1-3B`, or set PHOTOLIB_TAGGER_DIR)"
                )
            transformers.utils.logging.disable_progress_bar()
            device, dtype = torch_device()
            m = AutoModel.from_pretrained(str(path), trust_remote_code=True, dtype=dtype).to(device)
            m.eval()
            _ = m.engine  # builds the runner + tokenizer once
            if device == "cuda":
                torch.cuda.synchronize()
            self.device = device
            self.dtype = str(dtype).removeprefix("torch.")
            self._model = m
        return self._model

    def model(self):
        """Returns the d1 model, loading it on first use (thread-safe).

        Raises:
            RuntimeError: If the weights are not in `config.tagger_dir()`.
        """
        with self._lock:
            return self._load_locked()

    def tag(
        self, image: Image.Image, labels: Sequence[str], questions: Mapping[str, str | None] | None = None
    ) -> dict[str, float]:
        """Asks d1 whether each label is in the image, all labels in one forward pass.

        Args:
            image: The image (see `load_for_tagging`).
            labels: The labels to ask about; duplicates are dropped.
            questions: `{label: question or None}` from the DB vocabulary (None uses the default
                template). Without it the labels.py seed questions are used.

        Returns:
            `{label: P(yes)}` in the order of `labels`.
        """
        labels = list(dict.fromkeys(labels))
        if not labels:
            return {}
        questions = questions_for(labels, questions)
        schema = {f"q{i:03d}": {"type": "noul", "instructions": questions[lb]} for i, lb in enumerate(labels)}
        with self._lock:
            m = self._load_locked()
            r = m.system_one(None, schema, images=[image])
        return {labels[int(k[1:])]: float(v["noul"]) for k, v in r["answers"].items()}

    def unload(self) -> None:
        """Drops the model and gives its VRAM back to the driver (the CUDA context itself stays)."""
        with self._lock:
            if self._model is None:
                return
            self._model = None
            gc.collect()
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def info(self) -> dict:
        """Returns the model card shown by `status` (name, mode, device, dtype, loaded)."""
        return {
            "name": config.TAGGER_NAME,
            "available": True,
            "mode": "local",
            "endpoint": None,
            "device": self.device or torch_device()[0],
            "dtype": self.dtype,
            "loaded": self.loaded,
        }


class RemoteTagger:
    """d1-3B on another machine (`--decision-model URL`): same methods as `Tagger`.

    The request is d1's own `system_one` call as JSON: POST {model, images: [base64 JPEG], questions:
    {id: {type: "noul", instructions}}} -> {answers: {id: {noul: P(yes)}}}.

    Attributes:
        url: The decision endpoint, used exactly as given.
        loaded: Always True: nothing is loaded in this process.
    """

    loaded = True  # nothing to load in this process

    def __init__(self, url: str) -> None:
        """Creates the client; no request is sent until a photo is tagged.

        Args:
            url: The decision endpoint.
        """
        self.url = url

    def model(self):
        """Returns self (there is nothing to load)."""
        return self

    def tag(
        self, image: Image.Image, labels: Sequence[str], questions: Mapping[str, str | None] | None = None
    ) -> dict[str, float]:
        """Asks the remote d1 about each label in one request (see `Tagger.tag`).

        Raises:
            RemoteModelError: If the request fails or the answer is unusable.
        """
        labels = list(dict.fromkeys(labels))
        if not labels:
            return {}
        questions = questions_for(labels, questions)
        schema = {f"q{i:03d}": {"type": "noul", "instructions": questions[lb]} for i, lb in enumerate(labels)}
        r = post_json(self.url, {"model": config.TAGGER_NAME, "images": [image_b64(image)], "questions": schema})
        try:
            return {lb: float(r["answers"][f"q{i:03d}"]["noul"]) for i, lb in enumerate(labels)}
        except (KeyError, TypeError, ValueError) as e:
            raise RemoteModelError(f"unexpected decision response from {self.url}: {type(e).__name__}: {e}") from None

    def unload(self) -> None:
        """Does nothing: the model lives on the other machine."""

    def info(self) -> dict:
        """Returns the model card shown by `status` (see `Tagger.info`)."""
        return {
            "name": config.TAGGER_NAME,
            "available": True,
            "mode": "remote",
            "endpoint": self.url,
            "device": "remote",
            "dtype": None,
            "loaded": True,
        }


_TAGGER: tuple[str, Tagger | RemoteTagger] | None = None
_TAGGER_LOCK = threading.Lock()


def get_tagger() -> Tagger | RemoteTagger:
    """Returns the process-wide tagger selected by `--decision-model`.

    Raises:
        config.ModelUnavailable: If this process was started without a decision model.
    """
    global _TAGGER
    setting = config.require_decision()
    with _TAGGER_LOCK:
        if _TAGGER is None or _TAGGER[0] != setting:
            _TAGGER = (setting, Tagger() if setting == "local" else RemoteTagger(setting))
        return _TAGGER[1]


def tagger_info() -> dict:
    """Returns `info()` of the configured tagger, or an `available: False` stub when there is none."""
    if config.decision_model() is None:
        return {
            "name": config.TAGGER_NAME,
            "available": False,
            "mode": None,
            "endpoint": None,
            "device": None,
            "dtype": None,
            "loaded": False,
        }
    return get_tagger().info()
