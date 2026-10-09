---
name: web-accessibility
description: WCAG 2.2 AA practice for keyboard, screen reader, contrast, and motion. Use when building or auditing user interfaces.
license: MIT
compatibility: opencode
---

## What I do

- Make interfaces operable and perceivable for keyboard and assistive-technology users.

## When to use me

Use when building or auditing any user interface.

## Checklist

1. **Keyboard:** every action reachable and visible via keyboard; logical tab order; no keyboard traps; skip links on dense pages.
2. **Screen readers:** semantic landmarks and headings; every control has an accessible name; live regions announce async outcomes (loading → success/failure).
3. **Contrast & motion:** 4.5:1 text contrast minimum; honor `prefers-reduced-motion`; never convey status by color alone.
4. **Forms:** labels (not placeholder-only), inline error text tied to inputs, error summary on submit failure.
5. **Verify:** tab through the whole flow blind, then run one automated pass (axe/Lighthouse) and fix what it flags.
