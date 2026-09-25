# 商品数据源调研（免注册 / 免 Key / 可直接调用）

> **实测时间**：2026-09-24 22:30–23:10（北京时间）
> **实测环境**：Windows 11 + `curl.exe`（默认 UA 与自定义 UA 各试一次），未配置任何代理；工作机网络**对部分境外主机不可达**（下文逐个标注）
> **方法**：每个候选都由本机真实发起 HTTP 请求，记录完整 URL、状态码、响应头与**原样响应片段**。凡未实测成功的一律标「未通过实测」，不做任何"应该可用"的推断。
> **本轮范围**：只做调研与验证，未写任何集成代码、未新增适配器、未改动业务文件。

---

## 1. 结论速览表

| 源 | 分类 | 免注册 | 免费 | 数据真实 | 实测结果（2026-09-24） | 是否推荐 |
| --- | --- | --- | --- | --- | --- | --- |
| **Open Food Facts**（v2 单品） | **A** | 是 | 是（ODbL） | **真实**（社区众包，含条形码/品牌/成分） | `200 OK`；无 UA 要求；响应头无限流字段 | ✅ **补充源**（食品品类） |
| **Open Food Facts**（v2 搜索 / 旧 search.pl） | **D→A 之间（当前不可用）** | 是 | 是 | 真实 | **`503 Service Temporarily Unavailable` / `502` + 官方停机页** | ❌ 当前不可用（服务端故障） |
| **Open Beauty Facts**（v2 单品 / 搜索） | **A** | 是 | 是（ODbL） | **真实** | `200 OK`（搜索返回 `count:1858` 与完整商品对象）；robots.txt 对 `/api` 设了 Disallow | ✅ **补充源**（美妆品类） |
| **Open Library**（search.json） | **A（文档可查）／未通过实测** | 是 | 是 | 真实（书目） | **curl 退出码 28，无法连通 `openlibrary.org:443`** | ⚠️ 待换网络复测 |
| **DummyJSON** | **A** | 是 | 是 | **合成假数据** | `200 OK`（字段含 price/stock/rating 全套） | ⚠️ 仅演示（数据非真实，与本项目「数据真实性」叙事冲突） |
| **FakeStoreAPI** | **A** | 是 | 是 | **合成假数据** | `200 OK` | ⚠️ 仅演示 |
| **Platzi Fake Store（escuelajs）** | **A** | 是 | 是 | **合成假数据** | `200 OK`（`/products/1` 返回 `400 EntityNotFoundError`，换成 `/products?limit=1` 即通） | ⚠️ 仅演示 |
| **GitHub 数据集仓库**（`luminati-io/*`，项目现用源） | **A** | 是 | 是 | **真实**（平台抓取样本） | `200 OK`；**`X-RateLimit-Limit: 60`**（匿名 60 次/小时，响应头可见） | ✅ **主源**（一次性构建快照） |
| **Best Buy** | **B** | 否 | 免费额度 | 真实 | **`403` +「We were unable to locate your API Key.」** | ❌ 需注册 |
| **eBay / MercadoLibre** | **B（按官方文档）** | 否 | 免费额度 | 真实 | **未通过实测**（本机 `curl 28` 不可达），无凭证调用按文档为 401 | ❌ 需注册/OAuth |
| **Shopify 店铺 `/products.json`** | **A（技术）／禁于 ToS** | 是 | 是 | 真实 | **未通过实测**（allbirds / kith 均 `curl 35`：本机 schannel 吊销检查失败，非店铺拒绝，见 §6）；官方 ToS 明文禁止 | ❌ 合规不可用 |
| **books.toscrape.com** | **A（文档可查）／未通过实测** | 是 | 是 | 真实书名 + 合成价格（沙箱） | **`curl 28` 不可达**（http/https 均超时；robots.txt 请求返回 nginx 404） | ⚠️ 待换网络复测；**不能作为"已可用"写入交付** |
| **UPCitemdb（trial）** | **未判定** | 声称免注册 | 免费额度 | 真实条码库 | **未通过实测**（`curl 28` 超时） | ❌ 不足以作为依据 |
| **Hugging Face（datasets / datasets-server）** | **A（文档可查）／未通过实测** | 是 | 是 | 真实（数据转储） | **`curl 28` 不可达**（`huggingface.co` 与 `datasets-server.huggingface.co` 均超时） | ⚠️ 国内网络需镜像 |
| **万邦 / Taobaoapi2014 / `c0b.cc` 短链等** | **C** | 否（要 key+token） | 按量收费 | 转售官方数据 | 未实测（不在本项目采用范围） | ❌ 见第 5 节 |

