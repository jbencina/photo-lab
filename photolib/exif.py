"""EXIF extraction with Pillow (base IFD + Exif IFD 0x8769 + GPS IFD 0x8825)."""

from __future__ import annotations

import json
import math
from typing import Any

from PIL import ExifTags, Image

EXIF_IFD = 0x8769
GPS_IFD = 0x8825

# Base IFD
T_MAKE, T_MODEL, T_SOFTWARE, T_ORIENTATION, T_DATETIME = 271, 272, 305, 274, 306
# Exif IFD
T_EXPOSURE_TIME, T_FNUMBER, T_EXPOSURE_PROGRAM, T_ISO = 33434, 33437, 34850, 34855
T_DTO, T_OFFSET_DTO, T_OFFSET = 36867, 36881, 36880
T_EXPOSURE_BIAS, T_METERING, T_FLASH, T_FOCAL = 37380, 37383, 37385, 37386
T_WHITE_BALANCE, T_LENS_MAKE, T_LENS_MODEL = 41987, 42035, 42036
T_MAKERNOTE, T_USERCOMMENT = 37500, 37510
# GPS IFD
G_LAT_REF, G_LAT, G_LON_REF, G_LON = 1, 2, 3, 4


def to_float(v: Any) -> float | None:
    """Converts an EXIF number to a float.

    Args:
        v: An IFDRational, int, float, or a tuple/list whose first item is one of those.

    Returns:
        The value, or None when it is missing, NaN, infinite or has a zero denominator.
    """
    if v is None:
        return None
    if isinstance(v, (tuple, list)):
        if not v:
            return None
        v = v[0]
    try:
        f = float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def to_int(v: Any) -> int | None:
    """Converts an EXIF number to the nearest int, or None (see `to_float`)."""
    f = to_float(v)
    return int(round(f)) if f is not None else None


def clean_str(v: Any) -> str | None:
    """Converts an EXIF text value to a stripped str without NUL bytes, or None when empty."""
    if v is None:
        return None
    if isinstance(v, bytes):
        v = v.decode("utf-8", "ignore")
    s = str(v).replace("\x00", "").strip()
    return s or None


def exposure_str(t: float | None) -> str | None:
    """Formats an exposure time the way cameras show it.

    Args:
        t: The exposure time in seconds.

    Returns:
        A string such as "1/1250" (for 0.0008) or "2.5s", or None for a missing or non-positive time.
    """
    if t is None or t <= 0:
        return None
    if t >= 1:
        return f"{t:g}s"
    denom = 1.0 / t
    return f"1/{int(round(denom))}" if abs(denom - round(denom)) < 0.05 * denom else f"{t:.4g}s"


def parse_datetime(dt: Any, offset: Any = None) -> str | None:
    """Converts an EXIF date/time to ISO 8601.

    Args:
        dt: The EXIF value, e.g. '2025:06:21 11:40:12'.
        offset: The EXIF UTC offset, e.g. '-08:00', if the camera recorded one.

    Returns:
        A string such as '2025-06-21T11:40:12-08:00' (no offset when none was given), or None when the
        value is missing or not a date.
    """
    s = clean_str(dt)
    if not s or len(s) < 19 or s.startswith("0000"):
        return None
    date, _, time = s[:19].partition(" ")
    parts = date.split(":")
    if len(parts) != 3 or not time:
        return None
    iso = f"{parts[0]}-{parts[1]}-{parts[2]}T{time}"
    off = clean_str(offset)
    if off and len(off) == 6 and off[0] in "+-" and off[3] == ":":
        iso += off
    return iso


def _gps_coord(values: Any, ref: Any) -> float | None:
    if not values or len(values) != 3:
        return None
    d, m, s = (to_float(x) for x in values)
    if d is None or m is None or s is None:
        return None
    val = d + m / 60.0 + s / 3600.0
    if clean_str(ref) in ("S", "W"):
        val = -val
    return round(val, 7)


def _stringify(v: Any) -> str:
    if isinstance(v, bytes):
        if len(v) <= 64:
            try:
                txt = v.decode("ascii").replace("\x00", "").strip()
                if txt.isprintable():
                    return txt
            except UnicodeDecodeError:
                pass
        return f"<{len(v)} bytes>"
    if isinstance(v, (tuple, list)):
        return ", ".join(_stringify(x) for x in v)
    if isinstance(v, float) or hasattr(v, "numerator"):
        f = to_float(v)
        return "" if f is None else f"{f:g}"
    return str(v).replace("\x00", "").strip()


def extract(img: Image.Image) -> dict:
    """Reads the EXIF-derived columns of the `images` table (+ `exif_json`).

    MakerNote is skipped (huge vendor binary).

    Args:
        img: The opened image, before any `draft()` or resize.

    Returns:
        Column values keyed by name. `width`/`height` are the *displayed* dimensions (EXIF
        orientation applied).
    """
    exif = img.getexif()
    try:
        ex = exif.get_ifd(EXIF_IFD)
    except Exception:
        ex = {}
    try:
        gps = exif.get_ifd(GPS_IFD)
    except Exception:
        gps = {}

    orientation = to_int(exif.get(T_ORIENTATION)) or 1
    w, h = img.size
    if orientation in (5, 6, 7, 8):
        w, h = h, w

    exp_t = to_float(ex.get(T_EXPOSURE_TIME))
    taken = parse_datetime(ex.get(T_DTO), ex.get(T_OFFSET_DTO)) or parse_datetime(
        exif.get(T_DATETIME), ex.get(T_OFFSET)
    )
    lens = clean_str(ex.get(T_LENS_MODEL))

    full: dict[str, str] = {}
    for k, v in exif.items():
        if k in (EXIF_IFD, GPS_IFD, 0xA005):
            continue
        full[ExifTags.TAGS.get(k, f"Tag{k}")] = _stringify(v)
    for k, v in ex.items():
        if k in (T_MAKERNOTE, 0xA005):
            continue
        full[ExifTags.TAGS.get(k, f"Tag{k}")] = _stringify(v)
    for k, v in gps.items():
        full["GPS" + ExifTags.GPSTAGS.get(k, str(k)).removeprefix("GPS")] = _stringify(v)

    return {
        "width": w,
        "height": h,
        "orientation": orientation,
        "make": clean_str(exif.get(T_MAKE)),
        "model": clean_str(exif.get(T_MODEL)),
        "lens": lens,
        "software": clean_str(exif.get(T_SOFTWARE)),
        "taken_at": taken,
        "iso": to_int(ex.get(T_ISO)),
        "f_number": to_float(ex.get(T_FNUMBER)),
        "exposure_time": exp_t,
        "exposure_str": exposure_str(exp_t),
        "focal_length": to_float(ex.get(T_FOCAL)),
        "exposure_bias": to_float(ex.get(T_EXPOSURE_BIAS)),
        "flash": to_int(ex.get(T_FLASH)),
        "white_balance": to_int(ex.get(T_WHITE_BALANCE)),
        "exposure_program": to_int(ex.get(T_EXPOSURE_PROGRAM)),
        "metering_mode": to_int(ex.get(T_METERING)),
        "gps_lat": _gps_coord(gps.get(G_LAT), gps.get(G_LAT_REF)),
        "gps_lon": _gps_coord(gps.get(G_LON), gps.get(G_LON_REF)),
        "exif_json": json.dumps(full, ensure_ascii=False, sort_keys=True),
    }
