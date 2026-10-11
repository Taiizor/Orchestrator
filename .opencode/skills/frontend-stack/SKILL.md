---
name: frontend-stack
description: Docs-first protocol for any UI framework with version pinning. Use when working with shadcn, Next.js, Nuxt, Blazor, or any other frontend stack.
license: MIT
compatibility: opencode
---

## What I do

- Keep framework usage current and verified instead of memorized.

## When to use me

Use when working with any UI framework (shadcn, Next.js, Nuxt, Blazor, Flutter, or other).

## Protocol

1. **Declare the stack:** framework name + exact version from the installed `package.json` / lockfile. That version — not training memory — is the truth.
2. **Docs first:** before FIRST use of any component, hook, or API in the pinned version, fetch the official docs for that version (`webfetch`) and quote the relevant part — no self-exemption for claimed certainty.
3. **Verify against installed code:** prop names, import paths, and CLI flags must match the installed package, not the docs of a newer major.
4. **No framework drift:** one UI framework per project surface; adapters at the boundary if a second is unavoidable. Server-rendered surfaces use the declared framework's SSR/router — no hand-rolled HTML over raw http; prove with a framework production build plus a smoke test.
5. **Project skill drops win:** if `inputs/skills/<role>-*/SKILL.md` exists for your role, follow it over generic advice.
