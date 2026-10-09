---
name: observability-basics
description: Structured logs, correlation IDs, RED metrics, and health endpoints for operable services. Use when adding logging, metrics, or health checks.
license: MIT
compatibility: opencode
---

## What I do

- Ensure failures are findable: every request traceable, every symptom measurable.

## When to use me

Use when adding logging, metrics, health checks, or debugging production-like issues.

## Rules

1. **Structured logs:** JSON lines with timestamp, level, service, message; include a correlation id propagated across service boundaries; never log secrets, tokens, or PII.
2. **RED metrics:** track Rate, Errors, Duration per endpoint; alert on error-rate and p95-latency thresholds, not on log volume.
3. **Health:** `/health` (liveness) and `/ready` (dependencies reachable) endpoints; distinct statuses so orchestrators route correctly.
4. **Levels:** DEBUG for development detail, INFO for business events, WARN for degraded-but-working, ERROR for needs-human — with the context needed to act.
