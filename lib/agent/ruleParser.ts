import { PRODUCTS } from '@/lib/catalog/products';
import {
  CATEGORIES,
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
  // 7 个品类名本身必须全部收录（上面已覆盖 运动 / 数码 / 图书，这里补齐其余 4 个）：
  // 品类 chip 发出的「帮我看看<品类>的商品」在无 Key 降级路径下全靠这张表 ——
  // 漏一个，那个品类的 chip 就是一个「点了没反应」的死按钮（2026-09-26 修）。
  { term: '服饰', category: '服饰' },
  { term: '食品', category: '食品' },
  { term: '家居', category: '家居' },
  { term: '美妆', category: '美妆' },
];

/** 7 个品类名（品类 chip 的入口消息依赖它触发 search，见下方 INTENT_RULES 末条） */
const CATEGORY_NAME_PATTERN = new RegExp(CATEGORIES.join('|'));

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
      // 序数 / 替换类指代：「换成第二件」「换成那个」「换个便宜的」「要第三个」。
      // 必须判为 refine：若落到 search，会丢掉上一轮的关键词，把检索范围放宽
      // （实测「换成第二件」曾把「图书·小说」放宽成「图书」，命中从 8 件涨到 15 件）。
      // 这里刻意不写裸 `/换成/`：「换成耳机」是明确的新目标，应走 search。
      /换成(?:那个|这个|它|第[一二三四五六七八九十\d]+)|换个|换一[个件款]|第[一二三四五六七八九十\d]+[件个款]/,
    ],
  },
  {
    intent: 'search',
    patterns: [/想买|要买|买一|推荐|找一|有没有|搜索|预算|以内|以下|左右|适合|求推荐/],
  },
  {
    // 7 个品类名本身也是「找商品」的明确信号（品类 chip 的入口消息就是「帮我看看<品类>的商品」）。
    // 刻意只认品类名，不加「看看 / 帮我」这类通用词——那会改变其他意图的判定；
    // 放在列表最后，让「对比 / 结算 / 加购 / 细化」这些更具体的意图优先命中。
    intent: 'search',
    patterns: [CATEGORY_NAME_PATTERN],
  },
];

/* ============================================================
   「看全部 / 清空条件」判据（2026-09-26）

   背景：判据原来只有「新目标 → 重置细分条件」与「否则 → 全量继承」两支，
   「用户要看全部商品」落在缝隙里 —— LLM 不回写时上一轮的「数码」照样残留。
   这一支只看**用户原话**（不读 LLM 输出、不读 filters），确定性不受 LLM 判定波动影响。
   词表只此一处，parseIntent（LLM 路径）与 guessIntentByRules（无 Key 路径）共用。
   ============================================================ */

/** 强触发：清空类动词，单出现即命中 */
const CLEAR_ALL_STRONG_TERMS = [
  '清空条件',
  '重置',
  '从头开始',
  '重新开始',
  '不限',
  '随便看看',
  '随便逛逛',
  '都行',
];

/** 弱触发-浏览动词（须与聚合词同时出现） */
const BROWSE_TERMS = ['看', '查看', '浏览', '逛逛', '显示', '列出'];

/** 弱触发-聚合词（「420 件」这类 3 - 4 位数字 + 件 用正则） */
const AGGREGATE_TERMS = ['全部', '所有', '整个目录'];
const AGGREGATE_COUNT = /\d{3,4}\s*件/;

/** 排除词：问数量 / 金额的句子是统计诉求，不是清空条件 */
const CLEAR_ALL_EXCLUSIONS = [
  '加起来',
  '多少钱',
  '总价',
  '一共',
  '合计',
  '平均',
  '统计',
  '共多少',
  '几件',
];

/**
 * 触发词自身构成的「伪点名」。
 *
 * 目录里有「适用于所有车辆」「适合所有肤质」这类商品名，n-gram 抽取会把
 * 「所有」认成关键词，于是「看看所有商品」被判成「点名了某个词」而漏掉清空。
 * 其余触发词一并纳入，避免同类误伤。
 */
function isTriggerVocabulary(word: string): boolean {
  return [...CLEAR_ALL_STRONG_TERMS, ...BROWSE_TERMS, ...AGGREGATE_TERMS].some((term) =>
    term.includes(word),
  );
}

/**
 * 「用户要看全部商品 / 清空条件」判据（纯函数，只看原话）。
 *
 * 命中 =（强触发 ∨ 浏览动词 + 聚合词）∧ 无排除词 ∧ 原话未点名任何东西。
 * 「点名」以规则解析器的产出为准（category / keywords / tags / brands），
 * 但剔除触发词自身的伪点名（见 isTriggerVocabulary）：
 * 「看看所有小说」因为点名了「小说」而**不**清空（走切换目标），
 * 「所有商品加起来多少钱」因为排除词而**不**清空。
 *
 * 已知限制（记录在案）：中文数字（「四百二十件」）不命中；
 * 字段级重置不支持 —— 「重置预算」「不限品牌」清空的是整份条件。
 */
