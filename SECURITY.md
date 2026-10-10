# Security Policy

## Supported versions

The `main` branch is the only supported line. Security fixes land on `main` and
flow into product repos on their next template sync.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting
(repo → Security tab → Report a vulnerability). Include:

- Affected area (`orchestrator/`, `subagents/`, `.github/workflows/`, skill)
- Steps to reproduce or a minimal PoC
- Impact assessment (secret leak, prompt injection, supply chain, CI escape)

We aim to acknowledge within 72 hours. Secret leaks in `workspace/` fixtures
or logs are treated as high severity — see the `security-scan` skill for what
the gate already blocks.