**一句话结论**：在"免注册 + 免费 + 真实数据"三条同时满足、且**经本机实测通过**的前提下，只剩 **2 条路**——① **GitHub 上的真实抓取样本仓库**（60 次/小时、一次性拉取做快照，可支撑主源）；② **Open Food Facts / Open Beauty Facts**（无凭证、ODbL、真实商品，但**没有价格/库存/销量**，只能做品类补充）。其余候选要么是合成数据、要么需注册、要么本轮网络下不可达。

---

## 2. 逐个详述

### 2.1 Open Food Facts（A 类）

| 项 | 内容 |
| --- | --- |
| 端点 | `GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json?fields=...` |
| 参数 | `fields` 可裁剪返回字段；搜索端点为 `GET /api/v2/search?categories_tags=...&page_size=N` |
| UA | **实测：无需特殊 UA**（curl 默认 UA 与自定义 UA 均 200，行为一致；官方文档「要求」发送可识别 UA 与联系方式） |
| 免费/授权 | 免费；数据库 ODbL，图片 CC-BY-SA；官方提供夜间全量 dump 与 HF Parquet |

**实测片段（原样，`2026-09-24 22:3x`，HTTP 200）**

```
{"code":"3017620422003","product":{"brands":"Nutella, Ferrero","categories_tags":["en:breakfasts","en:spreads","en:sweet-spreads","en:confectionary-based-spreads","en:Petit-déjeuners","en:Produits à tartiner","en:Produits à tartiner sucrés","en:Pâtes à tartiner","fr:Nutella","fr:Nuttela"],"code":"3017620422003","image_url":"https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.879.400.jpg","nutri
```

**搜索端点实测（不可用）**

```
状态: HTTP/1.1 503 Service Temporarily Unavailable
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Page temporarily unavailable - Open Food Facts</title>
```

旧版 `GET /cgi/search.pl?search_terms=coffee&json=1` 同样失败，返回 502 并带官方停机页：

```
状态: HTTP/1.1 502 Bad Gateway
<title>🍊 Unscheduled downtime - Open Food Facts 🍊</title>
  <div class="alert">🍊🚧 Unscheduled downtime Alert for Open Food Facts 🚧🍊</div>
```

- **返回字段**（单品）：`code`、`product_name`、`brands`、`quantity`、`categories_tags`、`image_url`、`nutriments`、`nutriscore_grade`、`ingredients_text`、`labels_tags` 等
- **限流**：响应头**未体现**任何限流字段（无 `X-RateLimit-*`、无 `Retry-After`）；官方文档声明有限流并要求批量分析改用 dump —— 但**搜索端点当前正处官方停机状态**，不能作为可用的实时检索通道
- **数据真实性**：真实（社区众包录入，含真实条形码与品牌）；完整性因条目而异
- **合规边界**：ODbL 允许商用（需署名 + 相同方式共享）；官方明确欢迎 API 复用但要求「可识别 UA + 缓存 + 大批量走 dump」；**robots.txt 对 `/api`、`/cgi` 设了 Disallow**（语义针对爬虫，与按其文档调用 API 不直接冲突，但足以说明"批量爬 API"不是被鼓励的用法）
- **数据新鲜度**：实时（社区持续更新）+ 夜间全量导出

### 2.2 Open Beauty Facts（A 类）

与 OFF 同一套平台（同 API 形状、同 ODbL 授权），覆盖美妆品类。

**实测片段 1（v2 单品，HTTP 200 / 404 两种都记录）**

```
# 不存在的条码（证明无凭证即可访问，返回结构化错误）
{"code":"3574661465313","status":0,"status_verbose":"product not found"}

# v2 搜索（HTTP 200，返回完整商品对象）
{"count":1858,"page":1,"page_count":1,"page_size":1,"products":[{"_id":"0626232601015","_keywords":["hair","shampoo"],"added_countries_tags":[],"categories":"Shampoos","categories_hierarchy":["en:hair","en:shampoos"],"categories_lc":"en","categories_tags":["en:hair","en:shampoos"],"checkers_tags":[],"code":"0626232601015","codes_tags":["code-13","conflict-with-upc-12","0626232601xxx","062623260xxxx","06262326xxxxx","
```

