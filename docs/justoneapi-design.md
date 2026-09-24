# JustOneAPI 数据源接入设计（阶段设计评审稿）

> 状态：**待评审**。本文只做设计，不含实现代码。
> 依据：`lib/catalog/products.ts`、`lib/types.ts`、`scripts/build-real-catalog.mjs`、`scripts/localize-catalog.mjs`、`docs/project-status.md` §4（全部已读）。
> 实测记录见 §11；**尚未完成的实测项（需要你的 token）见 §11.2**——字段映射表里凡标注「待实测」的单元格，都必须在拿到 token 后回填，否则不进入 2a。

---

## 0. 决策摘要

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | 接入定位 | **两者都有**：构建期 `--source=justoneapi` 可选源 + **运行时做成图内条件触发节点 `enrichLiveData`**（v2 裁定，见 §14） |
| 2 | 先接平台 | **京东（jdcom）**——实测选定（字段覆盖更高、且只有它能拿到库存状态，理由见 §2）；Amazon 明确放第二批 |
| 3 | sales | **一律 `sales: 0`**——实测京东 `sales`/`monthSales` 全为空串、淘宝 `orderPayUV` 是区间文案（`"1万+"`），不映射（§4.1） |
| 4 | stock | **只映射状态，不映射件数**：京东详情 `stock.StockState` → 等级代表值（0 / 10 / 40），界面继续只显示等级（§4.2） |
| 5 | 币种 | 复用 `CURRENCY_TO_CNY`；未覆盖币种**按现有策略跳过**（运行时不报错，静默回退快照）。选定的京东是 CNY，本批不触发汇率路径 |
| 6 | 缓存 | 服务端内存 `Map`，TTL **300 秒**，键 `${platform}:${id}`，**含单飞去重**；失败不缓存；**只缓存映射结果（约 0.5 KB/件），不缓存原始响应（京东详情实测 40 KB/件）** |
| 7 | 错误处理 | 契约内 9 个错误码逐个定义（§7）+ 未知码/传输层/token 缺失，共 12 类失败；**任何 HTTP 状态下都先解析响应体**（实测：无效 token 返回 HTTP 401 + `code:100`；配额用尽返回 HTTP 429 + `code:303`）。官方 OpenAPI 的 code 枚举实际有 **15 个**（多出 101/202/300/404/503），处理方式见 §15.1 |
| 8 | Token | 只读 `process.env.JUSTONEAPI_TOKEN`；`.env.example` 加空占位符；`.gitignore` 已核对（`.env` / `.env.local` / `.env*.local` 均被忽略，`.env.example` 保持可提交）；**请在写代码前轮换一次**（§8） |
| 9 | 与现有源关系 | `CATALOG_SOURCE` 增加 `justoneapi` 分支，**`real` 仍是默认**；三源产物互相独立、互不覆盖 |
| 10 | 演示安全 | JustOneAPI **不在演示主路径**；未配置 token 时该源完全不可用且**对现有功能零影响** |
| 11 | 运行时补充的适用商品 | **只在商品 id 可解析为平台 id 时生效**（默认快照是 Amazon ASIN，无法用京东端点查询）——三选一待裁定，见 §15.3 |

**一处必须先纠正的前提**：你要求「必须复用现有的 staging → 校验 → 原子替换流程」——**该流程在当前仓库里不存在**。`scripts/build-real-catalog.mjs` 的实际做法是：逐行归一化 → 按 `skip` 原因丢弃不合格行 → 分品类取 Top N → **直接 `writeFile` 覆盖 `data/real-catalog.json`**（`build-real-catalog.mjs:834`）。现有真正的「校验」有两处可复用：构建期的按行丢弃 + `lib/catalog/products.ts` 的 `isProductLike()`（运行时逐字段校验，`products.ts:48-69`）。因此本设计的处理方式是：**JustOneAPI 源复用 `isProductLike()` 的校验语义（构建期写盘前也跑一遍），产物写独立文件**，从而根本不需要"原子替换"去保护现有快照；若你仍要原子写，那是新增 3 行（`writeFile(tmp)` + `rename`），不是复用。

---

## 1. 接入定位：构建期（**已交付**）+ 运行时（**待下一步：节点接入**）

| | 构建期 | 运行时（**待下一步实现，见 §14**） |
| --- | --- | --- |
| 状态 | **已交付**（`npm run catalog:build:justoneapi`，见 §12） | **未实现**：第 2 步做图内节点 `enrichLiveData` |
| 触发 | 人工执行 | 图里的条件边按需触发（token 已配置 / 结果非空 / 命中实时性关键词 / 60 秒冷却 / 未熔断 / **id 可解析为平台 id**） |
| 产物 | `data/justoneapi-catalog.json`（独立文件，**不覆盖** `real-catalog.json`） | 无产物，只写状态字段 `liveOverrides` |
| 调用量 | 一次构建 = 每品类 2 次搜索（7 品类共 14 次）+ 每件保留商品的 1 次详情 | 单轮最多 3 件，同一商品 5 分钟内最多 1 次（缓存 + 单飞） |
| 失败语义 | 单条失败丢弃并计数；配额/余额/token 类失败**中止构建**并保留上一版产物 | **完全静默**，只在右栏时间线留一条中性记录 |

**为什么两者都要**：HF 快照是冻结数据（不可刷新），但它保证了演示可复现与零配额消耗；JustOneAPI 的价值是「某个商品**现在**多少钱、还有没有货」，这只能是运行时按需拉取——构建期全量刷新既烧配额，也会把「可复现基线」弄丢。

**运行时形态由 §14 裁定（v2）**：不做图之外的独立函数，改成图里的**条件触发补充节点** `enrichLiveData`。执行顺序在 §15.3 调整为「**先构建期源、再节点接入**」——默认 `real` 源下商品 id 全是 Amazon ASIN，节点没有可拉取的目标，先做节点等于做一个无法演示的功能。

---

## 2. 平台选择：先 1 个 → **实测结论：京东（jdcom）**（2026-09-25 回填）

| 平台 | 端点（同步 V1） | 币种 | 结论 |
| --- | --- | --- | --- |
| 京东 | 搜索 `/api/jd/search-item-list/v1`、详情 `/api/jd/get-item-detail/v1`、价格 `/api/jd/get-item-price/v1` | CNY | **选定** |
| 淘宝/天猫 | 搜索 `/api/taobao/search-item-list/v1`、详情 `/api/taobao/get-item-detail/v1`（另有 V3/V6/V7/V9，字段语义各不相同：V3 无价格、V4 有最终价但多数商品不支持、V6 有模糊销量、V7 支持所有商品 ID） | CNY | 本批不接 |
| Amazon | `/api/amazon/search-products/v1`、`/api/amazon/get-product-detail/v1` | USD/EUR 等 | 第二批 |
| AliExpress / Shopee / Temu / 抖音 / 1688 | 各有端点 | 多币种 | 暂不接 |

