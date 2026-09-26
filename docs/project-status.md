# 项目现状说明书

> 用途：供审查（review）使用。描述**当前真实状态**，包括已完成、已验证、未验证与已知问题，不做美化。
>
> - 数据快照生成时间：2026-09-25 05:18 UTC
> - 文案本地化时间：2026-09-25 05:18 UTC
> - 版本锚点：git 仓库 `https://github.com/Zeffy-Real/eshopagent`，本次同步前 HEAD 为 `147672b`；**最终彩排已完成，项目冻结**（2026-09-26）：品类 chip 轮（检索条件重置 + 无 Key 品类名识别）关掉了 §8-32 / §8-34，A + C 两阶段最终彩排全部走通（[demo-rehearsal.md](./demo-rehearsal.md) 第十一节）；新记录 §8-35（时间线重载行为，含演示缓解）与 §8-36（规则路径两处条件污染，非本轮引入、记录不修）
> - 校验状态：`tsc --noEmit` 0 错误；**403 个单测全绿（27 个文件）**；`next build` 通过（首页 288 kB / First Load 425 kB / 共享 103 kB，与品类 chip 轮一致）；dev 正常运行于 http://localhost:3000

---

## 一、项目定位

对话式电商 Agent Web 应用。用户用自然语言完成 **商品搜索 → 智能推荐 → 多维度对比 → 购物车管理 → 下单结算** 全流程；Agent 的「思考 - 行动 - 观察」链路以可视化组件实时呈现，而不是纯文本输出。

两个核心卖点：

1. **真实电商数据而非 mock** —— 商品目录来自公开的真实平台抓取样本，不是手编数据。
2. **没有 API Key 也能完整跑通** —— LLM 未配置或调用失败时自动降级为规则解析 + 模板回复，搜索 / 对比 / 加购 / 下单中断恢复全部可用。

---

## 二、技术栈与规模

| 项 | 现状 |
| --- | --- |
| 框架 | Next.js 15（App Router）+ React 19 + TypeScript（strict，禁止 `any`） |
| 样式 | Tailwind CSS v4 + shadcn/ui 风格（Radix UI + CVA），设计令牌集中在 `app/globals.css` |
| 动画 | Framer Motion |
| 图表 | ECharts（按需引入，仅注册散点图相关模块） |
| 状态管理 | Zustand + persist（对话与购物车写入 localStorage） |
| Agent 框架 | `@langchain/langgraph` 1.4（StateGraph + SqliteSaver checkpoint + interrupt） |
| LLM 封装 | `@langchain/openai` 1.5（ChatOpenAI，`baseURL` 兼容 DeepSeek / 通义千问 / OpenAI） |
| 流式 | LangGraph `streamEvents()` → 后端 SSE → 前端 `fetch` + `ReadableStream` |
| 源码规模 | **136 个 `.ts` / `.tsx` 文件**（`app` / `components` / `lib` / `store` / `scripts`，其中 27 个单测文件）+ 9 个 `.mjs` 与 6 个 `.d.mts`（京东实时源；`.mjs + .d.mts` 的原因见设计文档 §15.6） |
| 页面与接口 | `app` 下 2 个页面（`/`、`/_not-found`）+ 2 个 API 路由 |
| Agent 节点 | **9 个**（`lib/agent/nodes/`，含条件触发的 `enrichLiveData`） |
| 测试 | **385 个单测用例**（Vitest，27 个文件，覆盖口径一致性的唯一实现、记忆机制、会话持久化、落地校验重试、在途请求中止、JustOneAPI 码表与字段映射、实时补充节点六条判定与静默失败、条件串去重与 LLM 失败文本清洗、目录字段分级与派生统计、跨产物继承的判据与边界、A+ CSS 描述降级的拼装与长度合格性、客户端轻量载荷的派生一致性、内联卡按 id 解析与静默失败、详情弹窗的实时覆盖解析、内联卡选取规则与两条路径产出同一 id 列表、检索命中总数与展示口径（`searchTotal`）、收尾兜底的挂起中断判定与成功态会话级门、订单历史合并规则（只收 confirmed / 按 id 幂等 / 上限 20）、**中栏三态判定（有结果 / 搜索空 / 非搜索）**）；无组件/E2E 自动化测试 |
| 版本控制 | git 仓库，远端 `https://github.com/Zeffy-Real/eshopagent` |

---

## 三、模块结构

```
app/
  api/agent/route.ts            SSE 主入口（消息 + 购物车快照 + 待对比商品）
  api/agent/resume/route.ts     中断恢复入口（Command resume）
  page.tsx                      三栏工作台
lib/
  agent/
    graph.ts                    StateGraph 构建 + 条件边 + 编译
    state.ts                    AgentState（Annotation.Root + reducer）
    checkpointer.ts             globalThis 单例 checkpointer（默认 SqliteSaver，可切 memory）
    history.ts                  短期记忆：按轮次裁剪历史上下文（纯函数）
    session-store.ts            session_meta 读写 + 惰性 TTL 清理
    llm.ts                      ChatOpenAI 封装（未配置时优雅降级）
    structured.ts               结构化输出三级降级
    grounding.ts                回复落地校验（防 LLM 编造金额与口径）
    prompts.ts                  System Prompt 与上下文构建
    ruleParser.ts               规则解析器（无 LLM 时的主路径）
    sse.ts                      streamEvents → SSE
    events.ts                   前后端共用事件协议
    nodes/                      9 个节点，每个节点一个文件（含条件触发的 enrichLiveData）
    tools/                      productTools / cartTools（纯函数 + zod 入参契约）
  catalog/products.ts           商品目录唯一入口（real | justoneapi | mock 可切换）
  catalog/field-truth.ts        字段真实性分级（唯一代码来源，面板与文档共用）
  justoneapi/                   京东实时数据源（构建期 + 运行时的共用实现）
    codes.mjs / codes.d.mts     码表与重试策略（15 个 code）、退避公式、熔断集合
    errors.mjs / errors.d.mts   错误载体 + 可读文案（.mjs + .d.mts 的原因见设计文档 §15.6）
    client.mjs / client.d.mts   HTTP 客户端（120s 超时、任何 HTTP 状态先解析响应体、脱敏出口）
    cache.ts                    实时数据缓存（TTL 300s + 单飞 + 失败不缓存）
    types.ts                    实时字段类型（只覆盖易变字段）
    platforms/jd.mjs / .d.mts   京东端点、cid 类目映射、价格/库存换算
    overrides.ts                实时覆盖规则（只盖 price/库存等级 + 划线价一致性；前后端共用）
  profile.ts                    跨会话画像：信号提取 + 幂等合并 + 提示文案（纯函数）
  order-history.ts              订单历史合并规则（纯函数：只收 confirmed、按 id 幂等、上限 20）
  product-panel-state.ts        中栏三态判定（纯函数：results / empty-search / recommend）
  cart-pricing.ts               购物车金额规则（纯函数，前后端共用）
  decision.ts                   决策推荐理由与对比结论（纯函数）
  utils.ts                      cn / 价格格式化 / formatCount / hasRealSales
  agent-client.ts               SSE 客户端（在途请求的中止入口、AbortError 分类）
components/
  chat/ product/ visualization/ charts/ order/ layout/ common/ ui/
  visualization/catalog-section.tsx   数据快照面板（只读）
  order/shopping-drawer.tsx     购物车 / 订单历史抽屉（两个顶栏入口共用；复用 cart-section）
  order/order-history-section.tsx 订单历史列表（空态「还没有订单」）
store/
  use-agent-store.ts            对话、快照、时间线、中断；成功态会话级门（不持久化）
  use-cart-store.ts             购物车（localStorage）
  use-order-store.ts            订单历史（localStorage；写入源是快照里的 confirmed 订单）
  use-ui-store.ts               面板开合、移动端视图、抽屉开关与 Tab
data/
  real-catalog.json             真实商品数据快照（默认源，420 件，冻结）
  justoneapi-catalog.json       京东实时源产物（可选源，构建时刻的真实价格/库存）
scripts/
  build-real-catalog.mjs        多源真实数据 → 统一 Product 模型（--source=real | justoneapi）
  catalog-shared.mjs            两个构建源共用的常量与纯函数（品类/汇率/价格区间/校验镜像）
  sources/justoneapi.mjs        京东实时源：搜索 → 详情 → 校验 → 原子写盘 + 丢弃统计
  localize-catalog.mjs          LLM 文案本地化 + 标签派生
  justoneapi-probe.mjs          字段探测脚本（打印真实字段名，原始响应落 .cache/）
```

### 贯穿全项目的两条约定

1. **唯一入口**：业务代码（工具层、节点、组件）一律从 `lib/catalog/products.ts` 取数，不直接依赖具体数据源。接真实电商 API 时只需替换该文件实现。
2. **唯一实现**：同一个事实只允许有一处实现，避免各层各解释一遍导致口径分叉。
   - 数量展示口径 → `lib/utils.ts` 的 `formatCount()`
   - 「有无真实销量」→ `lib/utils.ts` 的 `hasRealSales()`
   - 库存等级 → `lib/types.ts` 的 `stockLevelOf()` / `STOCK_RANK`（件数只作内部可用性模型，界面与文档一律不展示）
   - 画像合并与提示文案 → `lib/profile.ts` 的 `mergeProfile()` / `profileRecall()`
   - 金额规则 → `lib/cart-pricing.ts`
   - 商品目录 → `lib/catalog/products.ts`

---

## 四、数据层现状

### 4.1 数据来源

`data/real-catalog.json` 由 `scripts/build-real-catalog.mjs` 从两个公开数据集构建（均为 Bright Data 官方发布的真实抓取样本）：

| 数据集 | 用途 |
| --- | --- |
| `luminati-io/eCommerce-dataset-samples` | 综合电商样本，覆盖 Amazon / Walmart / Lazada / Shopee / Shein，提供 6 个品类 |
| `luminati-io/Amazon-popular-books-dataset` | 亚马逊畅销图书样本（2269 行），专门补实「图书」品类 |

### 4.2 目录构成

**420 件商品，7 个品类各 60 件。**

| 平台 | 件数 | 有真实销量的件数 |
| --- | --- | --- |
| Amazon | 280 | 29 |
| Walmart | 61 | 0 |
| Lazada | 59 | 59 |
| Shopee | 20 | 0 |
| **合计** | **420** | **88** |

> 另有 75 件商品没有任何标签（数码 13 / 服饰 2 / 食品 24 / 家居 6 / 运动 3 / 美妆 19 / 图书 8）——它们既没有源数据 features，本地化文案里也不含功能词，因此派生不出标签。

### 4.3 字段真实性边界

| 字段 | 来源 |
| --- | --- |
| 标题 / 品牌（图书为作者） / 类目 / 商品参数 / 图片 / ASIN·SKU | **真实**，来自数据集原始字段 |
| 价格 / 原价 | **真实**（各平台原币种），按固定汇率表折算为人民币展示 |
| 评分 / 评论数 | **真实**；缺失时如实显示「暂无评分」，不编造分数 |
| 销量 | **真实但覆盖率有限**：仅 Amazon `bought_past_month`（204/1000 行有值）与 Lazada `number_sold` 为真字段；Shopee `sold` 全为 0、Walmart 无该列 → 一律记 `sales: 0`，界面改展示真实评价数 |
| 库存状态（有货/缺货） | **真实**信号（`availability` / `is_available` / `in_stock`） |
| 库存件数 | ✅ **派生且界面不展示**（已修）：真实数据源里没有任何一件商品带真实库存件数（只有 Shopee 有 `stock` 字段，实测当前目录里 20 件 Shopee 商品该列全为 0 或空，因此都走了派生路径），件数全部由 `21 + hash % 480` 派生。现仅作为**内部可用性模型**（缺货不可加购、加购上限、缺货惩罚），界面一律只展示「有货 / 库存紧张 / 缺货」等级 |
| 描述 / 图书简介 | ⚠️ **派生文案**（少数条目）：源数据 `description` 是亚马逊 A+ 页面原始 CSS，不可用，改为用真实字段拼装——图书用作者/类目/评分/可选版本，综合源命中 A+ CSS 的 2 件用品牌/类目/商品参数/评分，**同一套拼装规则**（`scripts/catalog-shared.mjs` 的 `buildDerivedDescription`）；产物带 `descriptionDerived` 标记与 note 说明 |
| 中文文案 | **本地化**：商品名/描述/标签/规格值由 LLM 翻译（品牌与型号保留原文），价格/评分/图片/ASIN 不动 |

**原则：没有数据就显示没有，不用估算值填满界面。**

### 4.4 构建期处理要点（踩过的坑）

