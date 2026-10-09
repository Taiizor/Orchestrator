---
name: container-services
description: Fixed CI endpoints for Docker-provided Postgres, Redis, Mongo, and MinIO S3 with ephemeral-data discipline. Use when connecting to project services in CI.
license: MIT
compatibility: opencode
---

## What I do

- Connect to real services in CI without per-project wiring.

## When to use me

Use when your task touches the database, cache, queue, documents, or object storage.

## Endpoints (always these in CI)

- PostgreSQL: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/app`
- Redis: `REDIS_URL=redis://localhost:6379`
- MongoDB: `MONGO_URL=mongodb://localhost:27017/app`
- S3 (MinIO, R2/AWS-compatible): `S3_ENDPOINT=http://localhost:9000`, key `minioadmin` / secret `minioadmin`, bucket from `S3_BUCKET`, region `us-east-1`.

## Rules

1. **Read env, hardcode nothing:** all connection values come from environment with these CI defaults.
2. **Ephemeral data:** containers reset every run — seed fixtures inside the task/test setup; never assume rows, buckets, or keys pre-exist (create the bucket if missing).
3. **Fallback retained:** keep the SQLite/InMemory adapter path for runs without Docker (local dev), but CI targets the real services first.
4. **No production credentials:** the CI defaults are throwaway; production uses secret-managed values via the same env names.
