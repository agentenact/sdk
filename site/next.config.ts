import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    // No next/image default loader in a static export; we don't use next/image.
    unoptimized: true,
  },
  // Repo root also has a bun.lock (the package's own), which makes Next
  // infer the wrong workspace root. Pin it to site/ explicitly.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
