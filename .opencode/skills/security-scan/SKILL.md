---
name: security-scan
description: Secret-leak, SQL injection, path traversal, and header audit checklist for autonomous agents. Use when writing or reviewing security-sensitive code.
license: MIT
compatibility: opencode
---

## What I do

- Scan diffs for leaked secrets, injection flaws, traversal bugs, missing headers.

## When to use me

Use when auditing, reviewing, or writing auth, session, upload, webhook, or payment-adjacent logic.

## Checklist

1. **Never commit secrets:** reject AWS keys, `ghp_*`/`gho_*`, `sk-*`, `sk-ant-*`, private key blocks, `.env`/`.pem`/`.key` files in changesets.
2. **Safe SQLite:** parameterized statements only (see `sqlite-hardening` skill).
3. **Safe file operations:** resolve paths and verify the target stays under the allowed workspace root (`path.startsWith(workspaceDir)`); block `../` traversal.
4. **Uploads:** MIME/extension allowlist + size cap; store under a dedicated directory, never executable paths.
5. **Web serving:** set `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`; minimal CORS.
6. **Webhooks:** verify signatures on raw bytes, enforce timestamp/replay windows.
