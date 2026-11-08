'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseVerifyParams, recordUrl } from '@/lib/verify-params';
import { checkRecord, type VerifierModule } from '@/lib/verify-record';
import { VerifyView, type ShownRecord, type VerifyState } from './verify-view';
import { loadVerifier } from './live-proof';

/** Reads the target from the address bar, fetches the record by status only, then runs the package's verifier. */
export function VerifyRecord({ verifierSrc }: { verifierSrc: string }) {
  const [state, setState] = useState<VerifyState>({ phase: 'loading' });
  const run = useCallback(async () => {
    const target = parseVerifyParams(window.location.search);
    if (!target) return setState({ phase: 'bad_link' });
    setState({ phase: 'loading' });
    try {
      const res = await fetch(recordUrl(target), { headers: { accept: 'application/json' } });
      if (res.status === 404) return setState({ phase: 'not_found' });
      if (!res.ok) return setState({ phase: 'error' });
      const record = (await res.json()) as ShownRecord;
      const mod = (await loadVerifier(verifierSrc)) as unknown as VerifierModule;
      setState({ phase: 'done', record, result: await checkRecord(record, mod) });
    } catch {
      setState({ phase: 'error' });
    }
  }, [verifierSrc]);
  useEffect(() => {
    void run();
  }, [run]);
  return <VerifyView state={state} onRetry={() => void run()} />;
}
