'use client';

import { LayoutGrid, MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ChatPanel } from '@/components/chat/chat-panel';
import { ProductPanel } from '@/components/product/product-panel';
import { OrderConfirmDialog } from '@/components/order/order-confirm-dialog';
import { ShoppingDrawer } from '@/components/order/shopping-drawer';
import { AgentPanel } from '@/components/visualization/agent-panel';
import { useUiStore, type MobileTab } from '@/store/use-ui-store';
import { cn } from '@/lib/utils';

const TABS: { value: MobileTab; label: string; icon: typeof MessagesSquare }[] = [
  { value: 'chat', label: '对话', icon: MessagesSquare },
  { value: 'products', label: '商品', icon: LayoutGrid },
];

/** 与 xl 断点保持一致：≥1280px 右栏为静态列，以下为抽屉 */
const DESKTOP_QUERY = '(min-width: 1280px)';

export function Workspace() {
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);
  const syncBreakpoint = useUiStore((s) => s.syncBreakpoint);
  const [mounted, setMounted] = useState(false);

  // 抽屉形态下右栏是浮层，若沿用桌面端的「展开」状态会一直盖住中栏；
  // 窄屏强制收起，回到宽屏时恢复用户此前的桌面端意图。
  useEffect(() => {
    setMounted(true);
    const query = window.matchMedia(DESKTOP_QUERY);
    syncBreakpoint(query.matches);

    const handleChange = (event: MediaQueryListEvent) => syncBreakpoint(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, [syncBreakpoint]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 移动端：对话 / 商品 二选一 */}
      <div
        role="tablist"
        aria-label="视图切换"
        className="flex shrink-0 gap-1 border-b border-border bg-sidebar px-3 py-2 md:hidden"
      >
        {TABS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            role="tab"
            aria-selected={mobileTab === value}
            onClick={() => setMobileTab(value)}
            className={cn(
              'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] text-[13px] font-medium transition-colors duration-150',
              mobileTab === value
                ? 'bg-primary-soft text-primary-ink'
                : 'text-muted-foreground hover:bg-surface-muted',
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：智能对话区 */}
        <aside
          className={cn(
            'flex w-full min-w-0 shrink-0 flex-col border-r border-border bg-sidebar md:w-[336px] xl:w-[380px]',
            mobileTab === 'products' && 'hidden md:flex',
          )}
        >
          <ChatPanel />
        </aside>

        {/* 中栏：商品展示与交互区 */}
        <section
          className={cn(
            'min-w-0 flex-1 flex-col bg-background',
            mobileTab === 'chat' ? 'hidden md:flex' : 'flex',
          )}
        >
          <ProductPanel />
        </section>

        {/* 右栏：Agent 可视化面板（≥xl 静态列，<xl 抽屉） */}
        {mounted && rightPanelOpen && (
          <button
            type="button"
            aria-label="关闭 Agent 面板"
            onClick={() => setRightPanelOpen(false)}
            className="fixed inset-x-0 bottom-0 top-14 z-30 cursor-default bg-black/40 xl:hidden"
          />
        )}
        <aside
          inert={!rightPanelOpen}
          aria-hidden={!rightPanelOpen}
          className={cn(
            'fixed bottom-0 right-0 top-14 z-40 flex flex-col border-l border-border bg-sidebar',
            // 窄屏（<md）下聊天区是全宽的，抽屉却锚在右下角，会盖住聊天输入框的发送按钮：
            // 输入框左半仍然可见可点，发送按钮却被盖住，用户点下去没有任何反应也没有提示。
            // 所以 <md 时抽屉占满宽度，成为明确的全屏浮层（面板头部有「收起面板」按钮）；
            // md 及以上聊天区固定在左侧，抽屉只覆盖中栏，不存在遮挡。
            'w-full md:w-[340px] md:max-w-[88vw]',
            // 抽屉占满宽度时，顶部两条内容区（标签栏 48px + 对话头部 56px，见 h-14）都在它下面：
            // 对话头部已抬到 z-50（chat-panel.tsx）浮在抽屉之上，这里让出等高位置，
            // 否则抽屉自己的头部会被压在下面，连「收起面板」都点不到。
            // md 起抽屉只覆盖中栏，不需要让位，故 md:pt-0。
            'pt-26 md:pt-0',
            'transition-transform duration-200 ease-out xl:static xl:top-0 xl:z-auto xl:w-[360px] xl:max-w-none',
            rightPanelOpen ? 'translate-x-0' : 'translate-x-full xl:hidden',
          )}
        >
          <AgentPanel />
        </aside>
      </div>

      {/* 下单确认（human-in-the-loop）：由 interrupt 事件驱动 */}
      <OrderConfirmDialog />

      {/* 购物车 / 订单历史抽屉：顶栏两个入口共用，浮层形态不改三栏结构 */}
      <ShoppingDrawer />
    </div>
  );
}
