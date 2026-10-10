---
name: dotnet-essentials
description: .NET product discipline — SDK commands, nullable enable, DI, parameterized data access, Docker-always services. Use when the product stack is dotnet.
license: MIT
compatibility: opencode
---

## What I do

- Keep .NET products consistent per learn.microsoft.com conventions: nullable-aware, DI-first, warning-clean.

## When to use me

Use on every task whose effective stack (`task.stack` ?? `roadmap.stack`, or `workspace/*.sln` / `**/*.csproj`) is `dotnet`.

## Rules

1. **Toolchain only:** `dotnet add package` / `dotnet run` / `dotnet test` / `dotnet build`. Treat warnings as errors in CI (`<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`); `dotnet format` before exit.
2. **Verify:** `dotnet test` (0 failures, coverage collected where available) before exit; paste real output into `workspace/TASK_PROGRESS.md`. xUnit facts+theories, FluentAssertions, Moq/NSubstitute for boundaries; `WebApplicationFactory` for HTTP (through middleware, not around it) — never a live background server in tests. Name tests by behavior: `FindByIdAsync_ReturnsOrder_WhenOrderExists`.
3. **Language:** `<Nullable>enable</Nullable>` + `<ImplicitUsings>enable</ImplicitUsings>`; file-scoped namespaces; `async`/`await` end-to-end with `CancellationToken` on I/O; `IOptions<T>` for config (bind env, never hardcode). Mirror `src/` under `tests/`; target 80%+ on domain logic, validation, auth, failure paths.
4. **Architecture:** DI-first (constructor injection, `AddScoped` services over statics); thin controllers/endpoints over services; EF Core with parameterized LINQ/raw (`FromSqlInterpolated`, never concatenated SQL) + code-first migrations, never `EnsureCreated` drift.
5. **Data access:** connect via env to declared Docker services. No fallback data layers — fail fast (health checks unhealthy) when a service is unreachable.

## Depth (vendored ECC reference, MIT © 2026 Affaan Mustafa — read on demand)

- `vendor/ecc/rules/csharp/coding-style.md`, `patterns.md`, `security.md`, `testing.md`
- `vendor/ecc/skills/dotnet-patterns/SKILL.md`, `vendor/ecc/skills/csharp-testing/SKILL.md`
- Review checklist: `vendor/ecc/agents/csharp-reviewer.md`

- Reloadable staged IDs: `ecc-dotnet-patterns`, `ecc-csharp-testing` (skill tool, on-demand — staged by workflow/runner, never auto-injected)
