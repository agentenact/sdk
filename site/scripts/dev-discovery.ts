/**
 * Dev-only: canned discovery api on :8790, in the exact real response shapes
 * (apps/api/src/discovery/queries.ts). Not shipped, not part of the build.
 *
 *   bun run scripts/dev-discovery.ts
 *   NEXT_PUBLIC_DISCOVERY_API=http://localhost:8790 bun run dev
 *
 * A new feed line appears every few seconds so polling is visible.
 */
import { createServer } from 'node:http';

const REF = 'ab'.repeat(32);
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const TX = 'cd'.repeat(32);
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

interface Item {
  seq: number; kind: 'paid' | 'registered' | 'service_opened'; at: string; agentId: number;
  builder: 'hosted' | 'library' | 'external'; otherAgentId: number | null; amount: string | null;
  label: string | null; selfPublished: boolean;
  link: { type: 'proof'; ref: string; agentUuid: string | null } | { type: 'payment' | 'registration'; txHash: string } | null;
}

const HOSTILE = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const LONG = 'A'.repeat(70) + ' agent with an extremely long self-published name that must wrap';

const feed: Item[] = [
  { seq: 1, kind: 'registered', at: ago(900), agentId: 1284, builder: 'external', otherAgentId: null, amount: null, label: null, selfPublished: false, link: null },
  { seq: 2, kind: 'registered', at: ago(700), agentId: 31, builder: 'library', otherAgentId: null, amount: null, label: null, selfPublished: false, link: { type: 'registration', txHash: TX } },
  { seq: 3, kind: 'service_opened', at: ago(500), agentId: 902, builder: 'external', otherAgentId: null, amount: null, label: HOSTILE, selfPublished: true, link: null },
  { seq: 4, kind: 'service_opened', at: ago(400), agentId: 33, builder: 'hosted', otherAgentId: null, amount: null, label: LONG, selfPublished: true, link: null },
  { seq: 5, kind: 'paid', at: ago(300), agentId: 45, builder: 'hosted', otherAgentId: 46, amount: '0.001', label: null, selfPublished: false, link: { type: 'proof', ref: REF, agentUuid: UUID } },
  { seq: 6, kind: 'paid', at: ago(120), agentId: 45, builder: 'library', otherAgentId: null, amount: '12.5', label: null, selfPublished: false, link: { type: 'proof', ref: REF, agentUuid: null } },
  { seq: 7, kind: 'paid', at: ago(30), agentId: 700, builder: 'external', otherAgentId: null, amount: '0.25', label: null, selfPublished: false, link: { type: 'payment', txHash: TX } },
];
let seq = feed.length;
setInterval(() => {
  seq += 1;
  feed.push({ seq, kind: 'paid', at: new Date().toISOString(), agentId: 45, builder: 'hosted', otherAgentId: 46, amount: '0.001', label: null, selfPublished: false, link: { type: 'proof', ref: REF, agentUuid: UUID } });
}, 7000);

const agents = [
  { id: 45, builder: 'hosted', selfPublished: { name: 'Pixel Poet', service: { slug: 'haiku', description: 'A haiku', priceUsdc: '0.001' } }, paymentsReceived: 12, usdcReceived: '0.012', provenSales: 12, lastActiveAt: ago(30) },
  { id: 902, builder: 'external', selfPublished: { name: HOSTILE, service: { slug: HOSTILE, description: null, priceUsdc: null } }, paymentsReceived: 3, usdcReceived: '1.5', provenSales: 0, lastActiveAt: ago(500) },
  { id: 33, builder: 'hosted', selfPublished: { name: LONG, service: { slug: 'x'.repeat(60), description: null, priceUsdc: '2' } }, paymentsReceived: 0, usdcReceived: '0', provenSales: 0, lastActiveAt: null },
  { id: 1284, builder: 'external', selfPublished: null, paymentsReceived: 0, usdcReceived: '0', provenSales: 0, lastActiveAt: null },
  { id: 31, builder: 'library', selfPublished: null, paymentsReceived: 5, usdcReceived: '0.5', provenSales: 5, lastActiveAt: ago(86400 * 2) },
  ...Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, builder: 'external', selfPublished: null, paymentsReceived: i, usdcReceived: '0', provenSales: 0, lastActiveAt: ago(3600 * (i + 1)) })),
];


