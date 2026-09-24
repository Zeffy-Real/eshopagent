# 记忆机制改造计划（阶段 11 输出 · v2）

> 本文档是阶段 11 的交付物：**先审查现状、输出结论与改造计划**，经确认后再进入代码实现。
>
> - 审查时间：2026-09-24
> - 目标远端仓库：`https://github.com/Zeffy-Real/eshopagent`
> - 当前校验状态：`tsc --noEmit` 0 错误；`next build` 通过
> - v2 已依据审查意见修订，逐条对照见「修订记录」

---

## 修订记录

| 版本 | 变更 |
| --- | --- |
| v1 | 阶段 11 初审结论与改造计划 |
| v2 | 依据审查意见修订：补 3 处设计漏洞、改 3 处站不住的表述、核 2 处工程风险、调整执行顺序与遗漏项 |

### v2 逐条对照

| 审查意见 | 处理 |
| --- | --- |
| 1. `profilePatch` 生命周期未定义 | 已定义（覆盖型 reducer + 每轮由 `parseIntent` 重置 + 前端幂等合并）→ §3.3.1 |
| 2. 画像清除与在途 patch 竞态 | 采用 `profileGeneration` 回显方案，abort 作双保险 → §3.3.2 |
| 3. TTL 清理在 Next.js 无落点 | 改为「惰性 + 概率 + 最小间隔」触发 → §3.2.3 |
| 4. 「历史不作路由依据」自相矛盾 | 改为「历史只消解指代，不产生独立意图」并加 prompt 约束 → §3.1.4 |
| 5. 「跨会话记忆」表述过强 | 改为「同一浏览器下的跨会话记忆」并写明边界 → §3.3.5 |
| 6. 「无 Key 不报错」≠「画像生效」 | 规则路径也消费画像（体现为回复提示），验收标准升级 → §3.3.4 |
| 7. SqliteSaver 需显式声明 nodejs runtime | **前提不成立**：两个路由已声明，无需改动 → §3.2.6 |
| 8. `better-sqlite3` 需 WAL + busy_timeout | **已确认可实现**：构造函数接受 `Database` 实例 → §3.2.2 |
| 9. P0 A 应改措辞、不删理由 | 已采纳 → §4.1 |
| 10. P0 B 单测补 `history.ts` | 已采纳 → §4.2 |
| 11. A 与 B 合并为阶段 11.5 | 已采纳 → §4.3 |
| 12. 隐私边界未提 | 已补 → §3.3.6 |
| 13. 文档一致性检查未落清单 | 已补机械检查清单 → §3.4 |

---

## 一、审查结论（阶段 11）

### 1.1 Checkpointer 实现

**文件**：`lib/agent/checkpointer.ts`

| 项 | 现状 |
| --- | --- |
| 实现 | `MemorySaver`（纯内存） |
| 存放 | `globalThis.__eshopCheckpointer` 单例 |
| 为什么挂 globalThis | Next.js dev 热更新会重建模块级变量，放模块作用域会导致每次热更新丢掉全部会话上下文 |
| 对外接口 | `getCheckpointer()`、`threadConfig(sessionId)` |
| 进程重启 | **会话全部丢失** |

**关键结论**：`graph.ts` 与 8 个节点只依赖上述两个函数，没有任何地方直接 `new MemorySaver()`。因此「换 SqliteSaver、业务代码零改动」成立（唯一例外是 `graph.ts` 的类型签名，见 §3.2.1）。

### 1.2 thread_id 的生成、传递与跨刷新行为

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 生成 | `store/use-agent-store.ts` `createSessionId()` | `s-${Date.now()}-${random}`，store 初始 state |
| 持久化 | 同文件 `persist.partialize` | 含 `sessionId`，写入 localStorage key `eshop-agent` |
| 恢复 | `components/providers/store-hydration.tsx` | `skipHydration: true`，挂载后 `persist.rehydrate()` |
| 传递 | `sendMessage` / `resumeOrder` → 请求体 | `app/api/agent/route.ts` 用 zod 校验（1–64 字符） |
| 落图 | `threadConfig(sessionId)` | `{ configurable: { thread_id: sessionId } }` |