- **限流**：响应头未体现
- **robots.txt（实测 200）**：`User-agent: *` → `Disallow: /api`、`Disallow: /cgi`、`Disallow: /facets`
- **数据真实性**：真实（同 OFF 模式）
- **注意**：v2 搜索的 `fields` 裁剪在该端点上表现不一致（传 `fields=code,product_name,brands` 时 `products` 数组里只剩 `code`），取全字段更可靠

### 2.3 GitHub 数据集仓库（A 类，**项目当前主源**）

项目 `scripts/build-real-catalog.mjs` 现用两个仓库：`luminati-io/eCommerce-dataset-samples`（综合电商样本）与 `luminati-io/Amazon-popular-books-dataset`（图书样本），经 `api.github.com` 读取。

**实测片段（原样，HTTP 200）**

```
X-RateLimit-Limit: 60 | X-RateLimit-Remaining: 60 | X-RateLimit-Used: 0 | X-RateLimit-Resource: core | X-RateLimit-Reset: 1790265190
{
  "resources": { "code_search": { "limit": 60, "remaining": 60, ...
```

```
[
  {
    "name": "README.md",
    "path": "README.md",
    "sha": "d35bae254c3fbf4845730e75e5ddbf6977093172",
    "size": 4358,
    "url": "https://api.github.com/repos/luminati-io/eCommerce-dataset-samples/contents/README.md?ref=main",
```

- **限流**：**明确数字且响应头可见** —— 匿名 `60 次/小时`（`X-RateLimit-Limit`）；够一次性构建（当前全量构建用不到 60 次请求），但**不能做成实时刷新的爬虫**
- **数据真实性**：真实（平台公开页面的抓取样本，含真实 ASIN/SKU、价格、评分、评论数、图片、参数）
- **合规边界**：数据由第三方公开抓取后发布，仓库无 ODbL 之类明确授权声明；本项目仅用于**演示与快照**，README 已如实标注来源
- **新鲜度**：静态快照（仓库更新时才有新数据）
- 附注：图书仓库的 `contents/` 实测**本次超时一次**（`api.github.com` 偶发抖动，非限流；同一时段另一仓库 200），重试可通

### 2.4 合成数据源（A 类但**数据不真实**）

| 源 | 实测状态 | 实测片段（原样） | 结论 |
| --- | --- | --- | --- |
| DummyJSON | `200 OK` | `{"id":1,"title":"Essence Mascara Lash Princess","description":"The Essence Mascara Lash Princess is a popular mascara known for its volumizing and lengthening effects. ...","category":"beauty","price":9.99,"discountPercentage":10.48,"rating":2.56,"stock":99,"tags":["beauty","mascara"],"brand":"Essence","sku":"BEA-ESS-ESS-001","weight":4,"dimensions"` | 字段最全（price/stock/rating/sales 口径都有），但**是生成的假数据** |
| FakeStoreAPI | `200 OK` | `{"id":1,"title":"Fjallraven - Foldsack No. 1 Backpack, Fits 15 Laptops","price":109.95,"description":"Your perfect pack for everyday use and walks in the forest. ...","category":"men's clothing","image":"https://fakestoreapi.com/img/81fPKd-2AYL._AC_SL1500_t.png","rating":{"rate":3.9,"count":120}}` | 数据是占位符（标题为真、价格与评分为造） |
| Platzi Fake Store | `200 OK`（`/products?limit=1`） | `[{"id":4,"title":"Classic Grey Hooded Sweatshirt","slug":"classic-grey-hooded-sweatshirt","price":90,"description":"Elevate your casual wear with our Classic Grey Hooded Sweatshirt. ..."` | 同上；`/products/1` 会返回 `400 EntityNotFoundError`（id 不固定） |

> 这三个源**技术上完全满足**「免注册 + 直接调用」，但对本项目是**自相矛盾的选择**：项目卖点之一是「派生的库存件数不会冒充真实数据」，若上游本身是合成数据，所有"真实性"叙事同时失效。因此它们只能在纯 UI 演示时说明「此处数据为合成样例」。

### 2.5 需注册（B 类）与不可达候选

