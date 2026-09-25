import type { Product } from '@/lib/types';

/**
 * 商品目录的**字段真实性分级**（唯一代码来源）。
 *
 * 为什么要写进代码：同一件事有三个地方要讲——README 的「哪些是真实数据」表、
 * 右栏「数据快照」面板、`docs/project-status.md` §4.3。三处手写必然漂移（历史上就出现过
 * 「声称销量是真实数据、实际是估算」这种元信息撒谎）。因此这里定义一次：
 *   - 面板**直接渲染**这份表；
 *   - README 与 project-status 只描述口径，并注明「以 `lib/catalog/field-truth.ts` 为准」。
 *
 * 分级语义：
 *   - `real`      源数据原样带来的字段，没有任何加工（价格仅按固定汇率折算展示币种）
 *   - `derived`   由真实信号计算出来的**派生值**——必须写明生成方式，界面不得冒充原始数据
 *   - `localized` 真实字段的展示语言被 LLM 译成中文（值本身仍是同一件商品）
 *   - `missing`   目录里没有、也**不编造**的字段
 */
export type FieldTruthLevel = 'real' | 'derived' | 'localized' | 'missing';

export interface FieldTruthRow {
  /** 字段名（界面与文档里显示的叫法） */
  field: string;
  level: FieldTruthLevel;
  /** 来源或生成方式；`derived` 必须写明怎么算出来的 */
  detail: string;
}

export const FIELD_TRUTH_LEVEL_LABEL: Record<FieldTruthLevel, string> = {
  real: '真实',
  derived: '派生',
  localized: '本地化',
  missing: '缺失',
};

/** 默认源（`real` 冻结快照）的字段分级。非 real 源在面板里只给一行指引，不另写一份表 */
export const FIELD_TRUTH: FieldTruthRow[] = [
  { field: '标题', level: 'localized', detail: '真实平台标题经 LLM 译为中文；英文原文保留在 nameOriginal' },
  { field: '品牌', level: 'real', detail: '源数据原样保留（本地化时品牌与型号不译）；图书来源该字段存的是作者' },
  { field: '类目', level: 'real', detail: '源数据类目路径按固定规则映射到本项目 7 品类，映射不到的整条丢弃' },
  { field: '价格', level: 'real', detail: '源数据原币种价格，按固定汇率表折算为人民币展示' },
  { field: '原价（划线价）', level: 'real', detail: '同上；源数据未提供更低原价时等于现价' },
  { field: '评分', level: 'real', detail: '源数据评分（5 分制）；缺失时记 0，界面显示「暂无评分」' },
  { field: '评论数', level: 'real', detail: '源数据评论数；缺失时记 0' },
  { field: '销量', level: 'real', detail: '只有部分平台有真实字段（覆盖率见上方实时计算值）；其余记 0，界面改展示评价数' },
  { field: '库存状态', level: 'real', detail: '源数据的「有货 / 缺货」信号（availability / is_available / in_stock）' },
  {
    field: '库存件数',
    level: 'derived',
    detail: '内部可用性模型：真实有货信号 + 商品 id 哈希派生 21–500；界面只展示等级，不展示件数',
  },
  { field: '图片', level: 'real', detail: '源数据原始图片链接（平台 CDN）' },
  {
    field: '描述',
    level: 'localized',
    detail:
      '源数据商品描述，LLM 译为中文并截断到 180 字；少数商品的源描述是亚马逊 A+ 页 CSS（不可用），已降级为派生文案（与图书简介同源规则）',
  },
  {
    field: '图书简介',
    level: 'derived',
    detail: '图书源的 description 是 A+ 页 CSS 不可用 → 由作者 / 类目 / 评分 / 可选版本 / 首次上架等真实字段拼装',
  },
  { field: '标签', level: 'derived', detail: '扫本地化后的标题 / 描述 / 规格派生功能词（图书用题材词表），最多 6 个' },
  { field: '规格', level: 'localized', detail: '键来自源数据，值经 LLM 译为中文；数字与型号原样保留' },
  { field: '商品 ID（ASIN / SKU）', level: 'real', detail: '源数据主键，未改动' },
  {
    field: '实时价格 / 实时库存',
    level: 'missing',
    detail: '快照是冻结数据、不含实时值；需要京东实时源（CATALOG_SOURCE=justoneapi，条件触发补充）',
  },
];

/** 各源的重建命令（面板里给「可复制的一条命令」，不提供按钮） */
export const REBUILD_COMMAND: Record<'real' | 'justoneapi' | 'mock', string | null> = {
  real: 'npm run catalog:build -- --per=60 && npm run catalog:localize',
  justoneapi: 'npm run catalog:build:justoneapi -- --per=4',
  mock: null,
};

export interface CoverageRow {
  label: string;
  /** 有真实值的件数 */
  covered: number;
  total: number;
  note: string;
}

/**
 * 覆盖率：从**当前目录数据**算出来，不写死任何数字（目录扩容后自动正确）。
 *
 * 纯函数——面板只渲染结果，单测可以独立断言「与数据一致」。
 */
export function computeCatalogCoverage(products: Product[]): CoverageRow[] {
  const total = products.length;
  return [
    {
      label: '销量',
      covered: products.filter((product) => product.sales > 0).length,
      total,
      note: '其余记 0，界面改展示评价数',
    },
    {
      label: '评分',
      covered: products.filter((product) => product.rating > 0).length,
      total,
      note: '缺失时界面显示「暂无评分」',
    },
    {
      label: '划线价',
      covered: products.filter((product) => product.originalPrice > product.price).length,
      total,
      note: '源数据未提供更低原价时等于现价',
    },
  ];
}

/** 平台分布：同样从数据算，不写死。没有 `platform` 字段的条目（内置 mock 数据）不计入，不编造来源 */
export function computePlatformCounts(products: Product[]): { platform: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const product of products) {
    const platform = product.platform?.trim();
    if (!platform) continue;
    counts.set(platform, (counts.get(platform) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count);
}