'use client';

import { useEffect } from 'react';
import { useAgentStore } from '@/store/use-agent-store';
import { useCartStore } from '@/store/use-cart-store';

/**
 * 恢复本地持久化状态。
 *
 * zustand persist 使用 skipHydration，避免服务端渲染与客户端 localStorage
 * 不一致导致的 hydration mismatch，因此需要在挂载后手动 rehydrate。
 */
export function StoreHydration() {
  useEffect(() => {
    void useAgentStore.persist.rehydrate();
    void useCartStore.persist.rehydrate();
  }, []);

  return null;
}