**路径修正（实测发现，必须按实测走）**：早期契约里的搜索端点是 `/api/…/search-item/v1`，实测返回 **HTTP 404 + `code:404 Resource not found`**（token 有效、鉴权已通过，是路由没匹配上）；官方文档与实际可用路径是 **`search-item-list/v1`**。详情端点路径与契约一致。

**实测对比（同一 token、同一关键词「耳机」，各 1 次成功调用）**：

| 维度 | 京东 | 淘宝 |
| --- | --- | --- |
| 搜索单页件数 | 48 件（`totalCount` 7607，分页元数据齐全） | 10 件（`model.page.totalItems/totalPages`） |
| 单件字段数 | 85 - 87 | 43 |
| 现价 | `price` = `"198.00"`（精确字符串，需 `parseFloat`） | `priceYuanDouble` = `15.9`（number） |
| 划线价 / 活动价 | ❌ 无（`lowestPrice` 实测为 0/1 标记位，不是价格） | ⚠️ `discntPriceYuan` / `priceZKYuanDouble`（实测 124 vs 现价 399，即活动价） |
| 类目 | ✅ `cid1/cid2/cid3`（实测 `652/828/842`），详情另有 `product.category` | ❌ 搜索无类目 |
| 评分 / 评论数 | ❌ 搜索 `cc` 是区间文案（`"20万+"`）、`gcp`(99/100) 是好评率百分数；详情无评分字段 | ❌ 搜索 `itemGradeAvg` 实测全为 0、`commentCount` 全为空串（字段在、值没填） |
| **库存状态** | ✅ 详情 `stock.StockState`（实测 `33`） | ❌ 无（`frontStock` 是「前 N 件」促销名额，实测 20000 / 2974 万，**不是库存**） |
| 图片 | ⚠️ 搜索相对路径 `jfs/t1/…`（需拼 `https://img30.360buyimg.com/sku/`）；详情 `mainImages[]` 是完整 URL | ✅ `picUrlFull` 完整 URL（`picUrlList[]` 为相对路径） |
| 官方 24h 健康值 | 搜索 34-100 波动、详情 89、价格接口 100 | 搜索 97、**详情 V1 = 6（30 天几乎全在 0-12，基本不可用）** |
| 平均耗时 | 搜索 2.4s、详情 22.5s、价格 2.6s | 搜索 5.4s、详情 0.4s（多为失败） |

**结论：接京东**。四条理由：

1. **只有京东能拿到库存状态**（`stock.StockState`），而库存是 `enrichLiveData` 要覆盖的易变字段之一；
2. **类目链完整**（`cid1/cid2/cid3`），构建期源派生 7 品类时不需要额外的类目反查；
3. **接口健康值更高**：淘宝详情 V1 长期 0-12/100，作为运行时依赖不可接受（官方自己在文档里建议「部分商品不支持，可切换 V1/V6/V9 使用」——多版本切换本身就是不稳定的信号）；
4. **分页元数据完整**（`totalCount` 7607、每页 48 件），构建期按品类取 Top N 时可控。

**两边都拿不到的字段（本批端点范围内）**：`rating` / `reviews` / `sales`。它们要么实测为空（`itemGradeAvg`=0、`commentCount`=""、`sales`/`monthSales`=""），要么只是区间文案（`cc`="20万+"、`orderPayUV`="1万+"）。要拿真值必须接「商品评论 / 商品评价 / 商品销量」这类独立接口（京东与淘宝都有）——**明确放第二批**，本批不接（见 §4.1）。

---

## 3. 字段映射表（`Product` ← JustOneAPI）—— **实测回填版（2026-09-25）**

`Product` 模型（`lib/types.ts:18-47`）：`id / name / brand / category / price / originalPrice / rating / reviews / sales / stock / image / description / specifications / tags`

图例：✅ 可直接映射　⚠️ 需换算或派生（写明算法）　❌ 源里没有（写明在哪一层确认）

取数端点简称：**jd-search** = `/api/jd/search-item-list/v1`（`data.products[]`，48 件/页）；**jd-detail** = `/api/jd/get-item-detail/v1`（`data.*`）；**tb-search** = `/api/taobao/search-item-list/v1`（`data.model.itemList[]`）。所有字段名均来自真实响应的字段路径清单（原始响应存于 `.cache/justoneapi-probe/`，不进仓库）。