| 源 | 实测 | 说明 |
| --- | --- | --- |
| Best Buy | **`403` + `{"errorCode":"403", "errorMessage":"We were unable to locate your API Key."}`** | 官方 API 必须带 `apiKey`；免费但有条款限制 |
| eBay Browse | 未通过实测（`api.ebay.com` 本机 `curl 28` 不可达） | 官方文档：需 OAuth 应用的 client credentials 换取 access token |
| MercadoLibre | 未通过实测（本机 `curl 28`） | 官方文档：需注册应用拿 access token |
| AliExpress / Amazon PA-API / Walmart | 未实测（本轮直接按官方文档归入 B 类） | 均需 AppKey/Secret、签名或联盟审核，Amazon PA-API 还要求有销量的联盟账号 |
| Open Library | 未通过实测（无法连接 `openlibrary.org:443`，21.7s 后失败） | 公开资料均称无需 Key（`/search.json`），但**本机不可达 → 不作为已验证结论** |
| books.toscrape.com | 未通过实测（列表页 http/https 均超时；`robots.txt` 返回 nginx 404） | 常被当作"合法沙箱"，但本轮网络下**拿不到数据**；404 的 robots.txt 意味着站点未声明爬取约束 |
| UPCitemdb（trial） | 未通过实测（超时） | 声称免 Key 试用，实测未通，无法判定 |
| Hugging Face（`huggingface.co` / `datasets-server`） | 未通过实测（均超时） | 数据转储类的免注册路径；国内网络需镜像，本项目不依赖它 |
| Shopify `/products.json` | 未通过实测（allbirds、kith 均 `curl 35`：本机 schannel 证书吊销检查连不上 CRL/OCSP，**不是店铺封禁**，详见 §6） | 技术上无凭证，但**ToS 明文禁止**：见第 5 节 |

---

## 3. 与现有 Product 模型的字段映射可行性

现有字段（`lib/types.ts`）：`id / name / category / price / originalPrice / rating / reviewCount / sales / stock / image / description / specifications / tags`

### 3.1 能支撑主源的：GitHub 数据集仓库（当前主源）

| 字段 | 映射 | 说明 |
| --- | --- | --- |
| id | ✅ | 真实 ASIN / SKU |
| name | ✅ | 直接取 |
| category | ✅ | 平台类目 → 项目 7 品类（现有构建脚本已做映射） |
| price | ✅ | 直接取 |
| originalPrice | ⚠️ | 有折扣字段的商品可反算；无折扣时留空（现实现如此） |
| rating | ✅ | 直接取 |
| reviewCount | ✅ | 直接取 |
| sales | ⚠️ | **仅少部分平台有真实销量**（420 件里 88 件），其余留空不做派生 |
| stock | ⚠️ | 只有 availability 类信号 → 映射为「有货/紧张/缺货」等级（项目已如此处理） |
| image | ✅ | 图片 URL 数组（需去重与缺失兜底） |
| description | ✅ | 直接取 |
| specifications | ✅ | 平台参数表 |
| tags | ⚠️ | 从标题/类目派生 |

**结论**：**能填满主源所需字段**，唯一系统性缺口是 `sales`（真实销量覆盖率低）与 `stock`（只有等级信号）—— 两者都已按"没有就不编"处理。

### 3.2 只能当补充源的：Open Food Facts / Open Beauty Facts

| 字段 | 映射 | 说明 |
| --- | --- | --- |
| id | ✅ | 条形码 `code` |
| name | ✅ | `product_name`（众包数据可能缺失） |
| category | ⚠️ | `categories_tags` 是**多级标签树**（如 `en:breakfasts → en:spreads`），需选一层并映射到新品类（食品/美妆），与现有 7 品类不同构 |
| price | ❌ | **源里没有价格** |
| originalPrice | ❌ | 同上 |
| rating | ❌ | 无评分体系（有 `nutriscore_grade`，是营养等级不是用户评分） |
| reviewCount | ❌ | 无 |
| sales | ❌ | 无 |
| stock | ❌ | 无 |
| image | ✅ | `image_url` / `image_front_url` |
| description | ⚠️ | 需由 `ingredients_text` + `quantity` + `labels_tags` 拼装 |
| specifications | ⚠️ | `nutriments` + `nutriscore_grade` + `allergens_tags` 重组 |
| tags | ⚠️ | 从 `categories_tags` / `labels_tags` 派生 |

**明确标注：OFF / OBF 完全无法支撑「价格 / 库存 / 销量」三个核心字段** → **不能当主源**，只能作为食品、美妆两个品类的**补充源**（商品名、图片、成分、标签）。

