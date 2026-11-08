import { describe, expect, it } from 'bun:test';
import { TEMPLATES, defineTemplate, fromTemplate, getTemplate, registrationUri, type AgentTemplate, type TemplateModel } from '../src/templates.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const req = new Request('https://agent.example/run', { method: 'POST' });
const echo: TemplateModel = async ({ input }) => `ok: ${input}`;
const decodeUri = (uri: string) => {
  expect(uri.startsWith('data:application/json;base64,')).toBe(true);
  return JSON.parse(dec.decode(Uint8Array.from(atob(uri.split(',')[1]!), (c) => c.charCodeAt(0))));
};
const base = (): AgentTemplate => structuredClone(getTemplate('summarize')!) as AgentTemplate;

describe('built-in templates', () => {
  it('are valid, unique and frozen', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(() => defineTemplate(t as AgentTemplate)).not.toThrow();
      expect(Object.isFrozen(t)).toBe(true);
    }
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
  });
  it('make no correctness claim', () => {
    for (const t of TEMPLATES) {
      const copy = `${t.title} ${t.summary} ${t.defaults.description}`;
      expect(copy).not.toMatch(/\b(correct|accurate|guarantee|verified|trusted)\b/i);
    }
  });
  it('getTemplate finds by id, undefined otherwise', () => {
    expect(getTemplate('translate')?.id).toBe('translate');
    expect(getTemplate('nope')).toBeUndefined();
  });
});

describe('defineTemplate', () => {
  it.each([
    ['a non-kebab id', (t: AgentTemplate) => void (t.id = 'Sum_marize')],
    ['version 0', (t: AgentTemplate) => void (t.version = 0)],
    ['a zero price', (t: AgentTemplate) => void (t.defaults.price = '$0')],
    ['a non-numeric price', (t: AgentTemplate) => void (t.defaults.price = 'one dollar')],
    ['an undeclared placeholder', (t: AgentTemplate) => void (t.instructions += ' {{tone}}')],
    ['a name over 60 chars', (t: AgentTemplate) => void (t.defaults.name = 'x'.repeat(61))],
    ['maxBytes 0', (t: AgentTemplate) => void (t.input.maxBytes = 0)],
    ['a JSON input whose example is not JSON', (t: AgentTemplate) => void (t.input = { mediaType: 'application/json', maxBytes: 10, example: 'hi' })],
  ])('rejects %s', (_n, mutate) => {
    const t = base();
    mutate(t);
    expect(() => defineTemplate(t)).toThrow(/^template: /);
  });
});

describe('fromTemplate', () => {
  it('builds the registration document and its data: agentUri', () => {
    const a = fromTemplate(getTemplate('summarize')!, { model: echo, name: '  Brief  ', image: 'https://x.example/a.png' });
    expect(a.template).toBe('summarize@1');
    expect(a.registration).toEqual({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Brief',
      description: 'Summarizes the text you send.',
      image: 'https://x.example/a.png',
    });
    expect(decodeUri(a.agentUri)).toEqual(a.registration);
    expect(a.serve.price).toBe('$0.001');
    expect(a.serve.description).toBe('Summarizes the text you send.');
    expect('handlerTimeoutMs' in a.serve).toBe(false);
  });

  it('registrationUri round-trips non-ASCII text', () => {
    const doc = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Çevirmen ğüşıö', description: '日本語 ✓' } as const;
    expect(decodeUri(registrationUri(doc))).toEqual(doc);
  });

  it('fills params into the instructions the model gets', async () => {
    let seen: Parameters<TemplateModel>[0] | undefined;
    const a = fromTemplate(getTemplate('translate')!, { model: async (c) => ((seen = c), 'Hello world.'), params: { to: 'English' } });
    const out = await a.serve.handler(enc.encode('Merhaba dünya.'), req);
    expect(dec.decode(out.body)).toBe('Hello world.');
    expect(out.mediaType).toBe('text/plain');
    expect(seen).toEqual({ template: 'translate@1', instructions: expect.stringContaining('into English.'), input: 'Merhaba dünya.' });
    expect(seen!.instructions).not.toContain('{{');
  });

  it('uses param defaults and lets the operator override them', async () => {
    const calls: string[] = [];
    const model: TemplateModel = async (c) => (calls.push(c.instructions), 'x');
    await fromTemplate(getTemplate('summarize')!, { model }).serve.handler(enc.encode('t'), req);
    await fromTemplate(getTemplate('summarize')!, { model, params: { length: 'one sentence' } }).serve.handler(enc.encode('t'), req);
    expect(calls[0]).toContain('at most 5 bullet points');
    expect(calls[1]).toContain('as one sentence.');
  });

  it.each([
    ['a missing required param', { params: {} }, 'translate'],
    ['an unknown param', { params: { to: 'English', tone: 'dry' } }, 'translate'],
    ['a blank name', { name: '   ' }, 'summarize'],
    ['a bad price', { price: '-1' }, 'summarize'],
    ['a non-https image', { image: 'http://x.example/a.png' }, 'summarize'],
  ])('throws at construction on %s', (_n, o, id) => {
    expect(() => fromTemplate(getTemplate(id)!, { model: echo, ...o })).toThrow(/^template: /);
  });

  it('throws without a model function', () => {
    expect(() => fromTemplate(getTemplate('summarize')!, { model: undefined as never })).toThrow(/model must be a function/);
  });

  it('passes handlerTimeoutMs through', () => {
    expect(fromTemplate(getTemplate('summarize')!, { model: echo, handlerTimeoutMs: 20_000 }).serve.handlerTimeoutMs).toBe(20_000);
  });
});

