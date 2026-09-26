'use client';

import { Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { EmptyState } from '@/components/common/empty-state';
import { ProductImage } from '@/components/product/product-image';
import { Button } from '@/components/ui/button';
import { summarizeCart } from '@/lib/cart-pricing';
import { useAgentStore } from '@/store/use-agent-store';
import { useCartStore } from '@/store/use-cart-store';
import { useUiStore } from '@/store/use-ui-store';
import { formatPrice } from '@/lib/utils';

/** 购物车状态面板：数量增减、删除、金额汇总、优惠券提示 */
export function CartSection({ onBeforeCheckout }: { onBeforeCheckout?: () => void } = {}) {
  const items = useCartStore((s) => s.items);
  const setQuantity = useCartStore((s) => s.setQuantity);
  const removeItem = useCartStore((s) => s.removeItem);
  const thinking = useAgentStore((s) => s.thinking);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const openProductDetail = useUiStore((s) => s.openProductDetail);

  if (items.length === 0) {
    return (
      <EmptyState
        compact
        icon={ShoppingCart}
        title="购物车是空的"
        description="点击商品卡片上的加号，或在对话里说「把第一件加入购物车」。"
      />
    );
  }

  const summary = summarizeCart(items);

  return (
    <div className="space-y-2.5">
      <ul className="space-y-1.5">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={item.product.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface p-1.5"
            >
              <button
                type="button"
                onClick={() => openProductDetail(item.product.id)}
                aria-label={`查看 ${item.product.name} 详情`}
              >
                <ProductImage
                  src={item.product.image}
                  alt={item.product.name}
                  fallbackText={item.product.name}
                  className="size-9 rounded-[var(--radius-sm)]"
                />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] font-medium text-foreground">
                  {item.product.name}
                </p>
                <p className="text-[11px] text-primary-ink">
                  {formatPrice(item.product.price * item.quantity)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="减少数量"
                  disabled={thinking}
                  onClick={() => setQuantity(item.product.id, item.quantity - 1)}
                >
                  <Minus />
                </Button>
                <span className="w-6 text-center text-[12px] tabular-nums text-foreground">
                  {item.quantity}
                </span>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="增加数量"
                  disabled={thinking}
                  onClick={() => setQuantity(item.product.id, item.quantity + 1)}
                >
                  <Plus />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`移除 ${item.product.name}`}
                  disabled={thinking}
                  onClick={() => removeItem(item.product.id)}
                  className="text-muted-foreground hover:text-danger"
                >
                  <Trash2 />
                </Button>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      <dl className="space-y-1 rounded-[var(--radius-md)] border border-border bg-surface-muted/50 p-2.5 text-[11.5px]">
        <Row label={`商品合计（${summary.count} 件）`} value={formatPrice(summary.subtotal)} />
        {summary.saved > 0 && (
          <Row label="商品直降" value={`-${formatPrice(summary.saved)}`} tone="success" />
        )}
        {summary.coupon && (
          <Row
            label={`优惠券 · ${summary.coupon.title}`}
            value={`-${formatPrice(summary.discount)}`}
            tone="success"
          />
        )}
        <Row
          label="运费"
          value={summary.shippingFee === 0 ? '包邮' : formatPrice(summary.shippingFee)}
        />
        <div className="flex items-center justify-between border-t border-border pt-1.5">
          <dt className="text-foreground">应付</dt>
          <dd className="text-[14px] font-semibold text-primary-ink">
            {formatPrice(summary.total)}
          </dd>
        </div>
      </dl>

      {summary.nextCoupon && (
        <p className="rounded-[var(--radius-sm)] bg-primary-soft px-2 py-1.5 text-[11px] text-primary-ink">
          再买 {formatPrice(summary.nextCoupon.gap)} 可用「{summary.nextCoupon.coupon.title}」
        </p>
      )}

      {summary.stockWarnings.length > 0 && (
        <ul className="space-y-1 rounded-[var(--radius-sm)] bg-danger-soft px-2 py-1.5 text-[11px] text-danger">
          {summary.stockWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <Button
        className="w-full gap-1.5"
        disabled={thinking}
        onClick={() => {
          // 抽屉里点结算：先关闭抽屉（由调用方传入），避免与订单确认弹窗（同为浮层）
          // 叠层；右栏用法不传该回调，行为与之前完全一致。结算链路本身不变。
          onBeforeCheckout?.();
          void sendMessage('结算');
        }}
      >
        去结算
      </Button>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success';
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={tone === 'success' ? 'text-success' : 'text-foreground'}>{value}</dd>
    </div>
  );
}
