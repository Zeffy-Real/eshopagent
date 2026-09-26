'use client';

import { ReceiptText, ShoppingCart, X } from 'lucide-react';
import { CartSection } from '@/components/visualization/cart-section';
import { OrderHistorySection } from '@/components/order/order-history-section';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { selectCartCount, useCartStore } from '@/store/use-cart-store';
import { useOrderStore } from '@/store/use-order-store';
import { useUiStore, type ShoppingDrawerTab } from '@/store/use-ui-store';
import { cn } from '@/lib/utils';

/**
 * 购物车 / 订单历史抽屉。
 *
 * 形态选择：右侧浮层抽屉（复用 `@radix-ui/react-dialog`，不引入新依赖、不新增第四栏）——
 * 三栏总体布局与窄屏的「Tab + 右栏抽屉」结构都不受影响；`<md` 下占满宽度，与右栏抽屉
 * 在窄屏的处理一致，自带关闭按钮，不会出现「打开后关不掉」。
 *
 * 内容复用现有实现：购物车 Tab 直接用右栏同一个 `CartSection`（因此两处内容必然一致，
 * 不存在第二套渲染），订单历史 Tab 用 `OrderHistorySection`。结算仍走原有
 * interrupt 链路：`CartSection` 的「去结算」→（先关抽屉，避免与订单确认弹窗叠层）
 * → `sendMessage('结算')`。
 */

const TABS: { value: ShoppingDrawerTab; label: string; icon: typeof ShoppingCart }[] = [
  { value: 'cart', label: '购物车', icon: ShoppingCart },
  { value: 'orders', label: '订单历史', icon: ReceiptText },
];

export function ShoppingDrawer() {
  const open = useUiStore((s) => s.shoppingDrawerOpen);
  const tab = useUiStore((s) => s.shoppingDrawerTab);
  const openDrawer = useUiStore((s) => s.openShoppingDrawer);
  const closeDrawer = useUiStore((s) => s.closeShoppingDrawer);
  const cartCount = useCartStore(selectCartCount);
  const orderCount = useOrderStore((s) => s.orders.length);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDrawer();
      }}
    >
      <DialogContent
        hideClose
        // 覆盖 Dialog 的居中弹窗样式，改成右侧抽屉：宽屏 420px、窄屏占满
        className={cn(
          'left-auto right-0 top-0 h-full max-h-none w-full translate-x-0 translate-y-0',
          'gap-0 rounded-none border-y-0 border-r-0 p-0 md:w-[420px]',
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <DialogTitle className="text-[14px] font-semibold text-foreground">
            我的购物车
          </DialogTitle>
          <DialogDescription className="sr-only">
            购物车与订单历史（下单记录来自真实的确认下单结果）
          </DialogDescription>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="ml-auto text-muted-foreground"
            onClick={closeDrawer}
          >
            <X />
          </Button>
        </div>

        <div role="tablist" aria-label="购物车与订单" className="flex shrink-0 gap-1 px-3 pt-2.5">
          {TABS.map(({ value, label, icon: Icon }) => {
            const count = value === 'cart' ? cartCount : orderCount;
            return (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={tab === value}
                onClick={() => openDrawer(value)}
                className={cn(
                  'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] text-[13px] font-medium transition-colors duration-150',
                  tab === value
                    ? 'bg-primary-soft text-primary-ink'
                    : 'text-muted-foreground hover:bg-surface-muted',
                )}
              >
                <Icon className="size-3.5" />
                {label}
                {count > 0 && <span className="tabular-nums">· {count}</span>}
              </button>
            );
          })}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-3">
            {tab === 'cart' ? <CartSection onBeforeCheckout={closeDrawer} /> : <OrderHistorySection />}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}