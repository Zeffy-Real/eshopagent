import type { RunnableConfig } from '@langchain/core/runnables';
import {
  CATEGORIES,
  type CartItem,
  type Category,
  type Product,
  type SearchFilters,
} from '@/lib/types';

/**
 * 结构化用户画像（**同一浏览器下的**跨会话记忆）。
 *
 * 设计约束（与 docs/memory-plan.md §3.3 对齐）：
 *
 * 1. **只记录真实行为产生的信号**：搜索 / 加购 / 成交。没有任何行为就不产出任何字段 ——
 *    凭空生成偏好与「派生库存冒充真实库存」是同一类问题，会击穿数据真实性这条卖点。
 * 2. **不用向量库 / embedding**：112 件结构化商品的偏好用「品类 + 品牌 + 关键词 + 价位」
 *    已经够用；引入 embedding 会再次依赖外部 API，破坏「没有 Key 也能跑」这条基线。
 * 3. **存储只有一处**：浏览器 localStorage。服务端不持有画像 —— 请求上行时把画像放进
 *    `config.configurable`（只活在本次请求内）供 prompt 使用，用完即弃，不落 checkpoint。
 * 4. **合并必须幂等**：一轮里每个节点结束都会推一次快照（同一份 patch 被推多次），
 *    interrupt 恢复轮还会把上一轮的 patch 再带一遍。因此分值取「最高行为权重」（max）
 *    而不是累加 —— 累加会让同一份 patch 被推几次就翻几倍。
 */

/** 画像信号来源：权重递增（成交 > 加购 > 浏览） */
export type ProfileSignalSource = 'browse' | 'cart' | 'order';

export const PROFILE_WEIGHT: Record<ProfileSignalSource, number> = {
  browse: 1,
  cart: 3,
  order: 5,
};

/** 面板展示用的来源名 */
export const PROFILE_SOURCE_LABEL: Record<ProfileSignalSource, string> = {
  browse: '浏览',
  cart: '加购',
  order: '成交',
};

/** 提示语里的动作词：「注意到你之前常看图书」 */
const PROFILE_ACTION_LABEL: Record<ProfileSignalSource, string> = {
  browse: '常看',
  cart: '加购过',
  order: '买过',
};

/** 最近搜索最多保留的条数 */
export const RECENT_SEARCH_LIMIT = 10;
/** 单个检索词的最大长度（超长的多半是整句话，不适合当作偏好词） */
export const KEYWORD_MAX_CHARS = 12;
/** 品牌名的最大长度（渲染与校验共用，防超长字符串塞进 prompt） */
export const BRAND_MAX_CHARS = 40;

export type ProfileSignal =
  | { kind: 'category'; value: Category; source: ProfileSignalSource }
  | { kind: 'brand'; value: string; source: ProfileSignalSource }
  | { kind: 'keyword'; value: string; source: ProfileSignalSource }
  | { kind: 'price'; value: number; source: ProfileSignalSource };

export interface UserProfile {
  /** 每次「清除画像」自增：前端据此丢弃携带旧 generation 的在途 patch */
  generation: number;
  /** 最近搜索（去重、最新在前、最多 RECENT_SEARCH_LIMIT 条） */
  recentSearches: string[];
  /** 品类偏好：分值 = 该品类上观察到的最高行为权重（见文件头第 4 条） */
  preferredCategories: Partial<Record<Category, number>>;
  /** 品牌偏好：同品类，只有加购 / 成交才会产生 */
  brands: Record<string, number>;
  /** 关注的价位带：所有观察到的价格取并集（min 取下界、max 取上界） */
  priceRange: { min: number; max: number } | null;
}

/**
 * 能产生画像信号的真实行为。
 *
 * 刻意只接受这三类对象：调用方必须先把行为落到具体的商品 / 条件上，
 * 无法构造行为就没有信号 —— 这是「不凭空生成」在类型层面的保证。
 */
export type ProfileBehavior =
  | { kind: 'search'; filters: SearchFilters; hits: Product[] }
  | { kind: 'cart'; product: Product }
  | { kind: 'order'; items: CartItem[] };

export function createEmptyProfile(generation = 0): UserProfile {
  return {
    generation,
    recentSearches: [],
    preferredCategories: {},
    brands: {},
    priceRange: null,
  };
}

/** 一键清空：generation 自增，让清除之前发出的在途 patch 失效 */
export function clearProfile(profile: UserProfile): UserProfile {
  return createEmptyProfile(profile.generation + 1);
}

export function hasProfileSignals(profile: UserProfile): boolean {
  return (
    profile.recentSearches.length > 0 ||
    Object.keys(profile.preferredCategories).length > 0 ||
    Object.keys(profile.brands).length > 0 ||
    profile.priceRange !== null
  );
}

