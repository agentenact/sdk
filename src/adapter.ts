import type { Chain, SigAlg } from './record.js';

/** One on-chain payment inside the referenced transaction, as read by an adapter. */
export interface Settlement {
  chain: Chain;
  ref: string;
  payer: string;
  payee: string;
  amount: string;
  asset: string;
  /** RFC 3339 UTC ledger close time of the transaction. */
  at: string;
}

/** ERC-8004 identity → address binding. `wallet` is the optional agentWallet rebinding. */
export interface IdentityBinding {
  owner: string;
  wallet: string | null;
}

/**
 * Everything the core needs from a chain. Read-only except `sign`, which
 * operates on a caller-supplied secret and never sees the network.
 */
export interface ChainAdapter {
  chain: Chain;
  sigAlg: SigAlg;
  /** Sign a 32-byte digest; returns lowercase hex. */
  sign(digest: Uint8Array, secret: Uint8Array): Promise<string>;
  /** Verify a hex signature over a 32-byte digest for `address`. Never throws. */
  verify(digest: Uint8Array, signatureHex: string, address: string): Promise<boolean>;
  /** All payments in the referenced transaction; [] when the tx does not exist or failed. */
  readSettlement(ref: string): Promise<Settlement[]>;
  /** null when the agentId is not registered. */
  resolveIdentity(agentId: string): Promise<IdentityBinding | null>;
  /**
   * Optional. RFC 3339 close time of the oldest ledger this source still
   * serves, or null when unknown. Lets the verifier tell "this tx never
   * existed" from "this tx is older than the history we can read" (a testnet
   * reset, or a pruned node).
   */
  historyStart?(): Promise<string | null>;
}