| 处理点 | 说明 |
| --- | --- |
| 多币种 | 按 `currency` 查固定汇率表折算；汇率表未覆盖的币种**直接跳过**，而不是当美元处理（否则 93500 IDR 会被判价格越界） |
| 图片字段 | Shopee / Lazada 的 `image` 是 JSON 数组字符串（`["https://…"]`），不解析会把整个平台判成「缺少图片」 |
| 多语言类目 | Shopee / Lazada 类目是西/印尼/越语（`Buku & Majalah` = 图书与杂志），类目规则覆盖这些语言 |
| 图书评分解析 | `rating` 是自然语言 `"4.6 out of 5 stars"`。**不能交给 `toNumber`**——它剥掉非数字字符后得到 `"4.65"`（把 `out of 5` 的 5 当成小数位），必须用正则取 `out of 5` 前面的数 |
| 图书去重 | 按「书名主体」而非完整标题：截掉副标题 + 去掉版本噪声词 + 前缀判定，合并同书多版本（实测 4 组近重复）。**仅对图书启用**——服饰括号里是颜色/尺码，合并会丢 SKU |
| 图书标签 | 通用功能词表（透气/降噪）对图书完全失效。而 `matchHardFilters` 中标签命中不了会**整条过滤掉商品**，故改为从真实类目路径派生题材标签，命中词中英双语 |
| 规格键冲突 | 规格参数里的「品牌」与对比表固定行同名 → React key 冲突，构建期即剔除 |

---

## 五、Agent 层现状

### 5.1 状态图

```
START → parseIntent
          ├─ search   → searchProducts
          ├─ refine   → refineSearch
          ├─ compare  → compareProducts
          ├─ cart     → manageCart
          ├─ checkout → prepareOrder
          └─ default  → generateReply

refineSearch   → searchProducts                     （合并追加条件后重新检索）
searchProducts ├─ needsRefine && refineCount < 2 → refineSearch
               └─ 否则                            → generateReply
prepareOrder   ├─ pendingOrder 非空 → confirmOrder   （interrupt 确认后恢复执行）
               └─ 否则             → generateReply
confirmOrder   → generateReply → END
```

**循环保护**：`refineSearch ⇄ searchProducts` 是图中唯一的环，靠 `refineCount`（上限 2）强制收敛，否则「检索为空 → 放宽 → 仍为空」会一直绕到 `GraphRecursionError`。

### 5.2 三级降级（无 Key 也能用）

| 层 | 策略 |
| --- | --- |
| 结构化输出 | function calling → jsonMode → 纯文本 + 手工 JSON 提取 + zod 校验（实测该 provider 不支持 JSON-Schema 形式的 `response_format`） |
| 意图解析 | LLM → 规则解析器（词表全部从商品目录派生，不会解析出库里没有的词） |
| 回复生成 | LLM 流式 → 模板回复（数据 100% 来自状态） |

### 5.3 两道防线

1. **落地校验**（`lib/agent/grounding.ts`）：抽取回复里所有 ¥ 金额，逐个核对是否来自真实数据（商品价 / 原价 / 数量小计 / 优惠 / 运费 / 应付 / 两两价差）；「万」口径也必须与界面一致。处理分两级：**先带纠正提示重试一次**（把「哪些数字不在数据里」点名告诉模型，用 `invoke` 非流式，避免两段候选拼进同一气泡），仍不符才改用模板回复并在时间线标注原因。
2. **流式过滤**（`lib/agent/sse.ts`）：只把 `generateReply`（唯一面向用户的节点）的 token 推给前端，`parseIntent` / `manageCart` 的结构化 JSON 属内部中间结果，不外泄。

### 5.4 记忆机制（四层）

| 层 | 作用范围 | 实现 | 现状 |
| --- | --- | --- | --- |
| 1. 会话内短期记忆 | 当前 thread | `lib/agent/history.ts` 按轮次裁剪历史注入 `parseIntent`（裁剪以轮次为单位，不截断单条消息） | ✅ 已实现（阶段 12） |
| 2. 会话持久化 | 同一 sessionId，跨进程重启 | `SqliteSaver`（WAL + `busy_timeout`）+ `session_meta` 惰性 TTL 清理 | ✅ 已实现（阶段 13） |
| 3. 跨会话结构化画像 | **同一浏览器**（与 sessionId 解耦） | `lib/profile.ts`：只从真实行为取信号 + 幂等合并，存 localStorage | ✅ 已实现（阶段 14） |
| 4. 语义记忆 / 向量检索（RAG） | —— | **不做** | ⛔️ 刻意不做：420 件结构化商品用「关键词 + 标签 + 排序」已够用；embedding 要么再依赖外部 API（破坏「无 Key 也能完整跑通」）要么引入本地模型；同时讲 LangGraph 与 RAG 会稀释表达重点。完整理由见 README「记忆机制」 |

第 3 层的硬约束（评审时可直接对照代码）：

- 信号只来自三类真实行为：搜索（权重 1）/ 加购（3）/ 成交（5）。提取函数只接受「筛选条件 + 命中商品」或「被加购 / 被下单的那件商品」这类对象 —— **没有行为就没有字段**；
- 合并取**最高权重**而不是累加：一轮里每个 `node_end` 都会推送同一批信号，`interrupt` 恢复轮还会把上一轮的信号再带一遍，累加会让信号推几次就翻几倍；取 max 天然幂等（重复应用返回同一对象引用）；
- 两条消费路径都真的用上画像：LLM 路径注入意图 prompt（并在 prompt 里约束「当前输入已给品类/关键词时以输入为准」），规则路径在模板回复末尾带出提示；两条路径都会产出右栏「记起你的偏好」事件 —— 记忆被用到时可见；
- 清除竞态：`generation` 自增（主防线，丢弃携带旧值的在途信号）+ 中止在途请求（双保险）；
- **边界**：仅同一浏览器有效，不是跨设备 / 跨用户；服务端不持有画像（只在请求期内经 `config.configurable` 注入节点，不写 checkpoint）；画像摘要会随 prompt 出境到 LLM 服务商，demo 阶段**未做合规处理**（README「隐私边界」已写明）。

---

## 六、变更清单（累计）

### 6.1 数据与脚本

| 文件 | 变更 |
| --- | --- |
| `scripts/build-real-catalog.mjs` | 新增图书专用 provider 与独立归一化 `normalizeBookRow`；图书按书名主体去重；**销量不再用「评价数 × 1.6」估算**；真实性说明改为从数据算出 |
| `scripts/localize-catalog.mjs` | 新增图书题材标签词表（中英双语）；规格参数改为「只覆盖已存在的键」（原先整体替换会静默丢字段）；元信息不再声称假字段为真实 |
| `data/real-catalog.json` | 重新生成：98 件 → **112 件**，图书 2 本 → **16 本** |
| data/real-catalog.json | 第二轮扩容：112 件 → **420 件**（--per=60；平台新增 Shopee 20 件） |

### 6.2 口径与语义收敛

| 文件 | 变更 |
| --- | --- |
| `lib/utils.ts` | 新增 `hasRealSales()`，作为「有无真实销量」的唯一实现 |
| `lib/catalog/products.ts` | 运行时校验补全：字符串字段判 `typeof`（`null` 能骗过 `=== undefined`）、数值字段判 `Number.isFinite` 与区间（`typeof NaN === 'number'` 恒为真） |
| `lib/agent/tools/productTools.ts` | 无真实销量时不出「销量」对比行、不产出「销量最高」；整组为图书时固定行改用「作者」 |
| `lib/agent/prompts.ts` | 上下文按有无销量给不同口径；显式给出商品总数并说明明细只是前 N 件；新增规则「没有销量二字就不得编造销量」 |
| `lib/agent/grounding.ts` | 不再把 `0` 登记为合法销量口径 |
| `lib/agent/nodes/generateReply.ts` | 模板回复按有无销量切换「销量 / 评价数」 |

### 6.3 流式与前端

| 文件 | 变更 |
| --- | --- |
| `lib/agent/sse.ts` | token 按 `event.metadata.langgraph_node` 过滤；`toSnapshot` 的 `reply` 按「本轮开始前的消息条数」界定本轮，不再取整个会话最后一条 AI 消息 |
| `store/use-agent-store.ts` | 打字机状态机重写：用显式的本轮气泡 id 替代「最后一条是否 streaming」，气泡只在本轮真正结束时收尾 |
| `components/product/product-card.tsx` | 无真实销量改展示评价数 |
| `components/product/product-detail-dialog.tsx` | 同上，且不再重复展示销量 |
| `components/charts/price-rating-scatter.tsx` | 气泡度量在有销量时用销量、否则用评价数；tooltip 与图注同步 |
| `components/visualization/decision-section.tsx` | `chartProducts` 加 `useMemo`（原先 `slice` 每次渲染都是新数组，导致图表 option 每帧重建） |

### 6.4 文档

| 文件 | 变更 |
| --- | --- |
| `README.md` | 同步两个数据源、图书补实细节、销量真实覆盖率、新增「跨层口径与流式输出」修复表、补充已知限制 |
| `docs/architecture.md` | **新增**：三张 Mermaid 图（LangGraph 状态图 / 三层架构 / 一次交互时序）+ 节点·边·状态字段·事件类型的**代码行对照表**（抽查用） |
| `docs/demo-script.md` | **新增**：5 分钟 / 2 分钟演示脚本，每步含「操作 / 预期画面 / 证明什么」，全部真机跑通（实测文本直接写进预期画面） |
| `docs/decisions.md` | **新增**：10 条技术决策记录（背景 / 选项 / 决策 / 理由 / 代价 + 「如果被追问」），素材取自 README、本文件与代码注释 |
| `README.md`（首屏） | 重构为「一句话定位 + 三卖点 + 状态图缩略 + 3 行快速启动 + 三个文档入口」，原有详细内容全部保留在后半部分 |
| `docs/api-sources.md` | **新增**：免注册/免 Key 商品数据源调研（A/B/C/D 分类 + 逐源实测记录：URL、状态码、原样响应片段、限流头）+ Product 字段映射可行性 + 主源/演示源/补充源推荐 + 灰产转售与 Shopify ToS 合规边界 |

### 6.5 记忆机制与工程化（阶段 11.5 – 14.5）

| 主题 | 文件 | 变更 |
| --- | --- | --- |
| 库存口径（11.5） | `lib/types.ts` / `lib/decision.ts` / `lib/agent/tools/productTools.ts` / `components/product/stock-badge.tsx` | 界面只展示等级，件数退回内部可用性模型；对比表按等级判优；「现货可发」仅当等级确实有差异时才产出 |
| 工程化（11.5） | `vitest.config.mts` / `lib/**/*.test.ts` / `.git/config` | 引入 Vitest；`git init` + 远端 `Zeffy-Real/eshopagent` |
| 短期记忆（12） | `lib/agent/history.ts` / `prompts.ts` / `nodes/parseIntent.ts` / `nodes/searchProducts.ts` | 按轮次裁剪的历史注入（只消解指代，不推断意图）；序数指代 `targetIndex → focusProductId`，`searchProducts` 收窄为单件后消费掉该字段 |
| 会话持久化（13） | `lib/agent/checkpointer.ts` / `session-store.ts` / `state.ts` / `store/use-agent-store.ts` / 两个 API 路由 | SqliteSaver（WAL + `busy_timeout`）+ `CHECKPOINT_BACKEND` 兜底与自动回落；「清空对话 / 新会话」语义拆分；`hasHydrated` 门闸修 rehydrate 竞态；`session_meta` + 惰性 TTL 清理 |
| 跨会话画像（14） | `lib/profile.ts` / `lib/agent/state.ts` / `nodes/{parseIntent,searchProducts,manageCart,confirmOrder,generateReply}.ts` / `lib/agent/prompts.ts` / `app/api/agent/route.ts` / `store/use-agent-store.ts` / `components/visualization/profile-section.tsx` | 三个画像状态字段（`profilePatch` / `profileGeneration` / `profileHint`）；信号只来自真实行为且合并幂等；两条消费路径 + 记忆事件；清除竞态处理；右栏「你的偏好」面板（来源标注 + 一键清空） |
| 在途中止与窄屏遮挡（14.5） | `store/use-agent-store.ts` / `components/chat/chat-panel.tsx` / `components/layout/workspace.tsx` | 清除画像 / 清空对话 / 开启新会话统一中止在途请求并静默收尾（原先会导致旧 token 写进新会话）；窄屏抽屉不再遮挡对话头部（头部抬 `z-50` + 抽屉让出等高位置） |
| 落地校验重试（D）+ 分类入口（F，阶段 16） | `lib/agent/nodes/generateReply.ts` / `store/use-agent-store.ts` / `components/product/category-bar.tsx` / `components/product/product-panel.tsx` | ① 落地校验不过先按纠正提示重试一次（点名不符的数字），仍不过才降级模板；② 前端在「终态不是流式候选的续写」时**整体替换**气泡内容（否则会一直显示被否决的候选）；③ 中栏新增「按品类浏览」chip 行，点击走与对话相同的入口（`parseIntent → searchProducts`），不新增并行筛选实现 |
| 在途中止统一管理 + 验证缺口（17） | `lib/agent-client.ts` / `store/use-agent-store.ts` / `lib/agent-client.test.ts` / `store/use-agent-store.test.ts` / `vitest.config.mts` | `AbortController` 收敛为单一入口 `abortActiveRequest()`（三个调用方不再各自 new）；中止判定改为 `isAbortError()`（`error.name === 'AbortError'`）与网络错误区分；补 9 条单测（事件派发、HTTP 错误、中止、串行化）；vitest 纳入 `store/**/*.test.ts` |

### 6.6 JustOneAPI 京东实时源（阶段 18，构建期部分）

