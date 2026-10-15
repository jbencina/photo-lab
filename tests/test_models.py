"""Where the models run: `--embedding-model` / `--decision-model` = local | URL | omitted (not available).

The remote endpoints are a tiny stub HTTP server; no GPU model is loaded here.
"""

import base64
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from typer.testing import CliRunner

from conftest import text_vec


@pytest.fixture
def stub():
    """Stub model server: /v1/embeddings (model-endpoints schema) and /decide (d1 system_one as JSON)."""
    seen: list[tuple[str, dict]] = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            seen.append((self.path, body))
            if self.path == "/v1/embeddings":
                data = []
                for i, item in enumerate(body["input"]):
                    if isinstance(item, dict):
                        im = Image.open(io.BytesIO(base64.b64decode(item["image"])))
                        v = text_vec(f"image:{im.size}")
                    else:
                        v = text_vec(f"{body.get('prompt_name')}:{item}")
                    data.append({"index": i, "embedding": (v * 3).tolist()})  # un-normalised on purpose
                out = {"model": body["model"], "data": data[::-1]}  # out of order on purpose
            elif self.path == "/decide":
                out = {"answers": {k: {"type": "noul", "noul": 0.9 if "dog" in q["instructions"] else 0.1}
                                   for k, q in body["questions"].items()}}
            else:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b"boom")
                return
            raw = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    srv.seen = seen
    srv.base = f"http://127.0.0.1:{srv.server_port}"
    yield srv
    srv.shutdown()


def test_parse_model_setting():
    from photolib import config

    assert config.parse_model_setting(None) is None and config.parse_model_setting("  ") is None
    assert config.parse_model_setting("LOCAL") == "local"
    assert config.parse_model_setting("http://h/v1/embeddings") == "http://h/v1/embeddings"
    with pytest.raises(ValueError):
        config.parse_model_setting("cuda")


def test_remote_embedder(stub, monkeypatch):
    from photolib import config
    from photolib.embedder import RemoteEmbedder, get_embedder
    from photolib.remote import RemoteModelError

    monkeypatch.setenv("PHOTOLIB_EMBEDDING_MODEL", stub.base + "/v1/embeddings")
    e = get_embedder()
    assert isinstance(e, RemoteEmbedder) and e.info()["mode"] == "remote" and e.info()["endpoint"].endswith("/v1/embeddings")

    q = e.encode_query("a dog")
    assert q.shape == (768,) and abs(np.linalg.norm(q) - 1) < 1e-5
    assert np.allclose(q, text_vec("SearchQuery:a dog"), atol=1e-5)
    path, body = stub.seen[-1]
    assert body == {"model": config.MODEL_NAME, "input": ["a dog"], "prompt_name": "SearchQuery"}

    labels = e.encode_labels(["dog", "cat", "dog"])  # order kept even though the stub answers reversed
    assert np.allclose(labels[0], text_vec("SearchQuery:dog"), atol=1e-5) and np.allclose(labels[0], labels[2])
    n = len(stub.seen)
    e.encode_labels(["cat", "dog"])
    assert len(stub.seen) == n  # cached per label

    imgs = [Image.new("RGB", (40, 30), "red"), Image.new("RGB", (20, 20), "blue"), Image.new("RGB", (8, 8))]
    vecs = e.encode_images(imgs, batch_size=2)
    assert vecs.shape == (3, 768) and np.allclose(vecs[1], text_vec("image:(20, 20)"), atol=1e-5)
    assert [len(b["input"]) for _, b in stub.seen[-2:]] == [2, 1] and "prompt_name" not in stub.seen[-1][1]

    import socket

    with socket.socket() as sock:  # a port nothing listens on
        sock.bind(("127.0.0.1", 0))
        closed_port = sock.getsockname()[1]
    with pytest.raises(RemoteModelError, match="HTTP 500"):
        RemoteEmbedder(stub.base + "/nope").encode_query("x")
    with pytest.raises(RemoteModelError, match="could not reach"):
        RemoteEmbedder(f"http://127.0.0.1:{closed_port}/v1/embeddings").encode_query("x")


def test_remote_tagger(stub, monkeypatch):
    from photolib import config
    from photolib.tagger import RemoteTagger, get_tagger

    monkeypatch.setenv("PHOTOLIB_DECISION_MODEL", stub.base + "/decide")
    t = get_tagger()
    assert isinstance(t, RemoteTagger)
    probs = t.tag(Image.new("RGB", (32, 32)), ["dog", "cat"], {"cat": "Is a cat visible?"})
    assert probs == {"dog": 0.9, "cat": 0.1}
    _, body = stub.seen[-1]
    assert body["model"] == config.TAGGER_NAME and len(body["images"]) == 1
    assert body["questions"]["q001"] == {"type": "noul", "instructions": "Is a cat visible?"}
    t.unload()  # no-op


