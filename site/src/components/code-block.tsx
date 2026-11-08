'use client';

import { useState } from 'react';

/** A code sample on a raised panel, with a copy button. `label` names it (a file, a shell). */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="card my-4 overflow-hidden p-0">
      <figcaption className="flex items-center justify-between gap-3 border-b border-[var(--raised-line)] px-4 py-2 font-mono text-[11.5px] text-fg-3">
        <span>{label ?? ''}</span>
        <button
          type="button"
          className="min-h-[32px] rounded-md px-2 text-fg-2 transition-colors hover:text-fg"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <span aria-live="polite">{copied ? 'copied' : 'copy'}</span>
        </button>
      </figcaption>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-[1.65] text-fg">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
