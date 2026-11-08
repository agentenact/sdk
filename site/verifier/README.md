# Live verifier bundle

`agentenact.js` (in `../public/verifier/`) is a browser build of the package's
OWN `verifyRecord` + `createStellarAdapter` + `createStellarAgent` + hashing helpers (plus `Keypair`, `Networks` and `TransactionBuilder` from the SDK, for the create-agent panel) — not a
reimplementation. The site's client component `import()`s it at runtime and
calls it against public Horizon testnet data, so no AgentEnact server is in
the trust path.

## Rebuild it

```bash
bun run site/verifier/build.ts
```

(needs the repo root's `node_modules` installed — `cd .. && bun install` — since
`@stellar/stellar-sdk` resolves from there, not from `site/node_modules`.)

Rebuild any time `src/verify.ts`, `src/record.ts`, `src/create.ts` or
`src/adapters/stellar.ts` changes. The output is committed so the static site works without a build
step on servel; there's no `prebuild` wired up, so a stale bundle silently
drifts from `src/` — remember to rerun this by hand.

## Why `build.ts` writes to a temp file outside the repo

Repo root `package.json` has `"sideEffects": false` next to an `"exports"`
map. With that combination, `bun build`/`Bun.build()` silently breaks any
entry point that itself lives inside that package's directory tree: it
tree-shakes the entry's own exports as "unused" (wrongly — an entry's exports
are the bundle's public API by definition) and emits a dangling
`export { verifyRecord }` with no definition, exit code 0, no warning.

This is NOT about relative vs. absolute import specifiers — that was the
first (wrong) hypothesis, ruled out by testing both from a file physically
outside the repo. It's specifically that the *entry file's own location*
determines whether Bun applies the package's `sideEffects: false` to it. Found
by bisecting repo root's `package.json` field by field in a throwaway `/tmp`
reproduction (`files` + `sideEffects: false` together was the minimal
trigger; `sideEffects: false` alone with `exports` already breaks it).

Workaround: `build.ts` generates a tiny entry file in `os.tmpdir()` (outside
repo root, so it never falls under the offending `package.json`) with
absolute imports back into `../../src`, bundles *that*, then deletes it. The
imported files themselves (`verify.ts`, `adapter.ts`, `record.ts`,
`stellar.ts`) staying inside the repo is fine — only the entry's own location
matters.

## Buffer in the browser

`src/adapters/stellar.ts` calls the bare global `Buffer.from(...)` (Node
convention) without importing it. `@stellar/stellar-sdk`'s own internals are
bundled with a `buffer` polyfill, but that bare reference in our adapter code
is not — the site must set `globalThis.Buffer` (from the `buffer` npm
package) before calling `createStellarAdapter(...).sign`/`.verify`, i.e.
before the bundle is used, not just before it's imported. See
`src/components/verify-panel.tsx`.
