import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    // 把目录源内联进客户端包：`lib/catalog/products.ts` 在浏览器端也要解析出**同一个源**，
    // 否则服务端渲染 justoneapi 商品、客户端却按 real 计算品类计数，会直接 hydration 报错。
    // 只内联这一个非敏感开关；token 之类密钥永远不进客户端（也不该写成 NEXT_PUBLIC_*）。
    CATALOG_SOURCE: process.env.CATALOG_SOURCE ?? '',
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'fastly.picsum.photos' },
      { protocol: 'https', hostname: 'trae-api-cn.mchost.guru' },
    ],
  },
};

export default nextConfig;
