import { PRODUCTS } from '@/lib/catalog/products';
import {
  type AgentIntent,
  type Category,
  type SearchFilters,
  type SortKey,
} from '@/lib/types';

/* ============================================================
   规则解析器（LLM 不可用时的兜底路径）

   设计目标：没有 API Key 也能把「自然语言 → 筛选条件」跑通，
   且解析结果必须真的能命中商品，因此所有词表都从商品目录派生，
   避免出现「解析出关键词但库里没有对应商品」的空结果。
   ============================================================ */

/** 只取中文串做 n-gram：商品名里的数字/字母/空格（如「Q45」「1.8m」）不参与关键词 */
const CJK_RUN = /[\u4e00-\u9fa5]+/g;

/** 商品名称的中文 2 - 4 字 n-gram 集合：只把库里真实存在的词当关键词 */
const NAME_GRAMS: Set<string> = (() => {
  const grams = new Set<string>();
  for (const product of PRODUCTS) {
    for (const run of product.name.match(CJK_RUN) ?? []) {
      for (let length = 2; length <= 4; length += 1) {
        for (let i = 0; i + length <= run.length; i += 1) {
          grams.add(run.slice(i, i + length));
        }
      }
    }
  }
  return grams;
})();

/** 目录中真实存在的标签（长词优先，避免「降噪」抢先匹配「主动降噪」） */
const KNOWN_TAGS: string[] = Array.from(
  new Set(PRODUCTS.flatMap((product) => product.tags)),
).sort((a, b) => b.length - a.length);

const KNOWN_BRANDS: string[] = Array.from(
  new Set(PRODUCTS.map((product) => product.brand)),
).sort((a, b) => b.length - a.length);

/** 品类词表：命中后同时确定 category 与规范化关键词 */
const CATEGORY_TERMS: { term: string; category: Category; keyword?: string }[] = [
  { term: '跑鞋', category: '运动', keyword: '跑鞋' },
  { term: '运动鞋', category: '运动', keyword: '跑鞋' },
  { term: '鞋', category: '运动', keyword: '跑鞋' },
  { term: '瑜伽', category: '运动' },
  { term: '健身', category: '运动' },
  { term: '运动', category: '运动' },
  { term: '耳机', category: '数码', keyword: '耳机' },
  { term: '降噪', category: '数码', keyword: '耳机' },
  { term: '笔记本', category: '数码', keyword: '笔记本' },
  { term: '电脑', category: '数码', keyword: '笔记本' },
  { term: '键盘', category: '数码', keyword: '键盘' },
  { term: '充电器', category: '数码', keyword: '充电器' },
  { term: '平板', category: '数码', keyword: '平板' },
  { term: '相机', category: '数码', keyword: '相机' },
  { term: '数码', category: '数码' },
  { term: '外套', category: '服饰' },
  { term: '羽绒服', category: '服饰', keyword: '羽绒服' },
  { term: '冲锋衣', category: '服饰', keyword: '冲锋衣' },
  { term: 'T恤', category: '服饰', keyword: 'T 恤' },
  { term: '短袖', category: '服饰', keyword: 'T 恤' },
  { term: '牛仔裤', category: '服饰', keyword: '牛仔裤' },
  { term: '内裤', category: '服饰', keyword: '内裤' },
  { term: '内衣', category: '服饰', keyword: '内衣' },
  { term: '开衫', category: '服饰', keyword: '开衫' },
  { term: '衣服', category: '服饰' },
  { term: '坚果', category: '食品', keyword: '坚果' },
  { term: '牛奶', category: '食品', keyword: '牛奶' },
  { term: '酸奶', category: '食品', keyword: '酸奶' },
  { term: '咖啡', category: '食品', keyword: '咖啡' },
  { term: '大米', category: '食品', keyword: '大米' },
  { term: '零食', category: '食品' },
  { term: '四件套', category: '家居', keyword: '四件套' },
  { term: '床品', category: '家居', keyword: '四件套' },
  { term: '被芯', category: '家居', keyword: '被芯' },
  { term: '书桌', category: '家居', keyword: '书桌' },
  { term: '净化器', category: '家居', keyword: '净化器' },
  { term: '扫地机', category: '家居', keyword: '扫地机器人' },
  { term: '炒锅', category: '家居', keyword: '炒锅' },
  { term: '枕头', category: '家居', keyword: '枕' },
  { term: '精华', category: '美妆', keyword: '精华' },
  { term: '面霜', category: '美妆', keyword: '特护霜' },
  { term: '口红', category: '美妆', keyword: '口红' },
  { term: '粉饼', category: '美妆', keyword: '粉饼' },
  { term: '洁面', category: '美妆', keyword: '洁颜' },
  { term: '护肤', category: '美妆' },
  { term: '书', category: '图书' },
  { term: '图书', category: '图书' },
];

