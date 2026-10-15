import numpy as np
from PIL import Image

from photolib import colors


def test_hex_lab_roundtrip_known_values():
    white = colors.hex_to_lab("#ffffff")
    assert abs(white[0] - 100) < 0.05 and abs(white[1]) < 0.05 and abs(white[2]) < 0.05
    black = colors.hex_to_lab("000")
    assert abs(black[0]) < 1e-6
    red = colors.hex_to_lab("#ff0000")
    assert np.allclose(red, [53.24, 80.09, 67.20], atol=0.1)


def test_score_monotonic_in_distance():
    pal = [{"hex": "#ff0000", "lab": colors.hex_to_lab("#ff0000").tolist(), "share": 1.0}]
    queries = ["#ff0000", "#ee2200", "#cc4400", "#ff8800", "#00ff00", "#0000ff"]
    scores = [colors.color_score(pal, colors.hex_to_lab(q)) for q in queries]
    assert abs(scores[0] - 1.0) < 1e-9
    assert all(a > b for a, b in zip(scores, scores[1:4])), scores
    assert scores[3] > scores[4] and scores[3] > scores[5]


def test_score_monotonic_in_share():
    q = colors.hex_to_lab("#2050ff")
    blue = colors.hex_to_lab("#2050ff").tolist()
    grey = colors.hex_to_lab("#808080").tolist()
    prev = -1
    for share in (0.0, 0.2, 0.5, 0.8, 1.0):
        pal = [{"lab": blue, "share": share}, {"lab": grey, "share": 1 - share}]
        s = colors.color_score(pal, q)
        assert s > prev
        prev = s


def test_palette_from_image():
    im = Image.new("RGB", (200, 100), "#00aa44")
    im.paste(Image.new("RGB", (50, 100), "#ffffff"), (0, 0))
    pal = colors.palette(im)
    assert 1 <= len(pal) <= 6
    assert abs(sum(c["share"] for c in pal) - 1) < 1e-3
    assert pal[0]["hex"] == "#00aa44" and abs(pal[0]["share"] - 0.75) < 0.02
    assert pal == sorted(pal, key=lambda c: -c["share"])


def test_parse_hex_rejects_garbage():
    import pytest

    with pytest.raises(ValueError):
        colors.parse_hex("#12345")