| Product 字段 | 京东（选定平台） | 淘宝（对照，本批不接） | 说明 |
| --- | --- | --- | --- |
| `id` | ✅ jd-search `products[].id`（string，`"100207440191"`） | ✅ tb-search `itemList[].itemId`（number，`1019762789206`） | 加平台前缀 `jd-` / `tb-`，避免与快照目录（Amazon ASIN）撞车 |
| `name` | ✅ jd-search `products[].title`（`"Viken【2026最新款丨柏林之声第1名】骨传导蓝牙耳机…"`） | ✅ tb-search `itemList[].itemName` | 京东标题含大量促销词（`【…第1名】`），沿用现有 `truncate` 截断即可 |
| `brand` | ✅ jd-detail `product.brandName`（`"维肯（Viken）"`）、`product.cBrand` | ❌ 源里没有（`model.brandList[]` 是**筛选用品牌列表**，36 个候选，不是本商品的品牌） | 京东搜索不带品牌，只有详情有 → 构建期需详情补齐 |
| `category` | ⚠️ jd-search `cid1/cid2/cid3`（`"652/828/842"`）+ jd-detail `product.category`（`"652,828,842"`）→ **自建 cid → 7 品类映射表** | ❌ tb-search 无类目（`model.propertyList[]` 是筛选项） | 需新写映射表（现有 `CATEGORY_RULES` 面向 CSV 类目字符串，不适用）；映射不到就丢弃该商品 |
| `price` | ✅ jd-search `products[].price`（`"198.00"`，`parseFloat`）　❌ jd-detail `priceFloor.price` 实测为 `"1??"`（`frontStaticDocument.priceFloor.priceLoginText` = `"登录查看价格"`，无登录态时**打码**） | ✅ tb-search `priceYuanDouble`（`15.9`） | **京东价格必须来自搜索端点**（或待实测的 `/api/jd/get-item-price/v1`），详情取不到 |
| `originalPrice` | ❌ 源里没有（`lowestPrice` 实测 0/1、`jdpriceRange`/`priceTag` 为空串，都不是价格） | ⚠️ `discntPriceYuan` / `priceZKYuanDouble`（活动价，实测 124 vs 现价 399）→ 仅当它**高于**现价时作 `originalPrice` | 京东侧沿用现有兜底 `originalPrice = price`（`products.ts:87-89`） |
| `rating` | ❌ 源里没有（jd-search 无评分字段；`gcp`(99/100) 是**好评率百分数**，折算是派生值冒充真实值，按原则不用；jd-detail `pricerate.rate` 为空串） | ❌ 源里没有（`itemGradeAvg` 字段存在但实测全为 0） | **不覆盖**，保持快照值（要真值需接评论类接口，第二批） |
| `reviews` | ❌ 源里没有（`cc` 实测是区间文案 `"20万+"` / `"5000+"`，不是数值） | ❌ 源里没有（`commentCount` 实测全为空串） | 同 `rating`；缺失时界面显示「暂无评分」（现有策略） |
| `sales` | ❌ 源里没有（`sales` / `monthSales` 字段存在但实测全为空串） | ❌ 源里没有（`orderPayUV` 实测 `"1万+"`，区间文案） | **一律记 0**（见 §4.1） |
| `stock` | ✅ jd-detail `stock.StockState`（实测 `33`；京东官方 IOP 文档枚举：`33/39/40`=有货、`36`=预订、`34`=无货） | ❌ 源里没有（`frontStock` 实测 20000 / 29745876，是「前 N 件」促销名额） | 只编码为等级代表值 0/10/40（见 §4.2），界面仍只显示等级 |
| `image` | ⚠️ jd-search `products[].imageUrl`（`"jfs/t1/…"` 相对路径，需拼 `https://img30.360buyimg.com/sku/`）　✅ jd-detail `product.mainImages[]`（完整 URL，实测 3 张） | ✅ tb-search `picUrlFull`（完整 URL） | 京东侧用 jd-detail 的 `mainImages[0]` 最稳；jd-search 的 `images[]` 实测为空数组 |
| `description` | ❌ 源里没有（jd-search/jd-detail 无描述文案；`product.sellPoint` 实测为空串） | ❌ 源里没有（tb-search 无描述；详情里的 `beehiveContent` 是买家评价内容，不是商品描述） | 无 → 构建期写空串或沿用现有清洗后的兜底 |
| `specifications` | ⚠️ jd-detail `product`：`weight`(`"0.182"`)、`width/height/length`、`model`(`"i113"`)、`upc`、`wserve`(`"1年质保"`)、`skuName`/`product.spec` 等 → 组成 `Record<string,string>` | ⚠️ tb-search `model.propertyList[]` 是**筛选属性**（`pname/valueList`），非本商品参数 | 需剔除与对比表固定行同名的键（构建期已踩过「品牌」重名导致 React key 冲突，`project-status` §4.4） |
| `tags` | ⚠️ 从 `title` / `cid` 派生（复用 `localize-catalog.mjs` 的中文功能词表思路） | ⚠️ 同 | 无命中就是空数组（现有 21 件无标签是允许状态） |

---

## 4. `sales` 与 `stock`：两个敏感字段的处理

### 4.1 `sales` —— **实测判定：一律记 0（不映射）**（2026-09-25 写死）

- **现状基线**：真实销量只覆盖 112 件中的 17 件（Amazon `bought_past_month`、Lazada `number_sold`），界面优先展示真实评价数，销量仅用于排序与对比（`project-status` §4.3）。
- **实测证据**（本批可用端点内，均为真实响应）：

| 来源 | 字段 | 实测值 | 判定 |
| --- | --- | --- | --- |
| 京东搜索 | `products[].sales`、`products[].monthSales` | **全为空字符串**（48 件逐件确认） | ❌ 不映射 |
| 淘宝搜索 | `itemList[].orderPayUV` | `"1万+"`（区间文案） | ❌ 不映射 |
| 淘宝搜索 | `itemList[].itemGradeAvg` / `commentCount` | `0` / `""`（字段在、值没填） | ❌ 不映射 |

- **结论**：`sales` 记 0。区间值（`"1万+"`）冒充精确值会重演「派生值冒充真实值」的错误；空字段与「解析不出」同理。要拿真值需接京东/淘宝的「商品销量」类独立接口（第二批）。
- **兜底**：`sales: 0` 时界面行为与今天完全一致（不显示销量，显示评价数）。

### 4.2 `stock` —— **实测判定：京东 `stock.StockState` → 等级代表值**（2026-09-25 写死）

- **现状基线**：`stock` 是**内部可用性模型**（缺货不可加购、加购上限、性价比缺货惩罚），界面只显示等级；件数在真实源里几乎全是派生的，因此**绝不展示**（`lib/types.ts:33-41`、`project-status` §4.3）。
- **上游给的是「状态」而不是「件数」**（实测：京东详情 `stock.StockState = 33`；`stock.preStore`/`product.allnum` 语义不明或为空，不作件数使用）→ 编码为**等级代表值**：

| 上游信号（京东 `stock.StockState`） | 依据 | `stock` 取值 | `stockLevelOf()` | 界面 |
| --- | --- | --- | --- | --- |
| `33`（现货-下单立即发货）、`39`（在途-内部配货）、`40`（可配货） | 京东官方开放平台 IOP 文档枚举 | `40` | `in_stock` | 有货 |
| `36`（预订） | 同上 | `10` | `low` | 库存紧张 |
| `34`（无货） | 同上 | `0` | `out` | 缺货（不可加购） |
| 其它值 / 未返回该字段 / 淘宝 | — | **不覆盖**（沿用现有派生值，不改动） | 与今天一致 | 与今天一致 |

> 编码值 0/10/40 是**等级代表值**，不是件数；实现里必须在代码注释与产物 `note` 中写明「由真实有货/缺货信号编码为等级代表值，不代表真实件数」——这正是「派生值不冒充真实值」要求的正确执行方式。
>
> 上游枚举来源：京东官方开放平台文档（`opendoc.jd.com` 库存接口的 `stockStateId` 枚举）。**不采用**任何社区博客里的版本（社区文档对 34/40 的解释互相矛盾）。

---

## 5. 价格与币种

