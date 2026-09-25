import { Workspace } from '@/components/layout/workspace';
import { CatalogDataProvider } from '@/components/providers/catalog-data-provider';
import { buildCatalogClientPayload } from '@/lib/catalog/field-truth';
import { CATALOG_META, PRODUCTS, getFeaturedProducts } from '@/lib/catalog/products';

/**
 * 目录的**轻量数据在服务端打包**，再注入客户端树。
 *
 * 客户端不再 import `lib/catalog/products.ts`（它静态带着 451 KB 的目录 JSON，
 * 会让整份目录进首屏 bundle）。它需要的只是：来源与构建信息、品类计数、
 * 覆盖率、平台分布、首屏 12 件推荐——都在这里算好，切源（real / justoneapi / mock）
 * 由 `CATALOG_SOURCE` 决定，服务端打包的就是「当前源」的数据。
 */
export default function HomePage() {
  const payload = buildCatalogClientPayload({
    products: PRODUCTS,
    meta: CATALOG_META,
    featured: getFeaturedProducts(12),
  });

  return (
    <CatalogDataProvider payload={payload}>
      <Workspace />
    </CatalogDataProvider>
  );
}