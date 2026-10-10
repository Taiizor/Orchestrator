---
name: container-services
description: Fixed Docker endpoints for Postgres, Redis, Mongo, and S3 with ephemeral-data discipline. Use when connecting to project services locally or in CI.
license: MIT
compatibility: opencode
---

## What I do

- Connect to real services in CI without per-project wiring.

## When to use me

Use when your task touches the database, cache, queue, documents, or object storage.

## Endpoints (preset CI services; custom services add their own `env`)

- PostgreSQL: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/app`
- Redis: `REDIS_URL=redis://localhost:6379`
- MongoDB: `MONGO_URL=mongodb://localhost:27017/app`
- S3 (Adobe S3Mock in CI, MinIO/R2/AWS-compatible): `S3_ENDPOINT=http://localhost:9090`, key `test` / secret `test`, bucket from `S3_BUCKET` (create it via SDK — buckets start empty), region `us-east-1`.
- Custom services: read their documented `env` keys the same way (exported automatically).

## Rules

1. **Read env, hardcode nothing:** all connection values come from environment with these Docker defaults (same locally and in CI).
2. **Ephemeral data:** containers reset every run — seed fixtures inside the task/test setup; never assume rows, buckets, or keys pre-exist (create the bucket if missing).
3. **Docker-always, fail fast:** there are no fallback data layers. If a declared service is unreachable, fail with a clear error — never add SQLite/InMemory adapters.
4. **Missing a container? Provision + request it:** `docker run -d --name <name> -p <host:container> <image:pinned-tag>` for your own run, then append `{ "name", "image", "env?", "ports?" }` to `workspace/services.request.json` so the orchestrator auto-adopts it into the canonical compose (durable from the next tick). Pinned tags only, throwaway defaults only, and document the env in `workspace/CONTRACTS.md`.
5. **No production credentials:** the Docker defaults are throwaway; production uses secret-managed values via the same env names.
