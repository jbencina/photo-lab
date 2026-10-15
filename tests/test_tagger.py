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
