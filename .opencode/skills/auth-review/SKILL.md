---
name: auth-review
description: Session, MFA, OAuth, password storage, CSRF, and rate-limit review for authentication flows. Use when implementing or auditing auth.
license: MIT
compatibility: opencode
---

## What I do

- Harden authentication against enumeration, theft, replay, and brute force.

## When to use me

Use when implementing or auditing login, signup, sessions, MFA, OAuth, or API keys.

## Checklist

1. **Enumeration resistance:** identical responses and timing for valid/invalid users; generic "credentials invalid" everywhere, including reset flows.
2. **Storage:** memory-hard password hashing (argon2id/bcrypt) with per-user salts; never reversible encryption; TOTP secrets and recovery codes hashed.
3. **Sessions:** random opaque tokens, rotation on privilege change, absolute + idle expiry, secure/HttpOnly/SameSite cookies, CSRF tokens on state-changing routes.
4. **MFA:** TOTP with backup codes; step-up authentication before sensitive actions (payouts, role changes, key rotation).
5. **Brute force:** rate-limit + exponential backoff + lockout/breach screening on auth endpoints; log without recording secrets.
6. **API keys:** salted-hash storage, visible prefix, scopes, expiry, rotation path — never the raw key after creation.
