// Re-exports the few SDK pieces the create-agent panel needs, so the page uses the
// SAME stellar-sdk copy that createStellarAgent was bundled with. Not an entry: the
// generated entry (outside repo root, see build.ts) imports it by absolute path.
export { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
