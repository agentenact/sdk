import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentCards, EmptySearch, PaymentsNote, createQueryGate } from '../src/components/agent-list';
import type { AgentCard, PaymentsSource } from '../src/lib/explore';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const card = (o: Partial<AgentCard>): AgentCard => ({
  id: 45, builder: 'hosted', selfPublished: null, paymentsReceived: 7, usdcReceived: '0.007', provenSales: 3,
  lastActiveAt: '2026-10-12T09:00:00.000Z', lastPaymentAt: '2026-10-12T09:25:00.000Z', karma: null, ...o,
});
const UP: PaymentsSource = { source: 'agentkarma', available: true, asOf: '2026-10-12T09:58:00.000Z' };
const DOWN: PaymentsSource = { source: 'agentkarma', available: false, asOf: '2026-10-12T09:12:00.000Z' };
const html = (items: AgentCard[], payments?: PaymentsSource) => renderToStaticMarkup(createElement(AgentCards, { items, now: NOW, payments }));

describe('AgentCards', () => {
  it('shows price: ask the agent when the price is null', () => {
    const out = html([card({ selfPublished: { name: 'Poet', service: { slug: 'haiku', description: null, priceUsdc: null } } })]);
    expect(out).toContain('price: ask the agent');
    expect(out).toContain('“haiku”');
    expect(out).toContain('self-published');
  });

  it('shows the price when there is one', () => {
    const out = html([card({ selfPublished: { name: 'Poet', service: { slug: 'haiku', description: null, priceUsdc: '0.001' } } })]);
    expect(out).toContain('0.001 USDC');
    expect(out).not.toContain('ask the agent');
  });

  it('says no public services without a service', () => {
    expect(html([card({})])).toContain('no public services');
  });

  it('tags external vs Built on AgentEnact (hosted and library alike)', () => {
    expect(html([card({ builder: 'library' })])).toContain('>Built on AgentEnact<');
    expect(html([card({ builder: 'hosted' })])).toContain('>Built on AgentEnact<');
    const ext = html([card({ builder: 'external' })]);
    expect(ext).toContain('>external<');
    expect(ext).not.toContain('Built on AgentEnact');
  });

  it('always shows the id beside the name, including a self-published one', () => {
    const out = html([card({ id: 82, selfPublished: { name: 'XLM drop alert', service: null } })]);
    expect(out).toContain('<span class="ex-aid">#82</span>');
    expect(out).toContain('“XLM drop alert”');
    expect(html([card({ id: 91, builder: 'external' })])).toContain('<span class="ex-aid">#91</span>');
  });

  it('falls back to Agent #id without a name', () => {
    expect(html([card({ id: 77 })])).toContain('Agent #77');
    expect(html([card({ id: 78, selfPublished: { name: null, service: null } })])).toContain('Agent #78');
  });

  it('uses the self-published name when present', () => {
    expect(html([card({ selfPublished: { name: 'Pixel Poet', service: null } })])).toContain('Pixel Poet');
  });

  it('marks a self-published name and not a fallback name', () => {
    const own = html([card({ selfPublished: { name: 'Pixel Poet', service: null } })]);
    expect(own.match(/self-published/g)?.length).toBe(1);
    expect(html([card({ id: 77 })])).not.toContain('self-published');
    expect(html([card({ id: 78, selfPublished: { name: null, service: null } })])).not.toContain('self-published');
  });

  it('links to /agent?id=', () => {
    expect(html([card({ id: 45 })])).toContain('href="/agent?id=45"');
  });

  it('shows proven outputs for AgentEnact and payments received for external', () => {
    expect(html([card({ builder: 'hosted', provenSales: 3 })])).toContain('3 proven outputs');
    const ext = html([card({ builder: 'external', paymentsReceived: 7 })]);
    expect(ext).toContain('7 payments received');
    expect(ext).toContain('<b>0.007 USDC</b>');
    expect(ext).not.toContain('proven');
  });

  it('gets the plurals right', () => {
    expect(html([card({ builder: 'hosted', provenSales: 1 })])).toContain('>1 proven output<');
    expect(html([card({ builder: 'hosted', provenSales: 0 })])).toContain('>0 proven outputs<');
    expect(html([card({ builder: 'external', paymentsReceived: 1 })])).toContain('1 payment received');
    expect(html([card({ builder: 'external', paymentsReceived: 1 })])).not.toContain('1 payments');
  });

  it('says no payments received for an external agent with none', () => {
    expect(html([card({ builder: 'external', paymentsReceived: 0, usdcReceived: '0' })])).toContain('no payments received');
  });

  it('shows the last payment received age', () => {
    expect(html([card({})])).toContain('last payment received 35m');
  });

  it('says payments are unavailable (not zero) when AgentKarma is down, and keeps our proven outputs', () => {
    const ext = html([card({ builder: 'external', paymentsReceived: null, usdcReceived: null, lastPaymentAt: null })], DOWN);
    expect(ext).toContain('payments unavailable');
    expect(ext).not.toContain('no payments received');
    expect(ext).not.toContain('last payment');
    expect(html([card({ builder: 'hosted', provenSales: 2, paymentsReceived: null, usdcReceived: null })], DOWN)).toContain('2 proven outputs');
  });

  it('says not on AgentKarma yet when it is up but has no record of the agent', () => {
    const ext = html([card({ builder: 'external', paymentsReceived: null, usdcReceived: null, lastPaymentAt: null })], UP);
    expect(ext).toContain('not on AgentKarma yet');
    expect(ext).not.toContain('no payments received');
  });

  it('shows the AgentKarma score and tier when there is one, nothing when unrated or absent', () => {
    const text = (m: string) => m.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text(html([card({ karma: { score: 87, tier: 'Very Good' } })]))).toContain('AgentKarma 87 · Very Good');
    expect(text(html([card({ karma: { score: 87.4, tier: null } })]))).toMatch(/AgentKarma 87(?![\d.])/);
    for (const karma of [null, { score: null, tier: null }, { score: 0, tier: 'Unrated' }]) expect(html([card({ karma })])).not.toContain('AgentKarma');
    const legacy = card({});
    delete (legacy as Partial<AgentCard>).karma; // an older api build sends no karma field
    expect(html([legacy])).not.toContain('AgentKarma');
  });

  it('shows no last-payment text when the field is missing or null, and never borrows lastActiveAt', () => {
    const missing = card({});
    delete missing.lastPaymentAt;
    expect(html([missing])).not.toContain('last payment');
    expect(html([card({ lastPaymentAt: null })])).not.toContain('last payment');
    expect(html([missing])).not.toContain('active 1h');
  });

  it('escapes hostile names and slugs', () => {
    const out = html([card({ selfPublished: { name: '<script>x</script>', service: { slug: '<img onerror=1>', description: null, priceUsdc: null } } })]);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
  });
});

