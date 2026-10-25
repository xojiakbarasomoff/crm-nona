import { fileURLToPath } from 'node:url';
/** @type {import('next').NextConfig} */
const api = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4100';
export default {
  // Alohida demo muhit (scripts/demo-env) asosiy dev server bilan .next papkasini bo'lishmasligi uchun.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@crm/contracts'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      // Meta webhook'lari (GET verify, POST hodisa, deauthorize, data-deletion): backend ichki, web domeni orqali ochiladi.
      { source: '/webhooks/meta', destination: `${api}/webhooks/meta` },
      { source: '/webhooks/meta/:path*', destination: `${api}/webhooks/meta/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};
