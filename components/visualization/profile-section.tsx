'use client';

import { Award, Brain, CircleDollarSign, Search, Tag, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  PROFILE_SOURCE_LABEL,
  brandScores,
  categoryScores,
  hasProfileSignals,
  type ProfileSignalSource,
} from '@/lib/profile';
import { useAgentStore } from '@/store/use-agent-store';
import { formatPrice } from '@/lib/utils';

/** 来源标记的视觉分级：成交 > 加购 > 浏览 */
const SOURCE_VARIANT: Record<ProfileSignalSource, 'success' | 'primary' | 'neutral'> = {
  order: 'success',
  cart: 'primary',
  browse: 'neutral',
};

/** 最近搜索最多展示的条数（完整列表仍在 localStorage 里，最多 RECENT_SEARCH_LIMIT 条） */
const RECENT_SHOWN = 6;

/**
 * 跨会话画像面板：偏好的**查看入口**与**清除入口**。
 *
 * 每一项都标注来源（浏览 / 加购 / 成交），保证「画像可追溯到真实行为」；
 * 清空按钮自增 generation，使在途 patch 失效（见 lib/profile.ts）。
 */
export function ProfileSection() {
  const userProfile = useAgentStore((s) => s.userProfile);
  const clearUserProfile = useAgentStore((s) => s.clearUserProfile);

  if (!hasProfileSignals(userProfile)) {
    return (
      <EmptyState
        compact
        icon={Brain}
        title="还没有偏好记录"
        description="搜索、加购、下单后，会按真实行为在这里累积品类、品牌与价位。"
      />
    );
  }

  const categories = categoryScores(userProfile);
  const brands = brandScores(userProfile);

  return (
    <div className="space-y-2.5">
      {categories.length > 0 && (
        <ProfileGroup icon={Tag} title="常看品类">
          {categories.slice(0, 4).map((item) => (
            <li key={item.value} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[12px] text-foreground">{item.value}</span>
              <Badge variant={SOURCE_VARIANT[item.source]}>{PROFILE_SOURCE_LABEL[item.source]}</Badge>
            </li>
          ))}
        </ProfileGroup>
      )}

      {brands.length > 0 && (
        <ProfileGroup icon={Award} title="关注品牌">
          {brands.slice(0, 4).map((item) => (
            <li key={item.value} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[12px] text-foreground">{item.value}</span>
              <Badge variant={SOURCE_VARIANT[item.source]}>{PROFILE_SOURCE_LABEL[item.source]}</Badge>
            </li>
          ))}
        </ProfileGroup>
      )}

      {userProfile.recentSearches.length > 0 && (
        <ProfileGroup icon={Search} title="最近搜索">
          <li className="flex flex-wrap gap-1">
            {userProfile.recentSearches.slice(0, RECENT_SHOWN).map((item) => (
              <Badge key={item} variant="outline">
                {item}
              </Badge>
            ))}
          </li>
        </ProfileGroup>
      )}

      {userProfile.priceRange && (
        <ProfileGroup icon={CircleDollarSign} title="关注的价位带">
          <li className="flex items-center justify-between gap-2 text-[12px]">
            <span className="text-foreground">价格区间</span>
            <span className="tabular-nums text-muted-foreground">
              {formatPrice(userProfile.priceRange.min)} - {formatPrice(userProfile.priceRange.max)}
            </span>
          </li>
        </ProfileGroup>
      )}

      <div className="space-y-1.5 border-t border-border pt-2.5">
        <Button variant="secondary" size="sm" className="w-full gap-1.5" onClick={clearUserProfile}>
          <Trash2 />
          清除画像
        </Button>
        <p className="text-[11px] leading-4 text-muted-foreground">
          画像保存在本机浏览器（无账号、不同步到其它设备）；对话时会作为上下文发送给所配置的模型服务商。
        </p>
      </div>
    </div>
  );
}

function ProfileGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className="size-3 shrink-0" />
        {title}
      </p>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}