| 主题 | 文件 | 变更 |
| --- | --- | --- |
| 码表与客户端（2a） | `lib/justoneapi/{codes,errors,client}.mjs` + 同名 `.d.mts` / `cache.ts` / `types.ts` / `platforms/jd.mjs` + `.d.mts` | 码表从契约的 13 个扩到官方 OpenAPI 的 **15 个**（新增 101/202/300/404/503；404 显式分类为 `not_found`、503 归 `server_error` 且最多 2 次）；HTTP 客户端 120s 超时、任何 HTTP 状态都先解析响应体、重试仅 301/500/302/202/503/超时；日志与错误消息经 `redact()` 统一脱敏；缓存 TTL 300s + 单飞 + 失败不缓存 |
| 实测回填（2a） | `docs/justoneapi-design.md` §2/§3/§4/§15 | 平台二选一 → **京东**（实测：48 件/页、字段 85-87、类目链完整、唯一能拿库存状态；淘宝详情 V1 官方健康值仅 6/100）；字段映射逐格换成实测字段名；`sales` 一律记 0；`stock` 只编码等级（33/39/40→40、36→10、34→0，依据京东官方 IOP 文档枚举） |
| 构建期源（2b） | `scripts/sources/justoneapi.mjs` + `.d.mts` / `scripts/catalog-shared.mjs` + `.d.mts` / `scripts/build-real-catalog.mjs` / `scripts/justoneapi-probe.mjs` | 新增 `--source=justoneapi` 分支；京东源 = 每品类 2 关键词搜索（价格/标题/图片/类目链）+ 每件保留商品 1 次详情（品牌/主图/库存状态/参数）；cid 类目映射表 8 条（含刻意不映射的 11729）；产物 `data/justoneapi-catalog.json` 用 `tmp + rename` 原子写入，失败保留上一版；按原因分类的丢弃统计 + 配额消耗打印；`catalog-shared.mjs` 抽出两个源共用的品类/汇率/价格区间/校验镜像 |
| 目录源扩展 | `lib/catalog/products.ts` / `next.config.ts` | `CATALOG_SOURCE` 增加 `justoneapi` 分支（服务端缺 token 或缺产物**直接报错**，不静默回落）；两个源的校验与兜底收敛到同一处 `loadProducts()`；`next.config.ts` 把 `CATALOG_SOURCE` 内联进客户端包，保证服务端/浏览器解析出同一个源（否则会 hydration 报错） |
| 架构约束 | `docs/justoneapi-design.md` §15.6 | `lib/justoneapi` 的核心改成 `.mjs + .d.mts`：构建脚本（纯 node）加载不了 TS，而码表/客户端/字段映射又必须与运行时共用同一份实现，取交集即 `.mjs` 实现 + `.d.mts` 类型 |

### 6.7 实时补充节点 enrichLiveData（阶段 19）

| 主题 | 文件 | 变更 |
| --- | --- | --- |
| 图结构 | `lib/agent/graph.ts` / `lib/agent/events.ts` | 第 9 个节点 `enrichLiveData`；`searchProducts` 的条件边由「refineSearch / generateReply」改为「refineSearch / enrichLiveData / generateReply」，出边无条件回 `generateReply`——**不引入新环**；`NODE_LABEL` / `NODE_ORDER` 同步 |
| 状态与快照 | `lib/agent/state.ts` / `lib/agent/sse.ts` / `lib/agent/events.ts` | 新增 `liveOverrides`（**合并型** reducer，`mergeLiveOverrides`）与 `liveFetchedAt`（覆盖型）；**不写 `searchResults`**，让「哪个价格来自实时」可追溯；两者随 SSE 快照整体下发 |
| 节点实现 | `lib/agent/nodes/enrichLiveData.ts` / `lib/justoneapi/overrides.ts` | 六条判定（`shouldEnrich` 纯函数）+ 前 3 件上限 + 复用 `callJustOneApi` / `parseJdPriceFen` / `encodeStockLevel` / `SingleFlightCache`；只覆盖 `price`（含划线价一致性）与库存等级；失败静默、只在时间线留中性记录；熔断标记锚 `globalThis` 按自然日失效 |
| 口径同步（关键） | `lib/agent/grounding.ts` / `lib/agent/prompts.ts` | ① `collectProducts` 并入 `liveOverrides` 的值——否则回复引用实时价会被**自己的落地校验**判成编造并降级；② `buildReplyContext` 的明细套一层 `applyLiveOverride`，否则回复报旧价、卡片报新价 |
| 前端三处标注 | `components/product/live-badge.tsx`（新增）/ `product-card.tsx` / `product-grid.tsx` / `product-panel.tsx` / `product-detail-dialog.tsx` / `components/visualization/compare-section.tsx` | 「实时 · HH:mm」小标注（hover 显示拉取时刻）：卡片价格旁、详情弹窗价格行、对比表价格格；详情弹窗的数据来自目录（不是快照），因此单独叠了一次覆盖。排序仍按快照值走——**不改排序/筛选/推荐** |
| 文档 | README / `docs/{architecture,decisions,demo-script,justoneapi-design}.md` / 本文件 | 架构图与节点清单、新增 ADR 11（为什么做成节点而不是独立函数）、演示脚本第 9 步（可选）、§1 运行时整节从「待下一步」改为「已接入」 |

---

## 七、验证状态

