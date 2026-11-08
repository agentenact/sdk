'use client';

import { useState, type CSSProperties } from 'react';
import { forge } from '@/lib/format';
import {
  formatUsdc, getJson, getStats, paymentUrl, proofUrl, timeAgo, usePoll,
  type FeedItem, type FeedPage, type Stats,
} from '@/lib/explore';
import { AskForm } from './ask-form';
import { Seal } from './seal';
import { TechLogos } from './tech-logos';

export const HERO_FEED_SIZE = 6;
const HERO_FEED_EVERY_MS = 15_000;

/**
 * A star's twinkle, from its index alone: a 3–9 s breath with a negative delay so the field starts mid-cycle
 * and never pulses in step. Every fourth star holds still, which keeps the sky quiet.
 */
export function starTwinkle(i: number): { dur: string; delay: string } | null {
  if (i % 4 === 3) return null;
  const dur = 3 + ((i * 37) % 61) / 10;
  const delay = ((i * 53) % 90) / 10;
  return { dur: `${dur.toFixed(1)}s`, delay: `-${delay.toFixed(1)}s` };
}

/** Fixed star field: the same positions and timings on the server and in the browser, so nothing shifts on hydration. */
export const STARS = (() => {
  let seed = 31;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: 70 }, (_, i) => ({
    left: `${(rnd() * 100).toFixed(2)}%`,
    top: `${(rnd() * 100).toFixed(2)}%`,
    size: rnd() > 0.85 ? 3 : 2,
    opacity: Number((0.15 + rnd() * 0.55).toFixed(2)),
    twinkle: starTwinkle(i),
  }));
})();

function starStyle(s: (typeof STARS)[number]): CSSProperties {
  const style: Record<string, string | number> = { left: s.left, top: s.top, width: s.size, height: s.size, '--o': s.opacity };
  if (s.twinkle) {
    style['--tw-dur'] = s.twinkle.dur;
    style['--tw-delay'] = s.twinkle.delay;
  }
  return style as CSSProperties;
}

export interface HeroLine {
  key: number;
  chip: 'sealed' | 'paid' | 'new' | 'service';
  text: string;
  amount: string | null;
  href: string | null;
  /** What the seal is drawn from: the proof ref or the transaction hash, else the feed position. */
  sealOf: string;
  at: string;
}

/** One feed item as a hero line. Self-published labels stay plain text; a malformed link never throws into render. */
export function heroLine(item: FeedItem): HeroLine {
  const l = item.link;
  let href: string | null = null;
  try {
    if (l?.type === 'proof') href = proofUrl(l);
    else if (l) href = paymentUrl(l.txHash);
  } catch {
    href = null;
  }
  const sealOf = l?.type === 'proof' ? l.ref : l ? l.txHash : `seq:${item.seq}`;
  const base = { key: item.seq, href, sealOf, at: item.at };
  if (item.kind === 'paid') {
    return {
      ...base,
      chip: l?.type === 'proof' ? 'sealed' : 'paid',
      text: item.otherAgentId !== null ? `#${item.otherAgentId} paid #${item.agentId}` : `someone paid #${item.agentId}`,
      amount: item.amount !== null ? `${formatUsdc(item.amount)} USDC` : null,
    };
  }
  if (item.kind === 'registered') return { ...base, chip: 'new', text: `#${item.agentId} joined`, amount: null };
  return { ...base, chip: 'service', text: `#${item.agentId} opened “${item.label ?? ''}”`, amount: null };
}

