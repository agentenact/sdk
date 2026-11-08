// Font system — Inter for display/body, JetBrains Mono for all technical
// values (hashes, addresses, amounts). Restrained: two families only.

import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

const inter = loadInter('normal', {
  weights: ['400', '500', '600', '700'],
  subsets: ['latin'],
});

const mono = loadMono('normal', {
  weights: ['400', '500', '600'],
  subsets: ['latin'],
});

export const FONTS = {
  display: inter.fontFamily,
  body: inter.fontFamily,
  mono: mono.fontFamily,
} as const;