### 3.3 三个合成源的映射（列出来是为了说清"能填满 ≠ 能用"）

| 字段 | DummyJSON | FakeStoreAPI | Platzi |
| --- | --- | --- | --- |
| id / name / category / price / description / image | ✅ | ✅ | ✅ |
| originalPrice | ⚠️（`discountPercentage` 反算） | ❌ | ❌ |
| rating | ✅ | ✅（`rating.rate`） | ❌ |
| reviewCount | ⚠️（有 `reviews` 数组可计数） | ✅（`rating.count`） | ❌ |
| sales | ❌ | ❌ | ❌ |
| stock | ✅ | ❌ | ❌ |
| specifications | ⚠️（weight/dimensions/warranty 可拼） | ❌ | ❌ |
| tags | ✅ | ❌ | ❌ |
| **数据真实性** | ❌ 合成 | ❌ 合成 | ❌ 合成 |

---

## 4. 推荐结论

排序依据：**实际可用性 × 数据质量 × 合规性**。

### 主源推荐：GitHub 数据集仓库（`luminati-io/*`，维持现状）

- **理由**：唯一"实测通过 + 真实数据 + 字段能填满主源"的组合；匿名 60 次/小时对"构建期一次性拉取"完全够用；且它已经在本项目里跑通（420 件真实目录就是产物）。
- **已知短板**：静态快照，不刷新；真实销量覆盖率低（88/420）；无明确开源授权声明（仅作演示用，README 已标注来源）；`api.github.com` 偶发抖动（实测遇到一次超时，重试可通）；60 次/小时意味着**不能**把它当实时爬虫用。

### 演示源推荐：**不使用外部站点做现场抓取**，改用 Open Food Facts 单品端点

- 原本最理想的演示源是 `books.toscrape.com`（真实 HTML、零合规风险），但**本轮实测本机不可达**，因此不能写进交付脚本。
- 替代方案：演示"抓取 + 归一化"时，用**实测通过的 OFF 单品端点**（无凭证、有真实商品与图片），它同样能展示"真实 HTTP + 真实 JSON → Product 字段映射"的完整链路；换网络后若 books.toscrape 可用，再把它作为更贴近"网页抓取"的演示源。
- **明确不推荐**在演示里现场抓 Shopify 店铺（ToS 风险，见第 5 节）。

### 补充源推荐

| 源 | 补什么 | 短板 |
| --- | --- | --- |
| Open Beauty Facts | 美妆品类的真实商品名/图片/成分/标签 | 无价格/库存/销量；搜索端点时有 5xx；robots.txt 对 `/api` 设 Disallow（按文档调用 + 缓存 + 低频率仍属合理用法，需自行评估） |
| Open Food Facts | 食品品类 | 同上；**其搜索端点当前 502/503 停机**，只能用单品端点或官方 dump |
| Open Library（待复测） | 图书品类（真实书目与封面） | 本机不可达；即便可用也**无价格/库存/销量** |

### 与现有业务的分工建议

1. **主源不变**：继续用 GitHub 快照构建 `catalog/products.ts`（真实、可复现、60 次/小时够用）。
2. **补充源按需引入**：只在"扩大品类覆盖"时接入 OFF/OBF，且**只写它们真实的字段**（名称/图片/成分/标签），价格与库存留空 —— 与项目"没有数据就不显示"的原则一致。
3. **不引入合成源**：DummyJSON 类源虽然字段最全，但会直接击穿项目的数据真实性叙事。

---

## 5. 不能用的源与原因

### 5.1 C 类：灰产转售（本轮搜索中大量出现）

中文搜索「商品数据 API 免注册」的结果里，绝大多数是**转售商包装成"官方接口"**：

| 它们自称 | 实际是什么 | 证据 |
| --- | --- | --- |
| 「1688 商品详情 API / 淘宝 API，无需申请开放平台权限」 | 第三方网关转售官方数据，**仍要注册它们自己的 key + token**，按量收费 | 搜索结果里的教程先写「打开万邦平台官网，完成个人/企业注册 → 控制台获取 key 和 token」，再用 `api.wanbangdata.com/...` 调用 |
| 「Taobaoapi2014 前往体验」「`c0b.cc/R4rbK2` 网关」 | 短链跳转的私域接口，账号 + 计费，来源与授权不透明 | 腾讯云社区文章中给出的接口地址即短链，非官方域名 |
| 「TikTok Shop 商品全量数据，No Login Required」 | Apify 第三方 Actor，调用方**必须带 Apify token**，`from $25.00 / 1,000 results` | Apify Actor 页面：OpenAPI 里 `token` 为 required 参数，明码标价 |

