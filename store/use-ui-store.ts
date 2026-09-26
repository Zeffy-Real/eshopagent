'use client';

import { create } from 'zustand';
import type { BrowseViewSource } from '@/lib/catalog/browse-products';

export type MobileTab = 'chat' | 'products';

/** 购物车 / 订单历史抽屉的两个 Tab */
export type ShoppingDrawerTab = 'cart' | 'orders';

interface UiState {
  /** 桌面端右栏（Agent 可视化面板）是否展开（当前生效值） */
  rightPanelOpen: boolean;
  /** 桌面端的用户意图：从窄屏回到宽屏时用它恢复，而不是粗暴地保持收起 */
  desktopPanelOpen: boolean;
  /** 移动端主视图切换 */
  mobileTab: MobileTab;
  /**
   * 购物车 / 订单历史抽屉（顶栏两个入口共用同一个抽屉）。
   * `cart` 与 `orders` 是它的两个 Tab —— 不做两个独立抽屉，也不新增第四栏。
   */
  shoppingDrawerOpen: boolean;
  shoppingDrawerTab: ShoppingDrawerTab;
  openShoppingDrawer: (tab: ShoppingDrawerTab) => void;
  closeShoppingDrawer: () => void;
  /**
   * 中栏浏览视图（覆盖层）的数据来源；`null` = 未打开。
   *
   * 纯 UI 态：数据由客户端目录 chunk 现算（品类 / 全量），**不经对话、不碰 SSE、
   * 零 LLM 依赖** —— 无 Key 时它同样完整可用。
   * 只收目录浏览两个来源（`BrowseViewSource`）：搜索结果的展开归中栏就地「加载更多」，
   * 不再换视图（2026-09-26 收口）。
   */
  browseSource: BrowseViewSource | null;
  openBrowse: (source: BrowseViewSource) => void;
  closeBrowse: () => void;
  /** 详情弹窗当前展示的商品 id */
  detailProductId: string | null;
  /** 待对比商品 id（2 - 4 件，选择完成后一次性提交给 Agent） */
  compareIds: string[];
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;
  /** 断点切换：窄屏强制收起（抽屉会盖住中栏），宽屏恢复桌面端意图 */
  syncBreakpoint: (isDesktop: boolean) => void;
  setMobileTab: (tab: MobileTab) => void;
  openProductDetail: (id: string) => void;
  closeProductDetail: () => void;
  toggleCompare: (id: string) => void;
  clearCompare: () => void;
}

/** 对比商品数量上限 */
export const MAX_COMPARE = 4;

export const useUiStore = create<UiState>((set) => ({
  rightPanelOpen: true,
  desktopPanelOpen: true,
  mobileTab: 'chat',
  shoppingDrawerOpen: false,
  shoppingDrawerTab: 'cart',
  browseSource: null,
  detailProductId: null,
  compareIds: [],
  toggleRightPanel: () =>
    set((s) => {
      const next = !s.rightPanelOpen;
      return { rightPanelOpen: next, desktopPanelOpen: next };
    }),
  setRightPanelOpen: (open) => set({ rightPanelOpen: open, desktopPanelOpen: open }),
  syncBreakpoint: (isDesktop) =>
    set((s) => ({ rightPanelOpen: isDesktop ? s.desktopPanelOpen : false })),
  setMobileTab: (tab) => set({ mobileTab: tab }),
  openShoppingDrawer: (tab) => set({ shoppingDrawerOpen: true, shoppingDrawerTab: tab }),
  closeShoppingDrawer: () => set({ shoppingDrawerOpen: false }),
  openBrowse: (source) => set({ browseSource: source }),
  closeBrowse: () => set({ browseSource: null }),
  openProductDetail: (id) => set({ detailProductId: id }),
  closeProductDetail: () => set({ detailProductId: null }),
  toggleCompare: (id) =>
    set((s) => {
      if (s.compareIds.includes(id)) {
        return { compareIds: s.compareIds.filter((current) => current !== id) };
      }
      if (s.compareIds.length >= MAX_COMPARE) return s;
      return { compareIds: [...s.compareIds, id] };
    }),
  clearCompare: () => set({ compareIds: [] }),
}));

