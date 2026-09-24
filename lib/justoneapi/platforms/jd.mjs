/**
 * 京东（jdcom）平台适配：端点、类目映射、字段换算。**唯一实现**。
 *
 * 构建期源（`scripts/sources/justoneapi.mjs`）与下一轮的运行时补充节点都用这一份，
 * 字段口径不允许出现第二个版本。
 *
 * 所有字段名与取值都来自真实响应（见 docs/justoneapi-design.md §15），不是文档猜测：
 *   - 搜索 `/api/jd/search-item-list/v1` → `data.products[]`（48 件/页）
 *   - 详情 `/api/jd/get-item-detail/v1` → `data.product` / `data.stock`
 *   - 价格 `/api/jd/get-item-price/v1` → `data.data[][].price`（**单位是分**）
 */

/** 只用同步 V1 端点；V2 是异步任务（提交后去 Dashboard 下载），本项目不接 */
export const JD_ENDPOINTS = {
  search: '/api/jd/search-item-list/v1',
  detail: '/api/jd/get-item-detail/v1',
  price: '/api/jd/get-item-price/v1',
};

/** 京东商品图的固定前缀：搜索端点的 `imageUrl` 是 `jfs/t1/...` 相对路径，详情端点直接给完整 URL */
const JD_IMAGE_PREFIX = 'https://img30.360buyimg.com/sku/';

/**
 * 京东一级类目（cid1）→ 项目 7 品类。
 *
 * **来源：实测**（每个键都对应用一次真实搜索的返回，括号里是关键词与样例）：
 *   652   数码   （蓝牙耳机 → 652/828/842「骨传导蓝牙耳机」）
 *   1315  服饰   （连衣裙   → 1315/1343/21443「针织连衣裙两件套」）
 *   1672  服饰   （连衣裙   → 1672/2615/9188「PS Paul Smith 女士连衣裙」，该 cid 下样本全是连衣裙）
 *   1316  美妆   （面膜     → 1316/1381/1392「海葡萄面膜」）
 *   1713  图书   （小说     → 1713/3258/3297「沂蒙山区农民与土地现实题材小说」）
 *   6196  家居   （保温杯   → 6196/6219/6223「陶瓷内胆保温杯」）
 *   1318  运动   （跑步鞋   → 1318/12099/9756「竞速训练碳板跑鞋」）
 *   36574 食品   （坚果     → 36574/36824/37169「每日纯坚果」）
 *
 * **刻意不映射 11729**（鞋子/鞋靴）：跑步鞋搜索里有一半商品属于 11729（如「海澜之家男鞋」），
 * 但项目 7 品类里没有「鞋靴」这一格，映射到「运动」会把正装皮鞋也算成运动鞋。
 * 宁可按「映射不到就丢弃」处理——丢弃原因会出现在构建统计里，可复核。
 */
const CID1_TO_CATEGORY = {
  652: '数码',
  1315: '服饰',
  1672: '服饰',
  1316: '美妆',
  1713: '图书',
  6196: '家居',
  1318: '运动',
  36574: '食品',
};

/**
 * 更细粒度的覆盖表：键可以是 `cid1,cid2,cid3` 或 `cid1,cid2`。
 * 目前为空——实测下来一级类目已经够用；留着是因为两级/三级细分真的需要时，
 * 只加一条表项即可，不必改查表逻辑。
 */
const CID_CHAIN_TO_CATEGORY = {};

/**
 * 京东类目链 → 项目品类。
 *
 * 查找顺序：三级链 → 二级链 → 一级类目；都查不到返回 null（调用方按「映射不到就丢弃」处理）。
 */
export function resolveJdCategory(cid1, cid2, cid3) {
  const chain3 = `${cid1},${cid2},${cid3}`;
  const chain2 = `${cid1},${cid2}`;
  const hit =
    CID_CHAIN_TO_CATEGORY[chain3] ??
    CID_CHAIN_TO_CATEGORY[chain2] ??
    CID1_TO_CATEGORY[String(cid1)];
  return hit ?? null;
}

/**
 * 搜索端点的价格：`"198.00"`（**元**，字符串）→ `198`。
 *
 * 实测：同一商品（100207440191）搜索给 `"198.00"`、价格端点给 `19800`（分），两者一致，
 * 说明搜索的 price 就是当前售价，不需要换算。
 */
export function parseJdPriceYuan(raw) {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 价格端点的价格：`19800`（**分**）→ `198`。
 *
 * 实测该接口只返回 `{ good_id, price }`，price 单位是分（19800 分 = 198.00 元，
 * 与搜索端点同一商品的展示价一致）。
 */
export function parseJdPriceFen(raw) {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value / 100 : null;
}

/**
 * 京东库存状态码（`data.stock.StockState`）→ 等级代表值。
 *
 * 枚举依据**京东官方开放平台文档**（opendoc.jd.com 库存接口的 stockStateId）：
 *   33 现货-下单立即发货 / 39 在途-内部配货 / 40 可配货 → 有货（40）
 *   36 预订                                          → 紧张（10）
 *   34 无货                                          → 缺货（0）
 * 实测样例：100207440191 → 33（有货）。
 *
 * 返回 `null` 表示「上游没给可用信号」——调用方**不要**据此判缺货，应沿用快照值或派生值。
 * 注意：编码值是**等级代表值，不是件数**（件数在真实源里从来拿不到，界面也从不展示）。
 */
const STOCK_STATE_TO_LEVEL = {
  33: 40,
  39: 40,
  40: 40,
  36: 10,
  34: 0,
};

export function encodeStockLevel(stockState) {
  const key = typeof stockState === 'number' ? stockState : Number.parseInt(String(stockState ?? ''), 10);
  if (!Number.isFinite(key)) return null;
  const level = STOCK_STATE_TO_LEVEL[key];
  return level === undefined ? null : level;
}

/** 搜索端点的相对图片路径 → 可直接渲染的绝对 URL；空值返回空串 */
export function toJdImageUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  if (/^https?:\/\//i.test(text)) return text;
  return `${JD_IMAGE_PREFIX}${text.replace(/^\/+/, '')}`;
}