// ---- Profiles: /public/agents/:id (apps/api/src/discovery/queries.ts, AgentProfile) ----------------
const ADDR = (c: string) => 'G' + c.repeat(55);
const hist = (n: number, proof: boolean) => Array.from({ length: n }, (_, i) => ({
  at: ago(300 * (i + 1)), amount: '0.001', payer: ADDR('B'), txHash: i.toString(16).padStart(2, '0').repeat(32),
  proof: proof && i % 2 === 0 ? { ref: REF, agentUuid: UUID } : null,
}));
const base = { lastActiveAt: ago(300), links: { karma: '' }, hidden: false };
const profiles: Record<number, unknown> = {
  46: { ...base, id: 46, owner: ADDR('A'), wallet: ADDR('C'), builder: 'hosted',
    registered: { at: ago(86400 * 9), txHash: TX, source: 'event' },
    totals: { paymentsReceived: 6, usdcReceived: '0.006', provenSales: 3 }, history: hist(6, true),
    selfPublished: { name: 'Pixel Poet', description: 'Writes a haiku about anything you send.', fetchedAt: ago(60),
      services: [{ slug: 'haiku', description: 'Three lines, 5-7-5.', priceUsdc: '0.001' }, { slug: 'limerick', description: null, priceUsdc: '0.002' }] } },
  1284: { ...base, id: 1284, owner: ADDR('D'), wallet: null, builder: 'external', lastActiveAt: null,
    registered: { at: null, txHash: null, source: 'registry_read' },
    totals: { paymentsReceived: 2, usdcReceived: '0.5', provenSales: 0 }, history: hist(2, false),
    selfPublished: { name: 'Ask Me', description: null, fetchedAt: ago(60), services: [{ slug: 'anything', description: null, priceUsdc: null }] } },
  666: { ...base, id: 666, owner: ADDR('E'), wallet: null, builder: 'external', hidden: true,
    registered: { at: ago(86400), txHash: null, source: 'event' },
    totals: { paymentsReceived: 0, usdcReceived: '0', provenSales: 0 }, history: [], selfPublished: null },
  902: { ...base, id: 902, owner: ADDR('F'), wallet: ADDR('G'), builder: 'external',
    registered: { at: ago(86400 * 2), txHash: TX, source: 'event' },
    totals: { paymentsReceived: 1, usdcReceived: '1.5', provenSales: 0 }, history: hist(1, false),
    selfPublished: { name: HOSTILE + ' ' + LONG, description: HOSTILE + ' ' + 'word'.repeat(60), fetchedAt: ago(60),
      services: [{ slug: HOSTILE, description: LONG + LONG, priceUsdc: null }, { slug: 'x'.repeat(80), description: null, priceUsdc: '2' }] } },
  7: { ...base, id: 7, owner: ADDR('H'), wallet: null, builder: 'library', lastActiveAt: null,
    registered: { at: ago(86400 * 30), txHash: TX, source: 'event' },
    totals: { paymentsReceived: 0, usdcReceived: '0', provenSales: 0 }, history: [], selfPublished: null },
};
for (const p of Object.values(profiles) as { owner: string; links: { karma: string } }[]) p.links.karma = `https://agentkarma.io/agent/${p.owner}`;

const send = (res: import('node:http').ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'retry-after, x-truncated' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  if (u.pathname === '/public/stats') {
    return send(res, 200, {
      network: 'testnet', agents: 1284, provenOutputs: 56, usdcPaid: '213.4', activeLastHour: 7,
      asOf: new Date().toISOString(), indexedThrough: new Date().toISOString(), stale: u.searchParams.has('stale'),
    });
  }
  if (u.pathname === '/public/feed') {
    const after = u.searchParams.get('after');
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') ?? 50)));
    if (after !== null) {
      const items = feed.filter((i) => i.seq > Number(after)).slice(0, limit);
      return send(res, 200, { items, latestSeq: items.length ? items[items.length - 1]!.seq : Number(after) });
    }
    const items = [...feed].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq).slice(0, limit);
    return send(res, 200, { items, latestSeq: feed[feed.length - 1]!.seq });
  }
  if (u.pathname === '/public/agents') {
    const q = (u.searchParams.get('q') ?? '').trim().toLowerCase();
    const cursor = Number(u.searchParams.get('cursor') ?? 0);
    const hit = agents.filter((a) => !q || `#${a.id} ${a.selfPublished?.name ?? ''} ${a.selfPublished?.service?.slug ?? ''}`.toLowerCase().includes(q));
    const items = hit.slice(cursor, cursor + 20);
    return send(res, 200, { items, next: cursor + 20 < hit.length ? String(cursor + 20) : null });
  }
  const m = /^\/public\/agents\/(\d{1,10})$/.exec(u.pathname);
  if (m) {
    const p = profiles[Number(m[1])];
    return p ? send(res, 200, p) : send(res, 404, { error: 'not_found' });
  }
  send(res, 404, { error: 'not_found' });
}).listen(8790, () => console.log('dev discovery on http://localhost:8790 (add ?stale to /public/stats; profiles: 46 hosted, 1284 external null price, 666 hidden, 902 hostile, 7 empty, other = 404)'));
