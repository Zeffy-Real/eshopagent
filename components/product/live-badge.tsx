'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatLiveTime } from '@/lib/justoneapi/overrides';
import { cn } from '@/lib/utils';

/**
 * 「实时 · 14:32」标注。
 *
 * 只用在**确实被实时覆盖过**的字段旁（价格 / 对比表价格行），
 * 不是「这一轮查过实时数据」的全局标签——标注必须指向具体字段，
 * 否则用户会以为评分、库存件数也是实时的（它们不是：评分在京东端点里没有，
 * 件数从来是派生的且不展示）。
 *
 * 视觉沿用项目既有小控件语言：1px 实线边框 + 4px 圆角 + primary 系的浅底，
 * 不用模糊/阴影，不与价格本身的强调色抢层级。
 */
export function LiveBadge({ at, className }: { at: number | null | undefined; className?: string }) {
  const time = formatLiveTime(at);
  if (!time) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-[4px] border border-primary/35 bg-primary-soft px-1 py-px',
            'text-[10px] font-medium leading-4 text-primary-ink',
            className,
          )}
        >
          实时 · {time}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        该价格为 {time} 的京东实时查询结果；评分、销量、描述等字段仍来自快照数据
      </TooltipContent>
    </Tooltip>
  );
}