| 情形 | 处理 |
| --- | --- |
| CNY（京东/淘宝） | 直接使用，无需换算 |
| 表内币种（USD/EUR/JPY/GBP/…，`CURRENCY_TO_CNY`，`build-real-catalog.mjs:47-62`） | 复用同一张表折算，**不新增第二张表**（唯一实现原则） |
| 表外币种 | **构建期：跳过该商品**（现有策略，`build-real-catalog.mjs:473`，避免 93500 IDR 被判价格越界）；**运行时：不报错，静默回退快照** |
| 折算后价格越界 | `10 ≤ price ≤ 20000`（`build-real-catalog.mjs:65-66`）→ 构建期丢弃，运行时回退快照 |
| 浮动汇率 | **不引入汇率 API**（会新增外部依赖与故障点）；固定表 + README 标注"汇率为构建期静态值" |

---

## 6. 缓存策略

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 位置 | **服务端内存 `Map`**（`lib/justoneapi/cache.ts` 或 `client.ts` 内） | 运行时拉取只发生在服务端（Agent 节点侧）；存 localStorage 会把 token 与实时数据带到客户端，且浏览器缓存对服务端调用无效 |
| 键 | `${platform}:${productId}` | 平台前缀避免跨平台 id 撞车 |
| TTL | **300 秒（5 分钟）** | 实时性够用（价格分钟级变化对演示无意义），同一会话内多次问同一商品不会重复计费 |
| 单飞 | **同键并发共享同一个 Promise** | 一轮对话里"先搜索再问价格"可能触发两次同一 id 的拉取，去重直接省一次计费 |
| 失败 | **不缓存** | 失败不计费（官方口径），且失败会立即回退快照，缓存失败反而掩盖恢复 |
| dev 热更新 | 模块级 `Map` 会被 HMR 重建 → 缓存丢失（可接受，不做 `globalThis` 锚定） | 明确写下这个已知行为，避免被当成 bug（与 checkpointer 需锚定 globalThis 的场景不同：那里丢的是会话数据，这里丢的只是缓存） |
| 上限 | 最多 200 条，超出按插入顺序淘汰最旧 | 防止长时间运行内存无界增长 |

---

## 7. 错误处理矩阵（13 个业务码）

**前置（实测发现，必须写进实现）**：无效 token 时服务端返回 **HTTP 401 + `{"code":100,...}`**（实测见 §11.1）。因此 `client.ts` **必须在任何 HTTP 状态下都先尝试解析响应体**：只看 HTTP 状态码会把 `code:100` 误判为通用网络错误，也会把 `code:303 + HTTP 429` 误判为普通限流。只有"响应体无法解析为 JSON"时才归类为传输层错误。

| code | 含义 | 计费 | 重试 | 用户/调用方可见行为 |
| --- | --- | --- | --- | --- |
| 0 | 成功 | 是 | — | 正常返回 `data`；写入缓存 |
| 100 | Token 无效/失效（未配置 token 时同样返回它） | 否 | **不重试** | 构建期：中止并提示"检查 `JUSTONEAPI_TOKEN`"；运行时：静默回退快照。客户端在**发起请求前**先检查 env，未配置时抛独立错误（可与 100 区分） |
| 301 | 采集失败，请重试 | 否 | **最多 3 次**，指数退避 + 抖动 | 全部失败后：构建期中止 / 运行时回退快照 |
| 302 | 超出速率限制 | 否 | **退避后重试 1 次** | 仍失败即回退；不打印噪音日志 |
| 303 | 超出每日配额（HTTP 429） | 否 | **停止** | 构建期：中止并说明"今日配额用尽（Asia/Shanghai 自然日）"；运行时：回退快照且**当日不再尝试**（进程内开关，避免反复撞配额） |
| 400 | 参数错误 | 否 | **不重试** | 开发期问题：抛出并带上 `message`；运行时回退快照 |
| 500 | 内部服务器错误 | 否 | **最多 3 次** | 同上，全失败后回退 |
| 600 | 权限不足（token 无权访问该接口） | 否 | **不重试** | 构建期：提示"该 token 未开通此平台接口"；运行时：回退 |
| 601 | 账户余额不足 | 否 | **不重试** | 构建期：提示充值；运行时：回退 + 记录一次警告（这是需要人介入的状态，不能完全静默） |
| 602 | Token 限额超限 | 否 | **不重试** | 同 601（提示该 token 累计消费达上限） |
| 其他/未知码 | 未在契约内 | — | **不重试** | 抛出原始码与 message（不猜测语义），运行时回退快照 |
| 传输层错误（超时、DNS、TLS、非法 JSON） | — | — | 视为可重试 1 次（仅超时） | 运行时不弹错误，回退快照 |

退避公式（按你的要求）：`delay = min(30s, 500ms × 2^attempt) × (0.5 + random())`。

**"用户看到什么"的总原则**：运行时的所有失败路径**都不进入对话文本**、不弹错误；只在右栏时间线留一条 `tool` 级条目（例如「实时数据不可用，已用快照价格」）。这条链路是"无 Key 也能跑"底线的延伸：**JustOneAPI 挂了，对话必须照常**。

---

## 8. Token 安全

| 项 | 做法 |
| --- | --- |
| 读取 | 仅 `process.env.JUSTONEAPI_TOKEN`；**禁止**任何默认值、禁止写进 `NEXT_PUBLIC_*`（否则会进客户端 bundle） |
| 未配置 | `callJustOneApi()` 抛 `JustOneApiTokenMissingError`（明确错误，不静默失败）；`CATALOG_SOURCE=justoneapi` 时**启动即报错退出**（`resolveSource()` 中校验，`lib/catalog/products.ts:97-103`） |
| `.env.example` | 增加 `JUSTONEAPI_TOKEN=`（空占位符 + 一行注释说明从 dashboard.justoneapi.com 获取） |
| `.gitignore` | 已核对第 12–14 行：`.env`、`.env.local`、`.env*.local` 均被忽略；`.env.example` **不在**忽略之列（必须可提交）。实现时 `.env.example` 只写空占位符，绝不写入真值 |
| 日志 | 只记录 `endpoint`（**路径，不记完整 URL**）、`code`、`durationMs`、`attempt`；**任何日志与错误消息都不得包含 token**。若日志里不得不出现 URL，必须已脱敏为 `token=***`（`client.ts` 的 `redact()` 是唯一出口：既挡 `token=<值>` 参数，也挡 token 原值回显） |
| README | 明确写"此源为可选；不配置 token 时，本项目所有现有功能不受影响"，并指向 dashboard 获取方式 |
| **轮换（请你在实现前完成）** | 你提到此前 token 已在对话中出现过。**请在 Dashboard 轮换一次**，新 token 只写进 `.env.local`；**不要贴进对话**——我拿到新 token 的方式是"你在本地放好后告诉我"，我只执行 `node --env-file=.env.local scripts/justoneapi-probe.mjs` 这类脚本，token 不进对话上下文 |