**跨刷新**：**不变**（localStorage 恢复）。只要 dev server 进程没重启，刷新后上下文能延续。

**两个缺口**：

1. **rehydrate 竞态**：初始 state 先 `createSessionId()`，`rehydrate()` 是挂载后异步执行。用户在恢复完成前发消息会带**新 id** 出去，等于开新 thread。触发窗口短但真实存在。
2. **语义混淆**：`clearConversation()` 会换新 sessionId，因此「清空对话」按钮同时承担了唯一的「新会话」语义，需要拆开。

### 1.3 prompts.ts 是否已包含 messages 历史

**结论：不包含。全链路只有「最后一条用户消息」进入 LLM。**

证据 —— 全仓库对 `state.messages` 的消费只有 4 处：

| 位置 | 用法 |
| --- | --- |
| `lib/agent/nodes/parseIntent.ts` | `lastHumanText(state.messages)` —— 只取最后一条用户消息 |
| `lib/agent/nodes/refineSearch.ts` | 同上 |
| `lib/agent/nodes/manageCart.ts` | 同上 |
| `lib/agent/nodes/prepareOrder.ts` | 只用 `state.messages.length` 作为订单号 seed |

提示词侧：`buildIntentUserPrompt(text, previous)` 只收「最后一条文本 + 当前筛选条件」；`buildReplyContext(state)` 只用状态字段、无 messages；`generateReply` 的调用就是 `[system, user]` 两条。

**需要修正的表述**：不能说「多轮对话完全是假的」：

- **纯指代完全无法解析**：「刚才那个」「换成第二件」；
- **部分相对表述恰好能工作**：「再便宜一点」能跑通，但**不是理解了指代**，而是 `refineSearch` 的 `relaxFilters(searchFilters, text)` 把价格上限硬编码下调 30%。

所以第 1 层的价值应表述为「把硬编码的单场景规则升级为基于真实上下文的理解」。

### 1.4 localStorage 现状

| key | 内容 |
| --- | --- |
| `eshop-agent` | `sessionId`、`messages`（最近 40 条，`streaming` 置 false）、`snapshot` |
| `eshop-cart` | `items`（完整 Product 对象 + quantity） |

两者都 `skipHydration: true` + 挂载后 rehydrate。**没有任何用户偏好 / 画像存储**。

### 1.5 附带发现：库存件数 100% 是派生值

```
构建脚本中映射了 stock 字段的来源数：1（只有 Shopee）
目录现有平台：Amazon / Lazada / Walmart   ← 已无 Shopee 商品
stock > 0 的 111 件，取值范围 21 - 494     ← 与派生公式 21 + hash%480 完全吻合
```

**目录里没有任何一件商品拥有真实库存件数**（1 件 `stock=0` 来自真实的 availability 信号）。

因此问题不只是「展示假数字」：

- 对比表「库存」行实际上在**按哈希函数排序**；
- 决策推荐会输出「**库存最充足（231 件）· 下单后发货更快**」—— 把哈希值包装成推荐理由。

这比销量那处更该优先修：销量只影响展示，库存还进入了排序与推荐逻辑。

---

## 二、需要决策的 4 个点

| # | 决策点 | 建议 | 状态 |
| --- | --- | --- | --- |
| 1 | 第 3 层画像存哪 | **localStorage**，服务端只做信号提取并随快照回传 | 已定 |
| 2 | 画像归属键 | 画像**不按 sessionId 归属**，存 localStorage 天然解耦，无需 userId | 已定 |
| 3 | 并行 P0 排期 | 库存口径 + git init + 单测 → 合并为**阶段 11.5**，在阶段 12 之前；bindTools 放最后 | 已定（采纳审查意见） |
| 4 | SqliteSaver 原生模块风险 | `CHECKPOINT_BACKEND=memory\|sqlite` 兜底开关 | 已定 |

---

## 三、改造计划

### 阶段 12：会话内短期记忆

**目标**：让指代能正确解析；历史**只消解指代，不产生独立意图**。

#### 3.1.1 变更范围

