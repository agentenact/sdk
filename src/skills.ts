/**
 * `skills` — find, audit, approve, pin and use Agent Skills (skills.sh / agentskills.io format).
 *
 * The flow at agent setup:
 *   1. suggestSkills(tasks)      search skills.sh once per defined task, rank the matches
 *   2. reviewSkill(snapshot)     the owner sees the partner audits plus our own static findings
 *   3. approveSkill(review)      the approval is bound to OUR content hash of the exact files reviewed
 *   4. createSkillLock(entries)  the agent's skill lock: what it may use, pinned
 * At run time:
 *   5. loadSkills(lock, get)     re-fetches each skill and refuses any whose content hash moved
 *   6. createSkillKit(snapshots) name+description index for the prompt, bodies and files on demand
 *
 * Why our own hash: skills.sh audits carry `auditedAt` but no version or hash, so an audit cannot
 * prove which content it looked at. An approval therefore pins `contentHash` (and a GitHub commit
 * when the snapshot came from GitHub). A changed skill is never picked up silently: checkSkillUpdates
 * reports it, and only a new review + approval moves the pin.
 *
 * A skill is text the agent reads. Nothing here executes a skill's scripts, and no function in this
 * module takes or returns a signer, a secret or a wallet. Skills stay outside the signing boundary.
 * Zero dependencies; every network call goes through an injectable `fetch` and is a GET.
 */
import { sha256Hex, type RecordSkill } from './record.js';

export const SKILL_LOCK_VERSION = '0.1' as const;

// ─── errors ───────────────────────────────────────────────────────────────────

export type SkillErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'malformed'
  | 'bad_path'
  | 'not_approvable'
  | 'not_approved'
  | 'skill_changed';

export type SkillError = Error & { code: SkillErrorCode; status?: number };

export function createSkillError(code: SkillErrorCode, message: string, status?: number): SkillError {
  const err = new Error(message) as SkillError;
  err.name = 'SkillError';
  err.code = code;
  if (status !== undefined) err.status = status;
  return err;
}

export function isSkillError(err: unknown): err is SkillError {
  return err instanceof Error && err.name === 'SkillError';
}

// ─── types ────────────────────────────────────────────────────────────────────

export interface SkillFile {
  /** Relative to the skill root, `/`-separated: `SKILL.md`, `scripts/run.py`. */
  path: string;
  contents: string;
}

/** A skill as listed by skills.sh search. */
export interface SkillListing {
  /** `{source}/{slug}`: `owner/repo/slug` (github) or `domain/slug` (well-known). */
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: 'github' | 'well-known';
  installUrl: string | null;
  url: string;
  isDuplicate?: boolean;
}

/** Where a snapshot's files came from, and what pins them. */
export type SkillPin =
  | { kind: 'github'; repo: string; commit: string; dir: string }
  | { kind: 'skills.sh'; registryHash: string | null };

/** The exact files of one skill at one moment. `contentHash` is ours (see skillContentHash). */
export interface SkillSnapshot {
  id: string;
  files: SkillFile[];
  contentHash: string;
  pin: SkillPin;
}

export type AuditStatus = 'pass' | 'warn' | 'fail';

/** One partner audit as skills.sh returns it. Not bound to a version: see the module comment. */
export interface SkillAudit {
  provider: string;
  slug: string;
  status: AuditStatus;
  summary: string;
  auditedAt: string;
  /** Seen live: NONE, SAFE, LOW, MEDIUM, HIGH, CRITICAL. Kept as given. */
  riskLevel?: string;
  categories?: string[];
}

export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata: Record<string, string>;
}

// ─── SKILL.md ─────────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parses SKILL.md: YAML frontmatter (the flat subset the spec uses, plus a one-level `metadata` map)
 * and the markdown body. Validates `name` and `description` per agentskills.io/specification.
 */
