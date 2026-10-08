import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Nested development worktrees must resolve their own locked dependency tree.
  turbopack: { root: path.resolve(__dirname) },
  // outputFileTracingRoot: path.resolve(__dirname, '../../'),  // Uncomment and add 'import path from "path"' if needed
  /* config options here */
  serverExternalPackages: ['coze-coding-dev-sdk'],
  allowedDevOrigins: ['*.dev.coze.site'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
