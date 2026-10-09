---
name: i18n
description: Locale JSON structure, key discipline, and Intl formatting without hardcoded strings. Use when adding copy, languages, or user-facing text.
license: MIT
compatibility: opencode
---

## What I do

- Banish hardcoded user-facing strings; every copy lives in locale files.

## When to use me

Use when adding copy, new languages, or any user-facing text.

## Rules

1. **No raw strings in UI:** all copy keyed (`checkout.pay_button`), never inline literals — including errors, placeholders, aria-labels, and dates.
2. **Locale files:** one JSON per locale (`en.json`, `pl.json`...), identical key trees; missing keys fall back to the source locale and get flagged, never silently rendered blank.
3. **Intl, not hand-rolled:** numbers, currencies, dates, plurals via `Intl.*` APIs over the locale — no string concatenation for sentences.
4. **Review gate:** a diff that adds user-facing text without locale keys fails review.