export function parseSkillManifest(text: string): { manifest: SkillManifest; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) throw createSkillError('malformed', 'SKILL.md must start with YAML frontmatter');
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  let lastKey: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const nested = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (nested && inMetadata) {
      metadata[nested[1]!] = unquote(nested[2]!);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      inMetadata = top[1] === 'metadata' && top[2]!.trim() === '';
      lastKey = inMetadata ? null : top[1]!;
      if (!inMetadata) fields[top[1]!] = unquote(top[2]!);
      continue;
    }
    // Folded continuation of the previous scalar (`description: >` or a wrapped plain scalar).
    if (/^\s+/.test(line) && lastKey) {
      const prev = fields[lastKey]!;
      const piece = line.trim();
      fields[lastKey] = prev === '>' || prev === '|' || prev === '>-' || prev === '|-' ? piece : `${prev} ${piece}`;
      continue;
    }
    throw createSkillError('malformed', `SKILL.md frontmatter line not understood: ${line.slice(0, 80)}`);
  }
  const name = fields.name ?? '';
  if (!NAME_RE.test(name) || name.length > 64) {
    throw createSkillError('malformed', 'SKILL.md name must be 1-64 chars of a-z, 0-9 and single hyphens');
  }
  const description = fields.description ?? '';
  if (description.length === 0 || description.length > 1024) {
    throw createSkillError('malformed', 'SKILL.md description must be 1-1024 chars');
  }
  const manifest: SkillManifest = { name, description, metadata };
  if (fields.license) manifest.license = fields.license;
  if (fields.compatibility) manifest.compatibility = fields.compatibility;
  if (fields['allowed-tools']) manifest.allowedTools = fields['allowed-tools'].split(/\s+/).filter(Boolean);
  return { manifest, body: m[2]! };
}

// ─── content hash ─────────────────────────────────────────────────────────────

function checkPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw createSkillError('bad_path', `skill file path not allowed: ${path}`);
  }
}

/**
 * sha256 over the canonical file list: entries sorted by path (code-unit order), each
 * `[path, sha256(contents)]`, serialised as compact JSON. Independent of the order files arrive in
 * and of any registry's own hash. Requires a SKILL.md at the root and unique, relative paths.
 */
export async function skillContentHash(files: readonly SkillFile[]): Promise<string> {
  const seen = new Set<string>();
  for (const f of files) {
    checkPath(f.path);
    if (seen.has(f.path)) throw createSkillError('malformed', `duplicate skill file: ${f.path}`);
    seen.add(f.path);
  }
  if (!seen.has('SKILL.md')) throw createSkillError('malformed', 'a skill must have SKILL.md at its root');
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = await Promise.all(sorted.map(async (f) => [f.path, await sha256Hex(f.contents)] as const));
  return sha256Hex(JSON.stringify(entries));
}

/** Builds a snapshot, computing the content hash. */
export async function createSkillSnapshot(id: string, files: SkillFile[], pin: SkillPin): Promise<SkillSnapshot> {
  return { id, files, contentHash: await skillContentHash(files), pin };
}

// ─── http ─────────────────────────────────────────────────────────────────────