| 文件 | 变更 |
| --- | --- |
| `lib/agent/history.ts`（新增） | `buildHistoryContext(messages, budget)`：按字符预算（无 tokenizer，中文按 ~2 字符/token 估算）**丢弃最旧的完整轮次**，绝不截断单条消息；输出带角色标注（用户 / 助手） |
| `lib/agent/prompts.ts` | `buildIntentUserPrompt(text, previous, history)` 增加历史段；新增 prompt 约束（见 §3.1.4） |
| `lib/agent/nodes/parseIntent.ts` | 传入历史 |

#### 3.1.2 不改动

`state.ts`（`messages` 已在状态且 reducer 正确）、`parseIntent` 的输出 schema、条件边逻辑。

#### 3.1.3 环境变量

`HISTORY_ENABLED`（默认 `true`）、`HISTORY_MAX_CHARS`（默认 `2000`）。

#### 3.1.4 表述修正（采纳审查意见）

**v1 的「历史只作理解输入，不作路由依据」自相矛盾** —— 注入历史后，LLM 输出的 `intent` 必然受历史影响（用户说「再便宜点」，模型看到历史里是「推荐小说」，就会输出 `refine` 而非 `search`）。**这就是历史在影响路由。**

改为：

> **历史只帮助消解指代，不产生独立意图。**

并在 `INTENT_SYSTEM_PROMPT` 中加约束：

```
若当前输入可独立判断意图，不要引用历史；
仅在输入含指代词（「刚才那个」「换成第 N 件」「那个」「它」）时才参考历史。
历史用于确定指代对象，不用于推断意图类别。
```

#### 3.1.5 验收标准

- 「推荐几本小说」→「刚才那个再便宜点」→ 指向同一批图书并调整价格条件；
- 「换成第二件」能定位上一轮结果的第 2 件；
- 历史超预算时丢弃最旧轮次，单条消息不被截断；
- LLM 不可用时走规则路径不报错。

#### 3.1.6 测试用例要点（`lib/agent/history.ts` 为纯函数）

1. 空历史 → 空串；
2. 单轮 → 保留；
3. 超预算 → 丢最旧轮次、保留最新；
4. 一条超长消息 → **整条丢弃**而非截断；
5. 角色标注正确（human → 用户，ai → 助手）；
6. 多模态消息 → 只取文本部分。

---

### 阶段 13：会话持久化

**目标**：重启进程后同一 sessionId 上下文可恢复；拆开「清空对话」与「新会话」；加会话清理。

#### 3.2.1 变更范围

| 文件 | 变更 |
| --- | --- |
| `package.json` | 新增 `@langchain/langgraph-checkpoint-sqlite`（自带 `better-sqlite3`） |
| `lib/agent/checkpointer.ts` | 按 `CHECKPOINT_BACKEND` 返回 `SqliteSaver` 或 `MemorySaver`；注入自定义 `Database` 实例（见 §3.2.2）；初始化失败自动回落 memory 并打印原因 |
| `lib/agent/graph.ts` | checkpointer 类型从 `MemorySaver` 放宽为 `BaseCheckpointSaver`（「零改动」的唯一例外，仅类型签名） |
| `lib/agent/session-store.ts`（新增） | `session_meta` 表读写 + `maybeCleanupSessions()`（见 §3.2.3） |
| `app/api/agent/route.ts` | 请求开始处调用 `maybeCleanupSessions()` |
| `store/use-agent-store.ts` | 新增 `startNewSession()`（只换 sessionId）；`clearConversation()` 只清消息；新增 `hasHydrated` 标志，未恢复前禁止发送 |
| `components/chat/chat-panel.tsx`（或顶栏） | 新增「新会话」按钮，与「清空对话」区分 |
| `.env.example`、`README.md` | 新增环境变量说明 |

#### 3.2.2 WAL 与 busy_timeout（已确认可实现）

**核实结果**：该包的类型定义暴露了构造函数签名，**支持注入自定义 `Database` 实例**：

