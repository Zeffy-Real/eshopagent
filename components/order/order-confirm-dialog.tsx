'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgeCheck, CreditCard, Loader2, MapPin, PackageCheck } from 'lucide-react';
import { ProductImage } from '@/components/product/product-image';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAgentStore } from '@/store/use-agent-store';
import { PAYMENT_LABEL, type Order } from '@/lib/types';
import { formatPrice } from '@/lib/utils';

/** 下单成功后的展示时长 */
const SUCCESS_VISIBLE_MS = 4200;

/**
 * 订单确认弹窗（human-in-the-loop）。
 *
 * 数据流：prepareOrder 内 interrupt() → SSE 推送 interrupt 事件 →
 * 弹窗展示订单明细 → 用户点确认 → POST /api/agent/resume 带 Command(resume)
 * → 图从断点恢复执行 confirmOrder → 状态里出现 status=confirmed 的订单 → 展示成功动画。
 *
 * 「成功态」的数据源与判据（2026-09-26 修正）：
 *   - 订单本体来自 SSE 快照的 `pendingOrder`（confirmOrder 真实写回的结果）；
 *   - 但**必须同时**命中会话级门 `recentConfirmedOrderId` —— 它只在「本次页面会话内
 *     点过确认」的 resume 在途期间写入、且不持久化。少这道门，刷新后会从持久化的
 *     快照里再读出一条 confirmed 订单、把成功弹窗重播一次（A-2）；
 *   - 不再依赖 interrupt 事件：confirmed 的订单不是挂起中断（服务端已按此收紧）。
 */
