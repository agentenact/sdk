import { templateUrl } from '@/lib/panel-url';
import { TEMPLATES } from '@/lib/templates';

/** The four the homepage shows, one of each kind; /create lists them all. */
const FEATURED = ['xlm-drop', 'coin-crash', 'wallet-watch', 'daily-digest'];
import { TemplateIcon } from './template-icon';

/** Ready agents: each card opens its plan in the panel at once, no model call and no sign-up. */
export function ReadyAgents() {
  return (
    <section id="templates" className="px-5">
      <div className="mx-auto max-w-6xl pt-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="headline text-[clamp(1.75rem,3.2vw,2.5rem)]">Start from a ready agent</h2>
          <p className="max-w-md text-[15px] leading-[1.55] text-fg-2">
            Open a plan in one tap, change any value, then create it with your email and your device&rsquo;s screen lock: a PIN or password works,
            Face ID is optional.
          </p>
        </div>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TEMPLATES.filter((t) => FEATURED.includes(t.id)).map((t) => (
            <li key={t.id} className="min-w-0">
              <a href={templateUrl(t.id)} className="card group flex h-full flex-col gap-4 p-5 transition-colors hover:border-[var(--edge-strong)]">
                <span className="grid size-11 place-items-center rounded-[12px] bg-[var(--wax-tint)] text-accent-ink">
                  <TemplateIcon id={t.id} />
                </span>
                <span className="text-[17px] font-semibold">{t.title}</span>
                <span className="text-[14px] leading-[1.5] text-fg-2">{t.summary}</span>
                <span className="mt-auto pt-2 text-[13px] font-medium text-accent-ink">
                  Open the plan <span aria-hidden className="inline-block transition-transform group-hover:translate-x-0.5">→</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-[14px] text-fg-3">
          <a href="/create" className="text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
            All {TEMPLATES.length} ready agents
          </a>
        </p>
      </div>
    </section>
  );
}
