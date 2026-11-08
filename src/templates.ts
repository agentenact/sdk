/**
 * `templates` — ready-made agent drafts. A template is plain data: what the agent is
 * called, what it charges, the input/output contract and the instructions its model runs
 * with. `fromTemplate` turns one into the two things an agent needs:
 *   - an ERC-8004 registration document + `agentUri` for `createStellarAgent`
 *   - `price`, `description`, `handler` for `createEnactServer`
 *
 * The model is the operator's own function (any LLM, any provider). The package ships no
 * model, holds no API key and calls nothing: a template only shapes the call.
 * A handler that gets bad input or a malformed model answer throws, and `serve` answers
 * 500 before settlement, so the payer is never charged for it.
 * Templates describe what an agent does, never that its output is correct.
 */
import type { EnactServerOptions } from './serve.js';

export type TemplateMediaType = 'text/plain' | 'text/markdown' | 'application/json';

export interface TemplateParam {
  label: string;
  /** Used when the operator gives no value. A param without a default is required. */
  default?: string;
}

export interface AgentTemplate {
  /** kebab-case, stable. */
  id: string;
  /** Bump on any change to `instructions`, `input` or `output`; `fromTemplate` reports `id@version`. */
  version: number;
  title: string;
  /** One line for a picker. */
  summary: string;
  defaults: { name: string; description: string; price: string };
  input: { mediaType: Exclude<TemplateMediaType, 'text/markdown'>; maxBytes: number; example: string };
  output: { mediaType: TemplateMediaType };
  /** The model's instructions. `{{param}}` placeholders are filled from `params`. */
  instructions: string;
  params?: Record<string, TemplateParam>;
}

/** The operator's model. Gets the filled instructions and the buyer's input as text; returns the answer. */
export type TemplateModel = (call: { template: string; instructions: string; input: string }) => Promise<string>;

export interface FromTemplateOptions {
  model: TemplateModel;
  name?: string;
  description?: string;
  /** "$0.001" or "0.001", USD. */
  price?: string;
  /** https URL of the agent's image, carried in the registration document. */
  image?: string;
  params?: Record<string, string>;
  handlerTimeoutMs?: number;
}

/** ERC-8004 registration document (registration-v1), the fields this package writes. */
export interface RegistrationDocument {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string;
  image?: string;
}

export interface AgentFromTemplate {
  /** `id@version` of the template used. */
  template: string;
  registration: RegistrationDocument;
  /** The registration document inline as a data: URI, so no hosting is needed. */
  agentUri: string;
  serve: Pick<EnactServerOptions, 'price' | 'description' | 'handler'> & { handlerTimeoutMs?: number };
}

export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 160;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRICE = /^\$?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g;

function fail(msg: string): never {
  throw new Error(`template: ${msg}`);
}

function checkText(what: string, value: string, max: number): string {
  const v = value.trim();
  if (!v) fail(`${what} is empty`);
  if (v.length > max) fail(`${what} is longer than ${max} characters`);
  return v;
}

function checkPrice(price: string): string {
  const p = price.trim();
  if (!PRICE.test(p) || Number(p.replace('$', '')) <= 0) fail(`price "${price}" is not a positive USD amount`);
  return p;
}

/** Validate a template (built-in or the operator's own) and return it frozen. */
export function defineTemplate(t: AgentTemplate): Readonly<AgentTemplate> {
  if (!ID.test(t.id)) fail(`id "${t.id}" is not kebab-case`);
  if (!Number.isInteger(t.version) || t.version < 1) fail(`${t.id}: version must be a positive integer`);
  checkText(`${t.id}: title`, t.title, NAME_MAX);
  checkText(`${t.id}: summary`, t.summary, DESCRIPTION_MAX);
  checkText(`${t.id}: default name`, t.defaults.name, NAME_MAX);
  checkText(`${t.id}: default description`, t.defaults.description, DESCRIPTION_MAX);
  checkPrice(t.defaults.price);
  checkText(`${t.id}: instructions`, t.instructions, 8_000);
  if (!Number.isInteger(t.input.maxBytes) || t.input.maxBytes < 1) fail(`${t.id}: input.maxBytes must be a positive integer`);
  if (t.input.mediaType === 'application/json') {
    try {
      JSON.parse(t.input.example);
    } catch {
      fail(`${t.id}: input.example is not JSON`);
    }
  }
  const declared = new Set(Object.keys(t.params ?? {}));
  for (const m of t.instructions.matchAll(PLACEHOLDER)) if (!declared.has(m[1]!)) fail(`${t.id}: {{${m[1]}}} is not a declared param`);
  return Object.freeze({ ...t, params: t.params ? Object.freeze({ ...t.params }) : undefined });
}

function fillParams(t: AgentTemplate, given: Record<string, string> = {}): string {
  const params = t.params ?? {};
  for (const k of Object.keys(given)) if (!(k in params)) fail(`${t.id}: unknown param "${k}"`);
  const values: Record<string, string> = {};
  for (const [k, p] of Object.entries(params)) {
    const v = (given[k] ?? p.default ?? '').trim();
    if (!v) fail(`${t.id}: param "${k}" (${p.label}) is required`);
    values[k] = v;
  }
  return t.instructions.replace(PLACEHOLDER, (_m, k: string) => values[k]!);
}

