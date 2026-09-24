'use client';

import { create } from 'zustand';

export type MobileTab = 'chat' | 'products';

interface UiState {
  /** 桌面端右栏（Agent 可视化面板）是否展开（当前生效值） */
  rightPanelOpen: boolean;
  /** 桌面端的用户意图：从窄屏回到宽屏时用它恢复，而不是粗暴地保持收起 */
  desktopPanelOpen: boolean;
  /** 移动端主视图切换 */
  mobileTab: MobileTab;
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

