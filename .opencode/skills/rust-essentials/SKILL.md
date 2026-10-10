---
name: rust-essentials
description: Idiomatic Rust product discipline — fmt/clippy/test, Result errors, serde, Docker-always services. Use when the product stack is rust.
license: MIT
compatibility: opencode
---

## What I do

- Keep Rust products warning-free and idiomatic per the Rust Book and API Guidelines: ownership-first, `Result` everywhere, clippy-clean.

## When to use me

Use on every task when `roadmap.stack` (or `workspace/Cargo.toml`) says `rust`.

## Rules

1. **Toolchain only:** `cargo run` / `cargo test` / `cargo build`. Gate on `cargo fmt --check` AND `cargo clippy -- -D warnings` clean before exit.
2. **Verify:** `cargo test` (0 failures) before exit; paste real output into `workspace/TASK_PROGRESS.md`. Unit tests in `#[cfg(test)]` modules beside code, integration tests in `tests/`; examples use `?`, never `unwrap!`.
3. **Errors:** `Result<T, E>` for recoverable errors, `panic!` only for unrecoverable; propagate with `?`; domain errors via `thiserror`, app glue via `anyhow`; `Option<T>` for maybe-values. No `unwrap()`/`expect()` in library paths.
4. **Style:** `&str` params over `String` unless ownership is needed; borrow over `clone()`; lazy iterators over premature `collect()`; `serde` for serialization; `tokio` for async (+`#[tokio::test]`); split `lib.rs` (logic, testable) from `main.rs` (thin binary). Test naming: scenario verbs (`creates_user_with_valid_email`, `rejects_order_when_insufficient_stock`).
5. **Data access:** connect via env to declared Docker services (`std::env::var`, fail fast when missing); parameterized queries always (sqlx `$1`/`?` binds — never `format!` SQL). No fallback data layers. Parse, don't validate: newtypes (`Email::parse`) make invalid states unrepresentable.
6. **Security:** every `unsafe` block carries a `// SAFETY:` comment or it doesn't land; `cargo audit` on dependency changes; never expose internal paths/stack traces/DB errors in API responses (log server-side, return generic messages).

## Depth (vendored ECC reference, MIT © 2026 Affaan Mustafa — read on demand)

- `vendor/ecc/rules/rust/coding-style.md`, `patterns.md`, `security.md`, `testing.md`
- `vendor/ecc/skills/rust-patterns/SKILL.md`, `vendor/ecc/skills/rust-testing/SKILL.md` (rstest, proptest, mockall, criterion, cargo-llvm-cov)
- Review checklist: `vendor/ecc/agents/rust-reviewer.md`

- Reloadable staged IDs: `ecc-rust-patterns`, `ecc-rust-testing` (skill tool, on-demand — staged by workflow/runner, never auto-injected)
