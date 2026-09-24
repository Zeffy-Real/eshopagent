#!/usr/bin/env node
/**
 * JustOneAPI 字段探测脚本
 *
 * 用途：在写字段映射之前，先看清真实响应到底返回哪些字段名。
 * 各平台（淘宝 itemId / 京东 skuId / Amazon asin）字段名差异很大，**不凭文档猜**——
 * 猜错的映射会在上层一路返工（见 docs/justoneapi-design.md §3 的 🔬 单元格）。
 *
 * 用法（token 从 --env-file 注入，绝不从命令行参数传）：
 *   node --env-file=.env.local scripts/justoneapi-probe.mjs
 *   node --env-file=.env.local scripts/justoneapi-probe.mjs --keyword=跑鞋
 *   node --env-file=.env.local scripts/justoneapi-probe.mjs --platform=taobao
 *   node --env-file=.env.local scripts/justoneapi-probe.mjs --detail=jd --id=100012043978
 *
 * 计费提醒：**成功的调用会计费**（失败不计费）。默认跑 2 次搜索（淘宝 + 京东）用于二选一比较，
 * 详情用 `--detail` 单独触发。原始响应会自动落盘到 .cache/justoneapi-probe/（已在 .gitignore 中），
 * 后续写映射与夹具时直接读文件，不必重复花钱。
 *
 * 安全：任何打印与落盘内容都经过 redact（URL 里的 token 参数 + token 原值双重脱敏），
 * 脚本也从不把 token 写进产物文件。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = 'https://api.justoneapi.com';
/** 官方建议 120 秒：短超时会让少量请求被误判为失败 */
const TIMEOUT_MS = 120_000;
const OUT_DIR = resolve(ROOT, '.cache/justoneapi-probe');

/**
 * 只用同步 V1 端点；V2 是异步任务（提交后去 Dashboard 下载），本项目不接。
 *
 * 注意路径：搜索端点是 `search-item-list/v1`。早期契约里写的 `search-item/v1` 实测返回
 * HTTP 404 + `code:404 Resource not found`（token 有效，鉴权已通过，是路由没匹配上）——
 * 以官方文档的实际路径为准。
 */
const PLATFORMS = {
  taobao: { search: '/api/taobao/search-item-list/v1', detail: '/api/taobao/get-item-detail/v1' },
  jd: {
    search: '/api/jd/search-item-list/v1',
    detail: '/api/jd/get-item-detail/v1',
    price: '/api/jd/get-item-price/v1',
  },
};

/** 搜索响应里可能的「商品数组」字段名，用于从真实响应里找列表 */
const LIST_KEYS = ['items', 'list', 'itemList', 'item_list', 'auctions', 'products', 'productList', 'results', 'result', 'data'];

/** 映射表关心的字段线索：命中就重点打印，省得在几十个字段里翻 */
const INTERESTING = /id|title|name|price|rating|score|comment|review|stock|sold|sales|volume|quantity|category|shop|brand|image|pic/i;

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = args.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

