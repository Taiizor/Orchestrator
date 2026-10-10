---
name: php-essentials
description: PHP/Laravel product discipline — composer/phpunit, PSR-12 strict types, Eloquent parameterization, Docker-always services. Use when the product stack is php.
license: MIT
compatibility: opencode
---

## What I do

- Keep PHP products consistent per PSR-12 and ECC PHP rules: strict types, tested, Docker-backed, no string-built SQL.

## When to use me

Use on every task whose effective stack (`task.stack` ?? `roadmap.stack`, or `workspace/composer.json`) is `php`.

## Rules

1. **Toolchain only:** `composer install/require` / `php artisan <cmd>` / `php vendor/bin/phpunit` (or `vendor/bin/pest` when the project uses Pest — never mix frameworks in one suite). Keep Composer scripts checked in so CI runs the same commands.
2. **Verify:** `php vendor/bin/phpunit` (0 failures, `--coverage-text` with pcov where available) before exit; paste real output into `workspace/TASK_PROGRESS.md`. Separate fast unit tests from framework/DB integration tests; factories/builders over hand-written arrays; HTTP tests assert transport + validation, business rules live in service tests.
3. **Style:** PSR-12; `declare(strict_types=1)`; scalar + return type hints and typed properties everywhere; `use` imports for all classes (no global-namespace reliance); Laravel Pint or PHP-CS-Fixer + PHPStan/Psalm gate clean before exit. Immutable DTOs/value objects across service boundaries; exceptions for exceptional states (never `false`/`null` as hidden error channels); validated DTOs at the request boundary.
4. **Laravel:** `php artisan test` OK as the runner; Eloquent/query-builder with bindings always (never concatenated SQL); forward-only migrations; factories + seeders for fixtures (never hand-rolled rows in tests).
5. **Data access:** config via env (`.env` never committed); connect to declared Docker services. No SQLite fallback layers — fail fast when a service is unreachable.
6. **Layout:** `app/` + `tests/` (unit vs feature separated); never commit `vendor/`, `.env`, or coverage artifacts.

## Depth (vendored ECC reference, MIT © 2026 Affaan Mustafa — read on demand)

- `vendor/ecc/rules/php/coding-style.md`, `patterns.md`, `security.md`, `testing.md`
- `vendor/ecc/skills/laravel-patterns/SKILL.md`, `vendor/ecc/skills/laravel-tdd/SKILL.md`
- Review checklist: `vendor/ecc/agents/php-reviewer.md`
- Reloadable staged IDs: `ecc-laravel-patterns`, `ecc-laravel-tdd` (skill tool, on-demand — staged by workflow/runner, never auto-injected)
