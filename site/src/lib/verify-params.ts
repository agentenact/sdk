/**
 * What /verify was asked to check, from its query string. Two shapes, both from proof links on this site:
 * - a hosted agent's stored record: `?agent=<uuid>&tx=<64 hex>` → fetched same origin at /a/<uuid>/records/<tx>;
 * - a library agent's public record: `?record=https://api.agentenact.io/public/records/<64 hex>`.
 * Anything else (another host, http, extra path or query, repeated params) is null, so a crafted link can never make
 * the page fetch an arbitrary URL.
 */
export type VerifyTarget = { kind: 'hosted'; agent: string; tx: string } | { kind: 'public'; ref: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PUBLIC_RECORD = /^https:\/\/api\.agentenact\.io\/public\/records\/([0-9a-f]{64})$/;

export function parseVerifyParams(search: string): VerifyTarget | null {
  const q = new URLSearchParams(search);
  const one = (k: string): string | null => {
    const all = q.getAll(k);
    return all.length === 1 ? all[0]! : null;
  };
  const agent = one('agent')?.toLowerCase();
  const tx = one('tx');
  if (agent !== undefined && tx !== null && q.getAll('record').length === 0) {
    return UUID.test(agent) && HEX64.test(tx) ? { kind: 'hosted', agent, tx } : null;
  }
  const record = one('record');
  if (record !== null && q.getAll('agent').length === 0 && q.getAll('tx').length === 0) {
    const m = PUBLIC_RECORD.exec(record);
    return m ? { kind: 'public', ref: m[1]! } : null;
  }
  return null;
}

export function recordUrl(t: VerifyTarget): string {
  return t.kind === 'hosted' ? `/a/${t.agent}/records/${t.tx}` : `https://api.agentenact.io/public/records/${t.ref}`;
}