/** 任何输出（打印 / 落盘）之前都要过这里 */
function redact(text, token) {
  const masked = String(text).replace(/([?&]token=)[^&\s"']*/g, '$1***');
  return token ? masked.split(token).join('***') : masked;
}

function printHelp() {
  console.log(`JustOneAPI 字段探测脚本

用法：
  node --env-file=.env.local scripts/justoneapi-probe.mjs [选项]

选项：
  --keyword=词       搜索关键词，默认「耳机」
  --platform=a,b     搜索的平台，可选 taobao / jd，默认两个都跑（用于二选一比较）
  --detail=平台      改跑商品详情，需同时给 --id
  --price=平台       改跑商品价格端点（目前只有 jd），需同时给 --id
  --id=商品ID        详情/价格探测用的商品 ID（从搜索结果的 id 字段里取）

产出：
  终端打印真实字段名与首个商品的原始 JSON；
  原始响应落盘到 .cache/justoneapi-probe/，后续写映射不必重复计费。
`);
}

/** 描述一个值的结构：对象列出字段名与类型，数组说明元素结构（最多两层） */
function describe(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '数组(空)';
    return `数组(${value.length}) → ${describe(value[0], depth + 1)}`;
  }
  if (typeof value !== 'object') return typeof value;
  const entries = Object.entries(value);
  if (depth >= 2) return `对象(${entries.length} 字段)`;
  const inner = entries.map(([key, item]) => `${key}: ${describe(item, depth + 1)}`).join('，');
  return `对象{ ${inner} }`;
}

/** 从搜索响应里找商品数组，返回 { path, items } —— 不猜字段名，只是从真实结构里找 */
function findItemList(data) {
  if (Array.isArray(data)) return { path: '(根数组)', items: data };
  if (!data || typeof data !== 'object') return null;

  for (const key of LIST_KEYS) {
    const value = data[key];
    if (Array.isArray(value) && value.length > 0) return { path: key, items: value };
  }
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      return { path: `${key}（兜底匹配）`, items: value };
    }
  }
  return null;
}

/** 打印「值得重点看的字段」与完整字段清单 */
function printFields(label, item) {
  if (!item || typeof item !== 'object') return;
  console.log(`\n  [${label}] 字段清单：`);
  for (const [key, value] of Object.entries(item)) {
    const mark = INTERESTING.test(key) ? '★' : ' ';
    console.log(`   ${mark} ${key} = ${describe(value)}`);
  }
}

