// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // ← ファイルアップロード対応
    },
  },
  async rewrites() {
    return [
      {
        source: '/mu/:path*',
        destination: 'https://mu-ui-v1-0-5.vercel.app/:path*',
      },
    ];
  },
};

export default nextConfig;