---

## 9. 与现有源的关系（三源共存）

```text
CATALOG_SOURCE 未配置 → 有 real-catalog.json 用 real，否则 mock（现状，不改）
CATALOG_SOURCE=real        → data/real-catalog.json（默认，演示与构建基线，冻结）
CATALOG_SOURCE=justoneapi  → data/justoneapi-catalog.json（可选，可刷新；未配置 token 时启动报错）
CATALOG_SOURCE=mock        → lib/mock/products.ts（离线 50 条，不变）
```

- `resolveSource()` 与 `CATALOG_META`（provider / generatedAt / note）扩展 `justoneapi` 分支，`provider` 显示为「JustOneAPI · 京东/淘宝实时商品」+ 构建时间；**界面角标逻辑不需要改**（已有 `source` 驱动）。
- `CatalogSource` 类型从 `'real' | 'mock'` 扩为三值；`REAL_PRODUCTS` 的加载逻辑抽成"按源读 JSON 文件"，但**校验（`isProductLike`）与兜底（默认值补齐）保持唯一实现**。
- 运行时 `fetchLiveProduct()` 与 `CATALOG_SOURCE` **无关**：它总是拉实时数据并覆盖"那一件商品"的展示值，失败回退到当前源（real 或 mock）的同 id 商品。

---

## 10. 演示与失败安全

- **演示主路径不变**：`docs/demo-script.md` 的所有步骤仍走 `CATALOG_SOURCE=real` 冻结快照，`docs/demo-script.md` 不需要改。
- **未配置 token 时**：`real` 与 `mock` 两条路径完全不经过 `lib/justoneapi/`；只有显式选 `justoneapi` 才会在启动时报错。
- **运行时拉取失败的可见性**：不弹错误、不进气泡；只在右栏时间线留一条中性记录（可被演示时用来展示"降级可见"这一既有卖点）。
- **配额保护**：单轮最多 1 次实时拉取 + 5 分钟缓存 + 单飞 + 303 后当日熔断，四条叠加把"烧配额"压到最低。

---

## 11. 实测记录

### 11.1 已完成（2026-09-24 23:2x，无令牌探测，失败请求不计费）

| 探测 | 结果 |
| --- | --- |
| `POST/GET api.justoneapi.com/api/taobao/search-item/v1?keyword=耳机&page=1`（无 token） | **HTTP 401**，`{"code":100,"data":null,"message":"TOKEN INVALID/UNACTIVATE","recordTime":null}` |
| 同上 + `token=INVALID_TOKEN_FOR_PROBE` | 同上（**缺失与无效不可区分** → 因此客户端必须自己先检查 env） |
| `/api/jd/search-item/v1?token=INVALID…&keyword=耳机` | 同上（路由存在，端点路径正确） |
| `/api/amazon/search-products/v1?token=INVALID…&keyword=headphones&country=US` | 同上 |

**由实测得到的三条硬事实**：
1. `api.justoneapi.com` 在本机**可达**（对比：本轮调研中 `openlibrary.org`、`huggingface.co`、Shopify 店铺均不可达）—— 这个源在当前网络环境下可用；
2. 统一响应体实际字段为 `{code, message, data, recordTime}`——比你给的契约**多一个 `recordTime`**，实现时类型要带上它（或显式忽略）；
3. **HTTP 状态码与业务码并行存在**（401 + code 100）→ §7 的"任何 HTTP 状态下都先解析响应体"是硬要求。

### 11.2 待完成（需要 token，4 条命令）—— **已于 2026-09-25 完成，结果见 §15**

以下命令**请你本地执行**（`JUSTONEAPI_TOKEN` 已在 `.env.local` 中），把完整响应贴回给我，或允许我在你放好 token 后自行执行：

```bash
# ① 淘宝搜索
curl -sS -m 120 "https://api.justoneapi.com/api/taobao/search-item/v1?token=$JUSTONEAPI_TOKEN&keyword=%E8%80%B3%E6%9C%BA&page=1"
# ② 京东搜索
curl -sS -m 120 "https://api.justoneapi.com/api/jd/search-item/v1?token=$JUSTONEAPI_TOKEN&keyword=%E8%80%B3%E6%9C%BA&page=1"
# ③ 详情（用 ① 返回的真实 itemId）
curl -sS -m 120 "https://api.justoneapi.com/api/taobao/get-item-detail/v1?token=$JUSTONEAPI_TOKEN&itemId=<从①取>"
# ④ 详情（用 ② 返回的真实 skuId）
curl -sS -m 120 "https://api.justoneapi.com/api/jd/get-item-detail/v1?token=$JUSTONEAPI_TOKEN&itemId=<从②取>"
```

**回填清单**：① §2 的平台二选一结论；② §3 所有 🔬 单元格的真实字段名；③ §4 的 sales/stock 判定（真实字段 or 估算 or 无）；④ 单次响应体大小（决定缓存内存占用预估）。

> 这 4 次全部是**成功请求、会计费**（约 4 次配额）。若你想省配额，可只跑 ①②（搜索通常已含价格/销量/评分），详情字段留到 2b 阶段再补。

---

## 12. 实现清单（2a / 2b / 2c，待评审通过后执行）

| 阶段 | 交付 | 复用 / 新增 |
| --- | --- | --- |
| **2a（已完成）** | `lib/justoneapi/{codes,errors,client}.mjs` + 同名 `.d.mts`、`cache.ts`、`types.ts`、`platforms/jd.mjs` + `.d.mts` + 单测（码表 15 个码、重试、超时、token 缺失、缓存单飞、脱敏、字段映射、类目映射、价格解析、库存编码） | 复用：无第三方依赖、原生 `fetch` + `AbortController`（120s）；新增：码表体系、退避公式、脱敏出口 |
| **2b-构建（已完成）** | `scripts/sources/justoneapi.mjs`（+ `.d.mts`）+ `scripts/catalog-shared.mjs`（+ `.d.mts`）+ `build-real-catalog.mjs` 的 `--source=justoneapi` 分支 | 复用：`CURRENCY_TO_CNY`、价格区间 `10–20000`、`isProductLike` 校验语义（镜像 + 等价性单测）、`PER_CATEGORY`、库存派生规则；新增：cid 类目映射表、关键词表、原子写入、按原因分类的丢弃统计 |
| **2b-运行时（待下一步）** | 图内条件触发节点 `enrichLiveData`：状态字段 `liveOverrides` / `liveFetchedAt`、条件边六条判定、单轮 ≤3 件、静默失败、右栏中性记录、前端三处「实时」标注 | 复用：`codes.mjs`（熔断/重试判定）、`platforms/jd.mjs`（解析与编码）、`cache.ts`（TTL + 单飞）；新增：节点本身、`liveOverrides` reducer、事件类型 |
| **2c（部分完成）** | README「JustOneAPI 实时数据源」章节（含定位声明、端点、码表、配额）**已完成**；`project-status.md` 同步**已完成**；运行时相关章节与 `demo-script` 的可选步骤**随下一步补** | 含错误码速查表、配额说明、「可选源」声明 |

