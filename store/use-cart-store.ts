'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CartItem, Product } from '@/lib/types';

interface CartState {
  items: CartItem[];
  /** 加入购物车（已存在则累加数量） */
  addItem: (product: Product, quantity?: number) => void;
  removeItem: (productId: string) => void;
  /** 按序号删除（对话指令「删除第 2 个商品」使用，序号从 1 开始） */
  removeByIndex: (index: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  /** 以服务端状态为准整体覆盖（Agent 执行后同步） */
  setItems: (items: CartItem[]) => void;
  clear: () => void;
}

function sameCart(left: CartItem[], right: CartItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      item.product.id === other.product.id &&
      item.quantity === other.quantity
    );
  });
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      addItem: (product, quantity = 1) =>
        set((state) => {
          const existing = state.items.find((item) => item.product.id === product.id);
          if (existing) {
            return {
              items: state.items.map((item) =>
                item.product.id === product.id
                  ? { ...item, quantity: Math.min(99, item.quantity + quantity) }
                  : item,
              ),
            };
          }
          return { items: [...state.items, { product, quantity }] };
        }),
      removeItem: (productId) =>
        set((state) => ({
          items: state.items.filter((item) => item.product.id !== productId),
        })),
      removeByIndex: (index) =>
        set((state) => ({
          items: state.items.filter((_, i) => i !== index - 1),
        })),
      setQuantity: (productId, quantity) =>
        set((state) => ({
          items:
            quantity <= 0
              ? state.items.filter((item) => item.product.id !== productId)
              : state.items.map((item) =>
                  item.product.id === productId
                    ? { ...item, quantity: Math.min(99, quantity) }
                    : item,
                ),
        })),
      setItems: (items) => {
        // 避免每次状态推送都触发重渲染
        if (sameCart(get().items, items)) return;
        set({ items });
      },
      clear: () => set({ items: [] }),
    }),
    {
      name: 'eshop-cart',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
    },
  ),
);

/** 购物车商品总件数 */
export const selectCartCount = (state: CartState): number =>
  state.items.reduce((sum, item) => sum + item.quantity, 0);

/** 购物车合计金额（元） */
export const selectCartTotal = (state: CartState): number =>
  state.items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

/** 购物车原价合计（用于展示节省金额） */
export const selectCartOriginalTotal = (state: CartState): number =>
  state.items.reduce((sum, item) => sum + item.product.originalPrice * item.quantity, 0);
