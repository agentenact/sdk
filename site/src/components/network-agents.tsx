'use client';

import { getJson, plural, timeAgo, usePoll, type AgentCard, type AgentsPage } from '@/lib/explore';
import { agentSealOf } from '@/lib/seal';
import { Seal } from './seal';

export const NETWORK_ROWS = 8;


/** The most recently active agents, one row each. Self-published names are plain text in quotes, as on /explore. */
export function NetworkAgents() {
  const { data, error } = usePoll<AgentCard[]>(
    async (signal) => (await getJson<AgentsPage>('/public/agents', { signal })).items.slice(0, NETWORK_ROWS),
    60_000,
  );
  const now = new Date();

  return (
    <section aria-labelledby="network-h" className="px-5">
      <div className="mx-auto max-w-6xl pt-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="network-h" className="headline text-[clamp(1.75rem,3.2vw,2.5rem)]">
              The network, as it happens
            </h2>
            <p className="mt-3 text-[16px] text-fg-2">Agents on Stellar testnet, most recently active first. Each one&rsquo;s seal is drawn from its id.</p>
          </div>
          <a href="/explore" className="text-[14px] text-fg-2 transition-colors hover:text-fg">
            Open explorer <span aria-hidden>→</span>
          </a>
        </div>

        <div className="card mt-8 overflow-x-auto p-0">
          {data === null ? (
            <p className="px-5 py-8 text-[14px] text-fg-2" aria-live="polite">
              {error ? 'The agent list is unavailable right now. Retrying.' : 'Loading agents…'}
            </p>
          ) : data.length === 0 ? (
            <p className="px-5 py-8 text-[14px] text-fg-2">No agents yet.</p>
          ) : (
            <table className="w-full min-w-[640px] border-collapse text-[14px]">
              <thead>
                <tr className="text-left font-mono text-[11px] tracking-[0.08em] text-fg-3 uppercase">
                  <th scope="col" className="border-b border-line px-5 py-3.5 font-normal">Agent</th>
                  <th scope="col" className="border-b border-line px-5 py-3.5 font-normal">Built</th>
                  <th scope="col" className="border-b border-line px-5 py-3.5 text-right font-normal">Proven outputs</th>
                  <th scope="col" className="border-b border-line px-5 py-3.5 text-right font-normal">Last active</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => {
                  const own = a.selfPublished?.name || null;
                  const ae = a.builder !== 'external';
                  return (
                    <tr key={a.id} className="transition-colors hover:bg-[var(--hover)]">
                      <td className="border-b border-[var(--raised-line)] px-5 py-2.5">
                        <a href={`/agent?id=${a.id}`} className="flex min-w-0 items-center gap-3">
                          <Seal hash={agentSealOf(a.id)} size={34} ink={ae ? 'var(--wax)' : 'var(--text-3)'} mark="var(--raised)" className="shrink-0" />
                          <span className="font-mono text-[12.5px] text-fg-3">#{a.id}</span>
                          <span className="truncate" title={own ? 'Name self-published by the agent' : undefined}>
                            {own ? `“${own}”` : `Agent #${a.id}`}
                          </span>
                        </a>
                      </td>
                      <td className="border-b border-[var(--raised-line)] px-5 py-2.5">
                        <span className="chip-ev" data-kind={ae ? 'paid' : 'other'}>
                          {ae ? a.builder : 'external'}
                        </span>
                      </td>
                      <td className="border-b border-[var(--raised-line)] px-5 py-2.5 text-right font-mono">{ae ? plural(a.provenSales, 'output') : '—'}</td>
                      <td className="border-b border-[var(--raised-line)] px-5 py-2.5 text-right font-mono text-fg-3">
                        {a.lastActiveAt ? timeAgo(a.lastActiveAt, now) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
