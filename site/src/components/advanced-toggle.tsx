'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * The /create developer options: closed by default behind one button. A link to any anchor inside (the header's
 * `#install`, /developers' `#own-wallet`) or to `#advanced` opens it and scrolls there, so old links keep working.
 */
export function AdvancedToggle({ ids, children }: { ids: string[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const follow = () => {
      const id = window.location.hash.slice(1);
      if (id !== 'advanced' && !ids.includes(id)) return;
      setOpen(true);
      // Wait one frame for the opened content to lay out before scrolling to it.
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // ids come from static props; listening once on mount is intended
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section id="advanced" aria-label="Developer options" className="scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-8">
        <div>
          <p className="text-[16px] font-semibold text-fg">Developer options</p>
          <p className="mt-1 text-[14px] text-fg-3">Run it on your own infra with the library, or create it with your own wallet.</p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="advanced-body"
          onClick={() => setOpen((o) => !o)}
          className="btn btn-quiet h-11 px-5 text-[14px]"
        >
          {open ? 'Hide' : 'Show'} developer options <span aria-hidden>{open ? '↑' : '↓'}</span>
        </button>
      </div>
      <div id="advanced-body" hidden={!open} className="mt-10">
        {children}
      </div>
    </section>
  );
}