export function detectClearAll(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (CLEAR_ALL_EXCLUSIONS.some((word) => normalized.includes(word))) return false;

  const named = extractFiltersByRules(normalized);
  const namesSomething =
    Boolean(named.category) ||
    (named.tags?.length ?? 0) > 0 ||
    (named.brands?.length ?? 0) > 0 ||
    (named.keywords ?? []).some((word) => !isTriggerVocabulary(word));
  if (namesSomething) return false;

  const strong = CLEAR_ALL_STRONG_TERMS.some((word) => normalized.includes(word));
  const weak =
    BROWSE_TERMS.some((word) => normalized.includes(word)) &&
    (AGGREGATE_TERMS.some((word) => normalized.includes(word)) ||
      AGGREGATE_COUNT.test(normalized));
  return strong || weak;
}

export function guessIntentByRules(text: string): AgentIntent {
  const normalized = text.trim();
  if (!normalized) return 'chat';
  // 清空类表达优先于其他规则：无 Key 的降级路径也必须能「看全部商品」——
  // 放在最前是因为「清空条件」会撞上加购词表里的「清空」；只接 detectClearAll
  // 这一个纯函数，不扩充通用词表（对比 / 结算 / 加购 / 细化的判定不受影响）。
  if (detectClearAll(normalized)) return 'search';
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
    // 触发词自身不算关键词（2026-09-26）：目录里有「适用于所有车辆」「适合所有肤质」这类
    // 商品名，n-gram 会把「所有」认成关键词 —— 它既不是用户的检索目标，又会让
    // 「所有商品加起来多少钱」被当成「点名了某个词」而误触发切目标重置。
    .filter((word) => !isTriggerVocabulary(word))
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

/** 中文数字 → 阿拉伯数字（序数只覆盖常见范围） */
const CN_ORDINAL: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/**
 * 从文本里提取序数指代（「第二件」「第 3 个」「换成第2款」），返回 1 起始的序号。
 *
 * 必须带「第」字前缀：不带前缀的「3 件」是数量而不是序数。
 * 越界或解析不出时返回 null，调用方按「没有序数指代」处理。
 */
export function parseOrdinalIndex(text: string): number | null {
  const match = text.match(/第\s*([0-9]{1,2}|[一二两三四五六七八九十])\s*[件个款本条款]/);
  const raw = match?.[1];
  if (!raw) return null;
  const index = /^[0-9]+$/.test(raw) ? Number(raw) : CN_ORDINAL[raw];
  if (index === undefined || index < 1 || index > 20) return null;
  return index;
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
  // 反向区间兜底（2026-09-26）：上面的乘法放宽没有上限保证 ——
  // 「¥100000 以上」再「再便宜点」会产出 minPrice ¥100000 > maxPrice ¥70140，
  // 区间反向时检索必然为空，界面上像「放宽反而清空」。clamp 成单点区间。
  if (
    next.minPrice !== undefined &&
    next.maxPrice !== undefined &&
    next.maxPrice < next.minPrice
  ) {
    next.maxPrice = next.minPrice;
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

/**
 * 把筛选条件渲染成一句可读描述（时间线 / 回复文案复用）。
 *
 * 跨列表去重（2026-09-25）：同一题材词可能同时落在 keywords 与 tags —— LLM 解析
 * 把「小说」当关键词、规则解析把它归题材标签，同一 thread 混合两种解析来源时
 * 合并结果里两份列表都有它，直接拼接就出现「图书 · 小说 · 小说」。
 * 这里按「首次出现」保序去重，**只清洗展示结果，不改 filters 本身**。
 *
 * 注意：本函数也被 refineSearch 当作「条件是否变化」的等价比对使用
 * （`nodes/refineSearch.ts`）。去重只让「同词重复」的写法在比较中被视为相等；
 * relaxFilters / loosenFilters 都不会把词在列表之间搬动（relax 只改价格/评分/追加标签，
 * loosen 只会整列删除），因此该比对语义不受影响。
 */
export function describeFilters(filters: SearchFilters): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  /** 列表内保序去重后仍按空格拼接成一组（组之间才是 ` · `，与原格式一致） */
  const renderWords = (words: string[] | undefined): void => {
    const kept = (words ?? []).filter((word) => {
      if (seen.has(word)) return false;
      seen.add(word);
      return true;
    });
    if (kept.length > 0) parts.push(kept.join(' '));
  };

  if (filters.category) {
    seen.add(filters.category);
    parts.push(filters.category);
  }
  renderWords(filters.keywords);
  renderWords(filters.tags);
  renderWords(filters.brands);
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
