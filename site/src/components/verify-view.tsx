/** The verify page's states as plain markup (no hooks), so every state renders and is tested without a browser. */
import { formatUsdc } from '@/lib/explore';
import { shorten } from '@/lib/format';
import type { CheckName, CheckResult } from '@/lib/verify-record';
import { Seal } from './seal';

/** The parts of a record this page shows; the full record goes to the verifier untouched. */
export interface ShownRecord {
  agent: { address: string; agentId?: string };
  settlement: { ref: string; payer: string; amount: string; asset: string };
  issuedAt: string;
}

export type VerifyState =
  | { phase: 'loading' }
  | { phase: 'bad_link' }
  | { phase: 'not_found' }
  | { phase: 'error' }
  | { phase: 'done'; record: ShownRecord; result: CheckResult };

const ROWS: { key: CheckName; label: string; pass: string }[] = [
  { key: 'signature', label: 'Agent signature', pass: 'Valid' },
  { key: 'settlement', label: 'Payment', pass: 'Settled' },
  { key: 'timing', label: 'Timing', pass: 'Valid' },
  { key: 'identity', label: 'Owner', pass: 'Bound' },
];

const explorer = (tx: string) => `https://stellar.expert/explorer/testnet/tx/${tx}`;

/** What even a verified record leaves open; shown with every result so a pass is not read as more than it is. */
const NOT_SHOWN = [
  'Whether the output is right or useful.',
  'Which model or skill produced it.',
  "The exact signing time: it comes from the agent's clock and is only checked against the payment's time.",
  'What the buyer meant: only the exact bytes sent and returned are bound.',
];

export function VerifyView({ state, onRetry }: { state: VerifyState; onRetry: () => void }) {
  if (state.phase === 'loading') return <p className="mt-10 text-[17px] text-fg-2" aria-live="polite">Checking the proof against Stellar testnet…</p>;
  if (state.phase === 'bad_link') return <p className="mt-10 text-[17px] text-fg-2">This link doesn&apos;t point to a proof. Open it from an agent&apos;s page.</p>;
  if (state.phase === 'not_found') return <p className="mt-10 text-[17px] text-fg-2">We can&apos;t find this proof. It may not exist, or the link is wrong.</p>;
  if (state.phase === 'error')
    return (
      <div className="mt-10">
        <p className="text-[17px] text-fg-2">We couldn&apos;t reach the network. Try again in a minute.</p>
        <button type="button" className="btn btn-sm mt-4" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  const { record, result } = state;
  const amount = `${formatUsdc(record.settlement.amount)} ${record.settlement.asset.split(':')[0]}`;
  // The payment predates the testnet history Horizon still serves (testnet is reset from time to time).
  const lost = result.failure?.reason === 'history_unavailable';
  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-14" aria-live="polite">
      <div className="min-w-0">
        <p className="headline text-[clamp(1.5rem,2.6vw,2rem)]">
          {result.ok ? 'This record verifies.' : lost ? 'This record can no longer be checked.' : <span className="text-danger">This record does not verify.</span>}
        </p>
        {lost ? (
          <p className="mt-3 max-w-xl text-[15px] text-fg-2">
            Its payment is older than the Stellar testnet history still online. Testnet is reset from time to time, which removes old payments. That does not make the record forged, but nobody can verify it anymore.
          </p>
        ) : null}
        <p className="mt-3 max-w-xl text-[15px] text-fg-2">
          It shows who signed this output, which payment it is bound to, and who owns the agent, all checked just now from public Stellar testnet data. It does not say whether the output itself is right.
        </p>
        <div className="card mt-8 divide-y divide-line p-0">
          {ROWS.map((row) => {
            const s = result.checks[row.key];
            return (
              <div key={row.key} className="flex items-baseline justify-between gap-4 px-5 py-3.5 text-[14px]">
                <span>{row.label}</span>
                <span className={s === 'pass' ? 'text-ok' : s === 'fail' && !lost ? 'text-danger' : 'text-fg-3'}>
                  {s === 'pass' ? row.pass : s === 'fail' ? (lost && row.key === 'settlement' ? 'History reset' : 'Does not match') : 'Not checked'}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-8 max-w-xl text-[14px] text-fg-2">
          <p className="text-fg-3">What a verified record does not show</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {NOT_SHOWN.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      {/* The record's own claims (agent, payer, amount) are shown only once they verified; an unverified record could say anything. */}
      {result.ok ? (
        <aside className="min-w-0" aria-label="What the record says">
          <Seal hash={record.settlement.ref} label="Seal of this record's payment" className="w-full max-w-[200px]" mark="var(--ground)" />
          <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-[14px]">
            <dt className="text-fg-3">Agent</dt>
            <dd className="font-mono text-[13px] break-all">{shorten(record.agent.address, 6, 6)}</dd>
            {record.agent.agentId ? (
              <>
                <dt className="text-fg-3">Agent no.</dt>
                <dd>
                  <a href={`/agent?id=${record.agent.agentId}`} className="underline decoration-line underline-offset-4 hover:text-fg">
                    agent #{record.agent.agentId}
                  </a>
                </dd>
              </>
            ) : null}
            <dt className="text-fg-3">Owner</dt>
            <dd className="font-mono text-[13px] break-all">{result.owner ? shorten(result.owner, 6, 6) : 'Unknown'}</dd>
            <dt className="text-fg-3">Paid</dt>
            <dd>{amount} on Stellar testnet</dd>
            <dt className="text-fg-3">Payer</dt>
            <dd className="font-mono text-[13px] break-all">{shorten(record.settlement.payer, 6, 6)}</dd>
            <dt className="text-fg-3">Signed</dt>
            <dd>{new Date(record.issuedAt).toUTCString()}</dd>
            <dt className="text-fg-3">Payment</dt>
            <dd>
              <a href={explorer(record.settlement.ref)} target="_blank" rel="noreferrer" className="font-mono text-[13px] underline decoration-line underline-offset-4 hover:text-fg">
                {shorten(record.settlement.ref, 8, 8)} ↗
              </a>
            </dd>
          </dl>
        </aside>
      ) : null}
    </div>
  );
}