---

## 13. 需要你确认的 6 个决策点

> **2026-09-25 裁定结果（全部已落定）**
>
> | # | 决策点 | 裁定 |
> | --- | --- | --- |
> | 1 | 运行时是否接线 | **接线，且做成图内条件触发节点**（§14），但**顺序后移**到构建期源之后（§15.3 选项 A） |
> | 2 | 平台二选一 | **京东**（实测选定，§2） |
> | 3 | 原子替换 | **要 `tmp + rename`**（已实现，`writeJsonAtomically`；失败保留上一版产物） |
> | 4 | 配额熔断的持久性 | 进程内开关，**不持久化**（重启后重试一次的成本可接受） |
> | 5 | `sales` 判定尺度 | 取更严的那条：**只接受上游原生数值字段**；京东/淘宝实测都没有 → 一律记 0（§4.1） |
> | 6 | Token 轮换 | 已完成，token 只存在于 `.env.local`，任何输出不含 token（日志经 `redact()` 统一出口） |

1. **运行时是否接线**：本阶段只交付函数（不改节点），还是允许对 `searchProducts` 做最小改动以触发实时拉取？（影响验收项「Agent 查询 → 走实时 API」是否本阶段成立）
2. **平台二选一**：京东 or 淘宝（凭 §11.2 的实测结果定），是否同意先只接 1 个？
3. **原子替换**：确认"现有流程里没有原子替换"这一事实后，是接受"独立文件 + 普通写入"，还是要求新增 `tmp + rename`？
4. **配额熔断的持久性**：收到 `code:303` 后"当日不再尝试"目前设计为**进程内**开关（进程重启即失效）。是否需要持久化（写文件）？我倾向不持久化（重启后重试一次的成本可接受，且不引入新状态）。
5. **`sales` 判定尺度**：§4.1 的第 2 条（文案字符串「已售 N 件」可解析则映射）你接受吗？我倾向更严：**只接受上游原生数值字段**，其余一律 0。
6. **Token 轮换确认**：请确认已在 Dashboard 轮换，并只放入 `.env.local`（**不要贴进对话**）；我按 §11.2 执行 4 条命令并回填 §3/§4 的待实测单元格后，再开始 2a。

---

## 14. 架构裁定 v2：运行时改为图内条件触发节点（本节为第 2/3 步的唯一权威规格）

> **§1 的「运行时 = 独立函数、不接线」被本节取代。** 实时的定位仍是"补充"，但落点是**图里的一个节点**，不是图之外的函数。

### 14.1 节点定位

新增节点 **`enrichLiveData`**（补充节点，不是替代节点）：

- 主数据仍来自 `searchProducts`（冻结快照）；
- 本节点只做一件事：对**已选中**的商品，用 JustOneAPI 实时数据覆盖其**易变字段**（价格、原价、库存状态、评分、评论数）；**不新增商品、不改排序、不改筛选条件**；
- 命名语义是"补充信息"，不是"刷新数据"（不用 refresh / 副数据 之类叫法）。

**为什么做成节点而不是独立函数**（同步写入 `docs/decisions.md`）：图是唯一编排层，函数会变成图之外的特例（谁来调、何时调、失败怎么办都散落在调用点）；条件触发声明在**边**里可被单测覆盖；失败隔离在**节点内**，节点不抛错即天然不污染主流程。

### 14.2 图结构

```text
searchProducts ──▶ enrichLiveData ──▶ generateReply
        └──────────（条件不满足时直接到 generateReply）
```

**条件边只做判定，不做调用**；判定为真才进入节点，进入后由节点决定拉哪几件。

五条判定（**全部满足**才进入）：

| # | 条件 | 依据 |
| --- | --- | --- |
| 1 | `JUSTONEAPI_TOKEN` 已配置 | `process.env` |
| 2 | `searchResults` 非空 | 状态 |
| 3 | 本轮用户输入命中实时性关键词 | 词表：`现在 / 最新 / 实时 / 当前 / 多少钱 / 涨价 / 降价 / 还有货吗`（从本轮最后一条 human 消息取文本） |
| 4 | 同一 thread 距上次实时拉取 > 60 秒 | `liveFetchedAt`（冷启动为 null → 判定通过） |
| 5 | 当日未熔断 | 进程内标记（收到 `code:303`） |

**循环安全**：本节点是 `searchProducts → generateReply` 这条直线上的**插入点**，两边都是单向边，**不引入新的环**（图里唯一的环仍是 `refineSearch ⇄ searchProducts`）。

### 14.3 状态字段

```ts
liveOverrides: Annotation<Record<string, Product>>({
  reducer: (x, y) => ({ ...x, ...y }),   // 合并型：多轮可累积
  default: () => ({}),
}),
liveFetchedAt: Annotation<number | null>({
  reducer: (_, y) => y,
  default: () => null,
}),
```

- 键 = `productId`，值 = 覆盖后的 `Product`；**前端渲染按 id 查覆盖值，查不到就用 `searchResults` 原值**；
- **不写 `searchResults`**：独立字段让"哪些字段来自实时、哪些来自快照"始终可追溯（UI 可标注"实时 · 12:34"），数据血缘可讲 —— 这是项目真实性叙事的一致性要求。

### 14.4 节点行为

```text
enrichLiveData(state):
  1. 取 state.searchResults 前 3 件（上限 3，配额保护）
  2. 逐件调 JustOneAPI 详情端点（复用 2a 的 client：缓存 + 单飞 + 重试）
  3. 成功 → liveOverrides[productId] = 快照商品 ⊕ 易变字段覆盖
       覆盖：price / originalPrice / rating / reviews / stock
       不覆盖：name / category / image / description / specifications / tags
       （稳定字段；且快照里的本地化文案更好）
  4. 部分失败 → 成功的写入、失败的跳过，不抛错
  5. 全部失败 → liveOverrides 不变，返回空更新
  6. toolCallLog 写一条中性记录（右栏时间线渲染）
  7. liveFetchedAt = Date.now()
```

**失败必须完全静默**：不抛错、不进对话文本、不弹提示；右栏时间线只留一条中性记录（如「实时数据不可用，已用快照数据」）。