```ts
declare class SqliteSaver extends BaseCheckpointSaver {
  db: Database;
  constructor(db: Database, serde?: SerializerProtocol);
  static fromConnString(connStringOrLocalPath: string): SqliteSaver;
  deleteThread(threadId: string): Promise<void>;   // ← 公共 API，见 §3.2.3
}
```

因此审查意见中的 WAL + busy_timeout 可以完整实现：

```ts
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');    // 库级设置，持久写入文件头
db.pragma('busy_timeout = 5000');   // 连接级设置，避免热更新残留连接撞锁
const saver = new SqliteSaver(db);
```

**附带收益**：注入 `db` 后，`session_meta` 表可以直接用同一个连接创建与查询，无需另开连接。

**附带发现**：`deleteThread(threadId)` 是公共方法，清理会话不必手写 SQL —— 用它执行删除，`session_meta` 只负责「谁该被删」。

#### 3.2.3 TTL 清理：改为惰性 + 概率触发（采纳审查意见）

**v1 的「启动时清理」在 Next.js 里没有落点**：Next.js 没有可靠的进程启动钩子，Route Handler 是懒加载的；挂在 `getCheckpointer()` 初始化里会被 dev 热更新反复触发；只靠 `globalThis` 标记则可能几天都不触发。

改为双闸门惰性清理：

```ts
const CLEANUP_PROBABILITY = 0.05;          // 每次请求 5% 概率进入检查
const MIN_CLEANUP_INTERVAL_MS = 10 * 60_000; // 距上次清理不足 10 分钟直接跳过
let lastCleanupAt = 0;

export function maybeCleanupSessions(saver: SqliteSaver): void {
  if (Math.random() > CLEANUP_PROBABILITY) return;
  const now = Date.now();
  if (now - lastCleanupAt < MIN_CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  // 查 session_meta 中 last_active_at < now - TTL 的会话，逐个 saver.deleteThread(id)
}
```

调用点：`app/api/agent/route.ts` 的 POST 开头（跑图之前）。

**诚实标注**：`lastCleanupAt` 是模块级变量，dev 热更新会重建模块从而重置它，所以「最小间隔」这道闸门在热更新后会失效；但概率闸门（5%）仍然生效，且清理只是一次带索引的查询，代价可接受。生产环境应改为独立定时任务。

#### 3.2.4 数据库变更

- 新增 SQLite 文件，默认 `.cache/checkpoints.sqlite`（`.cache/` 已在 `.gitignore` 中）；
- LangGraph 自带表（库管理，勿手改）：`checkpoints`、`checkpoint_writes`、`checkpoint_blobs`；
- 新增自定义表：`session_meta(session_id TEXT PRIMARY KEY, created_at INTEGER, last_active_at INTEGER)`，仅用于判定「谁该被删」。

#### 3.2.5 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHECKPOINT_BACKEND` | `sqlite` | `sqlite` / `memory`；sqlite 初始化失败自动回落 |
| `CHECKPOINT_DB_PATH` | `.cache/checkpoints.sqlite` | 落盘位置 |
| `SESSION_TTL_DAYS` | `7` | 超过该天数未活跃的会话被清理 |

#### 3.2.6 关于 `runtime = 'nodejs'`（更正审查前提）

审查意见提出「需显式声明 Node runtime，否则 SqliteSaver 在 Edge 下会崩」。

**核实结果：两个路由都已经声明了，无需改动。**

```
app/api/agent/route.ts:9        export const runtime = 'nodejs';
app/api/agent/route.ts:10       export const dynamic = 'force-dynamic';
app/api/agent/resume/route.ts:8 export const runtime = 'nodejs';
app/api/agent/resume/route.ts:9 export const dynamic = 'force-dynamic';
```

处理方式：不新增改动，但在阶段 13 的验收里加一条**回归检查** —— 确认这两行未被后续改动删除（它是显式契约，不能退化为依赖默认值）。

#### 3.2.7 安全约束

- SQLite 文件包含**完整对话内容**，必须保持 gitignore，不得置于 `public/`；
- 无鉴权，TTL 清理同时是防止磁盘无限增长的手段；
- 该文件不得被任何接口直接读取返回。

#### 3.2.8 验收标准

