---
name: python-essentials
description: Python product discipline — ruff/pytest, pyproject+venv, type hints, parameterized data access, Docker-always services. Use when the product stack is python.
license: MIT
compatibility: opencode
---

## What I do

- Keep Python products clean per PEP 8 / PEP 484: typed, linted, pytest-verified, Docker-backed.

## When to use me

Use on every task whose effective stack (`task.stack` ?? `roadmap.stack`, or `workspace/pyproject.toml` / `requirements.txt`) is `python`.

## Rules

1. **Toolchain only:** `pip install` (inside venv) / `python -m <mod>` / `python -m pytest -q` / `python -m compileall .`. Gate on `ruff check .` AND `ruff format --check .` clean before exit; dependencies pinned in `pyproject.toml` or `requirements.txt`.
2. **Verify:** `python -m pytest -q` (0 failures) before exit; paste real output into `workspace/TASK_PROGRESS.md`. Fixtures for setup, `parametrize` for cases, `tmp_path`/`monkeypatch` over manual teardown; HTTP via `TestClient`/`httpx` ASGI transport — never a live background server in tests. Categorize with `@pytest.mark.unit` / `@pytest.mark.integration`; coverage via `pytest --cov=src --cov-report=term-missing`.
3. **Style:** `snake_case` functions/vars, `PascalCase` classes; full type hints on public functions (check with the configured checker when present); stdlib first (`pathlib`, `dataclasses`); no bare `except`, no `print` debugging leftovers.
4. **Data access:** connect via env to declared Docker services; parameterized queries (DB-API `%s`/`$1` placeholders or ORM expressions, never f-string SQL). No SQLite/`sqlite3` fallback layers — fail fast when a service is unreachable.
5. **Layout:** `src/` package layout with an explicit package name; tests in `tests/` mirroring the package; never commit `.venv/`, `__pycache__/`, or `.pytest_cache/`.

## Depth (vendored ECC reference, MIT © 2026 Affaan Mustafa — read on demand)

- `vendor/ecc/rules/python/coding-style.md`, `patterns.md`, `security.md`, `testing.md`, `fastapi.md` (FastAPI projects)
- `vendor/ecc/skills/python-patterns/SKILL.md`, `vendor/ecc/skills/python-testing/SKILL.md`
- Review checklist: `vendor/ecc/agents/python-reviewer.md`

- Reloadable staged IDs: `ecc-python-patterns`, `ecc-python-testing` (skill tool, on-demand — staged by workflow/runner, never auto-injected)
