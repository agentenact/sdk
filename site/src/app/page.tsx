import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CapturedProof } from '@/lib/proof-types';
import { SiteHeader } from '@/components/site-header';
import { NumbersStrip } from '@/components/numbers';
import { HowItWorks } from '@/components/how-it-works';
import { McpHarnesses } from '@/components/mcp-harnesses';
import { LiveProof } from '@/components/live-proof';
import { Hero } from '@/components/hero';
import { NetworkAgents } from '@/components/network-agents';
import { ReadyAgents } from '@/components/ready-agents';
import { SiteFooter } from '@/components/site-footer';
import { verifierSrc } from '@/lib/verifier-src';

function loadProof(): CapturedProof {
  const file = path.join(process.cwd(), 'public', 'proofs', 'latest.json');
  return JSON.parse(readFileSync(file, 'utf8')) as CapturedProof;
}

export default function Home() {
  const proof = loadProof();

  return (
    <>
      <SiteHeader />
      <main className="pb-28">
        <Hero recordHash={proof.record.output.sha256} />
        <NumbersStrip />
        <NetworkAgents />
        <ReadyAgents />
        <HowItWorks />
        <McpHarnesses />
        <LiveProof proof={proof} verifierSrc={verifierSrc()} />
      </main>
      <SiteFooter />
    </>
  );
}
