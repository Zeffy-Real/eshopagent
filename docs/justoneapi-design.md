# JustOneAPI 数据源接入设计（阶段设计评审稿）

> 状态：**待评审**。本文只做设计，不含实现代码。
> 依据：`lib/catalog/products.ts`、`lib/types.ts`、`scripts/build-real-catalog.mjs`、`scripts/localize-catalog.mjs`、`docs/project-status.md` §4（全部已读）。
> 实测记录见 §11；**尚未完成的实测项（需要你的 token）见 §11.2**——字段映射表里凡标注「待实测」的单元格，都必须在拿到 token 后回填，否则不进入 2a。

---

## 0. 决策摘要

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | 接入定位 | **两者都有**：构建期 `--source=justoneapi` 可选源 + **运行时做成图内条件触发节点 `enrichLiveData`**（v2 裁定，见 §14） |
| 2 | 先接平台 | **先接 1 个**：京东或淘宝（用同一次实测在两者间选字段覆盖率高的那个，理由见 §2）；Amazon 明确放第二批 |
| 3 | sales | **条件映射**：仅当实测确认是上游原生字段（如淘宝「月销」）才映射；否则一律 `sales: 0`（沿用"没有就不显示"） |
| 4 | stock | **只映射状态，不映射件数**：上游给的是「有货/缺货」信号 → 编码为等级代表值（0 / 10 / 40），界面继续只显示等级 |
| 5 | 币种 | 复用 `CURRENCY_TO_CNY`；未覆盖币种**按现有策略跳过**（运行时不报错，静默回退快照） |
| 6 | 缓存 | 服务端内存 `Map`，TTL **300 秒**，键 `${platform}:${id}`，**含单飞去重**；失败不缓存 |
| 7 | 错误处理 | 13 个业务码逐个定义（§7）；**任何 HTTP 状态下都先解析响应体**（实测：无效 token 返回 HTTP 401 + `code:100`） |
| 8 | Token | 只读 `process.env.JUSTONEAPI_TOKEN`；`.env.example` 加空占位符；`.gitignore` 已核对（`.env` / `.env.local` / `.env*.local` 均被忽略，`.env.example` 保持可提交）；**请在写代码前轮换一次**（§8） |
| 9 | 与现有源关系 | `CATALOG_SOURCE` 增加 `justoneapi` 分支，**`real` 仍是默认**；三源产物互相独立、互不覆盖 |
| 10 | 演示安全 | JustOneAPI **不在演示主路径**；未配置 token 时该源完全不可用且**对现有功能零影响** |

**一处必须先纠正的前提**：你要求「必须复用现有的 staging → 校验 → 原子替换流程」——**该流程在当前仓库里不存在**。`scripts/build-real-catalog.mjs` 的实际做法是：逐行归一化 → 按 `skip` 原因丢弃不合格行 → 分品类取 Top N → **直接 `writeFile` 覆盖 `data/real-catalog.json`**（`build-real-catalog.mjs:834`）。现有真正的「校验」有两处可复用：构建期的按行丢弃 + `lib/catalog/products.ts` 的 `isProductLike()`（运行时逐字段校验，`products.ts:48-69`）。因此本设计的处理方式是：**JustOneAPI 源复用 `isProductLike()` 的校验语义（构建期写盘前也跑一遍），产物写独立文件**，从而根本不需要"原子替换"去保护现有快照；若你仍要原子写，那是新增 3 行（`writeFile(tmp)` + `rename`），不是复用。

---

## 1. 接入定位：构建期 + 运行时，但两者职责严格分开

| | 构建期 | 运行时 |
| --- | --- | --- |
| 触发 | `npm run catalog:build -- --source=justoneapi`（人工执行） | Agent 侧按需调用（本阶段**只交付函数，不接线**，见下） |
| 产物 | `data/justoneapi-catalog.json`（独立文件，**不覆盖** `real-catalog.json`） | 无产物，返回内存中的 `Product` |
| 调用量 | 一次构建 = 每品类 1 次搜索 + N 次详情 | 同一商品 5 分钟内最多 1 次 |
| 失败语义 | 构建失败即中止（人工在场，看得到原因） | **静默回退快照**，不阻塞对话、不弹错误 |

**为什么两者都要**：HF 快照是冻结数据（不可刷新），但它保证了演示可复现与零配额消耗；JustOneAPI 的价值是"某个商品**现在**多少钱/还在不在售"，这只能是运行时按需拉取，构建期全量刷新既烧配额也没有必要（112 件全量刷新对配额是浪费，且快照一旦被实时数据覆盖，"可复现基线"就没了）。