const INTENT_RULES: { intent: AgentIntent; patterns: RegExp[] }[] = [
  { intent: 'compare', patterns: [/对比|比较|哪个好|哪个更|哪款|区别|差异|帮我选/] },
  { intent: 'checkout', patterns: [/下单|结算|结账|付款|支付|提交订单|买下/] },
  {
    intent: 'cart',
    patterns: [
      /加入购物车|加购|购物车|删掉|删除|移除|清空/,
      /数量改成|改成\s*\d+\s*(件|个)|加一件|减一件/,
      /买这个|要这个|就要它|这个吧/,
    ],
  },
  {
    intent: 'refine',
    patterns: [
      /再(便宜|贵)点?|便宜点|贵一点|换一批|其他的|别的/,
      /还有(没有)?更|更(便宜|贵|好|轻|大|小)/,
      /价格(降|提高|调)|放宽|扩大范围/,
    ],
  },
  {
    intent: 'search',
    patterns: [/想买|要买|买一|推荐|找一|有没有|搜索|预算|以内|以下|左右|适合|求推荐/],
  },
];

export function guessIntentByRules(text: string): AgentIntent {
  const normalized = text.trim();
  if (!normalized) return 'chat';
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) return rule.intent;
  }
  return 'chat';
}

/** 关键词抽取：文本的中文 n-gram ∩ 商品名中文 n-gram，长词优先并去掉被包含的子串 */
function extractKeywords(text: string, exclude: Set<string>, limit = 2): string[] {
  const candidates: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let length = Math.min(4, run.length); length >= 2; length -= 1) {
      for (let i = 0; i + length <= run.length; i += 1) {
        const gram = run.slice(i, i + length);
        if (NAME_GRAMS.has(gram) && !exclude.has(gram)) candidates.push(gram);
      }
    }
  }

  const picked: string[] = [];
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    if (picked.some((word) => word.includes(candidate) || candidate.includes(word))) continue;
    picked.push(candidate);
  }
  return picked;
}

/** 价格区间解析：支持「500 以内」「预算 800」「2000 左右」「300 到 600」 */
export function parsePriceRange(text: string): {
  minPrice?: number;
  maxPrice?: number;
} {
  const range = text.match(/(\d{2,6})\s*(?:元|块)?\s*(?:-|~|～|—|到|至)\s*(\d{2,6})/);
  if (range?.[1] && range[2]) {
    const first = Number(range[1]);
    const second = Number(range[2]);
    return { minPrice: Math.min(first, second), maxPrice: Math.max(first, second) };
  }

  const around = text.match(/(\d{2,6})\s*(?:元|块)?\s*(?:左右|上下|附近|差不多)/);
  if (around?.[1]) {
    const base = Number(around[1]);
    return { minPrice: Math.round(base * 0.8), maxPrice: Math.round(base * 1.2) };
  }

  const max =
    text.match(/(?:预算|不超过|最多|低于|少于|控制在|封顶)\s*(?:在)?\s*(\d{2,6})/) ??
    text.match(/(\d{2,6})\s*(?:元|块|块钱)?\s*(?:以内|以下|之内)/);
  const min =
    text.match(/(?:不低于|至少|高于|起步)\s*(\d{2,6})/) ??
    text.match(/(\d{2,6})\s*(?:元|块|块钱)?\s*(?:以上|起)/);

  return {
    minPrice: min?.[1] ? Number(min[1]) : undefined,
    maxPrice: max?.[1] ? Number(max[1]) : undefined,
  };
}

export function detectSort(text: string): SortKey | undefined {
  if (/最便宜|价格最低|低价优先|便宜的优先/.test(text)) return 'price_asc';
  if (/最贵|价格最高|高端一点/.test(text)) return 'price_desc';
  if (/评分最高|口碑最好|好评|评价最好|评分优先/.test(text)) return 'rating';
  if (/销量最高|卖得最好|最热|热门|销量优先/.test(text)) return 'sales';
  return undefined;
}

