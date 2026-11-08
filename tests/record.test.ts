import { describe, expect, it } from 'bun:test';
import {
  ENACTMENT_HEADER,
  bytesToHex,
  canonicalBytes,
  decodeRecordHeader,
  encodeRecordHeader,
  MAX_RECORD_SKILLS,
  parseRecord,
  parseRecordSkills,
  parseUnsignedRecord,
  randomNonce,
  recordDigest,
  sha256Hex,
  type UnsignedEnactmentRecord,
} from '../src/index.js';

export const UNSIGNED: UnsignedEnactmentRecord = {
  v: '0.1',
  agent: { chain: 'stellar', address: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', agentId: '66' },
  input: { sha256: 'a'.repeat(64), mediaType: 'text/plain' },
  output: { sha256: 'b'.repeat(64), mediaType: 'application/json', bytes: 120 },
  settlement: {
    chain: 'stellar',
    ref: 'c'.repeat(64),
    payer: 'GBSAMPLEPAYERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    amount: '0.0100000',
    asset: 'USDC',
  },
  issuedAt: '2026-09-02T10:00:00Z',
  nonce: '0123456789abcdef0123456789abcdef',
};

describe('canonicalBytes', () => {
  it('is deterministic and independent of key insertion order', () => {
    const reordered = JSON.parse(
      JSON.stringify({
        nonce: UNSIGNED.nonce,
        issuedAt: UNSIGNED.issuedAt,
        settlement: UNSIGNED.settlement,
        output: UNSIGNED.output,
        input: UNSIGNED.input,
        agent: UNSIGNED.agent,
        v: UNSIGNED.v,
      }),
    );
    expect(bytesToHex(canonicalBytes(reordered))).toBe(bytesToHex(canonicalBytes(UNSIGNED)));
  });
  it('excludes sig and has no whitespace', () => {
    const signed = { ...UNSIGNED, sig: { alg: 'ed25519' as const, value: 'ff' } };
    const text = new TextDecoder().decode(canonicalBytes(signed));
    expect(text).not.toContain('"sig"');
    expect(text).not.toMatch(/\s/);
    expect(text.startsWith('{"v":"0.1","agent":{"chain":"stellar","address":"')).toBe(true);
  });
  it('drops absent optional fields rather than emitting null', () => {
    const { agentId: _a, ...agent } = UNSIGNED.agent;
    const text = new TextDecoder().decode(canonicalBytes({ ...UNSIGNED, agent }));
    expect(text).not.toContain('agentId');
    expect(text).not.toContain('null');
  });
});

describe('recordDigest / sha256Hex', () => {
  it('golden vector: sha256("abc")', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('digest is 32 bytes and changes when any bound field changes', async () => {
    const base = bytesToHex(await recordDigest(UNSIGNED));
    expect(base).toHaveLength(64);
    const flips: Array<Partial<UnsignedEnactmentRecord>> = [
      { input: { ...UNSIGNED.input, sha256: 'd'.repeat(64) } },
      { output: { ...UNSIGNED.output, sha256: 'd'.repeat(64) } },
      { settlement: { ...UNSIGNED.settlement, ref: 'd'.repeat(64) } },
      { issuedAt: '2026-09-02T10:00:01Z' },
      { nonce: 'ffffffffffffffffffffffffffffffff' },
      { agent: { ...UNSIGNED.agent, agentId: '67' } },
    ];
    for (const flip of flips) {
      expect(bytesToHex(await recordDigest({ ...UNSIGNED, ...flip }))).not.toBe(base);
    }
  });
});

describe('parseUnsignedRecord', () => {
  it('accepts the fixture and returns a structurally equal copy', () => {
    expect(parseUnsignedRecord(UNSIGNED)).toEqual(UNSIGNED);
  });
  const bad: Array<[string, unknown, string]> = [
    ['not an object', 'x', 'malformed'],
    ['unknown version', { ...UNSIGNED, v: '0.3' }, 'unsupported_version'],
    ['uppercase hash', { ...UNSIGNED, input: { sha256: 'A'.repeat(64) } }, 'bad_hash'],
    ['short hash', { ...UNSIGNED, output: { sha256: 'ab' } }, 'bad_hash'],
    ['short nonce', { ...UNSIGNED, nonce: 'abcd' }, 'bad_nonce'],
    ['non-UTC timestamp', { ...UNSIGNED, issuedAt: '2026-09-02T10:00:00+02:00' }, 'bad_timestamp'],
    ['garbage timestamp', { ...UNSIGNED, issuedAt: 'yesterday' }, 'bad_timestamp'],
    ['unknown chain', { ...UNSIGNED, agent: { ...UNSIGNED.agent, chain: 'tron' } }, 'bad_chain'],
    ['missing settlement.ref', { ...UNSIGNED, settlement: { ...UNSIGNED.settlement, ref: '' } }, 'malformed'],
    ['empty payer', { ...UNSIGNED, settlement: { ...UNSIGNED.settlement, payer: '' } }, 'malformed'],
    ['negative output.bytes', { ...UNSIGNED, output: { ...UNSIGNED.output, bytes: -1 } }, 'malformed'],
  ];
  for (const [name, input, code] of bad) {
    it(`rejects ${name} with ${code}`, () => {
      expect(() => parseUnsignedRecord(input)).toThrow(expect.objectContaining({ code }));
    });
  }
});

describe('parseRecord', () => {
  it('requires a sig with a known alg', () => {
    expect(() => parseRecord(UNSIGNED)).toThrow(expect.objectContaining({ code: 'malformed' }));
    expect(() => parseRecord({ ...UNSIGNED, sig: { alg: 'rsa', value: 'ff' } })).toThrow(
      expect.objectContaining({ code: 'bad_sig_alg' }),
    );
    expect(parseRecord({ ...UNSIGNED, sig: { alg: 'ed25519', value: 'ff' } }).sig.alg).toBe('ed25519');
  });
});

describe('randomNonce', () => {
  it('is 32 lowercase hex chars and not repeated', () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('header transport', () => {
  const signed = { ...UNSIGNED, sig: { alg: 'ed25519' as const, value: 'ab'.repeat(64) } };
  it('round-trips and is base64url (no +, /, =)', () => {
    const h = encodeRecordHeader(signed);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRecordHeader(h)).toEqual(signed);
    expect(ENACTMENT_HEADER).toBe('Enactment-Record');
  });
  it('rejects garbage with malformed', () => {
    expect(() => decodeRecordHeader('%%%')).toThrow(expect.objectContaining({ code: 'malformed' }));
    expect(() => decodeRecordHeader(btoa('{"v":"0.1"}').replace(/=/g, ''))).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    );
  });
});

describe('v0.2 skills', () => {
  const S1 = { id: 'acme/skills/stellar-payments', sha256: 'd'.repeat(64) };
  const S2 = { id: 'aaa/skills/horizon-reads', sha256: 'e'.repeat(64) };
  const V02: UnsignedEnactmentRecord = { ...UNSIGNED, v: '0.2', skills: [S1, S2] };

  it('v0.1 bytes are unchanged (golden digest from before v0.2)', async () => {
    expect(bytesToHex(await recordDigest(UNSIGNED))).toBe('c6bd29cdbced385d1fb0f729c7e56be15748d4f6b80c5cc731b488d7920e9b5c');
  });
  it('v0.1 ignores a skills key: it is neither parsed nor signed', async () => {
    const withSkills = { ...UNSIGNED, skills: [S1] };
    expect(parseUnsignedRecord(withSkills)).toEqual(UNSIGNED);
    expect(bytesToHex(await recordDigest(withSkills))).toBe(bytesToHex(await recordDigest(UNSIGNED)));
  });
  it('parses v0.2 with skills sorted by id, placed after output in the canonical bytes', () => {
    expect(parseUnsignedRecord(V02).skills).toEqual([S2, S1]);
    const text = new TextDecoder().decode(canonicalBytes(V02));
    expect(text).toContain(`"output":{"sha256":"${'b'.repeat(64)}","mediaType":"application/json","bytes":120},"skills":[{"id":"${S2.id}","sha256":"${S2.sha256}"},{"id":"${S1.id}"`);
    expect(text.startsWith('{"v":"0.2",')).toBe(true);
  });
  it('the signature binds the skills: order-independent, any change moves the digest', async () => {
    const d = bytesToHex(await recordDigest(V02));
    expect(bytesToHex(await recordDigest({ ...V02, skills: [S2, S1] }))).toBe(d);
    expect(bytesToHex(await recordDigest({ ...V02, skills: [S1] }))).not.toBe(d);
    expect(bytesToHex(await recordDigest({ ...V02, skills: [S1, { ...S2, sha256: 'f'.repeat(64) }] }))).not.toBe(d);
    expect(bytesToHex(await recordDigest({ ...V02, skills: [] }))).not.toBe(bytesToHex(await recordDigest(UNSIGNED)));
  });
  it('an empty list is valid ("none used"); a missing one is not', () => {
    expect(parseUnsignedRecord({ ...V02, skills: [] }).skills).toEqual([]);
    const { skills: _s, ...noSkills } = V02;
    expect(() => parseUnsignedRecord(noSkills)).toThrow(expect.objectContaining({ code: 'bad_skills' }));
  });
  const bad: Array<[string, unknown]> = [
    ['not an array', { id: 'a/b', sha256: 'd'.repeat(64) }],
    ['uppercase hash', [{ id: 'a/b', sha256: 'D'.repeat(64) }]],
    ['empty id', [{ id: '', sha256: 'd'.repeat(64) }]],
    ['id with a space', [{ id: 'a b', sha256: 'd'.repeat(64) }]],
    ['duplicate id', [S1, { ...S1, sha256: 'e'.repeat(64) }]],
    ['too many', Array.from({ length: MAX_RECORD_SKILLS + 1 }, (_, i) => ({ id: `a/s/${i}`, sha256: 'd'.repeat(64) }))],
  ];
  for (const [name, skills] of bad) {
    it(`rejects skills: ${name}`, () => {
      expect(() => parseRecordSkills(skills)).toThrow(expect.objectContaining({ code: 'bad_skills' }));
      expect(() => parseUnsignedRecord({ ...V02, skills })).toThrow(expect.objectContaining({ code: 'bad_skills' }));
    });
  }
  it('header round-trips a signed v0.2 record and stays small with the maximum list', () => {
    const signed = { ...V02, skills: [S2, S1], sig: { alg: 'ed25519' as const, value: 'ab'.repeat(64) } };
    expect(decodeRecordHeader(encodeRecordHeader(signed))).toEqual(signed);
    const max = Array.from({ length: MAX_RECORD_SKILLS }, (_, i) => ({ id: `some-owner/some-skills-repo/skill-name-${String(i).padStart(2, '0')}`, sha256: 'd'.repeat(64) }));
    expect(encodeRecordHeader({ ...signed, skills: max }).length).toBeLessThan(8000);
  });
});
