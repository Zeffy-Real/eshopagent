'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { CatalogClientPayload } from '@/lib/catalog/field-truth';

/**
 * 目录轻量数据的注入点（服务端算好 → 客户端读）。
 *
 * 为什么不放构建期产物：客户端需要的东西（品类计数 / 覆盖率 / 平台分布 / 来源信息）
 * 是**源感知**的——real 是 7×60、mock 是另一套分布、justoneapi 是 7×4。
 * 服务端已经知道当前源（`lib/catalog/products.ts` 的 `resolveSource()`），
 * 由它打包「当前源」的数据最省事：不新增产物、不需要第三个构建脚本，
 * 也不可能出现「面板数字与徽标数字不一致」。
 */

const CatalogDataContext = createContext<CatalogClientPayload | null>(null);

export function CatalogDataProvider({
  payload,
  children,
}: {
  payload: CatalogClientPayload;
  children: ReactNode;
}) {
  return <CatalogDataContext.Provider value={payload}>{children}</CatalogDataContext.Provider>;
}

/**
 * 读取目录轻量数据。
 *
 * 缺失时**抛错而不是静默回落**：静默回落只能给出 0 件 / 空覆盖率的假数字，
 * 那正是这个项目反复避免的「元信息撒谎」。组件只在 `app/page.tsx` 的 provider 之下渲染。
 */
export function useCatalogData(): CatalogClientPayload {
  const payload = useContext(CatalogDataContext);
  if (!payload) {
    throw new Error('缺少 CatalogDataProvider：客户端目录数据必须由服务端（app/page.tsx）注入');
  }
  return payload;
}