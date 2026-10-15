"""Tiny JSON-over-HTTP client for models that run on another machine.

Used by `--embedding-model URL` and `--decision-model URL`. The URL is used exactly as given: nothing is
probed or checked up front, a request is simply sent when a model is needed and any failure surfaces as
`RemoteModelError`.
"""

from __future__ import annotations

import base64
import io
import json
import urllib.error
import urllib.request

from PIL import Image

TIMEOUT_SECONDS = 300  # generous: the first request may load the model on the other machine
JPEG_QUALITY = 95


class RemoteModelError(RuntimeError):
    """The remote model endpoint could not be reached or answered with something unusable."""


def image_b64(image: Image.Image) -> str:
    """Encodes a PIL image as a base64 JPEG.

    Args:
        image: The image, already EXIF-oriented and resized by the caller.

    Returns:
        The JPEG bytes as an ASCII base64 string.
    """
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def post_json(url: str, payload: dict, timeout: float = TIMEOUT_SECONDS) -> dict:
    """POSTs a JSON payload and returns the decoded JSON answer.

    Args:
        url: The endpoint, used exactly as given.
        payload: The request body.
        timeout: Seconds to wait for the answer.

    Returns:
        The decoded JSON response.

    Raises:
        RemoteModelError: If the endpoint can't be reached, answers with an HTTP error, or does not
            answer with JSON.
    """
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers={"content-type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read(500).decode("utf-8", "replace").strip()
        raise RemoteModelError(f"{url} answered HTTP {e.code}: {detail or e.reason}") from None
    except (urllib.error.URLError, OSError) as e:
        raise RemoteModelError(f"could not reach {url}: {getattr(e, 'reason', e)}") from None
    except ValueError as e:
        raise RemoteModelError(f"{url} did not answer with JSON: {e}") from None
