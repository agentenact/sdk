# Conformance vectors

`vectors.json` lists Enactment Records and the verdict each one must get from
`verifyRecord`: `ok`, the four check states, and the failure reason. The
verdicts are written by hand in `scripts/gen-vectors.ts`, which never calls the
verifier; `MANIFEST.sha256` pins every file, so a changed expectation is a
visible diff.

- `real-*`: records the testnet demo agent signed, verbatim.
- `tampered-*`, `wrong-alg`, `unsupported-version`: a real record changed after signing.
- the rest: signed with a published test-only key (seed = sha256 of
  `agentenact conformance vector key v1`; it never holds funds). Their
  settlement is a synthetic tx: the real `f951b337…` Horizon response with its
  hash and payee replaced.

`fixtures/` holds recorded testnet answers (Horizon JSON, Soroban simulate
results), captured read-only by `scripts/capture-vector-fixtures.ts`.
`replay.ts` serves them to the Stellar adapter, so the suite runs offline.
