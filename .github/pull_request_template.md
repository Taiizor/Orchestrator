## What changed

## Stack / area

- Product stack(s) touched: <!-- bun | go | rust | dotnet | python | php | none -->
- Area labels: <!-- area:engine | area:prompts | area:workflows | area:skills | area:docs | area:tests -->

## Test evidence

```text
# paste: bun test (engine suite, 0 failures required)
```

## Checklist

- [ ] Engine suite green (`bun test`, 0 fail) — proof pasted above
- [ ] No new fallback/data layers (Docker-always holds)
- [ ] `workspace/CONTRACTS.md` updated if API/schema changed (product repos)
- [ ] No secrets, tokens, or private keys in diff
- [ ] Docs updated if behavior changed (`AGENTS.md` / `README.md` / prompts)