- 发起几轮对话 → 重启 dev server → 刷新页面 → 上下文延续；
- 「新会话」按钮：换 thread、清消息，画像保留；
- 「清空对话」按钮：只清当前会话消息；
- 清理：把某会话 `last_active_at` 改到 TTL 之前，触发清理后被删除；
- `CHECKPOINT_BACKEND=memory` 时行为与改造前一致；
- 回归：两个路由的 `runtime` / `dynamic` 声明仍在。

#### 3.2.9 风险与回滚

| 风险 | 缓解 / 回滚 |
| --- | --- |
| `better-sqlite3` 原生模块安装失败 | `CHECKPOINT_BACKEND=memory`（回滚成本 = 改一个变量） |
| SQLite 同步 API 阻塞事件循环 | 单机 demo 可接受，README 标注生产应换 Postgres |
| 热更新残留连接撞锁 | `busy_timeout = 5000` + WAL |
| 迁移后旧会话丢失 | 旧会话本就在内存，进程重启即失，无迁移损失 |

---

### 阶段 14：结构化用户画像

**目标**：跨会话偏好记忆，纯结构化字段，可追溯、可见、可清除。

#### 3.3.1 `profilePatch` 的生命周期（补 v1 漏洞）

v1 只写了「追加型 reducer，与 `toolCallLog` 同语义」——但 `toolCallLog` 是纯展示数据，无限累加无所谓；`profilePatch` 要被前端消费并落盘，必须定义生命周期。

**最终设计：覆盖型 reducer + 每轮由 `parseIntent` 重置 + 前端幂等合并。**

```ts
/**
 * 本轮画像增量（信号）。
 *
 * 生命周期：
 * - reducer 是**覆盖型**（不是 concat）——避免同一会话跑 N 轮后堆 N 组重复信号；
 * - parseIntent 是每轮的第一个节点（START → parseIntent 恒定），它每轮都写 []，
 *   等于**在本轮开头清空上一轮的 patch**；
 * - 后续节点（searchProducts / manageCart / confirmOrder）读当前值再追加，
 *   因此同一轮内多个节点的信号会累积；
 * - 一轮里每个 node_end 都会推一次快照（同一 patch 被推多次），
 *   所以**前端合并必须幂等**（见 mergeProfile）。
 */
profilePatch: Annotation<ProfileSignal[]>({
  reducer: (_previous, next) => next,
  default: () => [],
}),
```

节点内的写法：

```ts
// searchProducts 内
const signals = extractProfileSignals({ kind: 'search', filters, hits });
return { profilePatch: [...state.profilePatch, ...signals] };
```

回答了 v1 的三个悬空问题：

| v1 问题 | 答案 |
| --- | --- |
| patch 什么时候清空？ | 每轮开头由 `parseIntent` 写 `[]` 清空，因此 state 里永远只保留**本轮**信号 |
| 每轮清的话，本轮信号来得及被前端读到吗？ | 来得及。清空发生在**下一轮**开头，本轮信号在整个本轮内（含最后一个 `node_end` 的快照）都可读 |
| 前端「消费」是合并后丢弃还是保留？ | 前端把 patch **幂等合并**进 `userProfile` 并落盘；patch 本身不留在 store 里（它由服务端每轮重置，无需前端管理） |

#### 3.3.2 画像清除与在途 patch 的竞态（补 v1 漏洞）

**竞态**：用户点「清除画像」→ 前端清 localStorage → 此时一个在途 SSE 响应回来，带着早先发出的 `profilePatch` → 前端应用 → 画像又长出来了。

**方案：`profileGeneration` 回显（确定性，不依赖时序）。**

```ts
interface UserProfile {
  generation: number;   // 每次「清除」自增
  // ...偏好字段
}
```

- 前端每次请求把 `profileGeneration` 放进请求体（与 `cart` 快照同一模式）；
- 服务端**原样回显**到状态快照的 `profileGeneration` 字段（服务端不持有画像，只做透传）；
- 前端应用 patch 前比对：`payload.profileGeneration === get().userProfile.generation` 才应用。

