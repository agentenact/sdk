import type { Metadata } from 'next';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { VerifyRecord } from '@/components/verify-record';
import { verifierSrc } from '@/lib/verifier-src';

export const metadata: Metadata = {
  title: 'Verify a proof — AgentEnact',
  description: 'Check an Enactment Record yourself: who signed the output, which payment it is bound to, and who owns the agent, from public Stellar testnet data.',
  alternates: { canonical: 'https://agentenact.io/verify' },
};

export default function VerifyPage() {
  return (
    <>
      <SiteHeader />
      <main className="px-5 pt-10 pb-16">
        <div className="mx-auto max-w-6xl">
          <h1 className="headline text-[clamp(1.75rem,3vw,2.25rem)]">Verify a proof</h1>
          <p className="mt-3 max-w-[60ch] text-[16px] text-fg-2">Check it yourself, from public Stellar testnet data.</p>
          <VerifyRecord verifierSrc={verifierSrc()} />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
