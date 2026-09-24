# 项目现状说明书

> 用途：供审查（review）使用。描述**当前真实状态**，包括已完成、已验证、未验证与已知问题，不做美化。
>
> - 数据快照生成时间：2026-09-24 06:30 UTC
> - 文案本地化时间：2026-09-24 06:31 UTC
> - 版本锚点：git 仓库 `https://github.com/Zeffy-Real/eshopagent`，本次同步前 HEAD 为 `c0f053c`（阶段 16）
> - 校验状态：`tsc --noEmit` 0 错误；**159 个单测全绿（16 个文件）**；`next build` 通过

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
| 源码规模 | **109 个 `.ts` / `.tsx` 文件**（`app` / `components` / `lib` / `store`） |
| 页面与接口 | `app` 下 2 个页面（`/`、`/_not-found`）+ 2 个 API 路由 |
| Agent 节点 | **8 个**（`lib/agent/nodes/`） |
| 测试 | **159 个单测用例**（Vitest，16 个文件，覆盖口径一致性的唯一实现、记忆机制、会话持久化、落地校验重试与在途请求中止）；无组件/E2E 自动化测试 |
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
    nodes/                      8 个节点，每个节点一个文件
    tools/                      productTools / cartTools（纯函数 + zod 入参契约）
  catalog/products.ts           商品目录唯一入口（real | mock 可切换）
  profile.ts                    跨会话画像：信号提取 + 幂等合并 + 提示文案（纯函数）
  cart-pricing.ts               购物车金额规则（纯函数，前后端共用）
  decision.ts                   决策推荐理由与对比结论（纯函数）
  utils.ts                      cn / 价格格式化 / formatCount / hasRealSales
  agent-client.ts               SSE 客户端（在途请求的中止入口、AbortError 分类）
components/
  chat/ product/ visualization/ charts/ order/ layout/ common/ ui/
data/real-catalog.json          真实商品数据快照（由 scripts 生成）
scripts/
  build-real-catalog.mjs        多源真实数据 → 统一 Product 模型
  localize-catalog.mjs          LLM 文案本地化 + 标签派生
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

**112 件商品，7 个品类各 16 件。**

| 平台 | 件数 | 有真实销量的件数 |
| --- | --- | --- |
| Amazon | 90 | 10 |
| Walmart | 15 | 0 |
| Lazada | 7 | 7 |
| **合计** | **112** | **17** |

> 另有 21 件商品没有任何标签（数码 2 / 服饰 1 / 食品 6 / 运动 3 / 美妆 9）——它们既没有源数据 features，本地化文案里也不含功能词，因此派生不出标签。

### 4.3 字段真实性边界

| 字段 | 来源 |
| --- | --- |
| 标题 / 品牌（图书为作者） / 描述 / 类目 / 商品参数 / 图片 / ASIN·SKU | **真实**，来自数据集原始字段 |
| 价格 / 原价 | **真实**（各平台原币种），按固定汇率表折算为人民币展示 |
| 评分 / 评论数 | **真实**；缺失时如实显示「暂无评分」，不编造分数 |
| 销量 | **真实但覆盖率有限**：仅 Amazon `bought_past_month`（204/1000 行有值）与 Lazada `number_sold` 为真字段；Shopee `sold` 全为 0、Walmart 无该列 → 一律记 `sales: 0`，界面改展示真实评价数 |
| 库存状态（有货/缺货） | **真实**信号（`availability` / `is_available` / `in_stock`） |
| 库存件数 | ✅ **派生且界面不展示**（已修）：真实数据源里没有任何一件商品带真实库存件数（只有 Shopee 有 `stock` 字段，而当前目录已无 Shopee 商品），件数全部由 `21 + hash % 480` 派生。现仅作为**内部可用性模型**（缺货不可加购、加购上限、缺货惩罚），界面一律只展示「有货 / 库存紧张 / 缺货」等级 |
| 图书简介 | ⚠️ **派生文案**：源数据 `description` 是亚马逊 A+ 页面原始 CSS，不可用，改为用真实字段（作者/类目/评分/可选版本）拼装 |
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
| 4. 语义记忆 / 向量检索（RAG） | —— | **不做** | ⛔️ 刻意不做：112 件结构化商品用「关键词 + 标签 + 排序」已够用；embedding 要么再依赖外部 API（破坏「无 Key 也能完整跑通」）要么引入本地模型；同时讲 LangGraph 与 RAG 会稀释表达重点。完整理由见 README「记忆机制」 |

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

