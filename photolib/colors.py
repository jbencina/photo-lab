"""Dominant-color palettes (k-means in CIELAB) and color-similarity scoring."""

from __future__ import annotations

import math
import re

import numpy as np
from PIL import Image

from . import config

# sRGB D65 -> XYZ
_M = np.array(
    [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]
)
_WHITE = np.array([0.95047, 1.0, 1.08883])
DELTA_E_SCALE = 25.0


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Converts sRGB to CIELAB (D65).

    Args:
        rgb: Array of shape (..., 3) with sRGB values in 0..255.

    Returns:
        Array of the same shape holding (L, a, b).
    """
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = (c @ _M.T) / _WHITE
    d = 6.0 / 29.0
    f = np.where(xyz > d**3, np.cbrt(xyz), xyz / (3 * d * d) + 4.0 / 29.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def parse_hex(hex_str: str) -> tuple[int, int, int]:
    """Parses a `#rgb` / `#rrggbb` color (the `#` is optional).

    Args:
        hex_str: The color string.

    Returns:
        The (r, g, b) values in 0..255.

    Raises:
        ValueError: If the string is not a 3- or 6-digit hex color.
    """
    m = _HEX_RE.match(hex_str.strip())
    if not m:
        raise ValueError(f"invalid hex color: {hex_str!r}")
    h = m.group(1)
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def hex_to_lab(hex_str: str) -> np.ndarray:
    """Returns the CIELAB value of a hex color (see `parse_hex`)."""
    return rgb_to_lab(np.array(parse_hex(hex_str), dtype=np.float64))


def to_hex(rgb) -> str:
    """Returns `#rrggbb` for an (r, g, b) triple, rounding and clamping each value to 0..255."""
    r, g, b = (int(max(0, min(255, round(float(x))))) for x in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def _sq_dists(x: np.ndarray, x_sq: np.ndarray, centers: np.ndarray) -> np.ndarray:
    """Returns the squared distance from every point to every center, shape (n, k)."""
    d2 = x_sq[:, None] - 2.0 * (x @ centers.T) + (centers * centers).sum(axis=1)[None]
    return np.maximum(d2, 0.0)


def _kmeans(x: np.ndarray, k: int, n_init: int = 3, max_iter: int = 300, seed: int = 0) -> np.ndarray:
    """Clusters points with k-means (k-means++ seeding, Lloyd iterations) and keeps the best of `n_init` runs.

    A run stops when the centers move less than 1e-4 of the data's variance, as in scikit-learn.

    Args:
        x: Points, shape (n, d).
        k: Number of clusters; at most the number of distinct points.
        n_init: Number of runs with different seeds; the one with the lowest inertia wins.
        max_iter: Iteration cap per run.
        seed: Seed for the random generator, so the same image always gets the same palette.

    Returns:
        The cluster index of each point, shape (n,).
    """
    rng = np.random.default_rng(seed)
    n, dim = x.shape
    x_sq = (x * x).sum(axis=1)
    tol = 1e-4 * float(x.var(axis=0).mean())
    best_labels, best_inertia = None, np.inf
    for _ in range(n_init):
        centers = x[[rng.integers(n)]]
        closest = _sq_dists(x, x_sq, centers)[:, 0]
        for _ in range(1, k):
            c = x[rng.choice(n, p=closest / closest.sum())]
            centers = np.vstack([centers, c])
            closest = np.minimum(closest, _sq_dists(x, x_sq, c[None])[:, 0])
        for _ in range(max_iter):
            labels = _sq_dists(x, x_sq, centers).argmin(axis=1)
            counts = np.bincount(labels, minlength=k)
            sums = np.stack([np.bincount(labels, weights=x[:, j], minlength=k) for j in range(dim)], axis=1)
            new = np.where(counts[:, None] > 0, sums / np.maximum(counts, 1)[:, None], centers)
            shift = float(((new - centers) ** 2).sum())
            centers = new
            if shift <= tol:
                break
        d2 = _sq_dists(x, x_sq, centers)
        labels = d2.argmin(axis=1)
        inertia = float(d2[np.arange(n), labels].sum())
        if inertia < best_inertia:
            best_labels, best_inertia = labels, inertia
    return best_labels


def palette(img: Image.Image, k: int = config.COLOR_K) -> list[dict]:
    """Extracts an image's dominant colors with k-means in CIELAB.

    The image is downscaled to ~100 px first; k is lowered when the image has fewer distinct colors.

    Args:
        img: The image.
        k: Number of clusters.

    Returns:
        A list of `{hex, lab: [L, a, b], share}` dicts, largest share first.
    """
    small = img.convert("RGB")
    small.thumbnail((config.COLOR_SAMPLE_SIDE, config.COLOR_SAMPLE_SIDE), Image.Resampling.BILINEAR)
    rgb = np.asarray(small, dtype=np.float64).reshape(-1, 3)
    lab = rgb_to_lab(rgb)
    n_unique = len(np.unique(rgb.astype(np.uint8), axis=0))
    k = max(1, min(k, n_unique))
    labels = _kmeans(lab, k)
    out = []
    for i in range(k):
        mask = labels == i
        if not mask.any():
            continue
        out.append(
            {
                "hex": to_hex(rgb[mask].mean(axis=0)),
                "lab": [round(float(x), 2) for x in lab[mask].mean(axis=0)],
                "share": round(float(mask.mean()), 4),
            }
        )
    out.sort(key=lambda c: c["share"], reverse=True)
    return out


def color_score(colors: list[dict], q_lab) -> float:
    """Scores how close a palette is to a query color.

    score = sum_i share_i * exp(-dE76(lab_i, q) / 25).

    Args:
        colors: A palette as returned by `palette`.
        q_lab: The query color in CIELAB.

    Returns:
        A score in [0, 1]; higher is better.
    """
    q = np.asarray(q_lab, dtype=np.float64)
    s = 0.0
    for c in colors:
        de = float(np.linalg.norm(np.asarray(c["lab"], dtype=np.float64) - q))
        s += float(c["share"]) * math.exp(-de / DELTA_E_SCALE)
    return s
