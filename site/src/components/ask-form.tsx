'use client';

import { useState } from 'react';
import { panelUrl } from '@/lib/panel-url';

/** One sentence in, the panel's draft out. The homepage hero and /create share it; `id` keeps their inputs distinct. */
export function AskForm({ id = 'create-prompt', className = '', label }: { id?: string; className?: string; label?: string }) {
  const [text, setText] = useState('');
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        window.location.assign(panelUrl(text));
      }}
    >
      {label ? (
        <label htmlFor={id} className="mb-2.5 block text-[15px] font-medium text-fg">
          {label}
        </label>
      ) : (
        <label htmlFor={id} className="mb-2.5 block font-mono text-[12px] tracking-[0.12em] text-fg-2 uppercase">
          &gt; Describe your agent
        </label>
      )}
      <div className="ask">
        <input
          id={id}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          autoComplete="off"
          placeholder="Tell me when XLM falls 5% in an hour"
        />
        <button type="submit" className="btn btn-wax h-[54px] rounded-[12px] px-6">
          Make my agent <span aria-hidden>→</span>
        </button>
      </div>
      <p className="mt-3 text-[13px] text-fg-3">Stellar testnet. You see the draft before signing up.</p>
    </form>
  );
}
