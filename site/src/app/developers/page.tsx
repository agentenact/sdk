import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Create with your own keys — AgentEnact',
  robots: { index: false },
  alternates: { canonical: 'https://agentenact.io/create#own-wallet' },
};

/** Moved to /create. A static export has no server redirects, so this page refreshes there and keeps a link. */
export default function DevelopersPage() {
  return (
    <main className="mx-auto max-w-xl px-5 py-24">
      <meta httpEquiv="refresh" content="0; url=/create#own-wallet" />
      <p className="text-[16px] text-fg-2">
        This page moved to <a href="/create#own-wallet" className="text-fg underline underline-offset-4">Create an agent</a>.
      </p>
    </main>
  );
}