**一处需要你拍板的缺口**：你同时要求「不改现有 Agent 节点逻辑」与「运行时按需拉取：Agent 查询某个商品 → 走实时 API」。这两条不能同时成立——不改节点，就没有任何东西会调用 `fetchLiveProduct()`。本设计的处理是：**2b 只交付函数 + 缓存 + 静默回退，不接线到节点**；把"接线"拆成独立评审项（建议形态：在 `searchProducts` 里对**用户明确提到实时性的输入**如「现在/最新/实时」触发，单轮最多 1 次，且必须命中已在快照里的商品 id）。验收清单里那条「Agent 查询 → 走实时 API」**在接线前无法成立**，请确认是"本阶段先不接线、验收相应后移"，还是"允许对单个节点做最小改动"。

---

## 2. 平台选择：先 1 个，用实测决定是京东还是淘宝

| 平台 | 端点（同步 V1） | 币种 | 结论 |
| --- | --- | --- | --- |
| 京东 | `/api/jd/search-item/v1`、`/api/jd/get-item-detail/v1` | CNY | **候选 A** |
| 淘宝/天猫 | `/api/taobao/search-item/v1`、`/api/taobao/get-item-detail/v1`（**不用 V2 异步**） | CNY | **候选 B** |
| Amazon | `/api/amazon/search-products/v1`、`/api/amazon/get-product-detail/v1` | USD/EUR 等 | 第二批 |
| AliExpress / Shopee / Temu / 抖音 | 各有端点 | 多币种 | 暂不接 |

**首选在"京东 / 淘宝"之间二选一的理由**：

1. **零汇率风险**：两者都返回 CNY，不需要碰 `CURRENCY_TO_CNY`，也不会撞上"未支持币种 → 跳过"（`build-real-catalog.mjs:473`）；
2. **与现有目录同构**：价格区间校验 `10 ≤ price ≤ 20000`（`build-real-catalog.mjs:65-66`）对国内平台成立，对 Amazon 的部分品类未必；
3. **字段重合度高**：京东/淘宝的详情都带价格、库存状态、评分、评论数，正好覆盖 `Product` 的核心字段。

**二选一靠实测**：用同一个 token 对两者各跑一次 `search-item/v1` + `get-item-detail/v1`（成本 4 次成功调用），比较「能直接映射的字段数」与「详情里是否真带库存状态/销量」，取高的那个。**Amazon 明确放第二批**：它需要 `country` 参数与 FX 折算，且美国站价格单位与国内目录的可比性更弱。

---

## 3. 字段映射表（`Product` ← JustOneAPI）

`Product` 模型（`lib/types.ts:18-47`）：`id / name / brand / category / price / originalPrice / rating / reviews / sales / stock / image / description / specifications / tags`

图例：✅ 可直接映射　⚠️ 需换算或派生（写明算法）　❌ 源里没有　🔬 **待实测确认字段名**（拿到 token 后回填）

| Product 字段 | 淘宝/天猫 | 京东 | Amazon（第二批） | 说明 |
| --- | --- | --- | --- | --- |
| `id` | 🔬 `itemId` | 🔬 `skuId` | 🔬 `asin` | 前缀区分平台（如 `tb-`/`jd-`/`amz-`），避免三源 id 撞车；与现有 `idPrefix`（`amz`）同思路 |
| `name` | ✅ `title` | ✅ `title` | ✅ `title` | 直接取；长度按现有 `truncate` 截断 |
| `brand` | 🔬 品牌字段 | 🔬 品牌字段 | ✅ `brand` | 源里可能没有独立品牌字段 → 从标题或参数表提取；提不出就用平台名兜底（与图书用作者兜底同理） |
| `category` | ⚠️ 平台类目 → 项目 7 品类 | ⚠️ 同 | ⚠️ 同 | **需要新写平台类目映射表**（现有 `CATEGORY_RULES` 面向 CSV 类目字符串，不适用）；映射不到就丢弃该商品（沿用按行丢弃策略） |
| `price` | ✅ 现价 | ✅ 现价 | ✅ 现价 | 国内平台已是 CNY；非 CNY 走 §5 |
| `originalPrice` | 🔬 划线价 | 🔬 划线价 | ✅ `list_price` | 无划线价时按现有兜底 `originalPrice = price`（`products.ts:87-89`） |
| `rating` | 🔬 `rating` | 🔬 `rating` | ✅ `rating` | 需实测确认量纲（5 分制还是 10 分制）；若是 10 分制 → ⚠️ 除以 2；超出 `0–5` 会被 `isProductLike` 丢弃（`products.ts:36`） |
| `reviews` | 🔬 评论数 | 🔬 评论数 | ✅ `reviews_count` | 缺失记 0，界面显示「暂无评分」（现有策略） |
| `sales` | 🔬 月销（**必须实测**） | 🔬 同 | 🔬 `bought_past_month` | **见 §4**：只有确认是上游原生字段才映射 |
| `stock` | 🔬 库存状态 | 🔬 库存状态 | 🔬 `availability` | **见 §4**：只取等级信号，不取件数 |
| `image` | ✅ 主图 | ✅ 主图 | ✅ 主图 | 可能是多图数组（现有 `toImageUrl` 处理过 JSON 数组字符串的坑） |
| `description` | 🔬 详情文案 | 🔬 详情文案 | ⚠️ | 淘宝/京东详情常含 HTML 与超长文案 → 必须清洗 + 截断（现有 `clean`/`truncate` 可复用） |
| `specifications` | ✅ 参数表 → `Record<string,string>` | ✅ 同 | ✅ `product_details` | 需剔除与对比表固定行同名的键（现有构建期已踩过「品牌」重名导致 React key 冲突，`project-status` §4.4） |
| `tags` | ⚠️ 从标题/类目/参数派生 | ⚠️ 同 | ⚠️ 同 | 复用 `localize-catalog.mjs` 的中文功能词表思路；无命中就是空数组（现有 21 件无标签是允许状态） |

