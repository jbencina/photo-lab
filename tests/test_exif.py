import json

from PIL import Image

from photolib import exif


def test_extract_sample(sample_dir):
    with Image.open(sample_dir / "5N7A1260.jpg") as im:
        m = exif.extract(im)
    assert m["make"] == "Canon"
    assert m["model"] == "Canon EOS R7"
    assert m["lens"] == "RF200-800mm F6.3-9 IS USM"
    assert m["taken_at"] == "2025-06-21T11:40:12-08:00"
    assert m["iso"] == 4000
    assert m["f_number"] == 14.0
    assert m["focal_length"] == 800.0
    assert m["exposure_str"] == "1/1250"
    assert abs(m["exposure_time"] - 0.0008) < 1e-9
    assert (m["width"], m["height"]) == (1600, 1067)
    assert m["orientation"] == 1
    full = json.loads(m["exif_json"])  # must be valid JSON (no NaN)
    assert full["Model"] == "Canon EOS R7"
    assert "MakerNote" not in full


def test_helpers():
    assert exif.exposure_str(1 / 250) == "1/250"
    assert exif.exposure_str(0.0008) == "1/1250"
    assert exif.exposure_str(2.5) == "2.5s"
    assert exif.exposure_str(None) is None
    assert exif.parse_datetime("2024:01:02 03:04:05") == "2024-01-02T03:04:05"
    assert exif.parse_datetime("2024:01:02 03:04:05", "+05:30") == "2024-01-02T03:04:05+05:30"
    assert exif.parse_datetime("0000:00:00 00:00:00") is None
    assert exif.to_float(float("nan")) is None


def test_orientation_swaps_dims(tmp_path):
    im = Image.new("RGB", (300, 200), "red")
    e = Image.Exif()
    e[274] = 6  # rotate 90 CW
    p = tmp_path / "rot.jpg"
    im.save(p, exif=e)
    with Image.open(p) as im2:
        m = exif.extract(im2)
    assert (m["width"], m["height"]) == (200, 300)
    assert m["orientation"] == 6
