'use client';

import {
  Brain,
  ChevronRight,
  Database,
  ListTree,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Target,
} from 'lucide-react';
import { PanelHeader } from '@/components/common/panel-header';
import { PanelSection } from '@/components/common/panel-section';
import { CartSection } from '@/components/visualization/cart-section';
import { CatalogSection } from '@/components/visualization/catalog-section';
import { CompareSection } from '@/components/visualization/compare-section';
import { DecisionSection } from '@/components/visualization/decision-section';
import { IntentSection } from '@/components/visualization/intent-section';
import { ProfileSection } from '@/components/visualization/profile-section';
import { TimelineSection } from '@/components/visualization/timeline-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { selectCartCount, useCartStore } from '@/store/use-cart-store';
import { useUiStore } from '@/store/use-ui-store';

/**
 * Agent 操作可视化面板（右栏）。
 *
 * 七段内容：推理时间线（node/tool 事件）、意图解析（searchFilters）、
 * 对比分析（comparison）、决策推荐（comparison 派生）、购物车（cart）、
 * 你的偏好（localStorage 里的跨会话画像，同一浏览器下有效）、
 * 数据快照（商品目录的来源 / 规模 / 字段真实性分级，**只读**，与中栏徽标同一口径）。
 */
export function AgentPanel() {
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);
  const cartCount = useCartStore(selectCartCount);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={Sparkles}
        title="Agent 工作台"
        subtitle="思考 · 行动 · 观察"
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="收起面板"
                onClick={() => setRightPanelOpen(false)}
              >
                <ChevronRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>收起面板</TooltipContent>
          </Tooltip>
        }
      />

      <ScrollArea className="min-h-0 flex-1">
        {/* 窄屏下输入区被提到抽屉之上（z-50），会遮住抽屉底部，这里留出等高的内边距，
            否则最后一段面板内容会被永久挡住 */}
        <div className="space-y-3 p-3 pb-28 md:pb-3">
          <PanelSection icon={ListTree} title="推理时间线">
            <TimelineSection />
          </PanelSection>

          <PanelSection icon={SlidersHorizontal} title="意图解析">
            <IntentSection />
          </PanelSection>

          <PanelSection icon={Table2} title="对比分析">
            <CompareSection />
          </PanelSection>

          <PanelSection icon={Target} title="决策推荐">
            <DecisionSection />
          </PanelSection>

          <PanelSection
            icon={ShoppingCart}
            title="购物车"
            meta={
              cartCount > 0 ? (
                <Badge variant="primary" className="tabular-nums">
                  {cartCount}
                </Badge>
              ) : null
            }
          >
            <CartSection />
          </PanelSection>

          <PanelSection icon={Brain} title="你的偏好">
            <ProfileSection />
          </PanelSection>

          {/* 数据快照放在最后：它是「关于这份数据」的静态说明，不是当轮推理的一部分 */}
          <PanelSection icon={Database} title="数据快照">
            <CatalogSection />
          </PanelSection>
        </div>
      </ScrollArea>
    </div>
  );
}
