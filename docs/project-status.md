# 项目现状说明书

> 用途：供审查（review）使用。描述**当前真实状态**，包括已完成、已验证、未验证与已知问题，不做美化。
>
> - 数据快照生成时间：2026-09-24 06:30 UTC
> - 文案本地化时间：2026-09-24 06:31 UTC
> - 当前目录**不是 git 仓库**，因此没有 commit 号可作为版本锚点
> - 校验状态：`tsc --noEmit` 0 错误；`next build` 通过

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
| Agent 框架 | `@langchain/langgraph` 1.4（StateGraph + MemorySaver + interrupt） |
| LLM 封装 | `@langchain/openai` 1.5（ChatOpenAI，`baseURL` 兼容 DeepSeek / 通义千问 / OpenAI） |
| 流式 | LangGraph `streamEvents()` → 后端 SSE → 前端 `fetch` + `ReadableStream` |
| 源码规模 | **89 个 `.ts` / `.tsx` 文件** |
| 页面与接口 | `app` 下 2 个页面（`/`、`/_not-found`）+ 2 个 API 路由 |
| Agent 节点 | **8 个**（`lib/agent/nodes/`） |
| 测试 | **116 个单测用例**（Vitest，12 个文件，覆盖口径一致性的唯一实现、会话持久化与过期清理）；无组件/E2E 自动化测试 |
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
    checkpointer.ts             globalThis 单例 MemorySaver（热更新不丢会话）
    llm.ts                      ChatOpenAI 封装（未配置时优雅降级）
    structured.ts               结构化输出三级降级
    grounding.ts                回复落地校验（防 LLM 编造金额与口径）
    prompts.ts                  System Prompt 与上下文构建
    ruleParser.ts               规则解析器（无 LLM 时的主路径）
    sse.ts                      streamEvents → SSE
    events.ts                   前后端共用事件协议
    nodes/                      8 个节点，每个节点一个文件
    tools/                      productTools / cartTools（纯函数 + LLM 工具契约）
  catalog/products.ts           商品目录唯一入口（real | mock 可切换）
  cart-pricing.ts               购物车金额规则（纯函数，前后端共用）
  decision.ts                   决策推荐理由与对比结论（纯函数）
  utils.ts                      cn / 价格格式化 / formatCount / hasRealSales
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

1. **落地校验**（`lib/agent/grounding.ts`）：抽取回复里所有 ¥ 金额，逐个核对是否来自真实数据（商品价 / 原价 / 数量小计 / 优惠 / 运费 / 应付 / 两两价差）；「万」口径也必须与界面一致。任一不符即改用模板回复并在时间线标注原因。
2. **流式过滤**（`lib/agent/sse.ts`）：只把 `generateReply`（唯一面向用户的节点）的 token 推给前端，`parseIntent` / `manageCart` 的结构化 JSON 属内部中间结果，不外泄。

---

## 六、本次变更清单

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

---

## 七、验证状态

### 7.1 已验证

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit` | ✅ 0 错误 |
| 单测 | `npm test`（Vitest，12 个文件） | ✅ 116 / 116 通过 |
| 跨重启持久化 | 建会话 → 杀进程（确认端口无监听）→ 重启 → 同 sessionId 追问指代 | ✅ 恢复上一轮上下文（时间线显示「历史 366 字」），指代解析为 refine 并收紧价格 |
| 内存态回落 | `CHECKPOINT_BACKEND=memory` 独立用例 | ✅ 不建连接、会话管理安全跳过、checkpointer 仍可用、不产生 sqlite 文件 |
| 构建 | `npm run build` | ✅ 通过；首页 326 kB / First Load 461 kB；共享 103 kB |
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

### 7.2 未验证 / 验证受限

| 项 | 原因 |
| --- | --- |
| 桌面三栏并排布局 | 浏览器视口被环境固定为 444×559，只验了窄屏形态（对话/商品分 Tab、右栏为抽屉）；`xl`（≥1280px）三栏布局未实测 |
| 暗色模式 | 未在本次验收中覆盖 |
| 以图搜商品 | 需要支持视觉的模型，未实测 |
| 极端时序 | 气泡拆分/计数一致性只验了 3 轮，未做长会话或并发压测 |
| 回归保护 | **无自动化测试**，全部依赖手工浏览器验收 |

### 7.3 已知的控制台噪声

在途 SSE 请求被**页面刷新 / 导航打断**时，浏览器会记一条 `net::ERR_ABORTED`（属浏览器行为，不影响功能；正常发送 3 轮实测 0 新增）。彻底消除需要在 `lib/agent-client.ts` 显式管理 `AbortController` 并区分「主动中止」。

---

## 八、已知问题清单

按建议处理优先级排列。

| # | 问题 | 性质 | 建议 |
| --- | --- | --- | --- |
| 1 | **销量覆盖率仅 17/112**，其余 95 件显示「评价 X 条」 | 取舍 | 接受现状，或换带销量字段的数据源 |
| 2 | ~~库存件数是派生值却展示精确数字~~ | 真实性 | ✅ **已修（阶段 11.5）**：界面一律只展示等级，件数退回内部可用性模型；对比表「库存」行改为按等级判优，「现货可发」只在等级有差异时产出 |
| 3 | **无鉴权、无限流** | 安全 | 生产前必须加会话鉴权 + 按用户限流 + 单次 token 上限 |
| 4 | ~~MemorySaver 无上限~~ | 稳定性 | ✅ **已修（阶段 13）**：换 SqliteSaver（WAL + busy_timeout），`session_meta` + 惰性 TTL 清理；初始化失败自动回落内存态 |
| 5 | **`tool()` 契约未接入 LLM** | 完整性 | 数组与 zod schema 已写好，但节点直调纯函数、未 `bindTools`；属预留扩展路径 |
| 6 | **无分类浏览入口** | 功能缺口 | `CATEGORY_COUNTS` 已统计好但界面未使用，当前只能靠对话按品类检索 |
| 7 | ~~无测试、非 git 仓库~~ | 工程化 | ✅ **已修（阶段 11.5）**：Vitest 单测 + git 仓库（远端 `Zeffy-Real/eshopagent`），现共 116 个用例 |
| 8 | ~~消息历史不参与 LLM 上下文~~ | 能力边界 | ✅ **已修（阶段 12）**：`parseIntent` 注入最近若干轮历史，可消解「刚才那个」这类指代 |
| 9 | **21 件商品无标签** | 数据完整度 | 源数据无 features 且文案无功能词；带标签过滤的检索会排除它们 |
| 10 | **数据快照需手动刷新** | 运维 | 生产应改为定时任务，或替换为实时电商 API 客户端 |
| 11 | **跨会话偏好记忆缺失** | 能力边界 | 阶段 14 计划做结构化画像（localStorage，不上向量库） |

---

## 九、建议的审查切入点

1. **先核数据**：抽 3–5 条 `data/real-catalog.json`（含图书）对照 `README.md` 的「哪些是真实数据」表，确认没有夸大。
2. **再定取舍**：第八节第 1、2 条（销量覆盖率、派生库存）——这两条直接决定界面观感与真实性口径。
3. **跑一遍主链路**：`npm run dev` → 「推荐几本小说」→「对比前 3 件」→「结算」，重点看右栏三个面板与中栏商品区是否一致。
4. **看收敛度**：本次改动最集中的四个文件是 `lib/utils.ts`、`lib/catalog/products.ts`、`lib/agent/sse.ts`、`store/use-agent-store.ts`。

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