这样「清除」后 `generation` 自增，任何携带旧 generation 的在途 patch 都会被丢弃。

**双保险**：清除时同时 `abort()` 在途请求（复用 §5 的 E 项 AbortController 工作），让服务端也停止产出。

**该竞态必须写进阶段 14 的验收标准**（见 §3.3.7 第 3 条）。

#### 3.3.3 变更范围

| 文件 | 变更 |
| --- | --- |
| `lib/profile.ts`（新增） | `UserProfile` / `ProfileSignal` 类型 + `extractProfileSignals()` + `mergeProfile()`（**必须幂等**） |
| `lib/agent/state.ts` | 新增 `profilePatch` 字段（见 §3.3.1） |
| `lib/agent/nodes/parseIntent.ts` | 每轮写 `profilePatch: []`（重置）+ 注入画像 |
| `lib/agent/nodes/searchProducts.ts` | 从真实检索行为提取信号 |
| `lib/agent/nodes/manageCart.ts` | 从加购行为提取信号 |
| `lib/agent/nodes/confirmOrder.ts` | 从成交行为提取信号（权重最高） |
| `lib/agent/prompts.ts` | 画像作为「用户画像」段注入；`buildTemplateReply` 增加画像提示（见 §3.3.4） |
| `lib/agent/events.ts`、`lib/agent/sse.ts` | 快照携带 `profilePatch` 与 `profileGeneration` |
| `app/api/agent/route.ts` | 请求体新增 `profileGeneration`（zod 校验） |
| `store/use-agent-store.ts` | persist 新增 `userProfile`；应用 patch（带 generation 校验） |
| `lib/agent/utils.ts` | 记忆事件日志工厂 |
| `components/visualization/` | 「记起你偏好 X」事件（复用时间线） |
| 画像查看 / 清除入口 | 新增面板，支持查看字段来源与一键清空 |

#### 3.3.4 规则路径也要消费画像（采纳审查意见）

v1 的验收只写「无 Key 时不报错」——但**不报错 ≠ 画像生效**。若 `ruleParser` 不读画像，那「无 Key 也能参考偏好」就是假的。

**明确规则路径的画像消费方式**：

- 规则解析出的筛选条件**若与画像冲突，以当前输入为准**（不做推断，避免污染）；
- 但**模板回复**要消费画像：当本轮输入较宽泛（无明确品类/关键词）且画像有信号时，附一句提示，例如
  「注意到你之前常看图书，需要我按这个方向再找找吗？」
- 该提示同样触发右栏「记起你偏好」事件，使「无 Key」路径下记忆的使用**可见**。

验收标准相应升级（见 §3.3.7 第 4 条）。

#### 3.3.5 「跨会话记忆」的准确表述（采纳审查意见）

画像存 localStorage、与 sessionId 解耦 —— 本质是「同一浏览器同一用户」。面试官会问「用户换台电脑呢？」

**README 中一律表述为「同一浏览器下的跨会话记忆」**，并明确写出当前边界：

- 无 userId、无登录、无跨设备同步；
- 清除浏览器数据即丢失画像；
- 把它当作「我知道边界在哪」的证据，而不是掩盖。

#### 3.3.6 隐私边界（补 v1 遗漏）

画像注入 prompt = 用户偏好数据**出境到 LLM 服务商**（DeepSeek / 通义 / OpenAI）。

README 中增加提示：

> 启用画像后，画像内容会随 prompt 发送到所配置的 LLM 服务商。当前为本地演示用途；生产环境需评估数据出境合规与用户告知义务。

同时约束画像**不得包含敏感信息**（收货地址、手机号、支付方式一律不进画像）。

#### 3.3.7 验收标准

1. 新用户先搜「图书」并加购 → 清除浏览器会话（保留画像）→ 新会话问「推荐点什么」→ 参考图书偏好且右栏出现记忆事件；
2. 画像每一项都能对应到用户真实操作；
3. **竞态**：在有 SSE 请求在途时点「清除画像」→ 清除后画像保持为空，不被在途 patch 复活；
4. **无 Key 路径**：`LLM_API_KEY` 留空时，宽泛提问仍能在回复里看到画像提示，且右栏出现记忆事件；
5. 一键清空后画像为空，后续对话不再出现记忆事件；
6. `mergeProfile` 幂等：同一 patch 应用两次结果一致。