### 7.1 已验证

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit` | ✅ 0 错误 |
| 单测 | `npm test`（Vitest，25 个文件） | ✅ 363 / 363 通过 |
| 跨重启持久化 | 建会话 → 杀进程（确认端口无监听）→ 重启 → 同 sessionId 追问指代 | ✅ 恢复上一轮上下文（时间线显示「历史 366 字」），指代解析为 refine 并收紧价格 |
| 内存态回落 | `CHECKPOINT_BACKEND=memory` 独立用例 | ✅ 不建连接、会话管理安全跳过、checkpointer 仍可用、不产生 sqlite 文件 |
| 构建 | `npm run build` | ✅ 通过；首页 **287 kB / First Load 423 kB**（客户端目录瘦身前是 419 / 555）；共享 103 kB（含内联的 justoneapi 目录产物——它只在服务端与按需 chunk 里） |
| 目录不变量 | 脚本扫描 420 件商品（价格/评分/评论数/销量/库存/原价/图片/描述/标签/规格） | ✅ 扩容后 0 异常；本地化后曾 2 处异常（描述过短，根因见 §8 第 22 条）→ **已修（2026-09-25 收尾轮）：A+ CSS 降级后重扫 0 异常** |
| 图书数据 | 逐条核对 16 本（扩容前） | ✅ 真实书名、作者、价格、评分、评论数、封面、题材标签齐全，无近重复 |
| 端到端（浏览器） | 3 轮对话 + 完整下单流程 | ✅ 通过 |
| — 图书检索 | 发「推荐几本小说」（扩容前） | ✅ 命中 8 本真实书籍，回复总数与商品区一致（8 = 8）；扩容到 420 件后重测：命中 30 件、展示前 12 件（见 §7.1 扩容后重测行） |
| — 销量口径 | 扫描商品卡文本 | ✅ 销量/评价数混排，**全页无「销量 0」** |
| — 对比表 | 发「对比前 3 件」 | ✅ 无「销量」行、固定行为「作者」、无重复行 |
| — 图表 | 合成 pointer 事件读 tooltip | ✅ 显示「评价 19.7万 条」而非销量；图注为「气泡大小 = 评价数」 |
| — 下单 | 加购 → 结算 → 确认 | ✅ 弹窗、订单号、购物车清空均正常 |
| — 流式气泡 | 3 轮回复逐轮计数 | ✅ 每轮恰好 1 个气泡，文本完整无截断，无跨轮串扰 |
| console | 刷新后发 3 轮消息 | ✅ 0 新增错误/警告 |
| 记忆机制（浏览器，阶段 12 / 14 / 14.5） | 逐项实测（视口 444×559） | ✅ 全部通过，逐项见下 |
| — 指代消解 | 「推荐几本图书」→「刚才那个再便宜点」/「换成第二件」 | ✅ 指向同一批图书；序数轮把结果收窄为单件 |
| — 跨重启持久化 | 建会话 → 杀进程（确认端口无监听）→ 重启 → 同 sessionId 追问指代 | ✅ 恢复上一轮上下文（时间线显示「历史 N 字」） |
| — 新会话保留画像 | 搜「图书」并加购 → 「开启新会话」（消息清空、thread 轮换）→ 问「推荐点什么」 | ✅ 本轮**无历史**，LLM 仍解析为「图书」（纯靠画像）；回复带出偏好；右栏出现「记起你的偏好：图书（来源：加购）」 |
| — 无 LLM 路径 | 把模型名改为无效值触发调用失败 | ✅ 时间线显示「规则解析 / 模板兜底」；模板回复末尾仍带出「注意到你之前加购过图书…」；记忆事件照常产出 |
| — 清除竞态 | 请求在途时点「清除画像」 | ✅ `generation` 自增、画像保持为空、在途信号未复活画像、无错误提示 |
| — 在途中止 | 回复流到一半点「开启新会话」/「清空对话」 | ✅ 消息列表保持为空、无残留 token、无错误提示、`thinking` 正常复位 |
| — 窄屏抽屉遮挡 | 抽屉打开时点对话头部按钮 | ✅ 「清空对话 / 开启新会话」与抽屉自身「收起面板」均可点击 |
| 桌面三栏（1440×900） | 当前浏览器运行时**没有 viewport/resize 工具**（`ALL_TOOLS` 中不存在），改用同源 1440×900 iframe 让媒体查询按 `xl` 求值后测量 | ✅ 三栏并排：对话 380px / 商品 700px（自适应）/ 右栏 360px，均在 `h-14` 顶栏之下（y=56，高 844）；右栏 `position: static`（静态列，不是抽屉）；对话头部按钮中心 `elementFromPoint` 命中按钮自身（未被遮挡，窄屏那个问题的桌面侧对照）；中栏 `scrollTop=200` 时另外两栏仍为 0（滚动互相独立）；窄屏标签栏 `display:none`、品类 chip 行可见。**限制**：截图仍受真实 444px 视口限制，桌面证据为测量式（几何 + 计算样式 + 滚动行为），非视觉截图 |
| 暗色模式 | 应用内主题开关切「深色」→ 在 1440×900 iframe 内读计算样式与对比度 | ✅ 令牌全部命中 `.dark` 分支（surface `#262a2f` / surface-muted `#2b3036` / sidebar `#17191c` / primary-soft `#3a251b` / primary-ink `#ff8a5c` / muted `#9ba1a9` / border `#363b42`）；对比度：气泡正文 15.86、时间线卡片 15.86、次要文字 6.76、价格/链接 6.19、选中 chip 6.19、商品卡 5.11（全部 ≥ WCAG-AA）；图表 canvas 存在且内容像素亮度 0.22 - 0.95（深底浅绘，可读），图表颜色本身从 `documentElement` 读令牌并随 `resolvedTheme` 重算，无硬编码色值 |
| 在途请求中止（浏览器） | ① 发消息中途点「开启新会话」② 发消息中途切「商品」Tab | ① ✅ `/api/agent` 请求数 1、消息列表 0 条、无错误提示、`thinking` 复位（旧请求静默中止，无跨会话串写）② ✅ 切 Tab 不打断请求（面板是 CSS 隐藏、组件不卸载），切回后回复完整、无错误提示 |
| 连续快速发两条消息 | 由单测锁住不变量（UI 层运行中所有发送入口已禁用/拒绝，无法构造第二个请求） | ✅ `store/use-agent-store.test.ts`：上一轮未结束时第二次 `sendMessage` 被拒绝（`fetch` 只调用 1 次、第二条不进入消息列表）；上一轮结束后可继续发送。浏览器侧辅证：运行中发送按钮 / 品类 chip / 购物车按钮 / 对比按钮均为 `disabled`，顶栏搜索框由 `handleSubmit` 提前 return，第 14.5 阶段的实测中点击禁用按钮被浏览器拒绝（`pointer-events: none`） |
| 落地校验重试（浏览器） | 发「前两件加起来一共多少钱」（诱使模型算总价） | ✅ 首次回复算出 **¥2749**（数据里没有的合计）被判未落地 → 按纠正提示重试 → 采用重试结果（只原样引用单价）；时间线显示「落地校验未通过（疑似编造金额 ¥2749），已按纠正提示重试一次并采用重试结果」；气泡内容等于服务端终态，被否决的候选没有残留（全页仅时间线那条诊断文案出现该数字） |
| 分类浏览入口（浏览器） | 切到「商品」Tab → 点「数码 60」 | ✅ 发送「帮我看看数码的商品」→ 面板标题变为「搜索结果 · 12 件商品 · 数码」，chip 高亮（`aria-pressed`），商品区刷新为数码品类 |
| JustOneAPI 码表与客户端（单测） | `lib/justoneapi/{errors,client}.test.ts`，全部 mock fetch | ✅ 15 个业务码逐个验证类别/重试次数（含 101/202/300/404/503 与 HTTP 401+code100、429+code303 的并存判定）；301→重试成功、500 连续 4 次只尝试 3 次、503 尝试 2 次、302 重试 1 次、303 立即停止；超时重试 1 次；token 缺失且**不发请求**；日志与错误消息均不含 token |
| JustOneAPI 缓存（单测） | `lib/justoneapi/cache.test.ts` | ✅ TTL 300s 命中与过期、同键并发只调一次 loader、失败不缓存且重试可恢复、超过 200 条淘汰最旧 |
| JustOneAPI 字段映射（单测） | `lib/justoneapi/jdSource.test.ts`（夹具为实测响应摘录） | ✅ cid 链 → 7 品类（含刻意不映射的 11729）；搜索价 `"198.00"`→198、价格端点 `19800` 分→198；库存码 33/39/40→40、36→10、34→0、未知码→null；图片相对路径补前缀；归一化产出完整 Product 且不含「品牌」参数行 |
| 校验语义等价性（单测） | 同一组 12 个用例同时喂给 `lib/catalog/products.ts` 与 `scripts/catalog-shared.mjs` 的两份 `isProductLike` | ✅ 12 / 12 判定一致（含 NaN 价格、空描述、越界评分、非对象） |
| 构建期源（真实调用） | `node --env-file=.env.local scripts/build-real-catalog.mjs --source=justoneapi --per=4` | ✅ 搜索 14/14、详情 28/28 成功；产出 `data/justoneapi-catalog.json` 28 件（7 品类各 4 件）；丢弃 172 件（全部为「cid 未映射」，即刻意不接的鞋靴类目等）；**配额消耗 42 次**（失败不计费）；过程中遇到 2 次 `code:301` 均由重试恢复 |
| 原子写入（单测） | `writeJsonAtomically` 成功与失败两条路径 | ✅ 成功替换内容；序列化失败时上一版文件原样保留（无半成品） |
| 构建期中止语义（单测） | mock 返回 `code:303` | ✅ 立即抛出（不重试、不返回半成品）；单条商品 404 只丢该条、不中止构建 |
| `CATALOG_SOURCE=justoneapi` 渲染（本地实测） | `CATALOG_SOURCE=justoneapi npm run dev` → 抓首页 HTML 与客户端 chunk | ✅ HTTP 200、4 次请求无错误；首页品类 chip 显示「数码 4」（= 实时源每品类 4 件，real 快照是 16）→ 服务端确实按实时源解析；商品图为 `img30.360buyimg.com`；无评分商品显示「暂无评分」；**客户端 chunk 内联了源判断**（`if (false) {} return 'justoneapi'`）→ 浏览器与服务器解析同一个源，无 hydration 不一致 |
| `real` 模式零影响 | `npm test` + `npm run build`（默认源） | ✅ 290 个单测全绿；构建通过；快照源行为未变（新增的 justoneapi 目录只作为另一个可选源存在） |
| 实时补充节点（单测，`lib/agent/nodes/enrichLiveData.test.ts`，全部 mock fetch） | 六条判定逐条 / 节点行为 / reducer / 划线价 / grounding 衔接 | ✅ 六条判定各自构造「只差这一条」的输入断言跳过（含 ASIN 场景）；≤3 件上限（价格模式 3 次调用、库存模式 6 次）；部分失败只丢该件；全部失败→空覆盖 + 中性记录 + 不抛错；命中 303 后条件边不再进入；`mergeLiveOverrides` 多轮合并且不污染无关商品；`withLivePrice` 的划线价一致性；覆盖后的价格被 `checkGrounding` 认作真实数据（未登记时会判为编造——用例同时断言了这一点） |
| 实时补充节点（真实调用，`CATALOG_SOURCE=justoneapi`） | 驱动 `/api/agent` 五轮：搜索 → 实时提问 → 库存提问 → 无效 token → 默认源对照 | ✅ ① 搜索轮：`liveOverrides` 空、`liveFetchedAt` null、**0 次调用**（条件边第 3 条挡住）；② 「按现在的价格推荐几款耳机」：时间线出现 `补充实时数据 · 3 件价格`、`liveOverrides` 3 件、价格端点 **3 次**（分→元换算与快照一致：376.4 / 99 / 237.8）；③ 再次提问时命中 **60 秒冷却**（实测 61.9 秒时仍被挡，省下一次调用）；④ 库存模式：时间线 `3 件价格 + 3 件库存`，价格 3 次**命中缓存**（0 新调用）、详情 3 次（284/290/238ms）；⑤ 无效 token：3 次 `HTTP 401 + code 100` 不重试、`liveOverrides` 空、时间线 `实时数据不可用，已用快照数据`、对话与回复正常、无 error 事件；⑥ 默认 `real` 源同样的问法：商品 id 是 `amz-…` → **0 次调用**、时间线无新增、无 error |
| 实时补充节点的配额消耗（本轮实测） | 逐次记录 | ✅ **6 次成功调用计费**（价格 3 + 详情 3）；无效 token 的 3 次失败、冷却被挡的 1 轮、默认源的 1 轮均**不计费** |
| 演示彩排（三阶段，2026-09-25） | 以 `real`（默认）/ `justoneapi` / 无 Key 三种配置各重启一次 dev，用内置浏览器按 `docs/demo-script.md` 顺序走完 9 步 | ✅ 9 步全部走通；逐步结果、实测耗时、脚本逐条修正（12 处）与翻车预案见 [demo-rehearsal.md](./demo-rehearsal.md) |
| — 主路径（默认源，浏览器） | 干净 localStorage → 检索 / 指代 / 对比 / 加购 / 结算 interrupt / 跨会话记忆 / 落地校验 | ✅ 与脚本一致（含「记起你的偏好：图书（来源：成交）」）；系统侧每步 2–4 秒，7 步合计约 20 秒 |
| — 实时标注的浏览器取证（`justoneapi` 源） | 两轮：「推荐几款耳机」→「按现在的价格推荐几款耳机」 | ✅ ① 整页 `实时 ·` 出现 0 次（条件边挡住，零调用）；② **前 3 件**卡片出现 `实时 · 09:42`（第 4 件无标注 = 单轮 3 件上限）、hover 文案「该价格为 09:42 的京东实时查询结果…」、时间线 `补充实时数据 · 3 件价格`（16014ms）、回复引用的 4 个价格与卡片逐个一致且**未触发落地校验重试**；服务端日志 3 行 `get-item-price http=200 code=0 attempt=1` → **3 次计费** |
| — 无 Key 全链路（浏览器） | 清空 `LLM_API_KEY` 重启 → 检索 / 对比 / 加购 / 结算 / 确认下单 | ✅ 全通：时间线全部 `规则解析 / 模板兜底`（无一处 LLM 字样）、商品区出现 `规则兜底` 徽标、模板回复末尾带出画像提示；订单 `ES20260925995029` 实付 ¥180、购物车已清空（`.env.local` 彩排后按备份原样还原，哈希一致） |
| — 服务商故障兜底（Plan B1 实测） | 以无效 Key 启动（`$env:LLM_API_KEY='invalid-…'`，**不改** `.env.local`） | ✅ 401 被节点捕获 → 时间线 `规则解析 · LLM 失败：…` + `模板兜底`，对话与全链路继续；`llmEnabled` 仍为 true（此时**不会**出现「规则兜底」徽标，讲解需指向时间线） |
| — 排序问法校准 | 追问「按价格从低到高排」 | ✅ 价格升序 75 → 80 → 96 → 101 → 101 → 120 → 121 → 180，时间线 `第 1/2 轮调整条件｜图书 · 小说 → 图书 · 小说`（「再便宜点」只收敛预算、**不重排**，脚本已改准） |
| 展示层修复（补充轮，单测锁定，commit `561e772`） | `ruleParser.test.ts` +3 / `parseIntent.test.ts` +3 | ✅ ① 条件串跨列表去重：同词同时在 keywords 与 tags 时只渲染一次，不同词内容与顺序不变；② `sanitizeLlmError` 清洗服务商回显的密钥片段（不含密钥末位与 `api key` 字样，保留 401 与 request_id，普通失败文本不误伤）。tsc 0 / 327 单测全绿 / build 通过 |
| — 修复真机复现 ①（同 thread 混合解析） | 同一 session 先走 LLM 路径「推荐几本小说」→ 以无效 Key 重启后同 thread 再发同一问 | ✅ 快照里 `searchFilters = { keywords: ["小说"], category: "图书", tags: ["小说"] }`（**重复仍在数据里**），而时间线渲染为 `检索「图书 · 小说」` → 去重只作用于展示 |
| — 修复真机复现 ②（无效 Key 的失败文本） | 同上重启后读 `识别意图` 条目 | ✅ `规则解析 · LLM 失败：401 Authentication Fails, 服务商鉴权失败(request_id: 6d70d081-…) · 小说`；对原始 SSE 文件搜测试无效值末 4 位（`zzq7`）与 `api key` 均 0 命中 |
| 实时失败路径（浏览器取证，补充轮，**0 计费**） | `CATALOG_SOURCE=justoneapi` + **无效但非空** token → 清空 localStorage 后两轮对话 | ✅ 全页 `实时 ·` 0 处、4 张卡片无标注；时间线多一条中性 `实时数据不可用，已用快照数据｜1409ms｜部分商品未取到实时值，已保留快照数据`（灰调图标）；`失败/错误/error/重试` 全 0、无 dialog/alert、无弹窗；对话与回复正常、商品仍 4 件；服务端 3 行 `http=401 code=100 attempt=1`（**失败不计费**）。截图 `docs/rehearsal/live-fallback.png` |
| 宽屏真实视口几何（补充轮） | `agent-browser` CLI 驱动本地 Chrome（`set viewport 1440 900 2`）——真实视口，不再是 iframe 推算 | ✅ 三栏 `380 / 700 / 360`、均 `position: static`（top 56、高 844）；`scrollWidth = 1440`，无横向溢出；对比表 `width 309`（表头列宽 54/87/88/81、10 行参数、**3 个绿底最优格**、父容器无横向滚动、右边界 1415 < 1440）；对比表与推理时间线矩形**无交叠**。整页图与对比表图入库：`docs/rehearsal/main-ui.jpg`、`docs/rehearsal/compare-table.png` |
| 目录扩容（本轮，420 件） | `npm run catalog:build -- --per=60`（默认值已与产物对齐） | ✅ 420 件、7 品类各 60；平台 Amazon 280 / Walmart 61 / Lazada 59 / Shopee 20；文件 451 KB；构建 6.8 s；丢弃原因分布见构建输出（图书 缺少图片 722 / Walmart 类目未映射 753 等） |
| — 逐字比对（扩容是否纯追加） | `.cache/compare-first16.mjs`（临时脚本）对比旧 112 件产物 | ✅ 每品类前 16 件 **id 112/112 一致**、**未本地化字段 1456/1456 逐字一致**（价格/评分/评论数/销量/库存/原价/图片/平台/来源 id 等），证明 `--per` 只影响「取多少」不影响「谁被接受」 |
| — 目录不变量扫描（两次） | `.cache/catalog-invariants.mjs` | ✅ 扩容后 0 异常；⚠️ 本地化后 2 异常（描述过短，详见 §8 第 22 条）→ **已修（2026-09-25 收尾轮）**：A+ CSS 降级后重扫 **0 异常** |
| — 增量本地化 | `scripts/localize-catalog.mjs` 增加「跳过已本地化条目」判定 | ⚠️ 当时**没省到**：构建会丢掉上一轮的本地化结果（见 §8 第 23 条），完整流水线第一次跑仍是全量 **70 批 / 221.5 秒** → **已修（2026-09-25 收尾轮）**：`catalog:build` 增加跨产物继承，重跑 build → localize = 继承 420 条 / **0 批** / **0.38 秒** |
| — 已验收文案的保全（112 件） | 全量重译后比对 `.cache/real-catalog.112.json` | ⚠️ 当时首次比对**只有 16/112 逐字未变**（name 66、description 92、tags 65、specifications 20 处被改写），靠一次性脚本 `.cache/restore-approved.mjs` 逐字还原 → **已修（2026-09-25 收尾轮）**：继承上线后重跑 build → localize，420 件 `products` 与重跑前**逐字未变**（含 112 件已验收），一次性脚本不再被依赖（README 已写明流程只需 build → localize 两步） |
| — 计数敏感步骤重测（扩容后，SSE 直连，0 计费） | 第 1 / 3 / 6 步 | ✅ 第 1 步「推荐几本小说」：命中 **30 件**、展示前 12 件（原 8/8）；第 6 步「新会话 + 推荐点什么」：命中 **60 件**、展示前 12 件（原 16/12）、「记起你的偏好：图书（来源：成交）」照旧；⚠️ 第 3 步「对比前 3 件」**前 3 件变了**（Beneath a Scarlet Sky / American Dirt / Troubled Blood，原为 American Dirt / The Vanishing Half / Where the Crawdads Sing）——原因：检索排序是相关性打分而非目录的评论数排序，「扩的是尾部」只对构建成立、对检索排序不成立 |
| 跨产物继承（2026-09-25 收尾轮，关 §8 第 23 条） | 真流程：`npm run catalog:build -- --per=60` → `npm run catalog:localize`（数据集走 `.cache/datasets` 缓存，0 计费） | ✅ 构建输出 `继承已本地化 420 条（id + 英文原文一致），待翻译 0 条`；localize 输出 `已本地化 420 条（跳过判据：带 nameOriginal 标记）、待本地化 0 条` → **实际 LLM 批次 0 / 0.38 秒**；`git diff --stat data/real-catalog.json` = **2 行**（只有 `generatedAt` / `localizedAt` 两个时间戳），`products` 数组深度相等；派生标签 0 处变化 |
| A+ CSS 描述降级（2026-09-25 收尾轮，关 §8 第 22 条） | build + localize 再跑一轮 | ✅ 2 件（`amz-B0009IY8U6` / `amz-B00I35Z6JY`）描述由「来自品牌」4 字 /「来自制造商。」6 字 → 派生文案（本地化后 **88 / 81 字**）；件数仍 **420**（不丢商品）；除这 2 件外 **418 件逐字未变**（逐字段 diff 只有 2 件 × 4 字段：name / description / descriptionDerived / tags）；**1 批（2 条）/ 2.54 秒 / 0 失败**；同流程再跑一轮 = 继承 420 / 0 批（描述基准 guard 不会让这 2 件每轮重译） |
| 本地化判据修正（2026-09-25 收尾轮） | 扫描 420 件产物的 `nameOriginal` | ✅ 发现 40 件（37 图书 + 2 Lazada + 1 Amazon）的译名与英文原文**逐字相同**（书名、品牌+型号，模型按提示词保留原文）——旧判据「`nameOriginal` ≠ `name`」把它们误判成未本地化，会让每次重建都重译这 40 件；判据改为「带 `nameOriginal` 标记」（该字段只有 localize 写入，批次失败不会留半个标记），单测锁定 |
| 继承与降级的单测（2026-09-25 收尾轮） | `lib/catalog/catalog-shared.test.ts`（新增 11 条） | ✅ 继承 8 条：英文原文一致→继承 / 不一致→不继承 / 旧产物缺该 id→不继承 / 首次构建→全不继承 / 译名与原文相同（上面 40 件的真实形态）→仍继承 / 描述基准变化（A+ CSS 降级）→不继承 / 缺标记→不继承 / **继承不改价格·原价·评分·评论数·销量·库存·图片·平台·来源 id（键集合也锁死）**；A+ CSS 降级 3 条：命中→派生（断言拼装结果逐字）/ 正常描述（含 `From the Manufacturer` 前缀）→不误判 / 派生结果过 `isProductLike` 且长度落在扫描区间 10–200（含退化情形） |
| 客户端 bundle 瘦身（2026-09-25 收尾轮 2） | `npm run build` 前后对比（先停 dev） | ✅ 首页 419 → **287 kB**、First Load JS 555 → **423 kB**（−132 kB / −23.8%）；探针实测「目录完全退出客户端」的理论值 428 kB，实际 423 kB（还少了 provider 层的重复数据） |
| — 首屏 chunk 取证 | 构建产物：`.next/server/app/index.html` 里的 10 个首屏 chunk 逐个检索商品 id（`bk-`/`amz-` 前缀） | ✅ **0 命中**；含商品 id 的只有按需 chunk `713.c3c0ea1ced5e54dc.js`（410 KB 原始），且 `app/page` chunk 里存在对它的 dynamic import 引用 → 目录确实退出了首屏，只按需下载 |
| — 服务端注入载荷的源感知（浏览器实读） | `agent-browser` CLI 驱动 Chrome（1440×900）读中栏 chip 与右栏「数据快照」面板；切源后重启 dev | ✅ real：chip 各 **60**、面板 `real · 冻结快照` / **420 件 · 7 品类** / 平台 Amazon 280 · Walmart 61 · Lazada 59 · Shopee 20 / 覆盖率 销量 88-420、评分 420-420、划线价 279-420；mock：chip **10 · 8 · 7 · 7 · 10 · 5 · 3**、面板 `mock · 内置演示数据` / **50 件** / 覆盖率 **50-50-50**；justoneapi：chip 各 **4**、面板 `justoneapi · 实时源产物` / **28 件** / 平台 京东 28 / 覆盖率 0-28-0-28-0-28。三源数字与各自产物一致 → 载荷确实是按当前源现算，没有任何写死计数 |
| — 内联卡与详情弹窗（浏览器） | ① 无效 Key 触发非流式（模板）回复 → 内联卡；② real 源点开卡片详情 | ✅ ① 回复内联卡渲染 2 张（`Troubled Blood … ¥104` / `The Guest List：小说 ¥94`），且网络日志出现 **`_app-pages-browser_lib_catalog_products_ts.js` 按需请求 200**（每次新页面上下文只在有内联卡时请求）→ 目录走按需 chunk；② 弹窗内容完整（名称/品牌/类目/价格 ¥104 / 划线价 ¥209 / 派生图书简介 / 标签 / 规格 5 行），`实时 ·` 计数 0 —— 与卡片一致（real 源本无实时覆盖）。⚠️ 未验到：chunk 请求被 `network route --abort/--body` 拦截（模块脚本请求不被该机制拦截），因此「加载中同高占位」只有构造性证据（占位与卡片同 `p-2` + `size-11` + `gap-2.5`，实测卡片高 **62px**）；失败路径由单测锁定（lookup 抛错 → null、loader catch → 空数组） |
| — 客户端解析单测（2026-09-25 收尾轮 2） | `lib/catalog/client-products.test.ts`（8 条）+ `field-truth.test.ts`（+2 条） | ✅ 载荷：与直接读目录算出的计数/覆盖率/平台分布逐项相等，换一份目录（3 件构造数据）时数字跟着变（证明非写死）；内联卡：命中→商品、未命中→null、lookup 抛错→null 不抛错、一批 id 保序跳过未命中、空列表不触发 chunk import；弹窗：**传入已叠加覆盖的对象 → 解析结果价格=覆盖价 199、id 不变**（「实时」标注不丢）、无覆盖时原样、id 为 null/未命中 → null；会话缓存：从内联卡点开也能解析 |
| 内联卡修复（2026-09-25 冻结轮，关 §8 第 25 条） | 判定：读初始提交注释 / `applySnapshot` 四分支 / 全仓检索；修法：`selectReplyProductIds` 唯一实现 + 快照 `replyProductIds` + store 两处消费 | ✅ **判定为实现遗漏**（依据见 §8 第 25 条）。真机 0 计费逐气泡取证：LLM 正常的两轮回复各挂 **3 张**且 = 中栏前 3 件（`Beneath a Scarlet Sky` / `American Dirt` / `Troubled Blood`，顺序一致）；干净会话发「你好」→ 回复是「没有检索到相关商品…」、**0 张**；无效 Key 模板路径 → **3 张** = 该轮中栏前 3 件。⚠️ **一处如实记录**：模板路径与 LLM 路径的卡片**数量一致（各 3 张）、列表各不相同**——因为两条路径的**解析器**不同（规则解析 vs LLM 解析），检索结果的排序本来就不一样；「共用同一函数」由单测锁定（同一份 `replyProductIds` 喂两条路径 → 同一 id 列表），不是靠两次真机的列表巧合 |
| — 内联卡点击与「实时」标注（冻结轮，0 计费） | ① 点内联卡 → 弹窗；② 中栏换列表后点**旧**内联卡；③ 注入伪造 `liveOverrides` 到持久化快照后刷新 | ✅ ① 弹窗内容完整（作者/类目/评分/派生简介/规格 5 行）、无覆盖时 `实时 ·` 计数 0（与卡片一致）；② 中栏已换成耳机类结果，点旧书卡仍开弹窗（走**会话缓存**分支，§8 第 24 条 ③ 的缓解生效）；③ 卡片与弹窗**同时**显示 `¥1 实时 · 15:01` → 覆盖价与标注在弹窗里都没丢（注入的是客户端自有数据，零计费、事后已清理） |
| — 修复单测（冻结轮） | `lib/agent/sse.test.ts`（5 条）+ `store/use-agent-store.test.ts`（+3 条） | ✅ 选取规则：有商品取前 3（顺序与检索结果一致）/ 不足 3 取全部 / 无商品空数组；`toSnapshot` 下发的 `replyProductIds` 就是 `selectReplyProductIds(searchResults)`；store 两路径：模板回复 3 张、LLM token 气泡补 3 张且**不新建第二个气泡**、无商品时 `productIds` 缺省 |