export function OrderConfirmDialog() {
  const interruptedOrder = useAgentStore((s) => s.interruptedOrder);
  const resuming = useAgentStore((s) => s.resuming);
  const recentConfirmedOrderId = useAgentStore((s) => s.recentConfirmedOrderId);
  const confirmedOrder = useAgentStore((s) =>
    s.snapshot?.pendingOrder?.status === 'confirmed' ? s.snapshot.pendingOrder : null,
  );
  const resumeOrder = useAgentStore((s) => s.resumeOrder);
  const dismissInterrupt = useAgentStore((s) => s.dismissInterrupt);
  // 用「已关闭的订单号」而不是布尔值：同一个会话里下第二单时也要能再次弹出成功态
  const [dismissedOrderId, setDismissedOrderId] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirmedOrder) return;
    const orderId = confirmedOrder.id;
    const timer = setTimeout(() => setDismissedOrderId(orderId), SUCCESS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [confirmedOrder]);

  const showSuccess =
    confirmedOrder !== null &&
    confirmedOrder.id === recentConfirmedOrderId &&
    confirmedOrder.id !== dismissedOrderId;
  const open = interruptedOrder !== null || showSuccess;

  function handleOpenChange(next: boolean) {
    if (next) return;
    if (showSuccess && confirmedOrder) {
      setDismissedOrderId(confirmedOrder.id);
      return;
    }
    dismissInterrupt();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="w-[min(520px,calc(100vw-2rem))]"
        // Radix 默认聚焦第一个可聚焦元素（「取消」），键盘用户按 Enter 会误取消订单，
        // 因此打开时把焦点显式放到主操作上
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          confirmRef.current?.focus();
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {showSuccess && confirmedOrder ? (
            <SuccessView key="success" order={confirmedOrder} />
          ) : interruptedOrder ? (
            <ConfirmView
              key="confirm"
              order={interruptedOrder}
              resuming={resuming}
              confirmRef={confirmRef}
              onCancel={() => void resumeOrder('cancel')}
              onConfirm={() => void resumeOrder('confirm')}
            />
          ) : null}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmView({
  order,
  resuming,
  confirmRef,
  onConfirm,
  onCancel,
}: {
  order: Order;
  resuming: boolean;
  confirmRef: React.RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <PackageCheck className="size-4 text-primary-ink" />
          确认订单
        </DialogTitle>
        <p className="text-[12px] text-muted-foreground">
          Agent 已暂停等待你确认，确认后才会生成正式订单号（演示环境不接入真实支付）
        </p>
      </DialogHeader>

      <ScrollArea className="max-h-[46vh]">
        <div className="space-y-3 p-4">
          <ul className="space-y-1.5">
            {order.items.map((item) => (
              <li
                key={item.product.id}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border p-1.5"
              >
                <ProductImage
                  src={item.product.image}
                  alt={item.product.name}
                  fallbackText={item.product.name}
                  className="size-9 rounded-[var(--radius-sm)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-foreground">
                    {item.product.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatPrice(item.product.price)} × {item.quantity}
                  </p>
                </div>
                <span className="shrink-0 text-[12px] font-medium text-foreground">
                  {formatPrice(item.product.price * item.quantity)}
                </span>
              </li>
            ))}
          </ul>

          <div className="space-y-1.5 rounded-[var(--radius-md)] border border-border bg-surface-muted/50 p-2.5 text-[12px]">
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <MapPin className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {order.address.name} {order.address.phone}
                <br />
                {order.address.province}
                {order.address.city}
                {order.address.district}
                {order.address.detail}
              </span>
            </p>
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <CreditCard className="size-3.5 shrink-0" />
              {PAYMENT_LABEL[order.payment]}
            </p>
          </div>

          <dl className="space-y-1 text-[12px]">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">商品原价合计</dt>
              <dd className="text-muted-foreground line-through">
                {formatPrice(order.originalSubtotal)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">商品现价合计</dt>
              <dd className="text-foreground">{formatPrice(order.subtotal)}</dd>
            </div>
            {order.coupon && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">优惠券 · {order.coupon}</dt>
                <dd className="text-success">-{formatPrice(order.discount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">运费</dt>
              <dd className="text-foreground">
                {order.shippingFee === 0 ? '包邮' : formatPrice(order.shippingFee)}
              </dd>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-1.5">
              <dt className="text-foreground">应付</dt>
              <dd className="text-[16px] font-semibold text-primary-ink">
                {formatPrice(order.total)}
              </dd>
            </div>
          </dl>
        </div>
      </ScrollArea>

      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <Button variant="secondary" disabled={resuming} onClick={onCancel}>
          取消
        </Button>
        <Button
          ref={confirmRef}
          className="ml-auto gap-1.5 transition-transform active:scale-[0.97]"
          disabled={resuming}
          onClick={onConfirm}
        >
          {resuming ? <Loader2 className="animate-spin" /> : <BadgeCheck />}
          {resuming ? '提交中…' : `确认下单 · ${formatPrice(order.total)}`}
        </Button>
      </div>
    </motion.div>
  );
}

function SuccessView({ order }: { order: Order }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="relative flex flex-col items-center gap-3 px-6 py-10 text-center"
    >
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18 }}
        className="flex size-14 items-center justify-center rounded-full bg-success-soft text-success"
      >
        <BadgeCheck className="size-7" />
      </motion.span>

      <h3 className="text-[16px] font-semibold text-foreground">下单成功</h3>
      <p className="text-[12.5px] text-muted-foreground">
        订单号 <span className="font-medium text-foreground">{order.id}</span>
      </p>

      <div className="w-full space-y-1.5 rounded-[var(--radius-md)] border border-border bg-surface-muted/50 p-3 text-left text-[12px]">
        <div className="flex justify-between">
          <span className="text-muted-foreground">商品</span>
          <span className="text-foreground">{order.items.length} 种</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">实付</span>
          <span className="font-semibold text-primary-ink">{formatPrice(order.total)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">收货地址</span>
          <span className="max-w-[62%] truncate text-foreground">
            {order.address.city}
            {order.address.district}
            {order.address.detail}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">状态</span>
          <Badge variant="success">已确认 · 待发货</Badge>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        演示环境不接入真实支付，订单仅用于展示 human-in-the-loop 中断恢复流程
      </p>
    </motion.div>
  );
}
