'use client';

import { useEffect, useRef, useState } from 'react';
import { formatUsdc, getJson, karmaLabel, plural, timeAgo, utcTime, type AgentCard, type AgentsPage, type PaymentsSource } from '../lib/explore';
import { agentSealOf } from '../lib/seal';
import { Seal } from './seal';

const tag = 'ex-tag';

/** The payments line of an external agent: AgentKarma's figures, or what is missing and why (never a zero for unknown). */
function paymentsLine(a: AgentCard, payments: PaymentsSource | undefined) {
  if (a.paymentsReceived === null || a.usdcReceived === null) return payments?.available === false ? 'payments unavailable' : 'not on AgentKarma yet';
  if (a.paymentsReceived === 0) return 'no payments received';
  return (
    <>
      {plural(a.paymentsReceived, 'payment')} received · <b>{formatUsdc(a.usdcReceived)} USDC</b>
    </>
  );
}

/** Where the card payments come from, or since when they are missing. Nothing for an older api build that does not say. */
export function PaymentsNote({ payments }: { payments?: PaymentsSource }) {
  if (!payments) return null;
  const at = utcTime(payments.asOf, false);
  if (!payments.available) {
    return (
      <p role="status" className="ex-quiet ex-small">
        Payments from AgentKarma are unavailable {at ? `since ${at}` : 'right now'}. Agents and proven outputs are shown from AgentEnact{'’'}s own index.
      </p>
    );
  }
  return (
    <p className="ex-quiet ex-small">
      Payments on these cards are AgentKarma{'’'}s index{at ? `, as of ${at}` : ''}. The transfers total above is AgentEnact{'’'}s own count (<code>payments.csv</code>).
    </p>
  );
}