**为什么本项目不能用**：

1. **ToS 风险**：它们转售的通常是官方 OpenAPI 数据，而官方 ToS 普遍禁止转售与再分发；一旦上游追责，使用方在链条上。
2. **与项目叙事自相矛盾**：项目的核心卖点是"每个数字都能追到来源、派生值不冒充真实值"。用一个来源不明、随时可能中断、且违反上游条款的通道获取数据，等于把整条真实性叙事建在沙地上 —— 面试时被问"你的数据从哪来、合规吗"会直接答不上来。
3. **不可复现**：这类服务随时改价、改字段、封号；演示当天挂掉就是事故。

### 5.2 Shopify `/products.json`：技术上免注册，但**ToS 明文禁止**

`/products.json` 确实无需任何凭证（社区大量教程把它当作"开放秘密"），但 Shopify 的法律条款写得很明确：

- Shopify API 许可条款（最后更新 2026-02-27）：不得使用 Shopify API 进行**任何系统性或自动化的数据采集活动**（scraping、data mining、data extraction、data harvesting），也不得**构建任何商业或商品索引（build any commerce or product index）**。
- Shopify 通用服务条款：不得使用 robot、spider、scraper 或其他自动化手段访问服务或监控其中任何材料或信息。

**结论**：即便技术上一条 `curl` 就能拿到干净 JSON（含 price/compare_at_price/variants/SKU），**本项目也不采用** —— "构建商品索引"正是本项目要做的事，属于条款明确禁止的用途。本轮实测对 allbirds / kith 未取到响应（`curl 35`，经排查为**本机 schannel 证书吊销检查失败**，不是店铺封禁），所以这条路的**技术可用性同样未获证实**。

### 5.3 若未来确实需要商业源：走正规路径

需要"真实、实时、有价格库存销量"的商品数据，且不是演示用途时，正规路径是**有合同与合规声明的数据服务商**：

- **Bright Data**（有明确的合规与授权声明、提供 web data 采集与数据集产品）
- **SerpApi / SearchApi**（搜索引擎结果类，用于比价场景）
- **官方开放平台**：Amazon SP-API（卖家自有数据）、eBay 官方 API、Best Buy API、Walmart Affiliate/IO——都需要注册与审核，属于 B 类，但**合规路径清晰**（有明确的服务条款、配额、审计与责任边界）。

选择标准很简单：**愿意公开自己是谁、数据怎么来的、出了问题谁负责**。这正是 C 类转售商全部缺失的部分。

---

## 6. 复测提醒

- 本文所有状态码与响应片段都是 **2026-09-24 单次实测**的结果；OPEN FOOD FACTS 的搜索端点当天正处于官方停机，**换时间需重测**。
- 本机网络对 `openlibrary.org`、`books.toscrape.com`、`api.ebay.com`、`api.mercadolibre.com`、`huggingface.co`、Shopify 店铺域名**不可达**（分别表现为连接超时或 TLS 失败）。这些源的"免注册"结论**尚未被本机证实**，接入前必须在**部署环境的网络**里重跑一遍本文的 `curl` 命令。
- **失败原因的补充排查（23:15）**：对 `github.com` 的 TLS 失败已定位为 **Windows schannel 的证书吊销检查无法连到 CRL/OCSP 服务器**（`curl: (35) schannel: next InitializeSecurityContext failed: CRYPT_E_REVOCATION_OFFLINE`）；同一时段 `api.github.com` 从可达转为 20s 超时（此前 200）。这说明上述失败**属于本机网络环境问题，不代表各源自身不可用** —— 但按本次调研的判定标准，未实测通过的一律不写成"可用"。
- 复测命令（把 URL 换成候选端点即可）：

```bash
curl -sS -m 30 -D - -o /dev/null "https://world.openfoodfacts.org/api/v2/product/3017620422003.json?fields=code,product_name,brands"
curl -sS -m 30 -D - -o /dev/null "https://world.openbeautyfacts.org/api/v2/search?categories_tags=en:shampoos&page_size=1"
curl -sS -m 30 -D - -o /dev/null "https://api.github.com/repos/luminati-io/eCommerce-dataset-samples/contents/"
```