#### 2026-09-26 解冻轮（Bug A / A-2 / Bug B / 购物车与订单历史抽屉）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 结算弹窗复发的诊断（Bug A） | SSE 直连 `/api/agent`（`real` 源，0 计费），四轮流：`a1` 结算 → `a2` resume confirm → `a3` 再发「你好」→ `a4` 在复发的弹窗上再点确认 | ✅ 复现并定位：`a1` 1 条 `interrupt`（status=pending，正常）；`a2` **1 条 interrupt（status=confirmed）**；`a3` **1 条 interrupt（同一订单，confirmed）** —— 根因是收尾兜底把「`pendingOrder` 非空」当成挂起中断，而 `confirmOrder` 之后该字段一直是 confirmed |
| — 修复后同四轮流（0 计费） | 同上前提，新会话 `diag-f`：`f1` 结算 → `f2` resume confirm → `f3`「你好」→ `f4` 再 resume | ✅ `f1` **1 条 interrupt（pending，正常流程未被修坏）**；`f2/f3/f4` **0 条 interrupt**；`f2` 节点序列 `prepareOrder→confirmOrder→generateReply`、`pendingOrder=ES20260926642726/confirmed`、`cart=0`（订单号与清空购物车都正常） |
| — 前端（浏览器，agent-browser 驱动 Chrome） | 挂购物车 → 抽屉「去结算」→ 确认下单 → 等成功态自动关闭 → **刷新页面** | ✅ 成功弹窗正常出现并自动关闭；**刷新后无成功弹窗**（A-2 修复：成功态由「会话级门 `recentConfirmedOrderId` + 快照里的 confirmed 订单」判定，门不入 `partialize`）；订单历史刷新仍在 |
| — 修复单测 | `lib/agent/sse.test.ts`（+3）、`store/use-agent-store.test.ts`（+4） | ✅ `fallbackInterruptOrder`：pending→订单 / confirmed→null / 无订单→null；store：confirmed 的 interrupt 事件被忽略、pending 的正常打开、resume 期间到达 confirmed 快照写入成功态、**普通一轮带回同一条 confirmed 快照不写成功态（刷新不重播）** |
| 目录件数口径（Bug B） | 比对 `data/real-catalog.json` 的 `products.length`、过 `isProductLike` 后的条数、`CATALOG_META.count` | ✅ 三者一致（420 / 420 / 0 条被丢弃）→ 判定为**口径问题**：面板写的是目录总量，而中栏单次最多展示 12 件。修法：新增只读字段 `searchTotal`（命中总数，截断前）+ 中栏副标题写「共 N 件 · 展示前 M 件」+ 数据快照面板写明「界面按需展示」 |
| — 中栏副标题（浏览器实读） | 1440 视口：检索「推荐几本小说」/「推荐几本悬疑小说」/ 闲聊「你好」 | ✅ 「共 30 件 · 展示前 12 件 · 图书 · 小说」/「**2 件商品** · 图书 · 悬疑 小说」（命中 < 展示上限时不写「展示前 12 件」）/ 闲聊轮回到「为你推荐」+「目录共 420 件 · 按评分与销量精选 12 件」 |
| — refine 后 `searchTotal` 更新（SSE 直连） | 同会话：小说(30) →「再便宜点」(¥200 以内，仍 30，经数据核对全部 ≤¥200) → 再「再便宜点」(¥140 以内) | ✅ 第三轮 **27**，与直接读目录算出的「小说标签且 ≤¥140 的件数 27」一致 → 确实是本轮命中数而不是历史值 |
| — 数据快照面板（浏览器实读） | 1440 视口读面板文本 | ✅ 「目录共 420 件 · 7 品类」+「界面按需展示：首屏精选 12 件；检索单次最多展示前 12 件」 |
| — 单测 | `lib/agent/nodes/searchProducts.test.ts`（+5） | ✅ 命中数多于上限→结果截断且 `searchTotal` 是真实命中数（图书 60）；命中数少于一屏（悬疑 5）→不截断且两数一致；refine 后 `searchTotal` 变小；命中 0→两数都是 0 且 `needsRefine`；序数定位→`searchTotal=1` |
| 购物车 / 订单历史抽屉（浏览器，1440 与 375 两档） | 顶栏购物车图标 → 抽屉；顶栏订单图标 → 抽屉「订单历史」Tab；抽屉内「去结算」→ 确认弹窗；下单 → 历史 | ✅ 抽屉 `420×900`、贴右（x=1020）、`position: fixed`、无横向溢出；窄屏 `375×812` 全宽全高、自带关闭按钮、`scrollWidth=375` 不破版；两 Tab 与件数角标正确；**空态**「购物车是空的」/「还没有订单」正确；抽屉内容与右栏一致（同一 `CartSection`：`商品合计（1 件）` 与 应付 ¥25 两处相同）；点「去结算」→ **抽屉先关闭、再出现居中确认弹窗**（不叠层） |
| — 订单历史来自真实下单 | 下单成功后读抽屉 + `localStorage['eshop-orders']` | ✅ 卡片显示 `ES20260926877136 / 已确认 · 待发货 / 2026-09-26 10:38 / 1 种商品 / Beneath a Scarlet Sky：小说 × 1 / 实付 ¥106`，与 localStorage 中 `status=confirmed` 的订单一致（来源是 `confirmOrder` 落单结果，节点未改动） |
| — 上限 20 条 | 灌 25 条（24 条构造 + 1 条真实）后触发一次真实写入（发一轮消息 → 快照 → `recordOrder`） | ✅ 写后为 **20** 条、真实订单 upsert 到最前、最旧的被截断；渲染 `scrollHeight=2659` 长列表不破版（构造数据事后已清理，仅留真实订单） |
| — 单测 | `lib/order-history.test.ts`（6 条） | ✅ 最新在前 / 同 id 不重复（推 5 次仍 1 条）/ 内容未变返回原数组（不触发 setState）/ pending 与 cancelled 拒绝写入 / 超上限截断 / 同 id 变化时覆盖 |
| 全量校验（解冻轮） | 先停 dev → `tsc` → `npm test` → `npm run build` | ✅ `tsc` 0 错误；**381 个单测全绿（26 个文件）**；build 通过：首页 **288 kB** / First Load **424 kB**（上一轮 287 / 423，+1 kB 为订单 store 与抽屉组件）；共享 103 kB 不变 |

