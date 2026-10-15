# AGENTS.md

Guidance for coding agents (and humans) working on photo-lib. See `README.md` for what the project does,
how to set it up and how it works.

## Commands

```bash
uv sync --extra local             # python env (without the extra: no PyTorch, remote models only)
uv run pytest -q -m "not slow"    # fast tests (no GPU, no models)
uvx ruff check .                  # lint (docstrings + unused names), must pass
cd frontend && npm run build      # type-check + build the web UI
cd website && npm run build       # build the documentation site (fails on broken links)
```

The slow tests need a GPU, the model weights and `PHOTOLIB_SAMPLE_DIR` (a folder of sample photos that
is not in the repository); they are skipped without it.

The documentation site in `website/docs/` covers the same ground as `README.md` in more detail. When
you change behaviour that is documented, update both, and retake the screenshots
(`frontend/scripts/docs-shots.mjs`) when the UI changes visibly. The system diagram in the README is
an export of `website/src/components/SystemDiagram`; re-export it (`frontend/scripts/diagram-shot.mjs`)
when you change the component.

## Python style

Follow the [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html). Match the
surrounding code where the guide leaves a choice.

Docstrings use the Google format
([section 3.8](https://google.github.io/styleguide/pyguide.html#38-comments-and-docstrings)) and are
checked by ruff (`[tool.ruff.lint.pydocstyle] convention = "google"` in `pyproject.toml`):

- Every module, public class, public function and public method has a docstring. Tests and private
  helpers (`_name`) only need one when the logic isn't obvious.
- The first line is a one-line summary that ends with a period, followed by a blank line if there is
  more. Write it in the descriptive style ("Returns the …", "Deletes the …"); the Typer commands in
  `cli.py` use the imperative style because their docstrings are the `--help` text.
- Use `Args:`, `Returns:` (or `Yields:`) and `Raises:` sections unless the summary already says it all
  (for example a one-line "Returns the …" getter). Don't repeat types that are in the signature.
- Classes document their public attributes in an `Attributes:` section.
- FastAPI endpoints and Typer commands keep their docstrings to a summary plus prose: the text is
  shown in the OpenAPI docs and in `--help`, so no `Args:` sections there.

```python
def parse_hex(hex_str: str) -> tuple[int, int, int]:
    """Parses a `#rgb` / `#rrggbb` color (the `#` is optional).

    Args:
        hex_str: The color string.

    Returns:
        The (r, g, b) values in 0..255.

    Raises:
        ValueError: If the string is not a 3- or 6-digit hex color.
    """
```

## Nothing machine-specific in the repository

This is a public repository. Code, tests, scripts, docs and commit messages must not contain:

- secrets, tokens or credentials;
- personal or machine-specific paths, user names, host names or IP addresses;
- references to private infrastructure or to files that aren't in the repository.

Anything that differs per machine comes from configuration: the `PHOTOLIB_*` environment variables and
CLI flags (`photolib/config.py`), `data/config.json`, and `PHOTOLIB_SAMPLE_DIR` / `CATALOG_DIR` /
`BASE_URL` for tests and QA scripts. Use placeholders such as `/path/to/photos` and
`http://gpu-host.example:8080` in docs and examples.
