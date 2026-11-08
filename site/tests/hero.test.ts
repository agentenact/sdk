import { describe, expect, it } from 'bun:test';
import { heroLine, sinceDay, STARS, starTwinkle } from '../src/components/hero';
import type { FeedItem } from '../src/lib/explore';

const TX = 'cd'.repeat(32);
const REF = 'ab'.repeat(32);
const item = (o: Partial<FeedItem>): FeedItem => ({
  seq: 7, kind: 'paid', at: '2026-10-16T11:32:37.000Z', agentId: 94, builder: 'external', otherAgentId: 95,
  amount: '0.001', label: null, selfPublished: false, link: { type: 'payment', txHash: TX }, ...o,
});

describe('heroLine', () => {
  it('names the payer first: otherAgentId paid agentId', () => {
    const l = heroLine(item({}));
    expect(l.text).toBe('#95 paid #94');
    expect(l.chip).toBe('paid');
    expect(l.amount).toBe('0.001 USDC');
    expect(l.sealOf).toBe(TX);
    expect(l.href).toContain(TX);
  });

  it('calls a payment with a proof sealed and draws its seal from the proof ref', () => {
    const l = heroLine(item({ link: { type: 'proof', ref: REF, agentUuid: null } }));
    expect(l.chip).toBe('sealed');
    expect(l.sealOf).toBe(REF);
  });

  it('describes registrations and services without amounts', () => {
    expect(heroLine(item({ kind: 'registered', amount: null, otherAgentId: null })).text).toBe('#94 joined');
    const s = heroLine(item({ kind: 'service_opened', amount: null, label: '<b>haiku</b>', link: null }));
    expect(s.text).toBe('#94 opened “<b>haiku</b>”');
    expect(s.href).toBeNull();
    expect(s.sealOf).toBe('seq:7');
  });

  it('drops a malformed link instead of throwing', () => {
    const l = heroLine(item({ link: { type: 'proof', ref: 'not a ref', agentUuid: 'x' } }));
    expect(l.href).toBeNull();
  });
});

describe('sinceDay', () => {
  it('names the UTC day the index stopped, or nothing', () => {
    expect(sinceDay('2026-10-20T13:45:17.385Z')).toBe('20 Oct');
    expect(sinceDay('2026-10-20T23:59:00.000-05:00')).toBe('21 Oct');
    expect(sinceDay(null)).toBeNull();
    expect(sinceDay('garbage')).toBeNull();
  });
});

describe('star twinkle', () => {
  it('derives each star\'s timing from its index alone, so server and browser agree', () => {
    for (let i = 0; i < STARS.length; i++) expect(STARS[i].twinkle).toEqual(starTwinkle(i));
    expect(starTwinkle(5)).toEqual(starTwinkle(5));
  });

  it('breathes on 3–9 s periods, starts mid-cycle, and leaves some stars still', () => {
    const tw = STARS.map((s) => s.twinkle).filter((t) => t !== null);
    expect(tw.length).toBeGreaterThan(STARS.length / 2);
    expect(tw.length).toBeLessThan(STARS.length);
    for (const t of tw) {
      const dur = parseFloat(t.dur);
      expect(dur).toBeGreaterThanOrEqual(3);
      expect(dur).toBeLessThanOrEqual(9);
      expect(parseFloat(t.delay)).toBeLessThanOrEqual(0);
    }
    expect(new Set(tw.map((t) => t.dur)).size).toBeGreaterThan(10);
  });
});
