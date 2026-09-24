import {
  BadgeCheck,
  Brain,
  ClipboardList,
  GitCompareArrows,
  Loader2,
  MessageSquareText,
  Receipt,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  Table2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToolLogEntry } from '@/lib/types';

const ICON_BY_NAME: Record<string, LucideIcon> = {
  parseIntent: Brain,
  search_products: Search,
  searchProducts: Search,
  refine_search: SlidersHorizontal,
  refineSearch: SlidersHorizontal,
  compare_products: Table2,
  compareProducts: Table2,
  add_to_cart: ShoppingCart,
  update_cart_item: ShoppingCart,
  remove_from_cart: ShoppingCart,
  clear_cart: ShoppingCart,
  manageCart: ShoppingCart,
  get_cart_summary: Receipt,
  create_order: ClipboardList,
  prepareOrder: ClipboardList,
  confirmOrder: BadgeCheck,
  generateReply: MessageSquareText,
};

/** 时间线条目图标：按工具名 / 节点名匹配，未命中用通用图标 */
export function iconForEntry(entry: ToolLogEntry): LucideIcon {
  return ICON_BY_NAME[entry.name] ?? GitCompareArrows;
}

export { Loader2 };