---

## 4. `sales` 与 `stock`：两个敏感字段的处理

### 4.1 `sales`

- **现状基线**：真实销量只覆盖 112 件中的 17 件（Amazon `bought_past_month`、Lazada `number_sold`），界面优先展示真实评价数，销量仅用于排序与对比（`project-status` §4.3）。
- **判定规则（写入实现，不做例外）**：
  1. 实测确认是**上游原生数值字段**（如淘宝「月销」）→ ✅ 直接映射，并在产物元信息里标注"来自 JustOneAPI 原生销量字段"；
  2. 实测只拿到「已售 N 件」这类文案字符串 → ⚠️ 可解析为整数则映射，解析不出就 0；
  3. 实测显示销量是区间/等级（如「1000+」）→ ❌ **不映射**，记 0（区间值冒充精确值会重演"派生值冒充真实值"的错误）；
  4. 实测确认是平台估算 → ❌ 不映射，记 0。
- **兜底**：无论哪种，`sales: 0` 时界面行为与今天完全一致（不显示销量，显示评价数）。

### 4.2 `stock`

- **现状基线**：`stock` 是**内部可用性模型**（缺货不可加购、加购上限、性价比缺货惩罚），界面只显示等级；件数在真实源里几乎全是派生的，因此**绝不展示**（`lib/types.ts:33-41`、`project-status` §4.3）。
- **JustOneAPI 的输入是"状态"不是"件数"**（官方描述为库存状态）→ 设计为**等级编码**：

| 上游信号 | `stock` 取值 | `stockLevelOf()` 结果 | 界面 |
| --- | --- | --- | --- |
| 缺货 / 下架 / 无货 | `0` | `out` | 缺货（不可加购） |
| 现货紧张（若上游有该信号） | `10` | `low` | 库存紧张 |
| 有货 | `40` | `in_stock` | 有货 |
| 未返回该字段 | **沿用现有派生值**（不改动） | 与今天一致 | 与今天一致 |

> 编码值 0/10/40 是**等级代表值**，不是件数；实现里必须在代码注释与产物 `note` 中写明"由真实有货/缺货信号编码而来，不代表真实件数"——这正是"派生值不冒充真实值"要求的正确执行方式。

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
| 日志 | 只记录 `endpoint`、`code`、`durationMs`、`attempt`；**任何日志与错误消息都不得包含 token**（含 URL 拼接后的完整 URL——记录 URL 前必须先脱敏 `token=***`） |
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

### 11.2 待完成（需要 token，4 条命令）

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
| **2a** | `lib/justoneapi/{client,errors,types,cache}.ts` + `platforms/{选中的平台}.ts` + 单测（13 码、重试、超时、token 缺失、映射） | 复用：无第三方依赖、原生 `fetch` + `AbortController`（120s）；新增：错误类型体系与映射函数 |
| **2b-构建** | `scripts/sources/justoneapi.mjs` + `build-real-catalog.mjs` 增加 `--source=justoneapi` 分支 | 复用：`CURRENCY_TO_CNY`、价格区间、`isProductLike` 校验语义、`PER_CATEGORY`、退出即中止的失败语义；新增：平台类目映射表、关键词表（从 7 品类派生） |
| **2b-运行时** | `fetchLiveProduct(productId, platform)`（含缓存 + 单飞 + 静默回退） | 复用：`getProductById()` 作为回退源；**不接线到任何节点**（见 §1 的待拍板项） |
| **2c** | README「JustOneAPI 数据源」章节 + `project-status.md`（模块结构 / 变更清单 / 验证状态） | 含错误码速查表、配额说明、"可选源"声明 |

---

## 13. 需要你确认的 6 个决策点

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