#### 2026-09-26 解冻轮收尾（空结果态 + 演示脚本重走）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 中栏三态修正（关 §8 第 31 条） | 判据抽成 `lib/product-panel-state.ts` 的 `productPanelStateOf`（唯一实现），面板按三态渲染 | ✅ 单测 4 条：有结果→`results`（与意图无关）/ search、refine + 0 命中→`empty-search` / chat、compare、cart、checkout、null + 0 命中→`recommend` / `isSearchIntent` 集合只有 search、refine |
| — 真机（浏览器 1440×900） | ①「十万元以上的商品」②「你好」③「推荐几本小说」 | ✅ ① 中栏 `没有找到符合条件的商品` + `试试放宽条件（价格 / 品类），或看看下面的推荐` + 12 件精选（带「为你推荐」小标题）、**全文无「0 件商品」**；② 仍为 `为你推荐`（**行为不变**）；③ `共 30 件 · 展示前 12 件 · 图书 · 小说`（不变） |
| 演示脚本重走（A 阶段，默认源 + LLM） | `agent-browser` 驱动 Chrome 1440×900，按 `demo-script.md` 第 1–7 步逐条走 | ✅ 7 步全部走通；时间线与中栏原文、逐步耗时、与脚本不符的 5 处（R1–R5）见 [demo-rehearsal.md](./demo-rehearsal.md) 第十节（本轮已按重走结果改准脚本） |
| — 本轮改动的专项验证（6 项） | 两个抽屉入口 / 抽屉结算时序 / 结账后不再复发弹窗 / 刷新不重播 / 副标题两种写法 / 空结果态 | ✅ 全部通过：抽屉 `420×900` 贴右；「去结算」先关抽屉再出居中弹窗（`tabs=[]`，不叠层）；确认下单后发「你好」`[role=dialog]` 数量 **0**；刷新后 `successDialog=false` 且订单历史仍在；副标题 `共 30 件 · 展示前 12 件` / `1 件商品` 两种写法均实测 |
| 演示脚本重走（C 阶段，规则路径） | `$env:LLM_API_KEY='invalid-…'` 注入无效但非空的 Key 后重启（`.env.local` 只读），走第 8 步的四步 | ✅ 检索 / 对比 / 加购 / 结算 → 确认下单全通（订单号 `ES20260926228507`、实付 ¥180、购物车清空），全轮无「LLM 解析 / LLM 生成」字样；时间线里的 401 文本**已被 `sanitizeLlmError` 清洗**（保留 401 与 request_id）——§8-21 在规则路径下的真机证据；两个抽屉在规则路径下同样正常。⚠️ 徽标未复验（无效 Key 注入时 `llmEnabled` 仍为 true），沿用 2026-09-25 记录 |
| — B 阶段（justoneapi） | 未重走 | 本轮未动其代码且需计费，沿用 2026-09-25 证据（`demo-rehearsal.md` 第三、九节） |
| 全量校验（解冻轮收尾） | 先停 dev → `tsc` → `npm test` → `npm run build` | ✅ `tsc` 0 错误；**385 个单测全绿（27 个文件）**；build 通过：首页 **288 kB** / First Load **425 kB**（上一轮 288 / 424，+1 kB 为三态判定与空态渲染）；共享 103 kB 不变 |
| — 重走期间发现（未修） | 见 §8 第 32（检索条件粘性）、33（LLM 文案波动）条 | ⚠️ 两条都已记录，按「不逐个修 §8」的约束**未动代码** |

#### 2026-09-26 品类 chip 轮（检索条件重置 + 无 Key 品类名识别）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 修复前后对照（SSE 直连，0 计费） | 脏会话先发「100 元以内」，再发 chip 原文「帮我看看服饰的商品」 | ✅ 修复前：条件 `服饰 · ¥100 以内`、命中 **4**；修复后：条件 `服饰`、**命中 60 · 展示 12**，时间线多一条 `切换浏览目标：重置上一轮条件｜¥100 以内 → 服饰` |
| — §8-32 场景 | 「十万元以上的商品」→「推荐几本小说」 | ✅ 条件从 `图书 · 小说 · ¥100000 以上`（0 件）变回 `图书 · 小说`（**30 件**），时间线含 `¥100000 以上 → 图书 · 小说` 的重置记录 |
| — refine 基线回归 | 「推荐几本小说」→「刚才那个再便宜点」 | ✅ 继承 `图书 · 小说` 并收敛到 `¥200 以内`（时间线 `图书 · 小说 → 图书 · 小说 · ¥200 以内`）；件数 30 与诊断基线 1 的差异来自 LLM 是否给出 `targetIndex` 的波动，与本轮改动无关 |
| — 首轮带条件回归 | 「500 元以内的透气跑鞋」 | ✅ `运动 · 跑鞋 · 透气 · ¥500 以内`、2 件（不变） |
| — 排序边界 | 「按价格从低到高排」（无品类/关键词）/「服饰，按价格排序」（有品类） | ✅ 前者继承 `图书 · 小说` 只改排序（30 件）；后者重置价格、保留 `sort=price_asc`（60 件） |
| — 干净会话与画像 | 干净会话 chip / 带价位带画像的 chip | ✅ 均 `服饰 · 60 件`（不变；画像不进筛选条件，本轮再次实测） |
| — 规则路径回归（LLM 关，4 条） | chip 消息 / 「你好」/「推荐几本小说」/「推荐几件数码的商品」 | ✅ `search · 服饰 · 60 件`（原为 chat、0 检索）/ 仍 chat / 仍 search（规则路径「小说」进 tags，见 §8-20）/ 仍 60 件 |
| 真机（浏览器 1440×900） | 脏会话「100 元以内」→ 点「服饰 60」chip；再加「500 元以内」→「帮我看看食品的商品」 | ✅ 中栏 `共 60 件 · 展示前 12 件 · 服饰`、chip 高亮（[chip-reset.jpg](./rehearsal/chip-reset.jpg)）；食品轮 `共 60 件 · 展示前 12 件 · 食品` + 时间线 `图书 · 小说 · ¥500 以内 → 食品`（[scope-reset-log.jpg](./rehearsal/scope-reset-log.jpg)） |
| — 一次观察 | 该浏览器会话前两轮的时间线未渲染；第三轮起、以及新建会话的冷启动首轮均正常 | ⚠️ 未复现，判定非本轮改动引入；**已在最终彩排中定位**：不是「前 N 轮不渲染」，而是「整页重载（刷新 / dev 的 Fast Refresh 强制 reload）后 `timeline` 不持久化、其余面板恢复」——机制、实验与演示缓解见下一块与 [demo-rehearsal.md](./demo-rehearsal.md) 11.4（§8-35） |
| 单测 | `parseIntent.test.ts`（+15）/ `ruleParser.test.ts`（+3） | ✅ 继承 / 重置四边界、同值沿用与原话兜底、reducer 语义（显式 undefined 覆盖旧值）、7 品类名与闲聊回归；**403 全绿（27 文件）** |
| 全量校验 | 先停 dev → `tsc` → `npm test` → `npm run build` | ✅ `tsc` 0 错误；build 通过：首页 **288 kB** / First Load **425 kB** / 共享 **103 kB** —— 与上一轮完全一致（Tooltip 复用已有 Radix 依赖）；dev 已恢复运行 |

#### 2026-09-26 最终彩排（A + C 两阶段）与冻结

| 项 | 方法 | 结果 |
| --- | --- | --- |
| A 阶段（默认源 + LLM） | `agent-browser` 驱动 Chrome 1440×900，按脚本第 1–7 步逐条走 | ✅ 7 步全部一致（逐步原文见 [demo-rehearsal.md](./demo-rehearsal.md) 11.1）：`共 30 件 · 展示前 12 件 · 图书 · 小说` → `¥200 以内` 收敛 → 对比 10 项参数 → 加购 → 订单 `ES20260926922726` 实付 ¥106 → 新会话「记起你的偏好（来源：成交）」→ 落地校验拦下 ¥1246 并重试 |
| — 专项（7 项） | chip 脏会话 / tooltip / 副标题三态 / 抽屉两入口 / 抽屉结算时序 / 确认后不复发 / 刷新不重播 | ✅ 全部通过（11.2）：chip `共 60 件 · 展示前 12 件 · 服饰` + `切换浏览目标：重置上一轮条件`；tooltip `该品类目录共 60 件`；`2 件商品 · …` 与空结果态（无「0 件商品」）；订单卡片 `ES20260926922726 / 已确认 · 待发货 / ¥106`；「去结算」先关抽屉（`dialogs=1` 仅弹窗）；确认后「你好」`dialogs=0`；刷新后无成功弹窗、订单历史仍在 |
| C 阶段（规则路径 = 进程级空 Key 启动） | 同法走第 8 步（`.env.local` 只读，用 Node 启动器把 `LLM_API_KEY` 覆盖为空） | ✅ **「规则兜底」徽标真机确认**（关掉此前「徽标未复验」的遗留）；**chip 修复点在真机复验**：`共 60 件 · 展示前 12 件 · 服饰`（原为 chat、0 检索）；检索 30 件（条件串 `小说`）→ 对比 → 加购 → 订单 `ES20260926470717` 实付 ¥180（模板回复明确报号） |
| 时间线「前两轮未渲染」排查 | 冷启动 dev + 多会话 + 刷新对照（11.4） | ✅ 结论：**不能复现**（首轮 3 条 / 第二轮 5 条 / 第二会话 3+3 条）；能复现的是「整页重载后时间线为空、其余面板恢复」——`timeline` 不持久化（设计），原始观察由 dev 的 `Fast Refresh had to perform a full reload` 触发。已记 §8-35，脚本加「开场预热」 |
| 新发现（记录，未修） | 规则路径「题材词进 tags」类别残留 + 「第一」被抽成关键词（11.5 F3 / F4） | ⚠️ 两处均**修复前后行为一致（非本轮引入）**，已记 §8-36 |
| 全量校验（冻结） | 先停 dev → `tsc` → `npm test` → `npm run build` | ✅ `tsc` 0 错误；**403 个单测全绿（27 文件）**；build 通过：首页 288 kB / First Load 425 kB / 共享 103 kB（与上一轮一致）；dev 已恢复运行 |

### 7.2 未验证 / 验证受限

| 项 | 原因 |
| --- | --- |
| ~~桌面三栏（≥1280px）的视觉截图~~ | ✅ **已覆盖（2026-09-25 补充轮）**：改用 `agent-browser` CLI 驱动本地 Chrome（`set viewport 1440 900 2`），拿到真实宽视口整页截图与右栏对比表截图，入库 `docs/rehearsal/`（`main-ui.jpg`、`compare-table.png`）；几何同时实测复核（三栏 380 / 700 / 360、右栏 `static`、无横向溢出） |
| 暗色模式的视觉截图 | 仍只有同源 1440×900 iframe 内的**测量式**证据（令牌全部命中 `.dark` 分支、对比度 ≥ WCAG-AA、画布像素可读），**没有截图**；评审若要"看图"需自行切主题 |
| 以图搜商品 | 需要支持视觉的模型，未实测 |
| 极端时序 | 气泡拆分/计数一致性只验了 3 轮，未做长会话或并发压测 |
| 画像的跨设备 / 跨用户形态 | 按设计不支持（存 localStorage、无 userId），因此**未实现也未验证**；多浏览器同时使用时的隔离性（各自独立画像）未实测 |
| 界面回归保护 | 组件 / E2E **无自动化**：单测覆盖 lib 纯函数与 store 不变量，界面仍依赖手工浏览器验收 |
| 运行时实时补充节点 `enrichLiveData` | **已接入并实测**（见 §7.1 两行）；仍然受限的是：`intent` 被解析为 `compare` / `chat` 时**不经过** `searchProducts`，因此那些问法不会触发实时补充（本轮实测：「那这几款现在多少钱？」被判成 compare、「这几款耳机还有货吗」被判成 chat，均未触发）——这是图结构决定的（节点挂在 searchProducts 之后），要覆盖更多问法需要改意图解析，本轮明确不做 |
| `justoneapi` 源的完整对话流程 | 实时源下已补验**检索 → 实时补充 → 回复**这条主链路（含库存模式、失败降级，2026-09-25 又补了浏览器侧取证）；仍未在实时源下走**加购 → 对比 → 下单**的完整流程 |
| ~~前端「实时」标注的视觉~~ | ✅ **已补验（2026-09-25）**：浏览器截图 + DOM 断言四项齐全（卡片标注 3 处、hover 说明、时间线条目、**失败路径中性记录**），实证见 §7.1 与 [demo-rehearsal.md](./demo-rehearsal.md)。**仍受限**：① 宽屏（≥1280px）下的「实时」标注截图需要一次**真实计费**的实时调用（本轮配额预算 0 次）；② 宽屏下的「规则兜底」徽标截图需要**文件级**清空 `LLM_API_KEY`（本轮硬约束不改 `.env.local`）。两者窄屏均有图，且 [demo-rehearsal.md](./demo-rehearsal.md) 第八节给了逐项自查清单 |
| 构建期源的更大规模 | 本轮用 `--per=4` 控制配额（28 件、42 次调用）；`--per=14`（满目录，预计 ≤112 次调用）未跑，配额上限与耗时未实测 |
| 京东库存状态码的完整枚举 | 只实测到 `33`（有货）；`34/36/39/40` 来自京东官方 IOP 文档枚举，未逐一代码实测（拿不到缺货/预订的真实样本） |

