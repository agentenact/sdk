import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProfileLoader } from '@/components/agent-profile';

export const metadata: Metadata = {
  title: 'Agent — AgentEnact',
  description: 'One agent in the stellar-8004 registry on Stellar testnet: who owns it, what it sells, and its paid history with proofs.',
  alternates: { canonical: 'https://agentenact.io/agent' },
};

export default function AgentPage() {
  return (
    <>
      <SiteHeader />
      <main className="px-5 pt-10 pb-4">
        <div className="mx-auto max-w-6xl min-w-0">
          <Suspense fallback={<p className="py-8 text-[14px] text-fg-2">Loading…</p>}>
            <ProfileLoader />
          </Suspense>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