**配额保护（节点内）**：单轮最多 3 件；收到 `code:303` → 写**进程内标记**（`globalThis` 锚定，避免 HMR 重置）当日不再进入本节点；收到 `code:601 / 602` → 同样熔断（避免反复撞配额）。

### 14.5 前端接入（不加面板、不加 Tab、不改三栏布局）

| 位置 | 变更 |
| --- | --- |
| 商品卡片 / 详情弹窗 | 被覆盖字段旁加"实时"小标注，hover 显示 `liveFetchedAt` 格式化时间（布局不变） |
| 右栏时间线 | 复用现有 `tool` 级条目样式，新增文案如「补充实时数据 · 3 件成功」/「实时数据不可用，已用快照数据」 |
| 商品对比表 | 参与对比的商品被覆盖时，价格单元格标注"实时" |

### 14.6 演示影响

`docs/demo-script.md` 增加**可选**一步（明确标注"仅在配置了 `JUSTONEAPI_TOKEN` 时可用"）：

- 操作：搜「耳机」→ 追问「现在多少钱」；
- 预期：商品卡价格旁出现"实时"标注，右栏时间线出现「补充实时数据 · N 件成功」；
- 说明：证明"图里有条件触发的实时数据补充，不影响主流程"。

**原演示路径保持不变**：不配 token 时脚本照常走完。

### 14.7 实现顺序（三步，逐步暂停）

| 步 | 内容 | 暂停点 |
| --- | --- | --- |
| **1（2a）** | `lib/justoneapi/{client,errors,cache,types}.ts` + `platforms/<选中平台>.ts`；13 个业务码、HTTP 401+code 100 不误判、重试、超时、缓存单飞，全部单测覆盖；**用 token 实测回填 §3/§4 字段映射** | **暂停：把实测回填的映射表交你确认** |
| **2** | `state.ts` 加两字段；`nodes/enrichLiveData.ts`；`graph.ts` 加节点 + 条件边；`prompts.ts` 加一句"部分商品价格来自实时查询"（不改回复结构）；`events.ts`/`sse.ts` 如需新事件；前端三处标注 + 时间线 | 本步内含节点级单测（条件边五条判定、部分/全部失败、>3 只取前 3、熔断后不再调用、reducer 多轮合并与不污染无关商品） |
| **3** | `scripts/sources/justoneapi.mjs` + `--source=justoneapi`（**tmp + rename 原子写入**）；产物 `data/justoneapi-catalog.json`（不覆盖 real）；`CATALOG_SOURCE=justoneapi` 分支；README/architecture/decisions/demo-script/project-status 同步 | 构建期可用性验收 |

### 14.8 验收与明确不做

**验收**：条件边五条判定逐条单测；无效 token 跑一轮确认对话正常、无错误提示、时间线有中性记录；模拟 `code:303` 后同进程不再进入节点；无 token 时图行为与改造前**完全一致**（现有 159 单测全绿）；有 token 时搜"耳机"→问"现在多少钱"→商品卡"实时"标注 + 时间线补充事件；构建期产出独立文件且件数与丢弃统计对得上；`tsc` 0 错误 / 单测全绿 / build 通过。

**明确不做**：不用实时数据替代快照；不改 `searchProducts` / `generateReply` 职责；不做多平台并行（先接 1 个）；不做 Amazon（第二批）；不改演示主路径（仅新增可选步骤）；不给 `searchResults` 写实时数据；不引入新依赖；单测不发真实网络请求。

---

## 15. 实测回填记录（2026-09-25，第 1 步交付）

> 本节是「用真实 token 跑探测 → 回填 §2/§3/§4」的结果存档。原始响应落盘在 `.cache/justoneapi-probe/`（已 gitignore，不进仓库）；脚本 `scripts/justoneapi-probe.mjs`，入口 `npm run justoneapi:probe`。

### 15.1 三条新事实（影响实现，必须知道）

1. **搜索端点路径修正**：正确路径是 `/api/<platform>/search-item-list/v1`（早期契约里的 `search-item/v1` 实测返回 404）。已同步进脚本与 §2；**详情端点路径与契约一致**。
2. **业务码枚举比契约更宽**：官方 OpenAPI 的 `code` 枚举是 **15 个**——`0, 100, 101, 202, 300, 301, 302, 303, 400, 404, 500, 503, 600, 601, 602`。契约外的 5 个码（`101 / 202 / 300 / 404 / 503`）在实现里一律走 `unknown_code`、**不重试**（`lib/justoneapi/errors.ts`）：其中 `404` 已实测为 `Resource not found`；`503` 官方描述为「服务暂时不可用」——**建议**把它单独归入可重试（1 次），但它不在你给的契约表里，**等你确认后再改**（当前保持不重试）。
3. **响应信封还带 `requestId`**：实际契约是 `{code, message, data, recordTime, requestId}`（OpenAPI 声明；`recordTime` 已在 §11.1 实测）。实现只依赖 `code` / `message` / `data`，其余忽略。

### 15.2 配额、耗时与响应体大小

| 探测 | 端点 | HTTP | code | 耗时 | 响应体 | 计费 |
| --- | --- | --- | --- | --- | --- | --- |
| 淘宝搜索「耳机」 | `/api/taobao/search-item-list/v1` | 200 | 0 | 1,513 ms | 36,524 B（10 件，≈3.6 KB/件） | ✅ 1 次 |
| 京东搜索「耳机」 | `/api/jd/search-item-list/v1` | 200 | 0 | 2,381 ms | 180,210 B（48 件，≈3.75 KB/件） | ✅ 1 次 |
| 京东详情 `100207440191` | `/api/jd/get-item-detail/v1` | 200 | 0 | 2,249 ms | 40,836 B（单件） | ✅ 1 次 |
| 淘宝 / 京东搜索（早期错误路径） | `/api/…/search-item/v1` | 404 | 404 | 698 / 115 ms | 82 B | ❌ 不计费 |

- **本次配额消耗：3 次成功调用**（失败请求不计费）。
- **缓存内存预估**：只缓存**映射结果**（约 10 个标量字段 ≈ 0.5 KB/件）→ 200 条上限 ≈ **100 KB**；若误缓存原始响应（详情 40 KB/件）则 200 条 = **8 MB**。因此实现明确**只缓存映射结果**（§0 第 6 行）。

### 15.3 待裁定的缺口：**id 空间不兼容**（这条会改 §14.4）