/** 分值 → 来源（分值是「最高权重」，因此可以反查） */
export function sourceOfScore(score: number): ProfileSignalSource {
  if (score >= PROFILE_WEIGHT.order) return 'order';
  if (score >= PROFILE_WEIGHT.cart) return 'cart';
  return 'browse';
}

/* ============================================================
   信号提取（纯函数：输入真实行为，输出本轮信号）
   ============================================================ */

/** 检索结果同属一个品类才认为用户聚焦了它；混品类说明还没聚焦，不替他总结 */
function uniformCategory(hits: Product[]): Category | null {
  const first = hits[0];
  if (!first) return null;
  return hits.every((hit) => hit.category === first.category) ? first.category : null;
}

function searchSignals(filters: SearchFilters, hits: Product[]): ProfileSignal[] {
  const signals: ProfileSignal[] = [];

  // 关键词：最多取 2 个（一条输入塞满「最近搜索」没有信息量）
  for (const keyword of (filters.keywords ?? []).slice(0, 2)) {
    const value = keyword.trim();
    if (value && value.length <= KEYWORD_MAX_CHARS) {
      signals.push({ kind: 'keyword', value, source: 'browse' });
    }
  }

  // 品类：优先用解析出的品类；没有时看检索结果（结果全部同品类才算）
  const category = filters.category ?? uniformCategory(hits);
  if (category) signals.push({ kind: 'category', value: category, source: 'browse' });

  // 价格：只取用户显式给出的上下界。商品价格属于「结果」，不属于用户的表达，
  // 用它反推会产生噪声（搜「图书」不代表用户偏好 ¥39）。
  if (typeof filters.minPrice === 'number') {
    signals.push({ kind: 'price', value: filters.minPrice, source: 'browse' });
  }
  if (typeof filters.maxPrice === 'number') {
    signals.push({ kind: 'price', value: filters.maxPrice, source: 'browse' });
  }

  return signals;
}

/** 加购 / 成交：信号直接来自被操作的那件真实商品 */
function productSignals(product: Product, source: ProfileSignalSource): ProfileSignal[] {
  return [
    { kind: 'category', value: product.category, source },
    { kind: 'brand', value: product.brand, source },
    { kind: 'price', value: product.price, source },
  ];
}

export function extractProfileSignals(behavior: ProfileBehavior): ProfileSignal[] {
  switch (behavior.kind) {
    case 'search':
      return searchSignals(behavior.filters, behavior.hits);
    case 'cart':
      return productSignals(behavior.product, 'cart');
    case 'order':
      return behavior.items.flatMap((item) => productSignals(item.product, 'order'));
  }
}

/* ============================================================
   合并（幂等）
   ============================================================ */

/**
 * 把本轮信号合并进画像。
 *
 * 幂等保证：完全相同的 patch 应用第二次时，每一项都判定为「没有变化」，
 * 返回的是**同一个对象引用** —— 前端据此跳过无意义的写入与重渲染。
 */
export function mergeProfile(profile: UserProfile, patch: ProfileSignal[]): UserProfile {
  if (patch.length === 0) return profile;

  let recentSearches = profile.recentSearches;
  const preferredCategories = { ...profile.preferredCategories };
  const brands = { ...profile.brands };
  let priceRange = profile.priceRange;
  let changed = false;

  for (const signal of patch) {
    const weight = PROFILE_WEIGHT[signal.source];

    switch (signal.kind) {
      case 'category': {
        if (weight > (preferredCategories[signal.value] ?? 0)) {
          preferredCategories[signal.value] = weight;
          changed = true;
        }
        break;
      }

      case 'brand': {
        if (weight > (brands[signal.value] ?? 0)) {
          brands[signal.value] = weight;
          changed = true;
        }
        break;
      }

      case 'keyword': {
        const value = signal.value.trim();
        if (!value || value.length > KEYWORD_MAX_CHARS) break;
        // 已经在最前 → 重复应用不再产生变化（幂等的关键分支）
        if (recentSearches[0] === value) break;
        recentSearches = [value, ...recentSearches.filter((item) => item !== value)].slice(
          0,
          RECENT_SEARCH_LIMIT,
        );
        changed = true;
        break;
      }

      case 'price': {
        const value = signal.value;
        if (!Number.isFinite(value) || value <= 0) break;
        const next = priceRange
          ? { min: Math.min(priceRange.min, value), max: Math.max(priceRange.max, value) }
          : { min: value, max: value };
        if (!priceRange || next.min !== priceRange.min || next.max !== priceRange.max) {
          priceRange = next;
          changed = true;
        }
        break;
      }
    }
  }

  if (!changed) return profile;
  return {
    generation: profile.generation,
    recentSearches,
    preferredCategories,
    brands,
    priceRange,
  };
}

/**
 * 应用快照里的 patch：generation 不一致说明这份 patch 发出于「清除画像」之前，直接丢弃。
 *
 * 这是清除竞态的主防线（abort 在途请求是双保险）：清除后 generation 自增，
 * 任何旧请求携带的 patch 都过不了这道校验。
 */
