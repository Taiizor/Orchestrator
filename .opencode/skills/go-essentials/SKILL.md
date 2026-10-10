---
name: go-essentials
description: Idiomatic Go product discipline — gofmt/vet, modules, error wrapping, table tests, Docker-always services. Use when the product stack is go.
license: MIT
compatibility: opencode
---

## What I do

- Keep Go products idiomatic per Effective Go, CodeReviewComments, and `go vet` — not a transliteration of another language.

## When to use me

Use on every task when `roadmap.stack` (or `workspace/go.mod`) says `go`.

## Rules

1. **Toolchain only:** `go get` / `go run ./...` / `go test ./...` / `go build ./...`. Format with `gofmt` (+`goimports`); gate on `go vet ./...` clean. `go mod tidy` before exit.
2. **Verify:** `go test ./...` with `-race` (0 failures, race detector on) before exit; paste real output into `workspace/TASK_PROGRESS.md`. Table-driven tests (`t.Run` subtests), success AND error cases; `t.Helper()` + `t.Cleanup()` in helpers. HTTP: `net/http` ServeMux (go ≥1.22 patterns) + `httptest` — never a live background server in tests. Coverage: `go test -cover ./...`.
3. **Errors:** check immediately, never discard with `_` silently; wrap context with `fmt.Errorf("...: %w", err)`; lowercase messages, no punctuation; sentinel errors + `errors.Is/As`.
4. **Style:** one `package` line per file (match the directory's package); small interfaces (`-er` names, accept interfaces / return concrete, define them where used); `any` only when truly unconstrained; early returns, happy path left-aligned. Dependencies via constructor injection (`NewUserService(repo, logger)`); functional options for config.
5. **Data access:** connect via env to declared Docker services; parameterized queries / driver placeholders always. Secrets from env, fail fast when missing. No fallback data layers — fail fast when a service is unreachable.
6. **Security & I/O:** `gosec ./...` clean on security-sensitive changes; `context.Context` with timeouts on all I/O; `crypto/rand` for randomness, `golang.org/x/crypto` (bcrypt/argon2) for passwords — never homemade crypto.

## Depth (vendored ECC reference, MIT © 2026 Affaan Mustafa — read on demand)

- `vendor/ecc/rules/golang/coding-style.md`, `patterns.md`, `security.md`, `testing.md`
- `vendor/ecc/skills/golang-patterns/SKILL.md`, `vendor/ecc/skills/golang-testing/SKILL.md`
- Review checklist: `vendor/ecc/agents/go-reviewer.md`

- Reloadable staged IDs: `ecc-golang-patterns`, `ecc-golang-testing` (skill tool, on-demand — staged by workflow/runner, never auto-injected)