`enrichLiveData` 的设计前提是「取 `searchResults` 前 3 件 → 逐件调详情端点」。但默认数据源 `CATALOG_SOURCE=real` 的商品 id 是 **Amazon ASIN**（`B0…`），而京东详情端点只认 **京东 skuId**（`100207440191` 这类）。拿 ASIN 去查京东**只可能失败**，且每轮会白跑最多 3 次。三个选项：

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| **A（推荐）** | 条件边补一条判定「商品 id 可解析为所选平台 id（`jd-` 前缀或 12-13 位纯数字）」；默认快照下自然跳过（**零调用、零风险**）；演示时切 `CATALOG_SOURCE=justoneapi` 即可看到实时标注 | 演示该步需先切源（`docs/demo-script.md` 的可选步骤要写清） |
| B | 用商品标题去京东搜索、取第一条当「同名商品」的实时价 | 会展示**别人的价格**（同名不同 SKU），直接违反项目「真实性」叙事，错配也无法自证 |
| C | 混合目录：构建期把 justoneapi 源商品（`jd-` 前缀）与快照商品合并成一份目录，运行时只补充能解析的 id | 需先做第 3 步构建期源 + 一次目录合并改造（工作量最大，演示最自然） |

**在裁定之前，第 2 步不写节点**——否则条件边会退化成「每轮最多 3 次注定失败的调用」：虽然失败不计费，但会污染右栏时间线，也让「失败静默」这个演示点变得没有说服力。

### 15.4 价格端点实测（2026-09-25，1 次成功调用；**已按裁定执行**）

`/api/jd/get-item-price/v1?itemId=100207440191` → HTTP 200、`code:0`、3,533 ms、**响应体 423 B**：

```json
{ "code": 0, "message": "", "data": { "data": [ { "good_id": "100207440191", "price": 19800 } ] }, "recordTime": null }
```

三个问题的答案：

| 问题 | 结论 |
| --- | --- |
| 1. 是否返回精确价格 | ✅ 是。`price = 19800`，**单位是分** → 198.00 元，与搜索端点同一商品返回的 `"198.00"` **完全一致**（说明它不是区间值、也没有被打码） |
| 2. 是否同时返回库存状态 | ❌ 否。只有 `good_id` + `price` 两个字段，库存仍需详情端点 |
| 3. 响应体大小 | 423 B（极小，可放心进缓存） |

**由此定下的取数口径**：
- 构建期：**价格 ← 搜索端点**（搜索响应里天然带着价格，不必额外调用）；**品牌/图片/库存/参数 ← 详情端点**（每件保留商品 1 次详情调用）。
- 运行时（下一步）：主用例「现在多少钱」只能走**价格端点**（快照商品没有搜索响应可用），库存走详情端点；两者都是 1 次调用/件，单轮上限 3 件。

### 15.5 类目映射与关键词表的实测来源（2026-09-25）

京东不返回类目名称，只返回 `cid1/cid2/cid3` 数字链。因此**类目映射表必须从真实搜索响应里反推**（做了 9 次探索性搜索）：

| 关键词 | 实测 cid 链（出现次数） | 判定品类 |
| --- | --- | --- |
| 蓝牙耳机 | `652/828/842`（45）、`652/828/31012`（2） | 数码 |
| 连衣裙 | `1672/2615/9188`（20）、`1315/1343/*`（26）、`1318/12102/23729`（2，运动连衣裙） | 服饰（1318 那条按 cid 归到运动） |
| 坚果 | `36574/36824/*`（全量） | 食品 |
| 保温杯 | `6196/6219/*`（46）、`6196/11143/11149`（1） | 家居 |
| 跑步鞋 | `11729/11730/6908`（20）、`1318/12099/*`（27） | 运动（**11729 刻意不映射**，见下） |
| 面膜 | `1316/1381/1392`（46）、`1316/16831/16846`（2） | 美妆 |
| 小说 | `1713/3258/*`、`1713/3260/*`（14 条链） | 图书 |

映射表落在 `lib/justoneapi/platforms/jd.mjs`（8 个 cid1 → 7 品类），查表顺序是「三级链 → 二级链 → 一级类目」，细粒度覆盖表留空但已支持。

**唯一一条刻意不映射的**：`11729`（鞋子/鞋靴）——跑步鞋搜索里有一半商品属于它（如「海澜之家男鞋」），但项目 7 品类没有「鞋靴」这一格，映射到「运动」会把正装皮鞋也算成运动鞋。按「映射不到就丢弃」处理，丢弃数量会出现在构建统计里。

**关键词表**（`CATEGORY_KEYWORDS`，7 品类 × 2 词）：数码（蓝牙耳机 / 移动电源）、服饰（连衣裙 / 男士夹克）、食品（坚果 / 咖啡豆）、家居（保温杯 / 收纳箱）、运动（跑步鞋 / 瑜伽垫）、美妆（面膜 / 口红）、图书（小说 / 儿童绘本）。选词标准：电商最典型的品类词，实测每个词都能返回 48 件且 cid 链稳定。

**顺带实测到一个重要事实**：探索阶段的 9 次搜索里**有 4 次返回 `code:301 COLLECT FAILED`**（瞬时失败率约 40%，每次耗时 7-17 秒）。这正是构建脚本必须带重试的原因——没有重试的构建几乎必然半途失败。构建日志显示重试都恢复了（`attempt=1/3 → attempt=2` 成功）。

### 15.6 为什么 `lib/justoneapi` 的核心是 `.mjs + .d.mts`

构建脚本由**纯 node** 直接运行（`node scripts/...`），加载不了 TS；而码表、重试策略、HTTP 客户端、京东字段映射这些规则又**必须与运行时共用同一份实现**（项目的「同一事实只允许一处实现」）。

取两条加载路径的交集就是：`.mjs` 放实现 + 同名 `.d.mts` 放类型。

| 文件 | 运行时（Next 服务端） | 构建脚本（纯 node） |
| --- | --- | --- |
| `lib/justoneapi/codes.mjs` | `import ... from '@/lib/justoneapi/codes.mjs'`（类型来自 `.d.mts`） | `import ... from '../../lib/justoneapi/codes.mjs'` |
| `lib/justoneapi/errors.mjs` | 同上 | 同上 |
| `lib/justoneapi/client.mjs` | 同上 | 同上 |
| `lib/justoneapi/platforms/jd.mjs` | 下一步的节点用它 | 构建期源用它 |

`cache.ts` / `types.ts` 保持 TS：前者只被运行时用（构建期不需要缓存），后者是纯类型（脚本用不到）。

**两条纪律**：`.mjs` 里只能用相对路径 import（纯 node 解析不了 `@/` 别名）；`.d.mts` 与 `.mjs` 必须同步改——单测跑的是真实实现，声明写错会先在类型检查或测试里暴露。