---

## 七、验证状态

### 7.1 已验证

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit` | ✅ 0 错误 |
| 单测 | `npm test`（Vitest，16 个文件） | ✅ 159 / 159 通过 |
| 跨重启持久化 | 建会话 → 杀进程（确认端口无监听）→ 重启 → 同 sessionId 追问指代 | ✅ 恢复上一轮上下文（时间线显示「历史 366 字」），指代解析为 refine 并收紧价格 |
| 内存态回落 | `CHECKPOINT_BACKEND=memory` 独立用例 | ✅ 不建连接、会话管理安全跳过、checkpointer 仍可用、不产生 sqlite 文件 |
| 构建 | `npm run build` | ✅ 通过；首页 327 kB / First Load 464 kB；共享 103 kB |
| 目录不变量 | 脚本扫描 112 件商品的价格/评分/评论数/销量/库存/原价/图片/描述/标签/规格等 | ✅ 0 异常 |
| 图书数据 | 逐条核对 16 本 | ✅ 真实书名、作者、价格、评分、评论数、封面、题材标签齐全，无近重复 |
| 端到端（浏览器） | 3 轮对话 + 完整下单流程 | ✅ 通过 |
| — 图书检索 | 发「推荐几本小说」 | ✅ 命中 8 本真实书籍，回复总数与商品区一致（8 = 8） |
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
| 分类浏览入口（浏览器） | 切到「商品」Tab → 点「数码 16」 | ✅ 发送「帮我看看数码的商品」→ 面板标题变为「搜索结果 · 12 件商品 · 数码」，chip 高亮（`aria-pressed`），商品区刷新为数码品类 |

### 7.2 未验证 / 验证受限

| 项 | 原因 |
| --- | --- |
| 桌面 / 暗色的视觉截图 | 运行时**没有 viewport/resize 工具**，桌面三栏与暗色是在同源 1440×900 iframe 内以**测量方式**验证（几何、计算样式、滚动行为、画布像素），截不到桌面宽度的整图；评审若要"看图"，需在 ≥1280px 的窗口里自行打开 |
| 以图搜商品 | 需要支持视觉的模型，未实测 |
| 极端时序 | 气泡拆分/计数一致性只验了 3 轮，未做长会话或并发压测 |
| 画像的跨设备 / 跨用户形态 | 按设计不支持（存 localStorage、无 userId），因此**未实现也未验证**；多浏览器同时使用时的隔离性（各自独立画像）未实测 |
| 界面回归保护 | 组件 / E2E **无自动化**：单测覆盖 lib 纯函数与 store 不变量，界面仍依赖手工浏览器验收 |

### 7.3 已知的控制台噪声

在途 SSE 请求被**页面刷新 / 导航打断**时，浏览器会记一条 `net::ERR_ABORTED` —— 属浏览器行为，不影响功能，**代码层不处理**（页面卸载时会话与连接一起消失，没有可挽救的动作）。主动中止的三个场景（清除画像 / 清空对话 / 开启新会话）不会产生这条噪声：中止统一走 `lib/agent-client.ts` 的 `abortActiveRequest()`，catch 里用 `error.name === 'AbortError'` 与网络错误区分，前者静默收尾。

---

## 八、已知问题清单

按建议处理优先级排列。

| # | 问题 | 性质 | 建议 |
| --- | --- | --- | --- |
| 1 | **销量覆盖率仅 17/112**，其余 95 件显示「评价 X 条」 | 取舍 | 接受现状，或换带销量字段的数据源 |
| 2 | ~~库存件数是派生值却展示精确数字~~ | 真实性 | ✅ **已修（阶段 11.5）**：界面一律只展示等级，件数退回内部可用性模型；对比表「库存」行改为按等级判优，「现货可发」只在等级有差异时产出 |
| 3 | **无鉴权、无限流** | 安全 | 生产前必须加会话鉴权 + 按用户限流 + 单次 token 上限 |
| 4 | ~~MemorySaver 无上限~~ | 稳定性 | ✅ **已修（阶段 13）**：换 SqliteSaver（WAL + busy_timeout），`session_meta` + 惰性 TTL 清理；初始化失败自动回落内存态 |
| 5 | ~~`tool()` 契约未接入 LLM~~ | 完整性 | ✅ **已决策（方案 b，阶段 13.5）**：评估后判定 tool calling 在本项目是多余的间接层（节点预设 / 路由有限 / 工具与节点一一对应，「动态选择工具集」问题不存在），已删除 `tool()` 包装与未被引用的数组，保留 zod schema；`cartLineSchema` 同时被 `/api/agent` 请求校验复用，消除了原先手写的重复约束 |
| 6 | ~~无分类浏览入口~~ | 功能缺口 | ✅ **已实现（阶段 16）**：中栏「按品类浏览」chip 行（7 个品类 + 件数），点击后发一句自然语言请求走**与对话相同的入口**（`parseIntent → searchProducts`），因此点分类与说品类的结果必然一致；当前品类高亮、重复点击禁用 |
| 7 | ~~无测试、非 git 仓库~~ | 工程化 | ✅ **已修（阶段 11.5）**：Vitest 单测 + git 仓库（远端 `Zeffy-Real/eshopagent`），现共 150 个用例 / 14 个文件 |
| 8 | ~~消息历史不参与 LLM 上下文~~ | 能力边界 | ✅ **已修（阶段 12）**：`parseIntent` 注入最近若干轮历史，可消解「刚才那个」这类指代 |
| 9 | **21 件商品无标签** | 数据完整度 | 源数据无 features 且文案无功能词；带标签过滤的检索会排除它们 |
| 10 | **数据快照需手动刷新** | 运维 | 生产应改为定时任务，或替换为实时电商 API 客户端 |
| 11 | ~~跨会话偏好记忆缺失~~ | 能力边界 | ✅ **已修（阶段 14）**：结构化画像（`lib/profile.ts`），信号只来自真实行为、合并幂等、可查看来源、可一键清空且不被在途信号复活；服务端不持有画像（请求期内经 `config.configurable` 使用，不落 checkpoint）。**边界**：仅同一浏览器有效 |
| 12 | **画像随 prompt 出境到 LLM 服务商** | 安全 / 合规 | demo 阶段**刻意不做合规处理**（无用户告知、无数据处理协议、无出境评估），README「隐私边界」已写明；生产必须评估出境合规与告知义务，或改为本地模型 |
| 13 | **画像无 userId、不随账号迁移** | 能力边界 | 存 localStorage 的必然结果（换浏览器即另一个「用户」）；若要做跨设备需引入账号体系与服务端存储，属另一个量级的改动 |
| 14 | ~~grounding 校验失败直接降级为模板回复~~ | 质量 | ✅ **已实现（阶段 16）**：先带「哪些数字不在数据里」的纠正提示重试一次（用 `invoke` 非流式，避免两段候选拼进同一气泡），仍不符才降级模板；顺带修掉「气泡显示被否决候选」——终态不是候选续写时前端整体替换气泡内容 |
| 15 | **页面刷新 / 导航不中止在途请求** | 资源 | 会话身份变更（清除画像 / 清空对话 / 新会话）已中止并静默收尾；刷新与导航**属浏览器行为**，卸载时连接随会话一起消失，代码层没有可挽救的动作，因此不做处理，只作为已知噪声记录 |
| 16 | **`LLM_FALLBACK_ENABLED` 是死开关** | 配置准确性 | `isLlmEnabled()` 里 `LLM_FALLBACK_ENABLED === 'false' && !isLlmConfigured()` 这一支与随后的 `return isLlmConfigured()` 结果完全相同 —— 两种取值行为一致，变量无实际效果。**本轮不改代码**：二选一（① 实现原语义：`=false` 时未配置就报错而不是降级；② 删掉该变量与 README 对应行），README 环境变量表已先标注为「无实际效果」 |

---

## 九、建议的审查切入点

1. **先核数据**：抽 3–5 条 `data/real-catalog.json`（含图书）对照 `README.md` 的「哪些是真实数据」表，确认没有夸大。
2. **再定取舍**：第八节第 1 条（销量覆盖率 17/112）——它直接决定界面观感与真实性口径。派生库存那条已在阶段 11.5 解决（界面只展示等级）。
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