/** 收集「字段路径 → 类型」的完整清单（数组展开元素结构），用于核对映射该取哪一层 */
function collectPaths(value, prefix, depth, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${prefix}: 数组(空)`);
      return;
    }
    collectPaths(value[0], `${prefix}[]`, depth, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= 3) {
      out.push(`${prefix}: 对象(更深层已省略)`);
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      collectPaths(inner, prefix ? `${prefix}.${key}` : key, depth + 1, out);
    }
    return;
  }
  out.push(`${prefix}: ${value === null ? 'null' : typeof value}`);
}

function printFieldPaths(label, item) {
  if (!item || typeof item !== 'object') return;
  const lines = [];
  collectPaths(item, '', 0, lines);
  console.log(`\n  [${label}] 完整字段路径（共 ${lines.length} 条）：`);
  for (const line of lines) console.log(`    ${line}`);
}

async function call(endpoint, params, token) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set('token', token);

  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  const elapsedMs = Date.now() - startedAt;

  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // 解析失败时原样保留文本，下面照常打印，便于判断是不是网关页
  }

  return {
    endpoint,
    // 只落盘业务参数，token 不进产物
    params,
    url: redact(url.toString(), token),
    httpStatus: response.status,
    elapsedMs,
    envelope,
    text: redact(text, token),
  };
}

function report(result, token) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`请求：${result.endpoint}  参数：${JSON.stringify(result.params)}`);
  console.log(`URL：${result.url}`);
  console.log(`HTTP ${result.httpStatus}  耗时 ${result.elapsedMs}ms`);

  if (!result.envelope) {
    console.log('响应体不是合法 JSON，原文（前 500 字符）：');
    console.log(`  ${result.text.slice(0, 500)}`);
    return false;
  }

  const { code, message, data } = result.envelope;
  console.log(`业务码 code=${code}  message=${JSON.stringify(message ?? '')}`);
  if (code !== 0) {
    console.log('（非 0 码：这次调用不计费，也不需要看字段）');
    return false;
  }

  console.log(`data 结构：${describe(data)}`);

  const list = findItemList(data);
  if (list) {
    console.log(`\n商品数组字段：${list.path}，共 ${list.items.length} 件`);
    const first = list.items[0];
    printFields('第 1 件商品', first);
    if (list.items[1]) printFields('第 2 件商品（确认字段稳定性）', list.items[1]);
    printFieldPaths('第 1 件商品', first);
    console.log('\n第 1 件商品完整 JSON（映射与夹具用）：');
    console.log(redact(JSON.stringify(first, null, 2), token));
  } else {
    console.log('\n未在 data 里找到商品数组，完整字段路径：');
    printFieldPaths('data', data);
    console.log('\n完整 JSON：');
    console.log(redact(JSON.stringify(data, null, 2), token));
  }
  return true;
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const token = (process.env.JUSTONEAPI_TOKEN ?? '').trim();
  if (!token) {
    console.error('[探测] 未配置 JUSTONEAPI_TOKEN。请把它写入 .env.local 后重跑：');
    console.error('       node --env-file=.env.local scripts/justoneapi-probe.mjs');
    process.exit(1);
  }

  const detailPlatform = argValue('detail');
  const pricePlatform = argValue('price');
  const detailId = argValue('id');
  const keyword = argValue('keyword', '耳机');
  const requested = (argValue('platform', 'taobao,jd') ?? '').split(',').map((item) => item.trim());

  const tasks = [];
  const singleMode = pricePlatform ? 'price' : detailPlatform ? 'detail' : null;
  if (singleMode) {
    const platform = pricePlatform ?? detailPlatform;
    if (!PLATFORMS[platform]) {
      console.error(`[探测] 未知平台：${platform}（可选：${Object.keys(PLATFORMS).join(' / ')}）`);
      process.exit(1);
    }
    const endpoint = PLATFORMS[platform][singleMode];
    if (!endpoint) {
      console.error(`[探测] 平台 ${platform} 没有 ${singleMode} 端点`);
      process.exit(1);
    }
    if (!detailId) {
      console.error(`[探测] --${singleMode} 需要同时给 --id=<商品ID>`);
      process.exit(1);
    }
    tasks.push({ platform, mode: singleMode, endpoint, params: { itemId: detailId } });
  } else {
    for (const platform of requested) {
      if (!PLATFORMS[platform]) {
        console.error(`[探测] 跳过未知平台：${platform}`);
        continue;
      }
      tasks.push({
        platform,
        mode: 'search',
        endpoint: PLATFORMS[platform].search,
        params: { keyword, page: 1 },
      });
    }
  }

  if (tasks.length === 0) {
    console.error('[探测] 没有可执行的探测任务，检查 --platform / --detail 参数');
    process.exit(1);
  }

  console.log(`[探测] 关键词「${keyword}」，平台 ${tasks.map((task) => `${task.platform}:${task.mode}`).join(' / ')}`);
  console.log('[探测] 成功的调用会计费；原始响应会落盘到 .cache/justoneapi-probe/');

  await mkdir(OUT_DIR, { recursive: true });
  let allOk = true;

  for (const task of tasks) {
    let result;
    try {
      result = await call(task.endpoint, task.params, token);
    } catch (error) {
      allOk = false;
      console.error(`\n[探测] ${task.platform}:${task.mode} 请求失败：${redact(error?.message ?? error, token)}`);
      continue;
    }

    const ok = report(result, token);
    allOk = allOk && ok;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = resolve(OUT_DIR, `${task.platform}-${task.mode}-${stamp}.json`);
    await writeFile(
      file,
      `${JSON.stringify(
        {
          endpoint: result.endpoint,
          params: result.params,
          httpStatus: result.httpStatus,
          elapsedMs: result.elapsedMs,
          envelope: result.envelope,
          rawText: result.envelope ? undefined : result.text,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`\n原始响应已落盘：${file}`);
  }

  console.log(`\n[探测] 完成${allOk ? '' : '（有请求未成功，见上方输出）'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`[探测] 未捕获异常：${redact(error?.message ?? error, process.env.JUSTONEAPI_TOKEN ?? null)}`);
  process.exit(1);
});