export function AgentCards({ items, now, payments }: { items: AgentCard[]; now: Date; payments?: PaymentsSource }) {
  return (
    <ul className="ex-cards">
      {items.map((a) => {
        const own = a.selfPublished?.name || null;
        const name = own ? `“${own}”` : `Agent #${a.id}`;
        const svc = a.selfPublished?.service ?? null;
        const ae = a.builder !== 'external';
        const lastPayment = a.lastPaymentAt ? timeAgo(a.lastPaymentAt, now) : '';
        const score = karmaLabel(a.karma);
        return (
          <li key={a.id} className="min-w-0">
            <a href={`/agent?id=${a.id}`} className="ex-ag">
              <span className="ex-aid">#{a.id}</span>
              <span className="ex-am">
                <span className="ex-an">
                  <Seal hash={agentSealOf(a.id)} size={20} ink={ae ? 'var(--wax)' : 'var(--text-3)'} mark="var(--ground)" className="shrink-0 self-center" />
                  <span className="ex-nm" title={own ? 'Name self-published by the agent' : undefined}>{name}</span>
                </span>
                <span className="ex-as">
                  {svc ? (
                    svc.priceUsdc ? (
                      <>
                        <span className="ex-svc">sells {'“'}{svc.slug}{'”'}</span>
                        <b>{formatUsdc(svc.priceUsdc)} USDC</b>
                        <span className="ex-sp">self-published</span>
                      </>
                    ) : (
                      <>
                        <span className="ex-svc">sells {'“'}{svc.slug}{'”'}</span>
                        <span>price: ask the agent</span>
                        <span className="ex-sp">self-published</span>
                      </>
                    )
                  ) : (
                    'no public services'
                  )}
                </span>
              </span>
              <span className="ex-meta">
                <span className="ex-bld">
                  <span className={ae ? `${tag} ex-tag-ae` : tag}>{ae ? 'Built on AgentEnact' : 'external'}</span>
                </span>
                {score ? (
                  <span className="ex-kar">
                    <span className="ex-kp">AgentKarma </span>
                    {score.replace(/^AgentKarma /, '')}
                  </span>
                ) : (
                  <span className="ex-kar ex-kar-none">none</span>
                )}
              </span>
              <span className="ex-ae">
                <span>{ae ? plural(a.provenSales, 'proven output') : paymentsLine(a, payments)}</span>
                {lastPayment ? <span className="ex-lp">last payment received {lastPayment}</span> : null}
              </span>
              <svg className="ex-go" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3.5 10.5 8 6 12.5" />
              </svg>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** What search found nothing for: the query as plain text, what search covers, one way out. */
export function EmptySearch({ query, total, onClear }: { query: string; total?: number; onClear?: () => void }) {
  return (
    <div className="ex-empty">
      <p className="ex-et">No agents match “{query}”.</p>
      <p>
        Search looks at names, services and ids such as #46. Try one word, or clear the search to see all {total !== undefined ? total : 'agents'}.
      </p>
      <button type="button" onClick={onClear} className="btn btn-quiet btn-sm">
        Clear search
      </button>
    </div>
  );
}

/** Tags each request with a version; any later request (a new query, a reload) makes earlier ones stale. */
export function createQueryGate() {
  let v = 0;
  return {
    begin: (_query: string): number => ++v,
    isCurrent: (token: number): boolean => token === v,
  };
}

/** Search box + cards. Debounced 300 ms; a newer query cancels the older request. */
export function AgentSearch({ total }: { total?: number }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<AgentCard[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentsSource | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const gate = useRef(createQueryGate());
  const moreCtl = useRef<AbortController | null>(null);

  const path = (query: string, cursor?: string) => {
    const p = new URLSearchParams();
    if (query.trim()) p.set('q', query.trim());
    if (cursor) p.set('cursor', cursor);
    const s = p.toString();
    return `/public/agents${s ? `?${s}` : ''}`;
  };

  useEffect(() => {
    const c = new AbortController();
    ctl.current?.abort();
    moreCtl.current?.abort();
    ctl.current = c;
    const token = gate.current.begin(q);
    setNext(null);
    setMore(false);
    const t = setTimeout(
      () => {
        getJson<AgentsPage>(path(q), { signal: c.signal })
          .then((r) => {
            if (c.signal.aborted || !gate.current.isCurrent(token)) return;
            setItems(r.items);
            setNext(r.next);
            setPayments(r.payments);
            setFailed(false);
          })
          .catch(() => {
            if (c.signal.aborted || !gate.current.isCurrent(token)) return;
            // A failed search must not leave the previous query's rows under the new text.
            setItems(null);
            setNext(null);
            setFailed(true);
          });
      },
      q === '' ? 0 : 300,
    );
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [q]);

  async function showMore() {
    if (!next || more) return;
    const token = gate.current.begin(q);
    const c = new AbortController();
    moreCtl.current = c;
    setMore(true);
    try {
      const r = await getJson<AgentsPage>(path(q, next), { signal: c.signal });
      if (c.signal.aborted || !gate.current.isCurrent(token)) return;
      setItems((prev) => [...(prev ?? []), ...r.items]);
      setNext(r.next);
      setPayments(r.payments);
    } catch {
      if (c.signal.aborted || !gate.current.isCurrent(token)) return;
      setFailed(true);
    } finally {
      if (!c.signal.aborted && gate.current.isCurrent(token)) setMore(false);
    }
  }

  const shown = items?.length ?? 0;
  const tail = q.trim() ? '' : ' · newest first';
  const sub = items === null ? 'loading' : total !== undefined ? `${shown} of ${total} shown${tail}` : `${shown} shown${tail}`;

  return (
    <div className="ex-agents min-w-0">
      <div className="ex-sh ex-sh-row">
        <h2>Agents</h2>
        <p>{sub}</p>
      </div>
      <label className="sr-only" htmlFor="agent-search">
        Find agents
      </label>
      <input
        id="agent-search"
        type="search"
        value={q}
        maxLength={64}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, service, or #46"
        className="ex-search"
      />
      <div aria-live="polite">
        {items === null ? (
          <p className="ex-quiet">{failed ? 'Agents are unavailable right now.' : 'Loading…'}</p>
        ) : items.length === 0 ? (
          q.trim() ? (
            <EmptySearch query={q.trim()} total={total} onClear={() => setQ('')} />
          ) : (
            <p className="ex-quiet">No agents yet.</p>
          )
        ) : (
          <>
            <div className="ex-lh" aria-hidden="true">
              <span>Agent</span>
              <span>Built</span>
              <span>AgentKarma</span>
              <span>Activity</span>
            </div>
            <AgentCards items={items} now={new Date()} payments={payments} />
          </>
        )}
        {failed && items !== null ? <p className="ex-quiet ex-small">Something went wrong. Try again.</p> : null}
        {next ? (
          <button type="button" onClick={showMore} disabled={more} className="btn btn-quiet btn-sm ex-more">
            {more ? 'Loading…' : 'Show more agents'}
          </button>
        ) : null}
      </div>
      <PaymentsNote payments={payments} />
    </div>
  );
}