#### 3.3.8 测试用例要点

1. **无任何行为 → `extractProfileSignals` 返回空 patch**（最关键的一条）；
2. 仅浏览未加购 → 只产出 `recentSearches` / `preferredCategories`，不产出 `brands`；
3. 加购 → 产出品牌信号；
4. 成交 → 权重最高；
5. `mergeProfile` 幂等性（重复应用同一 patch）；
6. `mergeProfile` 去重、字段上限（`recentSearches` 最多 10 条）、`priceRange` 合并规则；
7. generation 校验：旧 generation 的 patch 被丢弃。

---

### 阶段 15：文档

#### 3.4 文档一致性检查清单（补 v1 遗漏）

库存口径一变，至少三处要同步。**机械方法：全局搜索 `stock` / `库存` / `件数`，逐一核对文案。**

| # | 位置 | 必改内容 |
| --- | --- | --- |
| 1 | `README.md` 的「哪些是真实数据」表 | 库存行改为「**真实** availability 信号（有货/缺货）；**件数为派生值，界面不展示**」 |
| 2 | `docs/project-status.md` 第八节第 2 条 | 划掉或改写为已解决 |
| 3 | 代码注释 | `StockBadge` 组件、`lib/decision.ts`、对比表组件中所有提及「库存件数」的描述 |

另外 `README.md` 新增「记忆机制」章节：四层分别做了什么、为什么第 4 层不做、隐私边界、边界声明。

**验收标准**：README 描述与实际行为一致、无夸大；全局搜索 `stock` / `库存` / `件数` 无遗留的旧口径文案。

---

## 四、阶段 11.5（原 P0 A + B 合并，采纳审查意见）

审查意见指出 A 与 B 同属「堵住既有漏洞」，应合并。采纳。

### 4.1 A. 库存口径：改措辞，不删推荐理由（采纳审查意见）

v1 写的是「评估是否保留『库存最充足』这条推荐理由」。审查意见更合理：**保留推荐维度，但不提件数、不用「最充足」这种程度词** —— 因为 availability 信号本身是真实的，只有件数是派生的。

| 文件 | 改动 |
| --- | --- |
| `components/product/product-detail-dialog.tsx` | `StockBadge showCount` → 去掉 `showCount` |
| `components/ui/stock-badge.tsx`（如支持 showCount） | 确认并移除件数展示分支 |
| `lib/agent/tools/productTools.ts` | 对比表「库存」行：值从 `有货（231）` 改为 `有货` / `库存紧张` / `缺货` |
| `lib/decision.ts` | 「库存最充足」→ 改为「现货可发」类措辞；detail 去掉件数，改为「有现货 · 下单后发货更快」 |

**保留不动**（派生值仍服务于功能，只是不再展示）：

- `stock` 数值继续用于「缺货不可加购」「加购数量上限」「`computeValueScores` 的缺货惩罚」；
- `stockLevelOf()` 与 `STOCK_LABEL` 不变（它们本来输出的是等级，不是件数）。

**验收标准**：全局搜索 `stock` / `库存` / `件数`，界面与文档中不再出现任何库存件数；对比表与决策推荐仍正常渲染。

### 4.2 B. `git init` + 单测

| 项 | 内容 |
| --- | --- |
| git | `git init` → 初始 commit → 关联远端 `https://github.com/Zeffy-Real/eshopagent` → 推送 |
| 单测 | 引入 Vitest，覆盖 **7 个纯函数模块**：`ruleParser` / `grounding` / `cart-pricing` / `decision` / `formatCount` / `hasRealSales` / **`history`（阶段 12 新增，采纳审查意见一并纳入）** |

**安全检查（已核实）**：`.gitignore` 已覆盖 `.env.local`、`.env*.local`、`.cache/`、`.next/`、`node_modules/`；`.env.example` 中只有占位符 `sk-xxxxxxxx...`，无真实密钥。**推送前需再执行一次 `git status` 确认 `.env.local` 未被跟踪。**