describe('PaymentsNote', () => {
  const out = (p?: PaymentsSource) => renderToStaticMarkup(createElement(PaymentsNote, { payments: p })).replace(/<[^>]*>/g, '');
  it('names AgentKarma as the source of card payments and says the transfers total is ours', () => {
    const o = out(UP);
    expect(o).toContain('Payments on these cards are AgentKarma’s index, as of 09:58 UTC.');
    expect(o).toContain('payments.csv');
  });
  it('says what is missing and since when when AgentKarma is unavailable', () => {
    expect(out(DOWN)).toContain('Payments from AgentKarma are unavailable since 09:12 UTC. Agents and proven outputs are shown from AgentEnact’s own index.');
    expect(out({ source: 'agentkarma', available: false, asOf: null })).toContain('Payments from AgentKarma are unavailable right now.');
  });
  it('renders nothing for an older api build that does not say', () => {
    expect(out(undefined)).toBe('');
  });
});

describe('EmptySearch', () => {
  const out = (q: string, total?: number) => renderToStaticMarkup(createElement(EmptySearch, { query: q, total }));
  it('echoes the query as text, says what search covers and offers a way out', () => {
    const o = out('stellar dex', 92);
    expect(o).toContain('No agents match “stellar dex”.');
    expect(o).toContain('Search looks at names, services and ids such as #46.');
    expect(o).toContain('clear the search to see all 92.');
    expect(o).toContain('>Clear search<');
  });
  it('escapes a hostile query', () => {
    const o = out('<script>alert(1)</script>');
    expect(o).not.toContain('<script');
    expect(o).toContain('&lt;script&gt;');
  });
  it('does not invent a total', () => {
    expect(out('x')).toContain('to see all agents.');
  });
});

describe('createQueryGate', () => {
  it('accepts a response only for the latest query', () => {
    const g = createQueryGate();
    const a = g.begin('foo');
    expect(g.isCurrent(a)).toBe(true);
    const b = g.begin('bar');
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
  it('a load-more started for an old query is stale once the query changes', () => {
    const g = createQueryGate();
    g.begin('');
    const more = g.begin('');
    g.begin('x');
    expect(g.isCurrent(more)).toBe(false);
  });
});
