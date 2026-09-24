/** 全局领域模型定义（禁止 any） */

export const CATEGORIES = ['数码', '服饰', '食品', '家居', '运动', '美妆', '图书'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SORT_KEYS = [
  'relevance',
  'price_asc',
  'price_desc',
  'rating',
  'sales',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** 库存状态：有货 / 紧张 / 缺货 */
export type StockLevel = 'in_stock' | 'low' | 'out';

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: Category;
  /** 现价（元） */
  price: number;
  /** 划线原价（元） */
  originalPrice: number;
  /** 评分 0 - 5 */
  rating: number;
  /** 评价数 */
  reviews: number;
  /** 销量 */
  sales: number;
  /**
   * 库存件数（**内部可用性模型，不对外展示**）。
   *
   * 真实数据源里没有任何一件商品带真实库存件数（只有 Shopee 有 stock 字段，
   * 而当前目录已无 Shopee 商品），这里的值全部是构建期 `21 + hash % 480` 派生的。
   * 它只用于三个功能判断：是否缺货（不可加购）、加购数量上限、性价比的缺货惩罚。
   * 界面一律只展示「有货 / 库存紧张 / 缺货」等级，不展示件数。
   */
  stock: number;
  image: string;
  description: string;
  /** 核心参数（对比表格使用） */
  specifications: Record<string, string>;
  tags: string[];
}

export interface CartItem {
  product: Product;
  quantity: number;
}

/* ============================================================
   Agent 领域模型
   ============================================================ */

/** 意图分类：对应状态图中 parseIntent 的路由键 */
export type AgentIntent = 'search' | 'refine' | 'compare' | 'cart' | 'checkout' | 'chat';

export const INTENT_LABEL: Record<AgentIntent, string> = {
  search: '搜索商品',
  refine: '细化条件',
  compare: '商品对比',
  cart: '购物车操作',
  checkout: '下单结算',
  chat: '闲聊兜底',
};


/** 搜索筛选条件：parseIntent / refineSearch 写入，searchProducts 消费 */
export interface SearchFilters {
  /** 关键词（品类词、功能词、场景词） */
  keywords?: string[];
  category?: Category;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  brands?: string[];
  tags?: string[];
  sort?: SortKey;
  /** 触发本次筛选的原始自然语言，便于右栏回显 */
  rawQuery?: string;
}

/** 推理时间线条目：右栏「思考-行动-观察」面板的数据源 */
export type ToolLogKind = 'node' | 'tool' | 'decision';
export type ToolLogStatus = 'running' | 'done' | 'error';

export interface ToolLogEntry {
  id: string;
  kind: ToolLogKind;
  /** 节点名或工具名 */
  name: string;
  /** 时间线主文案，例如：正在搜索「跑鞋 · 500 元以内」 */
  title: string;
  /** 补充说明，例如：命中 12 件商品 */
  detail?: string;
  status: ToolLogStatus;
  /** 毫秒时间戳 */
  startedAt: number;
  finishedAt?: number;
}

export interface OrderAddress {
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
}

export type PaymentMethod = 'alipay' | 'wechat' | 'card';

export type OrderStatus = 'pending' | 'confirmed' | 'cancelled';

/** 订单（prepareOrder 生成草稿 → interrupt 确认 → confirmOrder 落单） */
export interface Order {
  id: string;
  items: CartItem[];
  address: OrderAddress;
  payment: PaymentMethod;
  /** 商品原价合计（划线价） */
  originalSubtotal: number;
  /** 商品现价合计 */
  subtotal: number;
  /** 优惠券抵扣金额 */
  discount: number;
  /** 运费 */
  shippingFee: number;
  /** 实付金额 = 现价合计 - 优惠 + 运费 */
  total: number;
  coupon?: string;
  /** ISO 时间字符串 */
  createdAt: string;
  status: OrderStatus;
}

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  card: '银行卡',
};

/** 优惠券（mock，用于展示「可用额度」与自动选券） */
export interface Coupon {
  code: string;
  title: string;
  /** 使用门槛（订单原价合计需达到该金额） */
  threshold: number;
  /** 抵扣金额 */
  amount: number;
  description: string;
}

/** 运费规则（mock） */
export const SHIPPING = {
  /** 满额包邮门槛 */
  freeThreshold: 99,
  /** 未达门槛时的运费 */
  fee: 12,
} as const;

/* ============================================================
   商品对比
   ============================================================ */

export interface ComparisonRow {
  /** 参数名，例如「价格」「评分」「鞋面材质」 */
  key: string;
  /** 与 products 顺序对齐的展示值，缺失为「—」 */
  values: string[];
  /** 是否差异项（各商品取值不完全相同） */
  diff: boolean;
  /** 表现更优的下标（价格最低 / 评分最高 / 销量最高 / 库存最多） */
  best: number[];
}

export interface ComparisonHighlights {
  lowestPriceId: string;
  highestRatingId: string;
  highestSalesId: string;
  mostStockId: string;
  /** 性价比最高（评分归一化 50% + 价格归一化 50%） */
  bestValueId: string;
}

export interface ComparisonResult {
  products: Product[];
  rows: ComparisonRow[];
  highlights: ComparisonHighlights;
  /** 每件商品的性价比得分（0 - 100），决策推荐面板的进度条数据源 */
  valueScores: Record<string, number>;
}

/** 购物车指令（manageCart 节点解析结果） */
export type CartActionKind = 'add' | 'update' | 'remove' | 'clear' | 'summary' | 'none';

export interface CartAction {
  action: CartActionKind;
  /** 目标商品 id（与 index 二选一） */
  productId?: string;
  /** 购物车中的序号，从 1 开始 */
  index?: number;
  quantity?: number;
  /** 解析依据，写入推理时间线 */
  reason?: string;
}

/** 决策推荐理由（右栏「决策推荐」面板） */
export interface DecisionReason {
  /** 例如「性价比最高」 */
  label: string;
  productId: string;
  productName: string;
  /** 0 - 100，用于进度条 */
  score: number;
  detail: string;
  tone: 'primary' | 'success' | 'warning' | 'neutral';
}


export function stockLevelOf(stock: number): StockLevel {
  if (stock <= 0) return 'out';
  if (stock <= 20) return 'low';
  return 'in_stock';
}

export const STOCK_LABEL: Record<StockLevel, string> = {
  in_stock: '有货',
  low: '库存紧张',
  out: '缺货',
};

/**
 * 库存等级的可比排序（0 = 最差）。
 *
 * 判断「哪件更可买」必须用等级，不能用件数：真实数据源里没有任何一件商品
 * 带真实库存件数（只有 Shopee 有 stock 字段，而目录已无 Shopee 商品），
 * 目录里的件数全部是 `21 + hash % 480` 派生的。用派生件数排序等于按哈希排序。
 */
export const STOCK_RANK: Record<StockLevel, number> = { out: 0, low: 1, in_stock: 2 };
