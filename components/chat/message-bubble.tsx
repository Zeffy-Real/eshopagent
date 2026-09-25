'use client';

import { memo, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { InlineProductCard } from '@/components/chat/inline-product-card';
import { Markdown } from '@/components/chat/markdown';
import { Logo } from '@/components/ui/logo';
import { Skeleton } from '@/components/ui/skeleton';
import { loadInlineProducts } from '@/lib/catalog/client-products';
import type { Product } from '@/lib/types';
import type { ChatMessage } from '@/store/use-agent-store';
import { cn } from '@/lib/utils';

export interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * 内联卡的加载占位：结构照抄 `InlineProductCard`（同一套 `p-2` + `size-11` + `gap-2.5`），
 * 因此高度一致——目录 chunk 到达前后不会发生布局跳动。
 */
function InlineCardSkeleton() {
  return (
    <div
      aria-hidden
      className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] border border-border bg-surface p-2"
    >
      <Skeleton className="size-11 shrink-0 rounded-[var(--radius-sm)]" />
      <span className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="block h-3.5 w-3/5 rounded" />
        <Skeleton className="block h-4 w-2/5 rounded" />
      </span>
    </div>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 对话气泡：用户右对齐、Agent 左对齐，Agent 侧支持 Markdown 与内联商品卡片 */
function MessageBubbleBase({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const idsKey = (message.productIds ?? []).join(',');
  /**
   * 内联卡的商品**按需解析**：目录模块在独立 chunk 里（客户端不再静态 import 全量目录，
   * 见 `lib/catalog/client-products.ts`）。`null` = 解析中（渲染同高占位）；
   * `[]` = 这条消息没有关联商品，或 chunk 加载失败——两种情况都只是不渲染卡片，不报错。
   */
  const [products, setProducts] = useState<Product[] | null>(null);

  useEffect(() => {
    if (idsKey === '') {
      setProducts([]);
      return;
    }
    let alive = true;
    void loadInlineProducts(idsKey.split(',')).then((list) => {
      if (alive) setProducts(list);
    });
    return () => {
      alive = false;
    };
  }, [idsKey]);

  const loading = products === null && idsKey !== '';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={cn('flex items-start gap-2', isUser && 'flex-row-reverse')}
    >
      {isUser ? (
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[11px] font-semibold text-muted-foreground">
          我
        </span>
      ) : (
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center">
          <Logo size={22} />
        </span>
      )}

      <div className={cn('flex min-w-0 max-w-[86%] flex-col gap-1.5', isUser && 'items-end')}>
        <div
          className={cn(
            'rounded-[var(--radius-bubble)] px-3 py-2',
            isUser
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-surface text-foreground',
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap text-[13px] leading-6">{message.content}</p>
          ) : (
            <>
              <Markdown content={message.content} />
              {message.streaming && (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[1px] bg-primary align-text-bottom" />
              )}
            </>
          )}
        </div>

        {message.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={message.imageUrl}
            alt="用户上传的参考图"
            className="size-16 rounded-[var(--radius-sm)] border border-border object-cover"
          />
        )}

        {loading && (
          <div className="w-full space-y-1.5">
            {idsKey.split(',').map((id) => (
              <InlineCardSkeleton key={id} />
            ))}
          </div>
        )}

        {products !== null && products.length > 0 && (
          <div className="w-full space-y-1.5">
            {products.map((product) => (
              <InlineProductCard key={product.id} product={product} />
            ))}
          </div>
        )}

        <span className="px-1 text-[10px] text-muted-foreground/80">
          {formatTime(message.createdAt)}
        </span>
      </div>
    </motion.div>
  );
}

export const MessageBubble = memo(MessageBubbleBase);