async function getJson(f: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { headers: { accept: 'application/json', ...headers } });
  } catch (err) {
    throw createSkillError('unavailable', `request failed: ${url}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw createSkillError('unauthorized', `${url} needs credentials (status ${res.status})`, res.status);
  }
  if (res.status === 404) throw createSkillError('not_found', `${url} not found`, 404);
  if (res.status === 429) throw createSkillError('rate_limited', `${url} rate limited`, 429);
  if (!res.ok) throw createSkillError('unavailable', `${url} returned ${res.status}`, res.status);
  try {
    return await res.json();
  } catch {
    throw createSkillError('malformed', `${url} did not return JSON`);
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function encodeId(id: string): string {
  const parts = id.split('/');
  if (parts.length < 2 || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw createSkillError('malformed', `bad skill id: ${id}`);
  }
  return parts.map(encodeURIComponent).join('/');
}

function parseListing(x: unknown): SkillListing | null {
  if (!isObj(x) || typeof x.id !== 'string' || typeof x.source !== 'string' || typeof x.slug !== 'string') return null;
  const listing: SkillListing = {
    id: x.id,
    slug: x.slug,
    name: typeof x.name === 'string' ? x.name : x.slug,
    source: x.source,
    installs: typeof x.installs === 'number' ? x.installs : 0,
    sourceType: x.sourceType === 'well-known' ? 'well-known' : 'github',
    installUrl: typeof x.installUrl === 'string' ? x.installUrl : null,
    url: typeof x.url === 'string' ? x.url : '',
  };
  if (x.isDuplicate === true) listing.isDuplicate = true;
  return listing;
}

/** `/api/search` items carry `skillId` for the slug and no sourceType/url; fill them the way the v1 API would. */
function publicListing(x: unknown, base: string): unknown {
  if (!isObj(x) || typeof x.id !== 'string' || typeof x.source !== 'string') return x;
  const slug = typeof x.slug === 'string' ? x.slug : x.skillId;
  return {
    ...x,
    slug,
    sourceType: x.source.includes('/') ? 'github' : 'well-known',
    installUrl: x.source,
    url: `${base}/${x.id}`,
  };
}

function parseAudit(x: unknown): SkillAudit | null {
  if (!isObj(x) || typeof x.provider !== 'string') return null;
  if (x.status !== 'pass' && x.status !== 'warn' && x.status !== 'fail') return null;
  const audit: SkillAudit = {
    provider: x.provider,
    slug: typeof x.slug === 'string' ? x.slug : x.provider,
    status: x.status,
    summary: typeof x.summary === 'string' ? x.summary : '',
    auditedAt: typeof x.auditedAt === 'string' ? x.auditedAt : '',
  };
  if (typeof x.riskLevel === 'string') audit.riskLevel = x.riskLevel.toUpperCase();
  if (Array.isArray(x.categories)) audit.categories = x.categories.filter((c): c is string => typeof c === 'string');
  return audit;
}

// ─── skills.sh ────────────────────────────────────────────────────────────────

export interface SkillsShOptions {
  /**
   * Vercel OIDC token. skills.sh's v1 API requires it for search and detail (401 without it, checked
   * 2026-10-17); the audit endpoint answered without one. Without a token, search uses `/api/search`,
   * the public endpoint the `skills` CLI (`npx skills find`) calls; `get` still needs the token, so read
   * content from GitHub (createGitHubSkillSource) instead.
   */
  token?: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface SkillsShClient {
  search(query: string, opts?: { limit?: number }): Promise<SkillListing[]>;
  /** Latest snapshot skills.sh holds. Pinned by our content hash; skills.sh's own hash is kept as info. */
  get(id: string): Promise<SkillSnapshot>;
  /** Partner audits. A skill no partner has audited yet returns []. */
  audits(id: string): Promise<SkillAudit[]>;
}

export function createSkillsShClient(opts: SkillsShOptions = {}): SkillsShClient {
  const f = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? 'https://skills.sh').replace(/\/+$/, '');
  const headers = async (): Promise<Record<string, string>> => {
    if (opts.token === undefined) return {};
    const t = typeof opts.token === 'function' ? await opts.token() : opts.token;
    return { authorization: `Bearer ${t}` };
  };
  return {
    async search(query, o = {}) {
      if (query.trim().length < 2) throw createSkillError('malformed', 'search query needs at least 2 characters');
      const limit = Math.min(Math.max(o.limit ?? 10, 1), 200);
      const q = encodeURIComponent(query.trim());
      if (opts.token === undefined) {
        const body = await getJson(f, `${base}/api/search?q=${q}&limit=${limit}`, {});
        if (!isObj(body) || !Array.isArray(body.skills)) throw createSkillError('malformed', 'search response has no skills');
        return body.skills.map((x) => parseListing(publicListing(x, base))).filter((l): l is SkillListing => l !== null);
      }
      const body = await getJson(f, `${base}/api/v1/skills/search?q=${q}&limit=${limit}`, await headers());
      if (!isObj(body) || !Array.isArray(body.data)) throw createSkillError('malformed', 'search response has no data');
      return body.data.map(parseListing).filter((l): l is SkillListing => l !== null);
    },
    async get(id) {
      const body = await getJson(f, `${base}/api/v1/skills/${encodeId(id)}`, await headers());
      if (!isObj(body) || !Array.isArray(body.files)) {
        throw createSkillError('not_found', `skills.sh holds no snapshot of ${id}`);
      }
      const files = body.files.map((x) => {
        if (!isObj(x) || typeof x.path !== 'string' || typeof x.contents !== 'string') {
          throw createSkillError('malformed', `bad file entry in ${id}`);
        }
        return { path: x.path, contents: x.contents };
      });
      const registryHash = typeof body.hash === 'string' ? body.hash : null;
      return createSkillSnapshot(id, files, { kind: 'skills.sh', registryHash });
    },
    async audits(id) {
      try {
        const body = await getJson(f, `${base}/api/v1/skills/audit/${encodeId(id)}`, await headers());
        if (!isObj(body) || !Array.isArray(body.audits)) throw createSkillError('malformed', 'audit response has no audits');
        return body.audits.map(parseAudit).filter((a): a is SkillAudit => a !== null);
      } catch (err) {
        if (isSkillError(err) && err.code === 'not_found') return [];
        throw err;
      }
    },
  };
}

// ─── GitHub (commit-pinned source) ────────────────────────────────────────────

export interface GitHubSkillSourceOptions {
  token?: string;
  fetch?: typeof fetch;
  apiUrl?: string;
  rawUrl?: string;
  /** Refuse skills with more files than this. Default 64. */
  maxFiles?: number;
}

export interface GitHubSkillSource {
  /**
   * Reads skill `owner/repo/slug` from GitHub at `ref` (default: the default branch) and pins the
   * resolved commit. With `ref` set to a commit sha, the result is the same files every time.
   */
  get(id: string, ref?: string): Promise<SkillSnapshot>;
}

export function createGitHubSkillSource(opts: GitHubSkillSourceOptions = {}): GitHubSkillSource {
  const f = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const raw = (opts.rawUrl ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  const maxFiles = opts.maxFiles ?? 64;
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  return {
    async get(id, ref) {
      const parts = id.split('/');
      if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) {
        throw createSkillError('malformed', `GitHub skill id must be owner/repo/slug: ${id}`);
      }
      const [owner, repo, slug] = parts as [string, string, string];
      const commitBody = await getJson(f, `${api}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? 'HEAD')}`, headers);
      if (!isObj(commitBody) || typeof commitBody.sha !== 'string' || !/^[0-9a-f]{40}$/.test(commitBody.sha)) {
        throw createSkillError('malformed', `no commit for ${owner}/${repo}@${ref ?? 'HEAD'}`);
      }
      const commit = commitBody.sha;
      const treeBody = await getJson(f, `${api}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, headers);
      if (!isObj(treeBody) || !Array.isArray(treeBody.tree)) throw createSkillError('malformed', 'tree response has no tree');
      if (treeBody.truncated === true) throw createSkillError('unavailable', `${owner}/${repo} tree too large to list`);
      const blobs = treeBody.tree
        .filter((e): e is { path: string; type: string } => isObj(e) && typeof e.path === 'string' && e.type === 'blob')
        .map((e) => e.path);
      // The skill directory is the one named `slug` holding a SKILL.md, or the repo root when the repo is the skill.
      const candidates = blobs.filter((p) => p === `${slug}/SKILL.md` || p.endsWith(`/${slug}/SKILL.md`));
      let dir: string;
      if (candidates.length === 1) dir = candidates[0]!.slice(0, -'/SKILL.md'.length);
      else if (candidates.length === 0 && blobs.includes('SKILL.md') && repo === slug) dir = '';
      else if (candidates.length === 0) throw createSkillError('not_found', `no ${slug}/SKILL.md in ${owner}/${repo}@${commit}`);
      else throw createSkillError('malformed', `${slug}/SKILL.md is ambiguous in ${owner}/${repo}: ${candidates.join(', ')}`);
      const prefix = dir === '' ? '' : `${dir}/`;
      const paths = blobs.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
      if (paths.length > maxFiles) throw createSkillError('malformed', `${id} has ${paths.length} files (max ${maxFiles})`);
      const files = await Promise.all(
        paths.map(async (path) => {
          const url = `${raw}/${owner}/${repo}/${commit}/${prefix}${path}`.split('/').map((s, i) => (i < 3 ? s : encodeURIComponent(s))).join('/');
          let res: Response;
          try {
            res = await f(url, { headers });
          } catch (err) {
            throw createSkillError('unavailable', `request failed: ${url}: ${(err as Error).message}`);
          }
          if (!res.ok) throw createSkillError(res.status === 404 ? 'not_found' : 'unavailable', `${url} returned ${res.status}`, res.status);
          return { path, contents: await res.text() };
        }),
      );
      return createSkillSnapshot(id, files, { kind: 'github', repo: `${owner}/${repo}`, commit, dir });
    },
  };
}