/** 自然语言 → 结构化筛选条件（兜底路径，也是无 Key 时的主路径） */
export function extractFiltersByRules(text: string): SearchFilters {
  const normalized = text.trim();
  const tags = KNOWN_TAGS.filter((tag) => normalized.includes(tag));
  const brands = KNOWN_BRANDS.filter((brand) => normalized.includes(brand));

  const matchedTerms = CATEGORY_TERMS.filter((item) => normalized.includes(item.term)).sort(
    (a, b) => b.term.length - a.term.length,
  );
  const category = matchedTerms[0]?.category;
  const canonicalKeywords = matchedTerms
    .map((item) => item.keyword)
    .filter((keyword): keyword is string => Boolean(keyword));

  const exclude = new Set([...tags, ...brands]);
  // 合并「品类规范词」与「名称命中词」，并去掉被其他关键词包含的短词，
  // 避免 ['耳机', '降噪耳机'] 这类冗余导致 AND 匹配过严。
  const keywords = Array.from(
    new Set([...canonicalKeywords, ...extractKeywords(normalized, exclude)]),
  )
    .filter((word, _, all) => !all.some((other) => other !== word && other.includes(word)))
    .slice(0, 2);

  const ratingMatch = normalized.match(/(\d(?:\.\d)?)\s*分\s*(?:以上|起)/);
  const price = parsePriceRange(normalized);

  return {
    keywords: keywords.length > 0 ? keywords : undefined,
    category,
    tags: tags.length > 0 ? tags : undefined,
    brands: brands.length > 0 ? brands : undefined,
    minPrice: price.minPrice,
    maxPrice: price.maxPrice,
    minRating: ratingMatch?.[1] ? Number(ratingMatch[1]) : undefined,
    sort: detectSort(normalized),
    rawQuery: normalized,
  };
}

/** 细化场景：在原条件上做「更便宜 / 更轻 / 更高评分」的增量调整 */
export function relaxFilters(filters: SearchFilters, text: string): SearchFilters {
  const next: SearchFilters = { ...filters, rawQuery: text };

  if (/再(便宜|低)点?|便宜点|价格(降|低)|降低预算|超预算/.test(text)) {
    next.maxPrice = filters.maxPrice
      ? Math.round(filters.maxPrice * 0.7)
      : Math.round((filters.minPrice ?? 0) + 200);
  }
  if (/再(贵|高)点?|贵一点|提高预算|好一点的?/.test(text)) {
    next.maxPrice = filters.maxPrice ? Math.round(filters.maxPrice * 1.5) : undefined;
    next.minPrice = filters.minPrice ? Math.round(filters.minPrice * 1.2) : undefined;
  }
  if (/轻一点|更轻|轻量/.test(text)) {
    next.tags = Array.from(new Set([...(filters.tags ?? []), '轻量']));
  }
  if (/评分(高|更好)|口碑好|好评/.test(text)) {
    next.minRating = Math.max(filters.minRating ?? 0, 4.6);
  }
  if (/其他|别的|换一批/.test(text)) {
    next.keywords = undefined;
    next.maxPrice = filters.maxPrice;
  }
  return next;
}

/** 放宽条件：检索为空时逐步去掉最受限的条件，避免直接给出空结果 */
export function loosenFilters(filters: SearchFilters): SearchFilters {
  if (filters.tags?.length) return { ...filters, tags: undefined };
  if (filters.keywords?.length) return { ...filters, keywords: undefined };
  if (filters.maxPrice !== undefined) {
    return { ...filters, maxPrice: Math.round(filters.maxPrice * 1.5) };
  }
  if (filters.category) return { ...filters, category: undefined };
  return filters;
}

/** 把筛选条件渲染成一句可读描述（时间线 / 回复文案复用） */
export function describeFilters(filters: SearchFilters): string {
  const parts: string[] = [];
  if (filters.category) parts.push(filters.category);
  if (filters.keywords?.length) parts.push(filters.keywords.join(' '));
  if (filters.tags?.length) parts.push(filters.tags.join(' '));
  if (filters.brands?.length) parts.push(filters.brands.join(' '));
  if (filters.minPrice !== undefined && filters.maxPrice !== undefined) {
    parts.push(`¥${filters.minPrice} - ¥${filters.maxPrice}`);
  } else if (filters.maxPrice !== undefined) {
    parts.push(`¥${filters.maxPrice} 以内`);
  } else if (filters.minPrice !== undefined) {
    parts.push(`¥${filters.minPrice} 以上`);
  }
  if (filters.minRating !== undefined) parts.push(`${filters.minRating} 分以上`);
  return parts.length > 0 ? parts.join(' · ') : '全部商品';
}
