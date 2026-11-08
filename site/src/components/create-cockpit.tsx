'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { AskForm } from '@/components/ask-form';
import { TemplateIcon } from '@/components/template-icon';
import { MCP_HARNESSES, MCP_ON_NPM, OWNER_MCP_LIVE } from '@/lib/mcp';
import { templateUrl } from '@/lib/panel-url';
import { TEMPLATES, type Template } from '@/lib/templates';

const GROUPS = ['All', ...new Set(TEMPLATES.map((t) => t.group))];

const STEPS = [
  { title: 'Pick or describe', line: 'A ready agent, or one sentence of your own.' },
  { title: 'Try it on real data', line: 'See what it would tell you right now. Nothing is sent.' },
  { title: 'Create it', line: 'Your email, then your device’s screen lock: a PIN or password works, Face ID is optional.' },
];

const ring = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wax-ring)]';

/** The chosen agent's plan: its sentence with the changeable values marked, three readings, the way in, and an example email. */
function Plan({ t, compact = false }: { t: Template; compact?: boolean }) {
  return (
    <div className="flex flex-col">
      <p className={`${compact ? 'text-[17px]' : 'text-[1.5rem]'} leading-[1.45] font-medium text-fg`}>
        {t.plan.map((part, i) =>
          typeof part === 'string' ? (
            <span key={i}>{part}</span>
          ) : (
            <span key={i} className="rounded-md bg-[var(--wax-tint)] px-1.5 py-0.5 whitespace-nowrap text-accent-ink">
              {part.v}
            </span>
          ),
        )}
      </p>
      <dl className={`grid grid-cols-3 divide-x divide-[var(--raised-line)] rounded-[12px] border border-[var(--raised-line)] ${compact ? 'mt-4' : 'mt-6'}`}>
        {[
          ['Checks', t.checks],
          ['Reads', t.reads],
          ['Tells you', 'By email'],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0 px-3.5 py-3">
            <dt className="text-[12px] text-fg-3">{k}</dt>
            <dd className="mt-0.5 text-[14px] font-medium text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${compact ? 'mt-4' : 'mt-6'}`}>
        <a href={templateUrl(t.id)} className="btn btn-wax h-12 px-6 text-[15px]">
          Open this plan <span aria-hidden>→</span>
        </a>
        <span className="text-[13px] text-fg-3">You can change every marked value before you create it.</span>
      </div>
      <figure className={`rounded-[12px] border border-dashed border-[var(--raised-line)] p-4 ${compact ? 'mt-5' : 'mt-8'}`}>
        <figcaption className="text-[12px] text-fg-3">An example of the email it sends</figcaption>
        <p className="mt-2 text-[14.5px] font-medium text-fg">{t.email.subject}</p>
        <p className="mt-1 text-[14px] leading-[1.5] text-fg-2">{t.email.body}</p>
      </figure>
    </div>
  );
}

/**
 * /create as one working screen: ready agents on the left, the chosen plan (or your own sentence) in the middle, the
 * three steps on the right. On small screens the columns stack and a chosen agent opens its plan in place.
 */
export function CreateCockpit() {
  const [group, setGroup] = useState('All');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>(TEMPLATES[0].id);
  const listRef = useRef<HTMLUListElement>(null);
  const q = query.trim().toLowerCase();
  const list = TEMPLATES.filter((t) => (group === 'All' || t.group === group) && (!q || `${t.title} ${t.summary}`.toLowerCase().includes(q)));
  const current = TEMPLATES.find((t) => t.id === selected) ?? TEMPLATES[0];

  // Up and down move through the list, as in any picker.
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = list.findIndex((t) => t.id === current.id);
    const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    setSelected(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`)?.focus();
  };

  return (
    <div className="grid gap-3 lg:h-[calc(100dvh-6.75rem)] lg:min-h-[620px] lg:grid-cols-[300px_minmax(0,1fr)_260px]">
      <section aria-labelledby="ready-h" className="card order-2 flex min-h-0 flex-col overflow-hidden lg:order-1">
        <div className="border-b border-[var(--raised-line)] p-4">
          <h2 id="ready-h" className="flex items-baseline justify-between text-[15px] font-semibold text-fg">
            Ready agents <span className="text-[13px] font-normal text-fg-3 tabular-nums">{list.length === TEMPLATES.length ? TEMPLATES.length : `${list.length} of ${TEMPLATES.length}`}</span>
          </h2>
          <label htmlFor="ready-search" className="sr-only">
            Search ready agents
          </label>
          <input
            id="ready-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ready agents"
            autoComplete="off"
            className="mt-3 h-10 w-full rounded-[10px] border border-[var(--raised-line)] bg-[var(--ground)] px-3 text-[14px] text-fg placeholder:text-fg-3 focus-visible:border-[var(--wax-ring)] focus-visible:outline-none"
          />
          <div role="group" aria-label="Show" className="mt-3 flex flex-wrap gap-1.5">
            {GROUPS.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={group === g}
                onClick={() => setGroup(g)}
                className={`rounded-full border border-[var(--raised-line)] px-2.5 py-1 text-[12.5px] text-fg-2 transition-colors hover:text-fg aria-pressed:border-[var(--wax-edge)] aria-pressed:bg-[var(--wax-tint)] aria-pressed:text-fg ${ring}`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
        <ul ref={listRef} onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.length === 0 ? (
            <li className="px-3 py-8 text-center text-[14px] leading-[1.5] text-fg-3">
              No ready agent matches. Describe it in your own words in the box instead.
            </li>
          ) : null}
          {list.map((t) => {
            const on = t.id === current.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  data-id={t.id}
                  aria-pressed={on}
                  onClick={() => setSelected(t.id)}
                  className={`flex w-full items-center gap-3 rounded-[12px] border border-transparent px-2.5 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--hover)] aria-pressed:border-[var(--wax-edge)] aria-pressed:bg-[var(--wax-tint)] ${ring}`}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-[var(--wax-tint)] text-accent-ink">
                    <TemplateIcon id={t.id} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium text-fg">{t.title}</span>
                    <span className="block truncate text-[12.5px] text-fg-3">{t.summary}</span>
                  </span>
                </button>
                {on ? (
                  <div className="mx-1 mt-1 mb-3 rounded-[12px] border border-[var(--raised-line)] p-4 lg:hidden">
                    <Plan t={t} compact />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="create-h" className="card order-1 flex min-h-0 flex-col overflow-y-auto p-5 sm:p-7 lg:order-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 id="create-h" className="headline text-[2rem]">
            Create an agent
          </h1>
          <p className="text-[13px] text-fg-3">Stellar testnet · free · no code</p>
        </div>
        <AskForm id="create-page-prompt" className="mt-6" label="Describe it in one sentence" />

        <div className="mt-8 hidden flex-col border-t border-[var(--raised-line)] pt-7 lg:flex">
          <div className="flex items-center gap-4">
            <span className="grid size-14 shrink-0 place-items-center rounded-[14px] bg-[var(--wax-tint)] text-accent-ink">
              <TemplateIcon id={current.id} size={28} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[20px] font-semibold text-fg">{current.title}</h2>
              <p className="text-[13.5px] text-fg-3">Ready agent · {current.group}</p>
            </div>
          </div>
          <div className="mt-6">
            <Plan t={current} />
          </div>
        </div>
      </section>

      <aside aria-labelledby="steps-h" className="card order-3 flex min-h-0 flex-col p-5">
        <h2 id="steps-h" className="text-[15px] font-semibold text-fg">
          How it goes
        </h2>
        <ol className="mt-4 space-y-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3" {...(i === 0 ? { 'aria-current': 'step' as const } : {})}>
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-full border text-[12.5px] tabular-nums ${i === 0 ? 'border-[var(--wax)] bg-[var(--wax)] text-[var(--wax-on)]' : 'border-[var(--raised-line)] text-fg-3'}`}
              >
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-[14.5px] font-medium text-fg">{s.title}</span>
                <span className="mt-0.5 block text-[13px] leading-[1.5] text-fg-3">{s.line}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-auto border-t border-[var(--raised-line)] pt-4 max-lg:mt-6">
          <a href="#mcp" className={`flex items-center justify-between rounded-md text-[14px] font-medium text-fg hover:text-accent-ink ${ring}`}>
            Run them from your harness
            <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </a>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-fg-3">
            {MCP_HARNESSES.join(', ').replace(/, ([^,]*)$/, ' or $1')} can find, hire and check agents over MCP, inside a budget you set
            {OWNER_MCP_LIVE ? ', and talk to the agents you made here.' : '.'}
            {MCP_ON_NPM ? null : ' Ships with the next npm release.'}
          </p>
        </div>
        <div className="mt-4 border-t border-[var(--raised-line)] pt-4">
          <a href="#advanced" className={`flex items-center justify-between rounded-md text-[14px] text-fg-2 hover:text-fg ${ring}`}>
            Developer options
            <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </a>
          <p className="mt-1 text-[12.5px] text-fg-3">The library, its templates, your own wallet.</p>
        </div>
      </aside>
    </div>
  );
}