### 7.3 已知的控制台噪声

在途 SSE 请求被**页面刷新 / 导航打断**时，浏览器会记一条 `net::ERR_ABORTED` —— 属浏览器行为，不影响功能，**代码层不处理**（页面卸载时会话与连接一起消失，没有可挽救的动作）。主动中止的三个场景（清除画像 / 清空对话 / 开启新会话）不会产生这条噪声：中止统一走 `lib/agent-client.ts` 的 `abortActiveRequest()`，catch 里用 `error.name === 'AbortError'` 与网络错误区分，前者静默收尾。

---

## 八、已知问题清单

按建议处理优先级排列。

| # | 问题 | 性质 | 建议 |
| --- | --- | --- | --- |
| 1 | **销量覆盖率仅 88/420**，其余 332 件显示「评价 X 条」 | 取舍 | 接受现状，或换带销量字段的数据源 |
| 2 | ~~库存件数是派生值却展示精确数字~~ | 真实性 | ✅ **已修（阶段 11.5）**：界面一律只展示等级，件数退回内部可用性模型；对比表「库存」行改为按等级判优，「现货可发」只在等级有差异时产出 |
| 3 | **无鉴权、无限流** | 安全 | 生产前必须加会话鉴权 + 按用户限流 + 单次 token 上限 |
| 4 | ~~MemorySaver 无上限~~ | 稳定性 | ✅ **已修（阶段 13）**：换 SqliteSaver（WAL + busy_timeout），`session_meta` + 惰性 TTL 清理；初始化失败自动回落内存态 |
| 5 | ~~`tool()` 契约未接入 LLM~~ | 完整性 | ✅ **已决策（方案 b，阶段 13.5）**：评估后判定 tool calling 在本项目是多余的间接层（节点预设 / 路由有限 / 工具与节点一一对应，「动态选择工具集」问题不存在），已删除 `tool()` 包装与未被引用的数组，保留 zod schema；`cartLineSchema` 同时被 `/api/agent` 请求校验复用，消除了原先手写的重复约束 |
| 6 | ~~无分类浏览入口~~ | 功能缺口 | ✅ **已实现（阶段 16）**：中栏「按品类浏览」chip 行（7 个品类 + 件数），点击后发一句自然语言请求走**与对话相同的入口**（`parseIntent → searchProducts`），因此点分类与说品类的结果必然一致；当前品类高亮、重复点击禁用 |
| 7 | ~~无测试、非 git 仓库~~ | 工程化 | ✅ **已修（阶段 11.5）**：Vitest 单测 + git 仓库（远端 `Zeffy-Real/eshopagent`），现共 150 个用例 / 14 个文件 |
| 8 | ~~消息历史不参与 LLM 上下文~~ | 能力边界 | ✅ **已修（阶段 12）**：`parseIntent` 注入最近若干轮历史，可消解「刚才那个」这类指代 |
| 9 | **75 件商品无标签** | 数据完整度 | 源数据无 features 且文案无功能词；带标签过滤的检索会排除它们 |
| 10 | **数据快照需手动刷新** | 运维 | 生产应改为定时任务，或替换为实时电商 API 客户端 |
| 11 | ~~跨会话偏好记忆缺失~~ | 能力边界 | ✅ **已修（阶段 14）**：结构化画像（`lib/profile.ts`），信号只来自真实行为、合并幂等、可查看来源、可一键清空且不被在途信号复活；服务端不持有画像（请求期内经 `config.configurable` 使用，不落 checkpoint）。**边界**：仅同一浏览器有效 |
| 12 | **画像随 prompt 出境到 LLM 服务商** | 安全 / 合规 | demo 阶段**刻意不做合规处理**（无用户告知、无数据处理协议、无出境评估），README「隐私边界」已写明；生产必须评估出境合规与告知义务，或改为本地模型 |
| 13 | **画像无 userId、不随账号迁移** | 能力边界 | 存 localStorage 的必然结果（换浏览器即另一个「用户」）；若要做跨设备需引入账号体系与服务端存储，属另一个量级的改动 |
| 14 | ~~grounding 校验失败直接降级为模板回复~~ | 质量 | ✅ **已实现（阶段 16）**：先带「哪些数字不在数据里」的纠正提示重试一次（用 `invoke` 非流式，避免两段候选拼进同一气泡），仍不符才降级模板；顺带修掉「气泡显示被否决候选」——终态不是候选续写时前端整体替换气泡内容 |
| 15 | **页面刷新 / 导航不中止在途请求** | 资源 | 会话身份变更（清除画像 / 清空对话 / 新会话）已中止并静默收尾；刷新与导航**属浏览器行为**，卸载时连接随会话一起消失，代码层没有可挽救的动作，因此不做处理，只作为已知噪声记录 |
| 16 | **`LLM_FALLBACK_ENABLED` 是死开关** | 配置准确性 | `isLlmEnabled()` 里 `LLM_FALLBACK_ENABLED === 'false' && !isLlmConfigured()` 这一支与随后的 `return isLlmConfigured()` 结果完全相同 —— 两种取值行为一致，变量无实际效果。**本轮不改代码**：二选一（① 实现原语义：`=false` 时未配置就报错而不是降级；② 删掉该变量与 README 对应行），README 环境变量表已先标注为「无实际效果」 |
| 17 | **实时覆盖只影响展示与回复，不重跑筛选 / 排序 / 推荐** | 定位边界 | 本轮定位是「补充信息」而非「重算」：`liveOverrides` 只改展示值与回复上下文，检索结果、排序、对比表数值、决策推荐仍按快照口径计算（对比表价格格只挂「实时」标注、不改数字）。后果是：若某件商品实时价大幅变化，它在「价格升序」里的位置不会随之改变。要改需把覆盖值回注 `searchResults` 并重跑排序——那会破坏「哪个价格来自快照」的可追溯性，与本轮明确约束冲突，**刻意不做** |
| 18 | **实时补充只在 `searchProducts` 之后触发** | 能力边界 | 意图被解析为 `compare` / `chat` 的问法（如「那这几款现在多少钱？」「这几款还有货吗」）不经过 `searchProducts`，因此不会触发实时补充。这是图结构的直接结果（节点挂在检索之后）；要扩大覆盖需要改意图解析或把节点挂到更多边，本轮明确不做。演示时用「按现在的价格推荐几款耳机」这类 search/refine 问法 |
| 19 | ~~条件串可能重复一个词~~（2026-09-25 彩排实测 `图书 · 小说 · 小说`） | 展示层 | ✅ **已修（2026-09-25 补充轮，commit `561e772`）**：`describeFilters`（`lib/agent/ruleParser.ts`）改为按「首次出现」保序做**跨列表**去重（品类 / keywords / tags / brands），**只清洗展示结果、不改 filters 本身**；单测 3 条锁定（`lib/agent/ruleParser.test.ts`）。真机复现：快照里 keywords 与 tags 各存一份「小说」时，时间线渲染为 `图书 · 小说`。⚠️ 需知道的耦合：该函数同时被 `refineSearch` 当作「条件是否变化」的等价比对，去重只影响「同词重复」这种退化写法——`relaxFilters` / `loosenFilters` 都不会在列表之间搬词（函数注释已写明） |
| 20 | **无 Key 时意图面板字段名与 LLM 路径不一致**（「功能 小说」vs「关键词 小说」） | 展示层 | ⛔️ **决策：不改（2026-09-25 补充轮评估后）**。理由：根因是**解析语义**（同一个词进哪个桶），改它超出「只动展示标签」的授权；而只把 tags 的标签改成「关键词」会让两份列表同时非空时出现**两行同名标签**——正是任务要求「停下」的情形。结论：保持现状，[demo-script.md](./demo-script.md) 第 8 步已加备注避免现场被问住 |
| 21 | ~~LLM 失败时时间线原样显示服务商错误文本~~（含服务商掩码后的密钥末位） | 安全（低） | ✅ **已修（2026-09-25 补充轮，commit `561e772`）**：新增 `sanitizeLlmError`（`lib/agent/nodes/parseIntent.ts`），把 `Your api key: ****abcd is invalid` 一类片段整体换成「服务商鉴权失败」，**保留 401 / request_id** 等可诊断信息；单测 3 条（含「普通失败文本不误伤」）。真机复现：时间线不含密钥末位、不含 `api key` 字样。口径与「token 不进日志 / 文档 / commit」一致——UI 时间线同样是被截图与被讲述的界面 |
| 22 | ~~2 件商品本地化后描述过短~~（`amz-B0009IY8U6` 4 字、`amz-B00I35Z6JY` 6 字，形如「来自品牌」） | 数据质量 | ✅ **已修（2026-09-25 收尾轮，commit `ccb0497`）**：根因是这两条的**源 `description` 本身就是亚马逊 A+ 页 CSS**（实测 5977 / 20747 字符），构建期「长度 ≥ 60」的门挡不住。按裁定**降级而不是丢弃**：`normalizeRow` 命中 A+ 页 CSS 特征（`aplus-v2` / `brand-story.cfg` / `display:block`）时把描述换成派生文案（品牌 + 类目 + 商品参数 + 评分/评价数，与图书简介共用 `buildDerivedDescription`），产物带 `descriptionDerived` 标记、件数写进 note。件数仍 420、扫描 0 异常、其余 418 件逐字未变。**只认 CSS 特征、不认 `From the Manufacturer` 前缀**——实测综合样本里 9 件以该前缀开头但正文可读，按前缀判会把好描述误降级 |
| 23 | ~~构建会丢掉上一轮的本地化结果~~ | 工程化 | ✅ **已修（2026-09-25 收尾轮，commit `ccb0497`）**：`catalog:build` 写盘前按「**id 相同 + 英文原文逐字一致**」把上一版的 `name` / `description` / `tags` / `specifications` / `nameOriginal` 继承到新构建结果（纯函数 `inheritLocalizedFields`，在 `scripts/catalog-shared.mjs`），构建输出打印「继承已本地化 N 条，待翻译 M 条」；`localize` 的跳过判据与它共用同一份实现——**判据语义：`nameOriginal` 存在 = 该条目已本地化过（该字段只有 localize 写入；批次失败不留半个标记）**，仅此一处定义（代码注释在 `isLocalizedProduct`）。实测 420 件产物重跑 build → localize = 继承 420 条 / **0 批 LLM 调用 / 0.38 秒**，`products` 逐字未变 → 不再依赖一次性脚本 `.cache/restore-approved.mjs`。**边界**：上游改了标题的条目会被重译一次（判据要求英文原文一致，这是刻意的——标题变了，旧中文文案不再对应）；描述基准变化（A+ CSS 降级）的条目同样重译一次 |
| 24 | **客户端不再持有全量目录**（本轮瘦身的代价，压下了 132 kB） | 架构边界 | 详情弹窗的商品来自「调用方传入的渲染中对象 / 会话内已解析列表」，内联卡按 id 解析走**按需 chunk**（`lib/catalog/client-products.ts`）。由此：① 内联卡从「首帧就有」变为「chunk 到达后出现」（有与卡片同高的占位，实测卡片 **62px**）；② chunk 加载失败时内联卡静默缺失（不报错、不显示「找不到」——与项目既有的「实时补充失败静默」同一口径）；③ 若某个 id 既不在渲染列表也不在会话缓存（正常交互到不了，只能由外部构造），弹窗不打开——今天它会从全量目录里查到。想恢复 ③ 的完全等价，要把弹窗数据源改成服务端接口（引入加载态）或把内联卡商品写进消息对象（改 store 形状），都超出本轮「只动客户端数据流」的授权 |
| 25 | ~~`productIds` 只在非流式回复里写入（LLM 路径没有内联卡）~~ | 能力边界 | ✅ **已修（2026-09-25 冻结轮，commit `85fd462`）**：**判定为实现遗漏**——依据：初始提交里那句注释写的是「逐字路径**等本轮结束再收尾**」，但 `finalizeReply` 只处理文本、没补该字段；同一个 `applySnapshot` 的 4 个分支只有 1 个写了它；全仓（含 docs 与 decisions）**没有一句**说明「LLM 路径不带卡片」；模板回复同样逐字列出了商品却也挂了卡（「冗余」这个理由不成立）。修法：选取规则收敛到 `lib/agent/sse.ts` 的 `selectReplyProductIds`（本轮检索结果**前 3 件**，与模板路径历史取值一致），随快照 `replyProductIds` 下发；store 在 LLM 气泡收尾时补齐、模板路径创建时写入——**节点逻辑与 store 形状都没动**。真机（0 计费）：real 源 LLM 正常的两轮回复各挂 **3 张**（逐气泡取证，= 中栏前 3 件）；干净会话发「你好」**0 张**（该轮无商品）；无效 Key 模板路径 **3 张** = 该轮中栏前 3 件；点内联卡详情弹窗正常；再往持久化快照注入伪造 `liveOverrides`（客户端自有数据、零计费）→ **卡片与弹窗都显示 `¥1 实时 · 15:01`**，覆盖价与标注在弹窗里都没丢。单测 8 条：选取规则（有/不足/无）、`toSnapshot` 下发值、两条路径同一列表、无商品不挂卡 |
| 26 | ~~结算弹窗在**已确认下单**之后仍会再弹~~（确认后再发任意消息，弹窗复现） | 缺陷 | ✅ **已修（2026-09-26 解冻轮）**：根因是**两处叠加**——`confirmOrder` 把 `pendingOrder` 置为 confirmed 后**不再清空**（语义是「最近一次订单状态」），而 `sse.ts` 的收尾兜底把「`pendingOrder` 非空」误读成「有挂起中断」，于是此后**每一轮**收尾都会把这条已完成订单当新中断推给前端（前端 `case 'interrupt'` 又无条件写入 `interruptedOrder`）。修法：兜底收紧为**只认 `status === 'pending'`**（纯函数 `fallbackInterruptOrder`，主路径 `findOrderInterrupt` 一行未动）+ 前端对 confirmed 事件防御性忽略。协议层四轮流实测：修复前 `a2/a3` 各 1 条 confirmed interrupt → 修复后 `f2/f3/f4` **全 0**，而 `f1`（真实结算）仍有 1 条 pending interrupt；单测 3 + 4 条锁定 |
| 27 | ~~刷新页面会重播「下单成功」弹窗~~（成功态从持久化快照里的 confirmed 订单推出） | 缺陷 | ✅ **已修（与第 26 条同轮，同源）**：成功态改为「**会话级门** `recentConfirmedOrderId`（只在确认下单的 resume 在途期间写入、**不持久化**）+ 快照里的 confirmed 订单」双条件；successOrderOf 的判据与刷新验证见 §7.1（刷新后无弹窗、订单历史仍在）。单测：resume 期间写入 / 普通一轮不写 |
| 28 | ~~面板写「420 件」而界面看不到 420 件~~（口径不清） | 展示层 | ✅ **已澄清（2026-09-26 解冻轮）**：三者一致（产物 420 / 过校验 420 / `CATALOG_META.count` 420，0 条被丢弃）→ 是**展示口径**而非数据问题。修法：新增只读字段 `searchTotal`（本轮命中数，截断前）+ 中栏副标题「共 N 件 · 展示前 M 件」（命中 < 展示上限时只写件数）+ 数据快照面板写明「目录共 420 件…界面按需展示」+ README/本文同步。单测 5 条 + 浏览器实读见 §7.1 |
| 29 | **订单历史只存在本浏览器**（localStorage，无账号体系 / 无导出） | 架构边界（新） | 与购物车、画像同构：换浏览器 / 清浏览器数据即丢，不跨设备、不跨用户；服务端只持有「图状态里那一条 `pendingOrder`」，不提供历史接口。要做跨端需要账号体系 + 服务端存储 + 数据出境评估（另一个量级）。**明确不做**导出与「再来一单」 |
| 30 | ~~检索命中为 0 时中栏回落到推荐位~~（不显示「0 件商品」） | 已知行为（既有） | ✅ **已被第 31 条取代（2026-09-26 解冻轮收尾）**：三态修正后，「搜索类意图 + 0 命中」有独立的空结果文案；本条保留作为问题沿革记录 |
| 31 | ~~**搜索类意图 + 0 命中**时中栏静默回落成「为你推荐」~~（用户分不清「没搜到」还是「被当成闲聊」） | 展示层 | ✅ **已修（2026-09-26 解冻轮收尾）**：中栏由两态改**三态** —— 判据抽成 `lib/product-panel-state.ts` 的 `productPanelStateOf`（唯一实现，读 snapshot 的 `intent`/`searchTotal`/`searchResults.length`，**不在客户端重新推导意图**）：`results`（有结果，与意图无关）/ `empty-search`（**搜索类意图** = `search` / `refine`，且命中 0）/ `recommend`（其余意图，**闲聊轮行为不变**）。空结果态文案：标题 `没有找到符合条件的商品` + 说明 `试试放宽条件（价格 / 品类），或看看下面的推荐`，下方仍给 12 件精选（带「为你推荐」小标题）。`compare` / `cart` / `checkout` 刻意**不算**搜索类（那些轮次里 0 结果不是「搜索失败」） |
| 32 | ~~**检索条件的「粘性」**：某轮设过的字段会被后续搜索继承~~ | 真实缺陷 | ✅ **已修（2026-09-26 品类 chip 轮，commit `d646ea2`）**：现象：`searchFilters` 是**浅合并** reducer（refine 只改一个字段的既定语义），而 `parseIntent` 的 `toFilters` 只写「本轮解析出来的字段」、**不把未提到的字段置空** → 一旦某轮设过 `minPrice`（实测「十万元以上的商品」→ `minPrice=100000`），后续**新的搜索**若没重新给出该字段就会继承它（实测后续「推荐几本小说」仍带 ¥100000 下限 → 命中 0、中栏停在空结果态）。诊断把根因修正为**三个叠加**：① 浅合并 reducer 让「未提到的字段」留下；② `parseIntent` 的 refine 分支无条件继承；③ **LLM 会把 prompt 里「当前筛选条件」的旧值写回输出**（实测 chip 轮带回 `maxPrice`、排序轮带回 `category`），使「本轮说了什么」与「原样输出」不可区分。修法：`parseIntent` 收敛为**唯一判定点**（`isScopeSwitch` / `resetRefinements`）——本轮**新给出**品类或关键词、且没有新的细分条件（价格 / 评分 / 标签 / 品牌）→ 重置上一轮细分条件（`sort` 是展示偏好，不参与判据也不被重置）；同值字段视为沿用（LLM 带回来的旧值），但用户原话里出现过的同值（重述预算）仍算本轮条件。`toFilters` 补齐全键（未解析出 = 显式 undefined），reducer 提为具名导出 `mergeSearchFilters`，由单测钉住「显式 undefined 覆盖旧值」。重置发生时时间线写一条中性记录（`切换浏览目标：重置上一轮条件｜… → 服饰`）。**实测**：脏会话（先「100 元以内」）点服饰 chip 从 4 件变回 60 件；「十万元以上 → 推荐几本小说」从「图书 · 小说 · ¥100000 以上」（0 件）变回「图书 · 小说」（30 件）。单测 +18；`demo-script.md` 加分动作里「演完新会话清条件」的提醒已随之删除 |
| 33 | **LLM 文案波动两例**（非缺陷） | 记录 | ① 空结果轮模型复述了上一轮对比（判定以中栏文案与时间线为准）；② 有一轮把**已确认**的订单称作「待确认」（状态是 confirmed，看时间线与订单历史 `已确认 · 待发货`）。都是模型自由生成文本的波动，代码层无对应缺陷；`demo-script.md` 第 5 步已加提醒 |
| 34 | ~~无 Key 时点品类 chip 不检索~~（规则路径下「帮我看看服饰的商品」判 chat、条件被清、回通用引导） | 功能缺口 | ✅ **已修（2026-09-26，与第 32 条同轮，commit `d646ea2`）**：根因是规则解析器的品类词表**漏了 4 个品类名**（服饰 / 食品 / 家居 / 美妆 —— 运动 / 数码 / 图书此前已有），且「帮我看看<品类>的商品」不命中任何 search 触发词。修法只补 7 个品类名本身（**不扩充通用词表**，避免改变其他意图判定）+ 品类名触发 search 意图（放在规则列表最后，让对比 / 结算 / 加购 / 细化优先命中）。实测（LLM 关）：chip 消息变为 `search · 服饰 · 60 件`；`你好` 仍 chat、`推荐几本小说` 仍 search（规则路径「小说」进 tags，字段名差异见第 20 条）、`推荐几件数码的商品` 仍 60 件 |
| 35 | **页面重载后时间线为空**（`timeline` 不持久化；重载只恢复对话 / 快照 / 画像） | 已知行为（设计） | 现象：刷新（或 dev 的 Fast Refresh 整页重载）后右栏时间线显示「等待 Agent 行动」，而对话、中栏（`snapshot`）、意图面板、画像全部恢复；**发任意一条消息后时间线即恢复**（每轮重置、只看当轮是既定语义）。排查（2026-09-26 最终彩排 11.4）：冷启动 dev + 全新会话的**首轮与第二轮时间线都正常**（3 / 5 条），第二会话同样正常 —— 「前两轮不渲染」**不能复现**；原始观察的触发源是旧 dev 日志里的 `⚠ Fast Refresh had to perform a full reload`（会话期间有文件写入），整页重载 = 刷新，签名完全一致（快照里有 5 条、界面为空）。**演示缓解**：不要刷新页面、演示期间不要在项目里保存文件或跑构建；若面板已空，发一条消息即恢复（`demo-script.md` 准备一节已加「开场预热」） |
| 36 | **规则路径的两处条件污染**（① 题材词进 tags 导致类别残留；② 序数词被抽成关键词） | 真实缺陷（成本高，记录不修） | ① 先点「服饰」chip（或任何带品类的轮次）后说「推荐几本小说」→ 规则解析把「小说」归入 `tags`（第 20 条的桶语义），而「切换浏览目标」判据只认 `category` / `keywords` → 不触发重置，检索「服饰 · 小说」0 命中后被自动放宽丢掉「小说」→ 回到服饰全量（用户要小说拿到服饰）。LLM 路径正常（「小说」进 `keywords` → 30 件）。② 「把第一件加入购物车」在规则路径下抽词抽到「第一」（目录商品名里的字面片段）→ 条件串被写成「第一」并顶掉上一轮条件（加购本身正常、由序号定位，检索结果不受影响）。两处都**已确认修复前后行为一致（非本轮引入）**；①的修法要动规则解析的桶语义（第 20 条明确不改）或给判据引入「题材词」名单（词表扩展被禁止），②的修法要收紧关键词抽取（会波及其他输入）→ 只记录（[demo-rehearsal.md](./demo-rehearsal.md) 11.5 F3 / F4） |

