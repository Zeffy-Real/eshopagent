'use client';

import { motion } from 'framer-motion';
import { NODE_LABEL } from '@/lib/agent/events';
import { cn } from '@/lib/utils';

export interface ThinkingIndicatorProps {
  /** 正在执行的节点名 */
  activeNodes: string[];
  className?: string;
}

/** 「思考中…」过渡动画：跳动圆点 + 当前节点文案 */
export function ThinkingIndicator({ activeNodes, className }: ThinkingIndicatorProps) {
  const current = activeNodes[activeNodes.length - 1];
  const label = current ? `${NODE_LABEL[current] ?? current}…` : '思考中…';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="flex items-end gap-0.5" aria-hidden>
        {[0, 1, 2].map((index) => (
          <motion.span
            key={index}
            className="size-1.5 rounded-full bg-primary"
            animate={{ y: [0, -3, 0], opacity: [0.45, 1, 0.45] }}
            transition={{
              duration: 0.9,
              repeat: Number.POSITIVE_INFINITY,
              delay: index * 0.14,
              ease: 'easeInOut',
            }}
          />
        ))}
      </span>
      <span className="text-[12px] text-muted-foreground" role="status">
        {label}
      </span>
    </div>
  );
}