// ─── suggestions ──────────────────────────────────────────────────────────────

export interface SkillSuggestion {
  listing: SkillListing;
  /** The defined tasks whose search returned this skill. */
  tasks: string[];
}

export interface SuggestSkillsOptions {
  /** The agent's defined tasks, one search each. */
  tasks: readonly string[];
  search: (query: string) => Promise<SkillListing[]>;
  /** Keep at most this many matches per task. Default 5. */
  perTask?: number;
  /** Drop skills installed fewer times than this. Default 0. */
  minInstalls?: number;
  /** Total cap. Default 12. */
  limit?: number;
}

/**
 * One search per task, merged by skill id. Forks/copies (`isDuplicate`) are dropped. Ranked by how
 * many tasks a skill matched, then installs. A failing search fails the call: a partial list would
 * look complete to the owner.
 */
export async function suggestSkills(opts: SuggestSkillsOptions): Promise<SkillSuggestion[]> {
  const perTask = opts.perTask ?? 5;
  const minInstalls = opts.minInstalls ?? 0;
  const byId = new Map<string, SkillSuggestion>();
  const tasks = [...new Set(opts.tasks.map((t) => t.trim()).filter((t) => t.length >= 2))];
  const results = await Promise.all(tasks.map((t) => opts.search(t)));
  tasks.forEach((task, i) => {
    const hits = results[i]!.filter((l) => !l.isDuplicate && l.installs >= minInstalls).slice(0, perTask);
    for (const listing of hits) {
      const s = byId.get(listing.id);
      if (s) {
        if (!s.tasks.includes(task)) s.tasks.push(task);
      } else byId.set(listing.id, { listing, tasks: [task] });
    }
  });
  return [...byId.values()]
    .sort((a, b) => b.tasks.length - a.tasks.length || b.listing.installs - a.listing.installs || (a.listing.id < b.listing.id ? -1 : 1))
    .slice(0, opts.limit ?? 12);
}

