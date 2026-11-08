import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rpc, xdr } from '@stellar/stellar-sdk';

// Protocol 30 (Bell) ledgers, built with stellar-sdk 17.4.0 from a real testnet ledger: the header's StellarValue
// switches to STELLAR_VALUE_SIGNED_MS (CAP-88). SDKs before 16.4.0 throw "unknown StellarValueType member for
// value 3" on it, which breaks rpc.getLatestLedger (create, and the x402 client before every Stellar payment).
const P30_HEADER =
  'AAAAHmsWizv8Wh+1qkzueWvam/GFeU2U3SwSgPZY4uOJ5aObhs5X9lYVPV5Jk0SDqnV2k8cNZPsuXfzfuQuRk36MNwsAAAAAauM8BwAAAAAAAAADAAABoYeifQ0AAAAAtV0Qsrt9KE7VwDpHpeG1kMkPV4NVRxzEUHu+ggTSPIsAAABAtWnjV4/Ft6VVWtILAfTK0Zn0aoCIwOHnaWM64k6i5XKqMm2Ujzf5LSvCTDWZ16Fi49MgaVQw4dHqbDH5PpvaDHh83ROMcAV5VUqO+QkXVIzZ8yF3QcMNOeFNd/pZ4RzuW9HS69lVPbd+fT/8UFrsLIb6JNgU8/NHCp7oGIY0NSUAUyujDeC2s6dkAAAAACyTfIpaIAAAAAAAAAAAAA5CPwAAAGQATEtAAAAAyEXckCUGjAKcvsbZkywddtDFTb0Sy5sksTrHdQ1PydLI+aWa1MSh/NcZCNuzRYWYjr8W7oE9ponBJshs5HBHr9Or8Tbch4JvaGtrZH1loRR6PqFyDYDBs4MLO+oOhpfzabZybqvx5w3/rvnIFyg6izRzhopGHpoNuKi7sOm3GcvVAAAAAA==';
const P30_CLOSE_META = // LedgerCloseMeta v2 around P30_HEADER, transaction lists emptied
  'AAAAAgAAAAD3FzcdJdZ80V9JJHLXtjdM/2ElJG3gMb/Afa80REdWHwAAAB5rFos7/FoftapM7nlr2pvxhXlNlN0sEoD2WOLjieWjm4bOV/ZWFT1eSZNEg6p1dpPHDWT7Ll3837kLkZN+jDcLAAAAAGrjPAcAAAAAAAAAAwAAAaGHon0NAAAAALVdELK7fShO1cA6R6XhtZDJD1eDVUccxFB7voIE0jyLAAAAQLVp41ePxbelVVrSCwH0ytGZ9GqAiMDh52ljOuJOouVyqjJtlI83+S0rwkw1mdehYuPTIGlUMOHR6mwx+T6b2gx4fN0TjHAFeVVKjvkJF1SM2fMhd0HDDTnhTXf6WeEc7lvR0uvZVT23fn0//FBa7CyG+iTYFPPzRwqe6BiGNDUlAFMrow3gtrOnZAAAAAAsk3yKWiAAAAAAAAAAAAAOQj8AAABkAExLQAAAAMhF3JAlBowCnL7G2ZMsHXbQxU29EsubJLE6x3UNT8nSyPmlmtTEofzXGQjbs0WFmI6/Fu6BPaaJwSbIbORwR6/Tq/E23IeCb2hra2R9ZaEUej6hcg2AwbODCzvqDoaX82m2cm6r8ecN/675yBcoOos0c4aKRh6aDbiou7DptxnL1QAAAAAAAAAAAAAAAWsWizv8Wh+1qkzueWvam/GFeU2U3SwSgPZY4uOJ5aObAAAAAAAAAAAAAAAAAAAAAAAAAAEKjbfRAAAAAA==';
// scvAddress holding a CAP-84 muxed contract (W...) address: discriminant 5, unknown to SDKs before 16.4.0.
const W_ADDRESS_SCVAL = 'AAAAEgAAAAUAAAAAAAAAKlBFzV7Acpp2j9WtAlBYUt9PAo3Ogw5axSIJukhIOy8B';

let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { id, method } = (await req.json()) as { id: number; method: string };
      const result =
        method === 'getLatestLedger'
          ? { id: '00', protocolVersion: 30, sequence: 100, closeTime: '1793276935', headerXdr: P30_HEADER, metadataXdr: P30_CLOSE_META }
          : null;
      return Response.json({ jsonrpc: '2.0', id, result });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

describe('protocol 30 ledgers', () => {
  it('decodes a millisecond-close ledger header', () => {
    const h = xdr.LedgerHeader.fromXDR(P30_HEADER, 'base64');
    expect(h.ledgerVersion()).toBe(30);
    expect(h.scpValue().ext().switch().value).toBe(3);
  });

  it('decodes a muxed contract address in an event value', () => {
    expect(xdr.ScVal.fromXDR(W_ADDRESS_SCVAL, 'base64').address().switch().value).toBe(5);
  });

  it('reads the latest ledger over RPC', async () => {
    expect((await new rpc.Server(url, { allowHttp: true }).getLatestLedger()).sequence).toBe(100);
  });

  it('the SDK @x402/stellar resolves reads it too', async () => {
    const fromX402 = createRequire(dirname(createRequire(import.meta.url).resolve('@x402/stellar')) + '/');
    const sdk = (await import(pathToFileURL(fromX402.resolve('@stellar/stellar-sdk')).href)) as typeof import('@stellar/stellar-sdk');
    expect((await new sdk.rpc.Server(url, { allowHttp: true }).getLatestLedger()).sequence).toBe(100);
  });
});
