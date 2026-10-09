---
name: ui-conventions
description: Black/white token system, accessible components, and copy rules for frontend work. Use when building screens, components, or design tokens.
license: MIT
compatibility: opencode
---

## What I do

- Keep all UI on the shared token system and accessibility baseline.

## When to use me

Use when creating screens, components, styles, or client-side state.

## Rules

1. **Tokens first:** colors, spacing, type from the shared design tokens — no hardcoded hex/spacing in components; must support future dark mode.
2. **Accessibility (WCAG 2.2 AA):** labels on every input, visible focus states, keyboard-reachable flows, no color-only status signaling, screen-reader names on icon buttons.
3. **States:** every screen handles loading, empty, error, and permission-denied — no blank frames.
4. **Money display:** `Intl.NumberFormat` over minor units; never sum across currencies without FX — grouped subtotals.
5. **No backend guessing:** method lists, amounts, and flows come from typed contracts only; capability-gated features hide when ineligible.
6. **Copy:** use provided copy decks verbatim; mark untranslated strings with `TBD` locale flags.