---

## 九、建议的审查切入点

1. **先核数据**：抽 3–5 条 `data/real-catalog.json`（含图书）对照 `README.md` 的「哪些是真实数据」表，确认没有夸大。
2. **再定取舍**：第八节第 1 条（销量覆盖率 88/420）——它直接决定界面观感与真实性口径。派生库存那条已在阶段 11.5 解决（界面只展示等级）。
3. **核记忆机制**：按第八节第 11 – 13 条与 README「记忆机制 / 隐私边界」两节，重点核对三件事 —— 画像字段能否逐项追溯到真实行为、规则路径是否真的用上了画像（无 Key 时回复里应能看到提示）、边界表述是否与实际实现一致（同一浏览器、画像出境、可清除）。
4. **跑一遍主链路**：`npm run dev` → 「推荐几本小说」→「对比前 3 件」→「结算」，重点看右栏各面板与中栏商品区是否一致。
5. **看收敛度**：本期改动集中的文件是 `lib/agent-client.ts`（中止单一入口）、`store/use-agent-store.ts`、`lib/agent/nodes/parseIntent.ts`、`lib/profile.ts`、`app/api/agent/route.ts`。

---

## 附录：如何复现与重建

```bash
npm install

# 重建商品目录（首次会自动下载数据集，之后走 .cache/datasets 缓存）
npm run catalog:build              # 默认每品类 16 条
node scripts/build-real-catalog.mjs --per=16 --refresh   # 强制拉最新数据

# 重新本地化（需要 .env.local 配 LLM_BASE_URL / LLM_API_KEY）
npm run catalog:localize           # 翻译文案 + 派生标签
node scripts/localize-catalog.mjs --tags-only   # 只重算标签，跳过翻译

# 校验与运行
npm run typecheck
npm run build
npm run dev                        # http://localhost:3000
```

### 环境变量

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `LLM_BASE_URL` | OpenAI 兼容接口地址 | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 接口密钥 | `sk-...` |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |
| `LLM_FALLBACK_ENABLED` | 是否允许规则兜底（默认 true） | `true` |
| `CATALOG_SOURCE` | 商品目录数据源：`real`（默认）/ `mock` | `real` |
| `HISTORY_ENABLED` | 是否把最近若干轮对话注入意图解析（默认 true） | `true` |
| `HISTORY_MAX_CHARS` | 历史注入的字符预算（约 2 字符 ≈ 1 token），默认 2000 | `2000` |
| `CHECKPOINT_BACKEND` | 会话持久化后端：`sqlite`（默认，落盘）/ `memory`；初始化失败自动回落 | `sqlite` |
| `CHECKPOINT_DB_PATH` | SQLite 落盘位置（含完整对话内容，已 gitignore，不要放进 `public/`） | `.cache/checkpoints.sqlite` |
| `SESSION_TTL_DAYS` | 超过该天数未活跃的会话会被清理（新会话创建时惰性触发） | `7` |
