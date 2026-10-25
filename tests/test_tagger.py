import pytest


@pytest.mark.slow
def test_d1_on_sample_images(sample_dir):
    """Real d1-3B at full resolution on 3 sample photos (dog, marigolds, pigeons in flight)."""
    import torch

    from photolib.tagger import get_tagger, load_for_tagging

    t = get_tagger()
    dog = t.tag(load_for_tagging(sample_dir / "5N7A1263.jpg"), ["dog", "ostrich", "bird"])
    assert list(dog) == ["dog", "ostrich", "bird"]
    assert dog["dog"] >= 0.8, dog
    assert dog["ostrich"] < 0.2, dog
    assert dog["bird"] < 0.5, dog

    marigold = t.tag(load_for_tagging(sample_dir / "5N7A1268.jpg"), ["marigold", "flower", "orange", "food"])
    assert marigold["marigold"] >= 0.8 and marigold["flower"] >= 0.8, marigold
    assert marigold["orange"] < 0.5, marigold  # override: "orange (the citrus fruit)", not the colour
    assert marigold["food"] < 0.5, marigold

    pigeons = t.tag(load_for_tagging(sample_dir / "5N7A1286.jpg"), ["pigeon", "bird in flight", "peach", "dog"])
    assert pigeons["pigeon"] >= 0.8 and pigeons["bird in flight"] >= 0.8, pigeons
    assert pigeons["peach"] < 0.2 and pigeons["dog"] < 0.2, pigeons

    info = t.info()
    assert info["loaded"] and info["name"] == "LiquidAI/d1-3B"
    if torch.cuda.is_available():
        assert info["device"] == "cuda" and info["dtype"] == "bfloat16"
        before = torch.cuda.memory_allocated()
        t.unload()
        assert not t.loaded
        assert torch.cuda.memory_allocated() < before - 4 * 2**30  # ~6 GB of weights released
    else:
        t.unload()
        assert not t.loaded


@pytest.mark.parametrize(
    ("size", "max_pixels"), [("original", None), ("1mp", 1_000_000), ("small", 524_288)]
)
def test_load_for_tagging_sizes(tmp_path, size, max_pixels):
    """Each tag size caps the pixel count by scaling the long edge, keeps the aspect ratio, and never upscales."""
    from PIL import Image

    from photolib.tagger import load_for_tagging

    big = tmp_path / "big.jpg"
    Image.new("RGB", (3000, 2000), "red").save(big)
    im = load_for_tagging(big, size)
    if max_pixels is None:
        assert im.size == (3000, 2000)
    else:
        w, h = im.size
        assert w * h <= max_pixels
        assert w * h > 0.99 * max_pixels  # as large as the cap allows
        assert abs(w / h - 1.5) < 0.01

    tiny = tmp_path / "tiny.jpg"
    Image.new("RGB", (300, 200), "red").save(tiny)
    assert load_for_tagging(tiny, size).size == (300, 200)


def test_load_for_tagging_rejects_unknown_size(tmp_path):
    """An unknown tag size is an error, not a silent default."""
    from PIL import Image

    from photolib.tagger import load_for_tagging

    p = tmp_path / "a.jpg"
    Image.new("RGB", (10, 10)).save(p)
    with pytest.raises(ValueError):
        load_for_tagging(p, "huge")