**验收标准**：`git status` 干净；远端可访问；`npx vitest run` 全绿；单测覆盖「无行为不产字段」「幂等合并」等关键不变量。

### 4.3 顺序（采纳审查意见）

```
阶段 11（本文档）
   ↓
阶段 11.5  A 库存口径 + B git init/单测
   ↓
阶段 12    会话内短期记忆
   ↓
阶段 13    会话持久化
   ↓
阶段 14    结构化画像
   ↓
阶段 15    文档
   ↓
C. bindTools（隔离进行）
```

---

## 五、其余并行待办

| 项 | 内容 | 建议位置 |
| --- | --- | --- |
| C. bindTools | `parseIntent` 通过 `bindTools` 让 LLM 真正选择工具，条件边路由依据来自 tool choice | 阶段 15 之后（隔离，避免与记忆改造互相干扰） |
| D. grounding 失败先重试 | 不符金额作为纠正提示给 LLM 一次重试，仍不符才降级 | 阶段 14 之后 |
| E. `AbortController` | `lib/agent-client.ts` 区分「主动中止」与网络错误，消除 `net::ERR_ABORTED` 噪声；同时作为 §3.3.2 的双保险 | 阶段 13 顺带 |
| F. 分类浏览入口 | `CATEGORY_COUNTS` 已算好未使用，加品类 chip 或下拉 | 阶段 15 之后 |

---

## 六、记忆机制整体验收标准

| 维度 | 标准 |
| --- | --- |
| 代词指代 | 「刚才那个」「再便宜点」「换成第二件」均能正确解析 |
| 跨刷新 | 刷新页面后对话上下文延续，购物车不丢 |
| 跨重启 | 重启 dev server 后同一 sessionId 的上下文仍可恢复 |
| 跨会话偏好 | **同一浏览器下**新会话能读取画像，右栏出现记忆事件 |
| 真实性 | 画像每一项都能对应到真实操作，用户可清除，且清除不被在途 patch 复活 |
| 降级不破坏 | LLM 不可用时，短期记忆与画像注入仍走规则路径，且**画像在模板回复中可见** |

---

## 七、风险点与回滚方案

| 风险 | 影响 | 缓解 / 回滚 |
| --- | --- | --- |
| **非 git 仓库**（阶段 11.5 前） | 无法 diff / 回滚 / review | 阶段 11.5 先 `git init` + 初始 commit；在此之前每阶段改动前手工备份 |
| `better-sqlite3` 安装失败 | 服务端启动失败，连累核心卖点 | `CHECKPOINT_BACKEND=memory` 兜底 + 自动回落 |
| 热更新残留连接撞锁 | 偶发 `SQLITE_BUSY` | WAL + `busy_timeout=5000` |
| 历史注入导致 token 膨胀 | 延迟与成本上升 | 字符预算截断 + `HISTORY_ENABLED=false` |
| 画像污染（凭空生成字段） | 击穿「真实性」卖点 | 提取函数只接受真实行为 + 单测锁死「无行为不产字段」+ 用户可清除 |
| 清除后画像被在途 patch 复活 | 用户感知「清除无效」 | `profileGeneration` 回显校验 + abort 双保险 |
| 提示词注入（历史 / 画像内容） | 模型被诱导 | 按纯文本注入，不做模板拼接 |
| 阶段间互相干扰 | 难定位问题 | 按 11.5 → 12 → 13 → 14 → 15 → C 推进，每阶段独立验收 |

---

## 八、执行顺序建议

```
阶段 11   本计划（已完成）
   ↓
阶段 11.5  A 库存口径统一 + B git init/单测
   ↓
阶段 12    会话内短期记忆 + 代词指代验证
   ↓
阶段 13    会话持久化 + thread_id 语义拆分 + 惰性会话清理
   ↓
阶段 14    结构化画像 + 记忆事件 + 查看/清除入口
   ↓
阶段 15    README「记忆机制」章节 + 文档一致性机械检查
   ↓
C. bindTools 接入（隔离进行）
```
