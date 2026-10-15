"""EmbeddingGemma 2 wrapper: lazy, thread-safe singleton shared by the indexer and search.

Notes on sentence-transformers 6.1 / transformers 5.19:
  * `model.encode({"image": [p1, p2]})` returns ONE embedding for the combined (interleaved) input --
    it is not a batch. A batch is a *list* of inputs: `model.encode([img1, img2])` with PIL images, or
    `model.encode([{"image": p1}, {"image": p2}])`. Both give identical vectors.
  * We pass EXIF-transposed PIL images downscaled to 1024px so orientation is honoured and decode happens once.
  * Text queries use `prompt_name="SearchQuery"` (= "task: search result | query: {q}").
  * bf16 outputs have norms of ~0.997-1.003, so we re-normalise in float32.
"""

from __future__ import annotations

import threading
from typing import Sequence

import numpy as np
from PIL import Image

from . import config
from .remote import RemoteModelError, image_b64, post_json


def torch_device():
    """Returns `(device, dtype)` for running a model in this process.

    CUDA with bfloat16 when available (float32 on GPUs without bf16), else CPU float32. Never float16:
    the activations overflow.
    """
    import torch

    if torch.cuda.is_available():
        return "cuda", torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
    return "cpu", torch.float32


def _normalize(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.maximum(n, 1e-12)


class Embedder:
    """EmbeddingGemma 2 loaded in this process (`--embedding-model local`).

    The weights are loaded on first use, bf16 on CUDA and fp32 on CPU.

    Attributes:
        device: "cuda" or "cpu" once the model is loaded, else None.
        dtype: The torch dtype name once the model is loaded, else None.
    """

    def __init__(self) -> None:
        """Creates the wrapper without loading the model."""
        self._model = None
        self._lock = threading.Lock()
        self._encode_lock = threading.Lock()
        self._label_cache: dict[str, np.ndarray] = {}
        self.device: str | None = None
        self.dtype: str | None = None

    @property
    def loaded(self) -> bool:
        """Whether the weights are in memory."""
        return self._model is not None

    def model(self):
        """Returns the SentenceTransformer, loading it on first use (thread-safe)."""
        if self._model is None:
            with self._lock:
                if self._model is None:
                    import transformers
                    from sentence_transformers import SentenceTransformer

                    if not (config.model_dir() / "config.json").is_file():
                        raise config.ModelUnavailable(
                            f"EmbeddingGemma weights not found in {config.model_dir()} (run `uvx hf download "
                            "google/embeddinggemma-2 --local-dir models/embeddinggemma-2`, or set PHOTOLIB_MODEL_DIR)"
                        )
                    transformers.utils.logging.disable_progress_bar()  # no "Loading weights" bar spam
                    device, dtype = torch_device()
                    m = SentenceTransformer(
                        str(config.model_dir()),
                        device=device,
                        model_kwargs={"torch_dtype": dtype},
                        config_kwargs={"audio_config": None},  # text + image only (~440M params)
                    )
                    m.eval()
                    self.device = device
                    self.dtype = str(dtype).removeprefix("torch.")
                    self._model = m
        return self._model

    def encode_images(self, images: Sequence[Image.Image], batch_size: int = config.EMBED_BATCH) -> np.ndarray:
        """Embeds images (no text prefix).

        Args:
            images: EXIF-oriented RGB images (the indexer downscales them to `config.EMBED_MAX_SIDE`).
            batch_size: Images per forward pass.

        Returns:
            An (n, 768) float32 matrix of L2-normalised vectors.
        """
        if not images:
            return np.zeros((0, config.EMBED_DIM), dtype=np.float32)
        m = self.model()
        with self._encode_lock:
            out = m.encode(list(images), batch_size=batch_size, convert_to_numpy=True, show_progress_bar=False)
        return _normalize(out)

    def encode_query(self, text: str) -> np.ndarray:
        """Returns the L2-normalised 768-d vector of a search query (`SearchQuery` prompt)."""
        m = self.model()
        with self._encode_lock:
            out = m.encode([text], prompt_name="SearchQuery", convert_to_numpy=True, show_progress_bar=False)
        return _normalize(out)[0]

    def encode_labels(self, labels: Sequence[str]) -> np.ndarray:
        """Embeds subject labels as `SearchQuery` text, cached per label.

        Args:
            labels: The labels, in order.

        Returns:
            An (n, 768) float32 matrix, one row per label.
        """
        missing = [lb for lb in labels if lb not in self._label_cache]
        if missing:
            m = self.model()
            with self._encode_lock:
                out = m.encode(list(missing), prompt_name="SearchQuery", convert_to_numpy=True, show_progress_bar=False)
            for lb, v in zip(missing, _normalize(out)):
                self._label_cache[lb] = v
        return np.stack([self._label_cache[lb] for lb in labels])

    def info(self) -> dict:
        """Returns the model card shown by `status` (name, mode, device, dtype, dim, loaded)."""
        return {
            "name": config.MODEL_NAME,
            "available": True,
            "mode": "local",
            "endpoint": None,
            "device": self.device or torch_device()[0],
            "dtype": self.dtype,
            "dim": config.EMBED_DIM,
            "loaded": self.loaded,
        }


class RemoteEmbedder:
    """EmbeddingGemma 2 on another machine (`--embedding-model URL`): same methods as `Embedder`.

    Request format: POST {model, input: [str | {image: base64}], prompt_name}
    -> {data: [{index, embedding}]}. Images are sent as the same EXIF-oriented, 1024px-capped pixels the
    local model gets (JPEG, quality 95).

    Attributes:
        url: The embeddings endpoint, used exactly as given.
        loaded: Always True: nothing is loaded in this process.
    """

    loaded = True  # nothing to load in this process

    def __init__(self, url: str) -> None:
        """Creates the client; no request is sent until a vector is needed.

        Args:
            url: The embeddings endpoint.
        """
        self.url = url
        self._label_cache: dict[str, np.ndarray] = {}

    def model(self):
        """Returns self (there is nothing to load)."""
        return self

    def _embed(self, inputs: list, prompt_name: str | None = None) -> np.ndarray:
        payload: dict = {"model": config.MODEL_NAME, "input": inputs}
        if prompt_name:
            payload["prompt_name"] = prompt_name
        try:
            data = sorted(post_json(self.url, payload)["data"], key=lambda d: d.get("index", 0))
            out = np.asarray([d["embedding"] for d in data], dtype=np.float32)
        except (KeyError, TypeError, ValueError) as e:
            raise RemoteModelError(f"unexpected embeddings response from {self.url}: {type(e).__name__}: {e}") from None
        if out.shape != (len(inputs), config.EMBED_DIM):
            raise RemoteModelError(
                f"{self.url} returned embeddings of shape {out.shape}, expected {(len(inputs), config.EMBED_DIM)}"
            )
        return _normalize(out)

    def encode_images(self, images: Sequence[Image.Image], batch_size: int = config.EMBED_BATCH) -> np.ndarray:
        """Embeds images, one request per `batch_size` images (see `Embedder.encode_images`).

        Raises:
            RemoteModelError: If a request fails or the answer is unusable.
        """
        if not images:
            return np.zeros((0, config.EMBED_DIM), dtype=np.float32)
        chunks = [images[i : i + batch_size] for i in range(0, len(images), batch_size)]
        return np.concatenate([self._embed([{"image": image_b64(im)} for im in chunk]) for chunk in chunks])

    def encode_query(self, text: str) -> np.ndarray:
        """Returns the vector of a search query (see `Embedder.encode_query`)."""
        return self._embed([text], "SearchQuery")[0]

    def encode_labels(self, labels: Sequence[str]) -> np.ndarray:
        """Embeds subject labels, cached per label (see `Embedder.encode_labels`)."""
        missing = [lb for lb in dict.fromkeys(labels) if lb not in self._label_cache]
        if missing:
            for lb, v in zip(missing, self._embed(missing, "SearchQuery")):
                self._label_cache[lb] = v
        return np.stack([self._label_cache[lb] for lb in labels])

    def info(self) -> dict:
        """Returns the model card shown by `status` (see `Embedder.info`)."""
        return {
            "name": config.MODEL_NAME,
            "available": True,
            "mode": "remote",
            "endpoint": self.url,
            "device": "remote",
            "dtype": None,
            "dim": config.EMBED_DIM,
            "loaded": True,
        }


_EMBEDDER: tuple[str, Embedder | RemoteEmbedder] | None = None
_EMBEDDER_LOCK = threading.Lock()


def get_embedder() -> Embedder | RemoteEmbedder:
    """Returns the process-wide embedder selected by `--embedding-model`.

    Raises:
        config.ModelUnavailable: If this process was started without an embedding model.
    """
    global _EMBEDDER
    setting = config.require_embedding()
    with _EMBEDDER_LOCK:
        if _EMBEDDER is None or _EMBEDDER[0] != setting:
            _EMBEDDER = (setting, Embedder() if setting == "local" else RemoteEmbedder(setting))
        return _EMBEDDER[1]


def embedder_info() -> dict:
    """Returns `info()` of the configured embedder, or an `available: False` stub when there is none."""
    if config.embedding_model() is None:
        return {
            "name": config.MODEL_NAME,
            "available": False,
            "mode": None,
            "endpoint": None,
            "device": None,
            "dtype": None,
            "dim": config.EMBED_DIM,
            "loaded": False,
        }
    return get_embedder().info()
