'use client';

import { memo } from 'react';
import { motion } from 'framer-motion';
import { InlineProductCard } from '@/components/chat/inline-product-card';
import { Markdown } from '@/components/chat/markdown';
import { Logo } from '@/components/ui/logo';
import { getProductById } from '@/lib/catalog/products';
import type { ChatMessage } from '@/store/use-agent-store';
import { cn } from '@/lib/utils';

export interface MessageBubbleProps {
  message: ChatMessage;
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
  const products = (message.productIds ?? [])
    .map((id) => getProductById(id))
    .filter((product) => product !== undefined);

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

        {products.length > 0 && (
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