describe('handler refuses before the model runs (serve answers 500, nothing settled)', () => {
  const counted = () => {
    const calls = { n: 0 };
    return { calls, model: (async () => (calls.n++, '{}')) as TemplateModel };
  };
  it.each([
    ['empty input', new Uint8Array()],
    ['input over maxBytes', enc.encode('x'.repeat(20_001))],
    ['input that is not UTF-8', Uint8Array.of(0xff, 0xfe, 0xfd)],
  ])('%s', async (_n, input) => {
    const { calls, model } = counted();
    const a = fromTemplate(getTemplate('classify')!, { model, params: { labels: 'a, b' } });
    await expect(a.serve.handler(input, req)).rejects.toThrow(/^template: classify@1: /);
    expect(calls.n).toBe(0);
  });
  it('JSON input that is not JSON', async () => {
    const { calls, model } = counted();
    const t: AgentTemplate = { ...base(), id: 'json-in', input: { mediaType: 'application/json', maxBytes: 100, example: '{}' } };
    await expect(fromTemplate(t, { model }).serve.handler(enc.encode('{nope'), req)).rejects.toThrow(/input is not JSON/);
    expect(calls.n).toBe(0);
  });
});

describe('handler checks the model answer', () => {
  it('returns JSON output as application/json', async () => {
    const a = fromTemplate(getTemplate('extract')!, { model: async () => '{"total":"1250.00"}', params: { fields: 'total' } });
    const out = await a.serve.handler(enc.encode('total 1,250.00'), req);
    expect(out.mediaType).toBe('application/json');
    expect(JSON.parse(dec.decode(out.body))).toEqual({ total: '1250.00' });
  });
  it.each([
    ['prose instead of JSON', 'Sure! Here it is: {"label":"a"}', /model answer is not JSON/],
    ['an empty answer', '  ', /model returned no answer/],
  ])('throws on %s', async (_n, answer, re) => {
    const a = fromTemplate(getTemplate('classify')!, { model: async () => answer, params: { labels: 'a, b' } });
    await expect(a.serve.handler(enc.encode('text'), req)).rejects.toThrow(re);
  });
  it('lets a model failure propagate', async () => {
    const a = fromTemplate(getTemplate('summarize')!, { model: async () => Promise.reject(new Error('upstream 529')) });
    await expect(a.serve.handler(enc.encode('text'), req)).rejects.toThrow('upstream 529');
  });
});

describe('a template agent under createEnactServer', () => {
  const AGENT = 'GAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const PAYER = 'GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const TX = 'e'.repeat(64);
  const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const REQ = { scheme: 'exact', network: 'stellar:pubnet', amount: '10000', asset: 'CCW67…', payTo: AGENT, maxTimeoutSeconds: 60, extra: {} } as never;

  async function run(answer: string, body: string) {
    const { createEnactServer } = await import('../src/serve.js');
    const { ENACTMENT_HEADER } = await import('../src/index.js');
    const x = { settled: 0 };
    const agent = fromTemplate(getTemplate('classify')!, { model: async () => answer, params: { labels: 'refund, other' } });
    const handle = await createEnactServer({
      network: 'stellar:pubnet',
      agent: { address: AGENT, agentId: '66', secret: new Uint8Array(32) },
      adapter: {
        chain: 'stellar',
        sigAlg: 'ed25519',
        async sign() { return 'sig'; },
        async verify() { return true; },
        async readSettlement() { return []; },
        async resolveIdentity() { return { owner: AGENT, wallet: null }; },
      },
      facilitator: { url: 'https://example.invalid', apiKey: 'k' },
      resource: 'https://agent.example/classify',
      ...agent.serve,
      x402: {
        async accepts() { return [REQ]; },
        async paymentRequired() { return { status: 402 as const, headers: {}, body: '{}' }; },
        async verify() { return { ok: true as const, requirements: REQ, payload: { x402Version: 2, accepted: REQ, payload: {} } as never, payer: PAYER, asset: USDC, decimals: 7 }; },
        async settle() { x.settled++; return { ok: true as const, transaction: TX, payer: PAYER, amount: '0.0010000', responseHeader: 'resp' }; },
      },
    });
    const res = await handle(new Request('https://agent.example/classify', { method: 'POST', body, headers: { 'PAYMENT-SIGNATURE': 'good' } }));
    return { res, settled: x.settled, record: res.headers.get(ENACTMENT_HEADER) };
  }

  it('a good answer settles once and carries a record', async () => {
    const { res, settled, record } = await run('{"label":"refund","reason":"asks for money back"}', 'refund please');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(settled).toBe(1);
    expect(record).toBeTruthy();
  });
  it('a malformed model answer settles nothing', async () => {
    const { res, settled, record } = await run('Sure: refund', 'refund please');
    expect(res.status).toBe(500);
    expect(settled).toBe(0);
    expect(record).toBeNull();
  });
});
