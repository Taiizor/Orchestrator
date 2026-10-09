---
name: design-system
description: Token-to-component discipline for shared UI kits. Use when creating design tokens or shared components.
license: MIT
compatibility: opencode
---

## What I do

- Turn tokens into a component kit that stays consistent as it grows.

## When to use me

Use when creating design tokens or shared components.

## Rules

1. **Tokens are the only source:** color, spacing, type, radius, elevation — components reference tokens, never raw values.
2. **Component anatomy:** every shared component ships variants, sizes, states (default/hover/disabled/loading), and an accessible name — documented with one usage example.
3. **Composition over configuration:** small primitives (`Button`, `Badge`, `Input`) composed into patterns; avoid mega-components with twenty props.
4. **No one-off drift:** a screen needing a "slightly different" button gets a token or variant, not an inline style.