def test_no_models_gates_features(data_dir, tmp_path, monkeypatch):
    from photolib import config, db, indexer
    from photolib.embedder import get_embedder

    monkeypatch.delenv("PHOTOLIB_EMBEDDING_MODEL")
    monkeypatch.delenv("PHOTOLIB_DECISION_MODEL")
    with pytest.raises(config.ModelUnavailable):
        get_embedder()

    cat = tmp_path / "cat"
    cat.mkdir()
    config.save_config({"catalog_dir": str(cat)})
    db.connect().close()
    from photolib.api import app

    c = TestClient(app)
    s = c.get("/api/status").json()
    assert s["model"]["available"] is False and s["model"]["mode"] is None
    assert s["tagger"]["available"] is False and s["tagger"]["labels"] > 0
    r = c.get("/api/search/query", params={"q": "dog"})
    assert r.status_code == 503 and r.json()["code"] == "model_unavailable"
    assert c.post("/api/admin/refresh", json={}).status_code == 503
    assert c.post("/api/admin/retag", json={"confirm": True}).status_code == 503
    assert c.post("/api/admin/catalog", json={"catalog_dir": str(cat), "confirm": True}).status_code == 503
    assert config.catalog_dir() is not None  # refused before the purge
    # browsing, metadata search, colour search and suggestions (text matches) don't need a model
    assert c.get("/api/images").status_code == 200
    assert c.get("/api/search/color", params={"hex": "#ff0000"}).status_code == 200
    sug = c.get("/api/labels/suggest", params={"q": "dog"}).json()
    assert any(it["label"] == "dog" and it["match"] == "exact" for it in sug["items"])

    res = indexer.tag(retag=True)  # refused before any tag is cleared
    assert "no embedding model" in res["error"]


def test_refresh_without_decision_model_embeds_only(data_dir, tmp_path, monkeypatch):
    from photolib import indexer

    monkeypatch.delenv("PHOTOLIB_DECISION_MODEL")
    cat = tmp_path / "cat"
    cat.mkdir()
    res = indexer.refresh(cat)  # empty folder: nothing to embed, and the tag pass is skipped
    assert res["error"] is None and res["skip_tags"] is True


def test_cli_flags(data_dir, monkeypatch):
    import os

    from photolib import cli, config

    monkeypatch.delenv("PHOTOLIB_EMBEDDING_MODEL")
    monkeypatch.delenv("PHOTOLIB_DECISION_MODEL")
    def run(app, args):
        r = CliRunner().invoke(app, args)
        r.flat = "".join(r.output.split())  # rich wraps long table cells
        return r

    out = run(cli.app, ["status"]).output
    assert out.count("not available") == 2
    url = "http://embed.example/v1/embeddings"
    r = run(cli.app, ["status", "--embedding-model", url])
    assert f"remote({url})" in r.flat and r.flat.count("notavailable") == 1
    assert os.environ[config.EMBEDDING_ENV] == url
    monkeypatch.delenv("PHOTOLIB_EMBEDDING_MODEL")
    r = run(cli.app, ["--embedding-model", url, "--decision-model", url, "status"])  # also accepted before the command
    assert r.flat.count("remote(") == 2
    monkeypatch.delenv("PHOTOLIB_EMBEDDING_MODEL")
    monkeypatch.delenv("PHOTOLIB_DECISION_MODEL")
    assert run(cli.app, ["status", "--embedding-model", "cuda"]).exit_code == 2
    r = run(cli.app, ["refresh"])
    assert r.exit_code == 1 and "Noembeddingmodel" in r.flat
    r = run(cli.app, ["tag", "--embedding-model", url])
    assert r.exit_code == 1 and "Nodecisionmodel" in r.flat


def test_cli_dir_flags(tmp_path, monkeypatch):
    from photolib import cli, config

    monkeypatch.setenv("PHOTOLIB_DATA_DIR", str(tmp_path / "from-env"))  # the flag wins, and is undone after the test
    monkeypatch.setenv("PHOTOLIB_CATALOG_DIR", "")
    data, photos = tmp_path / "data", tmp_path / "photos"
    r = CliRunner().invoke(cli.app, ["--data-dir", str(data), "--catalog-dir", str(photos), "catalog", "show"])
    assert r.exit_code == 0, r.output
    assert config.data_dir() == data and config.catalog_dir() == photos
    flat = "".join(r.output.split())
    assert str(data) in flat and str(photos) in flat