// ─── review ───────────────────────────────────────────────────────────────────

export type SkillFindingCode = 'executable' | 'secret_reference' | 'network' | 'broad_tools';

export interface SkillFinding {
  code: SkillFindingCode;
  path: string;
  detail: string;
}

const EXEC_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|exe|bin)$/i;
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(private[_ -]?key|secret[_ -]?key|seed[_ -]?phrase|mnemonic)\b/i, 'mentions a private key, seed phrase or mnemonic'],
  [/(^|[^\w])\.env(\.[\w-]+)?\b/, 'reads a .env file'],
  [/\bS[A-Z2-7]{55}\b/, 'contains a Stellar secret seed'],
  [/\b0x[0-9a-fA-F]{64}\b/, 'contains a 32-byte hex value (possible EVM private key)'],
  [/\b(keychain|wallet\.json|keystore|id_rsa|\.ssh\/)/i, 'touches a keystore or credential file'],
];
const NETWORK_RE = /\b(curl|wget|fetch\(|axios|requests\.(get|post)|http\.request|nc\s+-|https?:\/\/(?!agentskills\.io|skills\.sh)[\w.-]+)/;

/**
 * Our own static pass over every file. It cannot prove a skill safe; it surfaces what the owner should
 * look at, next to the partner audits, before approving.
 */
export function scanSkill(snapshot: SkillSnapshot): SkillFinding[] {
  const findings: SkillFinding[] = [];
  for (const file of snapshot.files) {
    if (file.path.startsWith('scripts/') || EXEC_EXT.test(file.path) || file.contents.startsWith('#!')) {
      findings.push({ code: 'executable', path: file.path, detail: 'executable code the agent can run' });
    }
    for (const [re, detail] of SECRET_PATTERNS) {
      if (re.test(file.contents)) findings.push({ code: 'secret_reference', path: file.path, detail });
    }
    const net = NETWORK_RE.exec(file.contents);
    if (net) findings.push({ code: 'network', path: file.path, detail: `network access: ${net[0]}` });
  }
  const skillMd = snapshot.files.find((x) => x.path === 'SKILL.md');
  if (skillMd) {
    const tools = parseSkillManifest(skillMd.contents).manifest.allowedTools ?? [];
    const broad = tools.filter((t) => /^(Bash|Shell|Exec)(\(\*(:\*)?\))?$/i.test(t) || t === '*');
    if (broad.length > 0) findings.push({ code: 'broad_tools', path: 'SKILL.md', detail: `unrestricted tools: ${broad.join(' ')}` });
  }
  return findings;
}

/**
 * clear: audited, every audit passed, no finding. caution: a warn, a MEDIUM risk, or a finding.
 * blocked: a fail, or HIGH/CRITICAL risk. unaudited: no partner audit yet.
 */
export type SkillVerdict = 'clear' | 'caution' | 'blocked' | 'unaudited';

export interface SkillReview {
  snapshot: SkillSnapshot;
  manifest: SkillManifest;
  audits: SkillAudit[];
  findings: SkillFinding[];
  verdict: SkillVerdict;
}

const HIGH_RISK = new Set(['HIGH', 'CRITICAL']);

export function reviewSkill(snapshot: SkillSnapshot, audits: readonly SkillAudit[]): SkillReview {
  const skillMd = snapshot.files.find((x) => x.path === 'SKILL.md');
  if (!skillMd) throw createSkillError('malformed', `${snapshot.id} has no SKILL.md`);
  const { manifest } = parseSkillManifest(skillMd.contents);
  const findings = scanSkill(snapshot);
  let verdict: SkillVerdict;
  if (audits.some((a) => a.status === 'fail' || HIGH_RISK.has(a.riskLevel ?? ''))) verdict = 'blocked';
  else if (audits.length === 0) verdict = 'unaudited';
  else if (audits.some((a) => a.status === 'warn' || a.riskLevel === 'MEDIUM') || findings.length > 0) verdict = 'caution';
  else verdict = 'clear';
  return { snapshot, manifest, audits: [...audits], findings, verdict };
}

// ─── approval and lock ────────────────────────────────────────────────────────

export interface SkillLockEntry {
  id: string;
  name: string;
  contentHash: string;
  pin: SkillPin;
  verdict: SkillVerdict;
  /** What the owner saw: audit outcomes and our finding codes at approval time. */
  audits: { provider: string; status: AuditStatus; riskLevel?: string; auditedAt: string }[];
  findings: SkillFindingCode[];
  approvedBy: string;
  approvedAt: string;
}

export interface SkillLock {
  v: typeof SKILL_LOCK_VERSION;
  skills: SkillLockEntry[];
}

export interface ApproveOptions {
  /** Who approved: the owner's address or account id. */
  approvedBy: string;
  /** Required to approve a `blocked` or `unaudited` skill. The owner's explicit call, never a default. */
  acceptRisk?: boolean;
  now?: () => Date;
}

export function approveSkill(review: SkillReview, opts: ApproveOptions): SkillLockEntry {
  if (!opts.approvedBy) throw createSkillError('malformed', 'approvedBy is required');
  if ((review.verdict === 'blocked' || review.verdict === 'unaudited') && opts.acceptRisk !== true) {
    throw createSkillError('not_approvable', `${review.snapshot.id} is ${review.verdict}; approving it needs acceptRisk`);
  }
  return {
    id: review.snapshot.id,
    name: review.manifest.name,
    contentHash: review.snapshot.contentHash,
    pin: review.snapshot.pin,
    verdict: review.verdict,
    audits: review.audits.map((a) => {
      const out: SkillLockEntry['audits'][number] = { provider: a.provider, status: a.status, auditedAt: a.auditedAt };
      if (a.riskLevel !== undefined) out.riskLevel = a.riskLevel;
      return out;
    }),
    findings: [...new Set(review.findings.map((x) => x.code))].sort(),
    approvedBy: opts.approvedBy,
    approvedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

/** A lock holds one entry per skill id and one per skill name (the name is how the agent calls it). */
export function createSkillLock(entries: readonly SkillLockEntry[]): SkillLock {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) throw createSkillError('malformed', `skill ${e.id} is in the lock twice`);
    if (names.has(e.name)) throw createSkillError('malformed', `two skills are named ${e.name}`);
    ids.add(e.id);
    names.add(e.name);
  }
  return { v: SKILL_LOCK_VERSION, skills: [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

/** Replaces (or adds) one entry: how a re-reviewed update moves its pin. */
export function updateSkillLock(lock: SkillLock, entry: SkillLockEntry): SkillLock {
  return createSkillLock([...lock.skills.filter((e) => e.id !== entry.id), entry]);
}

export function serializeSkillLock(lock: SkillLock): string {
  return `${JSON.stringify(createSkillLock(lock.skills), null, 2)}\n`;
}

const HEX64 = /^[0-9a-f]{64}$/;

function parsePin(x: unknown): SkillPin {
  if (isObj(x) && x.kind === 'github' && typeof x.repo === 'string' && typeof x.commit === 'string' && /^[0-9a-f]{40}$/.test(x.commit) && typeof x.dir === 'string') {
    return { kind: 'github', repo: x.repo, commit: x.commit, dir: x.dir };
  }
  if (isObj(x) && x.kind === 'skills.sh' && (x.registryHash === null || typeof x.registryHash === 'string')) {
    return { kind: 'skills.sh', registryHash: x.registryHash as string | null };
  }
  throw createSkillError('malformed', 'bad pin in skill lock');
}

export function parseSkillLock(text: string): SkillLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw createSkillError('malformed', 'skill lock is not JSON');
  }
  if (!isObj(raw) || raw.v !== SKILL_LOCK_VERSION || !Array.isArray(raw.skills)) {
    throw createSkillError('malformed', `skill lock must be { v: "${SKILL_LOCK_VERSION}", skills: [] }`);
  }
  const entries = raw.skills.map((e): SkillLockEntry => {
    if (
      !isObj(e) || typeof e.id !== 'string' || typeof e.name !== 'string' || !NAME_RE.test(e.name) ||
      typeof e.contentHash !== 'string' || !HEX64.test(e.contentHash) ||
      typeof e.approvedBy !== 'string' || typeof e.approvedAt !== 'string' ||
      !['clear', 'caution', 'blocked', 'unaudited'].includes(e.verdict as string) ||
      !Array.isArray(e.audits) || !Array.isArray(e.findings)
    ) {
      throw createSkillError('malformed', 'bad skill lock entry');
    }
    return {
      id: e.id,
      name: e.name,
      contentHash: e.contentHash,
      pin: parsePin(e.pin),
      verdict: e.verdict as SkillVerdict,
      audits: e.audits as SkillLockEntry['audits'],
      findings: e.findings as SkillFindingCode[],
      approvedBy: e.approvedBy,
      approvedAt: e.approvedAt,
    };
  });
  return createSkillLock(entries);
}

// ─── run time: load, update check, kit ────────────────────────────────────────

/** Fetches the content for a lock entry. A GitHub pin should be fetched at its commit. */
export type SkillFetcher = (entry: SkillLockEntry) => Promise<SkillSnapshot>;

/** The fetcher most callers want: GitHub pins at their commit, skills.sh pins from skills.sh. */
export function createSkillFetcher(sources: { github?: GitHubSkillSource; skillsSh?: SkillsShClient }): SkillFetcher {
  return async (entry) => {
    if (entry.pin.kind === 'github') {
      if (!sources.github) throw createSkillError('unavailable', `no GitHub source for ${entry.id}`);
      return sources.github.get(entry.id, entry.pin.commit);
    }
    if (!sources.skillsSh) throw createSkillError('unavailable', `no skills.sh client for ${entry.id}`);
    return sources.skillsSh.get(entry.id);
  };
}

export interface SkillUpdate {
  id: string;
  status: 'unchanged' | 'changed' | 'missing';
  /** Present when changed: review it, and approve it to move the pin. */
  current?: SkillSnapshot;
}

/**
 * Compares each approved skill against what its source serves now. Never changes the lock: a changed
 * skill goes back through reviewSkill + approveSkill + updateSkillLock.
 * For a GitHub pin pass a fetcher that reads the default branch, not the pinned commit.
 */
export async function checkSkillUpdates(lock: SkillLock, fetchLatest: SkillFetcher): Promise<SkillUpdate[]> {
  return Promise.all(
    lock.skills.map(async (entry): Promise<SkillUpdate> => {
      try {
        const current = await fetchLatest(entry);
        return current.contentHash === entry.contentHash ? { id: entry.id, status: 'unchanged' } : { id: entry.id, status: 'changed', current };
      } catch (err) {
        if (isSkillError(err) && err.code === 'not_found') return { id: entry.id, status: 'missing' };
        throw err;
      }
    }),
  );
}

/**
 * Fetches every approved skill and checks it against its pin. Any mismatch throws `skill_changed`
 * before the agent sees a single file: an approved-then-altered skill never runs.
 */
export async function loadSkills(lock: SkillLock, fetchPinned: SkillFetcher): Promise<SkillSnapshot[]> {
  return Promise.all(
    lock.skills.map(async (entry) => {
      const snap = await fetchPinned(entry);
      const hash = await skillContentHash(snap.files);
      if (hash !== entry.contentHash) {
        throw createSkillError('skill_changed', `${entry.id} changed since it was approved (approved ${entry.contentHash}, now ${hash}); re-review it`);
      }
      return { ...snap, contentHash: hash };
    }),
  );
}

export interface SkillIndexEntry {
  name: string;
  description: string;
  files: string[];
}

export interface SkillUse {
  id: string;
  name: string;
  contentHash: string;
}

export interface SkillKit {
  /** name + description of every skill: what the agent sees up front. */
  index: SkillIndexEntry[];
  /** The index as a short prompt section. */
  prompt(): string;
  /** The SKILL.md body (instructions), loaded when the agent picks the skill. Records the use. */
  activate(name: string): string;
  /** Another file of an activated skill (references/, assets/, scripts/ as text). Never executes it. */
  read(name: string, path: string): string;
  /** Skills activated so far, in first-use order. */
  used(): SkillUse[];
}

/**
 * The agent-facing surface: progressive disclosure per agentskills.io (index, then body, then files).
 * Only verified snapshots go in (loadSkills output). It holds text, nothing else.
 */
export function createSkillKit(snapshots: readonly SkillSnapshot[]): SkillKit {
  const byName = new Map<string, { snap: SkillSnapshot; manifest: SkillManifest; body: string }>();
  for (const snap of snapshots) {
    const md = snap.files.find((x) => x.path === 'SKILL.md');
    if (!md) throw createSkillError('malformed', `${snap.id} has no SKILL.md`);
    const { manifest, body } = parseSkillManifest(md.contents);
    if (byName.has(manifest.name)) throw createSkillError('malformed', `two skills are named ${manifest.name}`);
    byName.set(manifest.name, { snap, manifest, body });
  }
  const uses: SkillUse[] = [];
  const get = (name: string) => {
    const s = byName.get(name);
    if (!s) throw createSkillError('not_approved', `skill ${name} is not approved for this agent`);
    return s;
  };
  const index = [...byName.values()].map(({ snap, manifest }) => ({
    name: manifest.name,
    description: manifest.description,
    files: snap.files.map((x) => x.path).filter((p) => p !== 'SKILL.md').sort(),
  }));
  return {
    index,
    prompt() {
      if (index.length === 0) return '';
      const lines = index.map((s) => `- ${s.name}: ${s.description}`);
      return ['Approved skills. Activate one by name when a task matches its description.', ...lines].join('\n');
    },
    activate(name) {
      const s = get(name);
      if (!uses.some((u) => u.id === s.snap.id)) uses.push({ id: s.snap.id, name, contentHash: s.snap.contentHash });
      return s.body;
    },
    read(name, path) {
      checkPath(path);
      const s = get(name);
      if (!uses.some((u) => u.id === s.snap.id)) throw createSkillError('not_approved', `activate ${name} before reading its files`);
      const file = s.snap.files.find((x) => x.path === path);
      if (!file) throw createSkillError('not_found', `${name} has no file ${path}`);
      return file.contents;
    },
    used() {
      return uses.map((u) => ({ ...u }));
    },
  };
}

/** The record's `skills` field (Enactment Record v0.2) from what a kit says was used. */
export function recordSkills(uses: readonly Pick<SkillUse, 'id' | 'contentHash'>[]): RecordSkill[] {
  return [...new Map(uses.map((u) => [u.id, u.contentHash])).entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, sha256]) => ({ id, sha256 }));
}

/**
 * One sha256 over the skills a piece of work used: sorted `[id, contentHash]` pairs as compact JSON.
 * Order-independent; empty list → hash of `[]`. For places that hold one hash, not the list
 * (the record itself carries the list: see recordSkills).
 */
export async function skillsDigest(uses: readonly Pick<SkillUse, 'id' | 'contentHash'>[]): Promise<string> {
  const pairs = [...new Map(uses.map((u) => [u.id, u.contentHash])).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(JSON.stringify(pairs));
}