export function applyProfilePatch(
  profile: UserProfile,
  patch: ProfileSignal[],
  generation: number,
): UserProfile {
  if (generation !== profile.generation) return profile;
  return mergeProfile(profile, patch);
}

/* ============================================================
   展示与提示（面板 / prompt / 模板回复共用）
   ============================================================ */

export interface ProfileScore<T> {
  value: T;
  score: number;
  source: ProfileSignalSource;
}

/**
 * 品类分量（降序）。
 *
 * 先按 CATEGORIES 过滤一遍：localStorage 是可被用户改写的，非目录品类不进画像展示，
 * 也不会被渲染进 prompt。
 */
export function categoryScores(profile: UserProfile): ProfileScore<Category>[] {
  return CATEGORIES.map((category) => ({
    value: category,
    score: profile.preferredCategories[category] ?? 0,
  }))
    .filter((item) => item.score > 0)
    .map((item) => ({ ...item, source: sourceOfScore(item.score) }))
    .sort((a, b) => b.score - a.score || CATEGORIES.indexOf(a.value) - CATEGORIES.indexOf(b.value));
}

/** 品牌分量（降序；同分按名称排序，保证展示顺序稳定） */
export function brandScores(profile: UserProfile): ProfileScore<string>[] {
  return Object.entries(profile.brands)
    .filter(([brand, score]) => brand.trim().length > 0 && brand.length <= BRAND_MAX_CHARS && score > 0)
    .map(([brand, score]) => ({ value: brand, score, source: sourceOfScore(score) }))
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
}

export interface ProfileRecall {
  /** 用于展示的标签，例如「图书」「Apple」 */
  label: string;
  source: ProfileSignalSource;
}

/**
 * 画像里最强的那条信号（品类优先，其次品牌）。
 *
 * 「记忆事件」与「回复里的偏好提示」共用这一处判定，避免两处各写一套排序规则。
 */
export function profileRecall(profile: UserProfile): ProfileRecall | null {
  const category = categoryScores(profile)[0];
  if (category) return { label: category.value, source: category.source };
  const brand = brandScores(profile)[0];
  if (brand) return { label: brand.value, source: brand.source };
  return null;
}

/** 由一条召回目标生成提示语（画像面板之外的所有出口共用这一处文案规则） */
export function profileHintOf(recall: ProfileRecall): string {
  return `注意到你之前${PROFILE_ACTION_LABEL[recall.source]}${recall.label}，需要我按这个方向再找找吗？`;
}

/** 规则路径要展示给用户的那句话（空串 = 没有可用偏好，不要硬提） */
export function buildProfileHint(profile: UserProfile): string {
  const recall = profileRecall(profile);
  return recall ? profileHintOf(recall) : '';
}

/**
 * 注入 prompt 的画像摘要（纯文本行，不含任何 ID、联系方式、地址）。
 *
 * 隐私边界：这些内容会随 prompt 发往所配置的 LLM 服务商，
 * 因此只给偏好本身，且长度有上限。
 */
export function profileSummaryLines(profile: UserProfile): string[] {
  const lines: string[] = [];

  const categories = categoryScores(profile).slice(0, 3);
  if (categories.length > 0) {
    lines.push(
      `常看品类：${categories
        .map((item) => `${item.value}（${PROFILE_ACTION_LABEL[item.source]}）`)
        .join('、')}`,
    );
  }

  const brands = brandScores(profile).slice(0, 3);
  if (brands.length > 0) {
    lines.push(
      `关注品牌：${brands
        .map((item) => `${item.value}（${PROFILE_ACTION_LABEL[item.source]}）`)
        .join('、')}`,
    );
  }

  if (profile.recentSearches.length > 0) {
    lines.push(`最近搜索：${profile.recentSearches.slice(0, 5).join('、')}`);
  }

  if (profile.priceRange) {
    lines.push(`关注的价位带：¥${profile.priceRange.min} - ¥${profile.priceRange.max}`);
  }

  return lines;
}

/* ============================================================
   请求期透传
   ============================================================ */

/**
 * 从 RunnableConfig 读客户端随请求上行的画像。
 *
 * 为什么走 config 而不是 state：state 会被写进服务端 checkpoint（SQLite 文件），
 * 画像内容会因此落盘到服务器；config.configurable 只活在本次请求内，
 * 用完即弃 —— localStorage 始终是画像的唯一存储。
 *
 * 取值前由路由层用 zod 校验过请求体，这里只做最低限度的形状判断。
 */
export function profileFromConfig(config?: RunnableConfig): UserProfile | null {
  const raw: unknown = config?.configurable?.profile;
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<UserProfile>;
  if (typeof candidate.generation !== 'number') return null;
  if (!Array.isArray(candidate.recentSearches)) return null;
  return candidate as UserProfile;
}