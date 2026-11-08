import type { Metadata } from 'next';
import { Geist, Geist_Mono, Unbounded } from 'next/font/google';
import './globals.css';

const unbounded = Unbounded({
  subsets: ['latin'],
  weight: ['400', '600', '800'],
  variable: '--font-unbounded',
  display: 'swap',
});

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

const DESCRIPTION =
  'Agentic. Signetic. Create an agent on Stellar. Every paid output it makes is sealed by the agent, bound to the payment that bought it, and checkable by anyone.';

export const metadata: Metadata = {
  metadataBase: new URL('https://agentenact.io'),
  alternates: { canonical: 'https://agentenact.io' },
  title: 'AgentEnact — agentic, signetic',
  description: DESCRIPTION,
  openGraph: {
    title: 'AgentEnact — agentic, signetic',
    description: DESCRIPTION,
    url: 'https://agentenact.io',
    siteName: 'AgentEnact',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentEnact — agentic, signetic',
    description: 'Agentic. Signetic. Create a Stellar agent in your browser; every paid output it makes is checkable by anyone.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${unbounded.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