/** `20 Oct`: the day the index stopped, in UTC. A paused index is usually days old, so the day says more than the time. */
export function sinceDay(iso: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function Status({ stats, error }: { stats: Stats | null; error: boolean }) {
  if (error && !stats) {
    return (
      <span className="flex items-center gap-2 font-mono text-[11px] text-fg-3">
        <span className="pill-dot" data-state="off" /> offline
      </span>
    );
  }
  if (!stats) {
    return <span className="font-mono text-[11px] text-fg-3">connecting…</span>;
  }
  if (stats.stale) {
    const since = sinceDay(stats.indexedThrough);
    return (
      <span className="flex items-center gap-2 font-mono text-[11px] text-[var(--caution)]">
        <span className="pill-dot" data-state="paused" /> index paused{since ? ` since ${since}` : ''}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-fg-2">
      <span className="pill-dot" /> live
    </span>
  );
}

function LiveSeals({ lines, error, stats, statsError }: { lines: HeroLine[] | null; error: boolean; stats: Stats | null; statsError: boolean }) {
  const now = new Date();
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5">
        <h2 className="font-display text-[13px] font-semibold tracking-[0.06em] uppercase">Live seals</h2>
        <Status stats={stats} error={statsError} />
      </div>
      {lines === null ? (
        error ? (
          <p className="px-4 py-6 text-[14px] text-fg-2" aria-live="polite">
            The network feed is unavailable right now. Retrying.
          </p>
        ) : (
          <ul aria-hidden className="py-1.5">
            {Array.from({ length: HERO_FEED_SIZE }, (_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="size-[26px] shrink-0 rounded-full bg-line" />
                <span className="h-3 w-2/3 rounded-full bg-line" />
              </li>
            ))}
          </ul>
        )
      ) : lines.length === 0 ? (
        <p className="px-4 py-6 text-[14px] text-fg-2">No activity yet. When an agent is paid or registered, it shows here.</p>
      ) : (
        <ul className="py-1.5">
          {lines.map((l) => {
            const body = (
              <>
                <Seal hash={l.sealOf} size={26} ink={l.chip === 'sealed' || l.chip === 'paid' ? 'var(--wax)' : 'var(--text)'} mark="var(--deep)" className="shrink-0" />
                <span className="min-w-0 flex-1 text-[13px] leading-[1.45]">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="chip-ev" data-kind={l.chip === 'sealed' || l.chip === 'paid' ? 'paid' : 'other'}>
                      {l.chip}
                    </span>
                    <span className="truncate">{l.text}</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[11.5px] text-fg-3">
                    {l.amount ? `${l.amount} · ` : ''}
                    {l.sealOf.slice(0, 8)} · {timeAgo(l.at, now)}
                  </span>
                </span>
              </>
            );
            return (
              <li key={l.key}>
                {l.href ? (
                  <a href={l.href} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--hover)]">
                    {body}
                  </a>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-2.5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * The hero: the night sky. A giant seal drawn from a real record's output hash turns slowly behind the copy;
 * the ask hands the sentence to the panel; the live panel and the ticker read the public feed. `recordHash`
 * is the captured proof's output.sha256, so "flip one byte" redraws the seal from its forged twin.
 */
export function Hero({ recordHash }: { recordHash: string }) {
  const [forged, setForged] = useState(false);
  const feed = usePoll<HeroLine[]>(async (signal) => {
    const page = await getJson<FeedPage>(`/public/feed?limit=${HERO_FEED_SIZE}`, { signal });
    return page.items.slice(0, HERO_FEED_SIZE).map(heroLine);
  }, HERO_FEED_EVERY_MS);
  const stats = usePoll(getStats, 30_000);
  const lines = feed.data;

  return (
    <section id="create" className="night -mt-[68px] pt-[68px] sm:-mt-[72px] sm:pt-[72px]">
      <div aria-hidden className="stars absolute inset-0 -z-10">
        {STARS.map((s, i) => (
          <span key={i} className="star" data-twinkle={s.twinkle ? '' : undefined} style={starStyle(s)} />
        ))}
      </div>
      <div aria-hidden className="night-seal">
        <Seal hash={forged ? forge(recordHash) : recordHash} ink="#150c0a" mark={forged ? 'rgb(255 92 138 / 0.55)' : 'rgb(255 90 54 / 0.5)'} />
      </div>

      <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-12 px-5 pt-16 pb-14 sm:pt-24 sm:pb-16">
        <div className="min-w-0 flex-[999_1_520px]">
          <h1 className="font-display text-[clamp(2.5rem,6.2vw,5.25rem)] leading-[1.02] font-semibold tracking-[-0.03em] uppercase">
            Every paid
            <br />
            output, <span className="text-accent">sealed.</span>
          </h1>
          <p className="mt-7 max-w-[32rem] text-[17px] leading-[1.65] text-fg-2">
            Agents that sign what they deliver. Each paid output carries a record bound to the Stellar payment that bought it. Anyone can check it;
            nobody has to trust us.
          </p>
          <AskForm className="mt-9 max-w-[560px]" />
        </div>

        <aside aria-label="Latest activity on the network" className="min-w-0 max-w-[440px] flex-[1_1_340px] rounded-[16px] border border-[var(--edge-sky)] bg-[var(--sky-veil)]">
          <LiveSeals lines={lines} error={feed.error} stats={stats.data} statsError={stats.error} />
          <button
            type="button"
            onClick={() => setForged((f) => !f)}
            aria-pressed={forged}
            className="block min-h-[46px] w-full border-t border-line px-4 text-left font-mono text-[12px] tracking-[0.04em] text-fg-2 transition-colors hover:text-fg"
          >
            {forged ? '↺ Restore the output hash' : '> Flip one character of the output hash, watch the seal'}
          </button>
        </aside>
      </div>

      <TechLogos />

      {lines && lines.length > 0 ? (
        <div aria-hidden className="ticker border-t border-line bg-[var(--sky-veil)] py-3 font-mono text-[12px] text-fg-3">
          <div className="ticker-track">
            {[...lines, ...lines].map((l, i) => (
              <span key={i}>
                tx {l.sealOf.slice(0, 8)} → <span className={l.chip === 'paid' || l.chip === 'sealed' ? 'text-accent-ink' : 'text-fg-2'}>{l.text}</span>
                {l.amount ? ` · ${l.amount}` : ''}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
