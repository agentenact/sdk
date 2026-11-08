import { BRAND_HASH, Seal } from './seal';

const NAV = [
  { href: '/explore', label: 'Explore' },
  { href: '/verify', label: 'Verify' },
  { href: '/create#install', label: 'Developers' },
  { href: 'https://agentkarma.io', label: 'Karma ↗' },
];

/** A floating dark pill over the page: the seal mark, the testnet badge, four links and the one call to action. */
export function SiteHeader() {
  return (
    <header className="site-header sticky top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
      <div className="glass mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-full py-1.5 pr-1.5 pl-3 sm:pl-4">
        <a href="/" className="flex min-w-0 items-center gap-2.5 font-display text-[15px] font-semibold tracking-[0.02em] text-fg uppercase">
          <Seal hash={BRAND_HASH} size={26} mark="var(--deep)" />
          Enact
          <span className="rounded-[4px] border border-[var(--caution)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--caution)] max-[359px]:hidden">
            TESTNET
          </span>
        </a>
        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="hidden rounded-full px-3 py-2 text-[14px] text-fg-2 transition-colors hover:text-fg md:inline">
              {item.label}
            </a>
          ))}
          <a href="/create" className="btn btn-wax ml-1 h-10 px-4 text-[14px] max-[359px]:px-3">
            Create an agent
          </a>
        </nav>
      </div>
    </header>
  );
}