/** Inline data: URI for a registration document. Works in Bun, Node ≥18 and browsers. */
export function registrationUri(doc: RegistrationDocument): string {
  let binary = '';
  for (const b of new TextEncoder().encode(JSON.stringify(doc))) binary += String.fromCharCode(b);
  return `data:application/json;base64,${btoa(binary)}`;
}

function checkJson(what: string, text: string): void {
  try {
    JSON.parse(text);
  } catch {
    fail(`${what} is not JSON`);
  }
}

/** Turn a template into a registration document + agentUri and the serve options of a working agent. */
export function fromTemplate(t: AgentTemplate, opts: FromTemplateOptions): AgentFromTemplate {
  const tpl = defineTemplate(t);
  if (typeof opts.model !== 'function') fail(`${tpl.id}: model must be a function`);
  const ref = `${tpl.id}@${tpl.version}`;
  const name = checkText('name', opts.name ?? tpl.defaults.name, NAME_MAX);
  const description = checkText('description', opts.description ?? tpl.defaults.description, DESCRIPTION_MAX);
  const price = checkPrice(opts.price ?? tpl.defaults.price);
  if (opts.image !== undefined && !/^https:\/\/\S+$/.test(opts.image)) fail('image must be an https URL');
  const instructions = fillParams(tpl, opts.params);

  const registration: RegistrationDocument = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description,
    ...(opts.image ? { image: opts.image } : {}),
  };

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const { model } = opts;
  const handler: EnactServerOptions['handler'] = async (input) => {
    if (input.byteLength === 0) fail(`${ref}: input is empty`);
    if (input.byteLength > tpl.input.maxBytes) fail(`${ref}: input is larger than ${tpl.input.maxBytes} bytes`);
    let text: string;
    try {
      text = decoder.decode(input);
    } catch {
      fail(`${ref}: input is not UTF-8`);
    }
    if (tpl.input.mediaType === 'application/json') checkJson(`${ref}: input`, text);
    const answer = await model({ template: ref, instructions, input: text });
    if (typeof answer !== 'string' || !answer.trim()) fail(`${ref}: model returned no answer`);
    if (tpl.output.mediaType === 'application/json') checkJson(`${ref}: model answer`, answer);
    return { body: encoder.encode(answer), mediaType: tpl.output.mediaType };
  };

  return {
    template: ref,
    registration,
    agentUri: registrationUri(registration),
    serve: { price, description, handler, ...(opts.handlerTimeoutMs !== undefined ? { handlerTimeoutMs: opts.handlerTimeoutMs } : {}) },
  };
}

const JSON_ONLY = 'Answer with one JSON value and nothing else: no prose, no code fences.';

export const TEMPLATES: readonly Readonly<AgentTemplate>[] = Object.freeze([
  defineTemplate({
    id: 'summarize',
    version: 1,
    title: 'Summarizer',
    summary: 'Turns a long text into a short summary.',
    defaults: { name: 'Summarizer', description: 'Summarizes the text you send.', price: '$0.001' },
    input: { mediaType: 'text/plain', maxBytes: 100_000, example: 'Paste an article, a report or a thread here.' },
    output: { mediaType: 'text/markdown' },
    instructions: 'Summarize the text you are given as {{length}}. Keep names, numbers and dates exactly as written. Use only what the text says.',
    params: { length: { label: 'Summary length', default: 'at most 5 bullet points' } },
  }),
  defineTemplate({
    id: 'translate',
    version: 1,
    title: 'Translator',
    summary: 'Translates text into one target language.',
    defaults: { name: 'Translator', description: 'Translates the text you send.', price: '$0.001' },
    input: { mediaType: 'text/plain', maxBytes: 50_000, example: 'Merhaba dünya.' },
    output: { mediaType: 'text/plain' },
    instructions: 'Translate the text you are given into {{to}}. Keep its formatting, names and numbers. Answer with the translation only.',
    params: { to: { label: 'Target language' } },
  }),
  defineTemplate({
    id: 'extract',
    version: 1,
    title: 'Data extractor',
    summary: 'Pulls named fields out of a text as JSON.',
    defaults: { name: 'Data extractor', description: 'Extracts the fields it is set up for from the text you send, as JSON.', price: '$0.002' },
    input: { mediaType: 'text/plain', maxBytes: 50_000, example: 'Invoice 2041 from Acme Ltd, due 2026-11-01, total 1,250.00 EUR.' },
    output: { mediaType: 'application/json' },
    instructions: `Extract these fields from the text you are given: {{fields}}. Return a JSON object with exactly those keys; use null for a field the text does not contain. ${JSON_ONLY}`,
    params: { fields: { label: 'Fields to extract, comma-separated' } },
  }),
  defineTemplate({
    id: 'classify',
    version: 1,
    title: 'Classifier',
    summary: 'Puts a text into one of a fixed set of labels.',
    defaults: { name: 'Classifier', description: 'Labels the text you send with one of its categories.', price: '$0.001' },
    input: { mediaType: 'text/plain', maxBytes: 20_000, example: 'My order arrived broken and I want a refund.' },
    output: { mediaType: 'application/json' },
    instructions: `Classify the text you are given into exactly one of these labels: {{labels}}. Return {"label": "<one of the labels>", "reason": "<one sentence>"}. ${JSON_ONLY}`,
    params: { labels: { label: 'Labels, comma-separated' } },
  }),
]);

/** A built-in template by id, or undefined. */
export function getTemplate(id: string): Readonly<AgentTemplate> | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
