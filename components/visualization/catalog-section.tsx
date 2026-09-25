'use client';

import { type ReactNode } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useCatalogData } from '@/components/providers/catalog-data-provider';
import { Badge } from '@/components/ui/badge';
import {
  FIELD_TRUTH,
  FIELD_TRUTH_LEVEL_LABEL,
  REBUILD_COMMAND,
  type FieldTruthLevel,
} from '@/lib/catalog/field-truth';
// 只取类型（`import type` 在编译期被抹掉）——面板的数字全部来自服务端注入的载荷，
// 组件本身不 import 服务端的目录模块（否则整份目录会进首屏 bundle）
import type { CatalogSource } from '@/lib/catalog/products';
import { CATEGORIES } from '@/lib/types';

/**
 * 「数据快照」只读面板。
 *
 * 定位：把「这份目录是怎么来的、哪些字段可信」从文档搬进界面——此前这些结论只写在
 * README 与 project-status 里，产品本身不露出。它是**关于数据本身的说明**，
 * 与「意图解析 / 对比分析 / 决策推荐」同属「系统自述与可审计」，因此放在右栏末尾。
 *
 * 三条硬约束（都有对应实现）：
 *   1. **纯只读**：零网络请求、零写盘、不执行构建——只渲染静态常量与派生数字；
 *   2. **数字全部派生**：件数 / 品类分布 / 平台分布 / 覆盖率都由**当前目录**算出来
 *      （不写死 112 或 420，扩容后自动正确）。算法在服务端 `buildCatalogClientPayload` 里跑，
 *      组件只渲染结果——客户端不再持有全量目录（否则整份目录会进首屏 bundle）；
 *   3. **与角标同一口径**：件数/来源/时间读的都是服务端注入的同一个 `meta` 对象
 *      （就是 `CATALOG_META`），不可能出现两处数字不同。
 *
 * 字段分级表定义在 `lib/catalog/field-truth.ts`（唯一代码来源），README 与
 * `docs/project-status.md` 只描述口径并指向它。
 */

const SOURCE_LABEL: Record<CatalogSource, string> = {
  real: 'real · 冻结快照',
  justoneapi: 'justoneapi · 实时源产物',
  mock: 'mock · 内置演示数据',
};

const SOURCE_HINT: Record<CatalogSource, string> = {
  real: '构建期生成后随仓库发布，请求期不更新',
  justoneapi: '构建时刻调用一次京东接口取回，之后同样冻结',
  mock: '随代码发布，不来自外部数据集',
};

/** 分级 → 视觉：真实绿、派生蓝、本地化中性、缺失警示 */
const LEVEL_VARIANT: Record<FieldTruthLevel, 'success' | 'primary' | 'neutral' | 'warning'> = {
  real: 'success',
  derived: 'primary',
  localized: 'neutral',
  missing: 'warning',
};

function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** 数据集地址拆成可读的「仓库名 + 链接」（产物里是 `A + B` 形式） */
function parseOrigins(origin: string | null): { label: string; url: string }[] {
  if (!origin) return [];
  return origin
    .split(' + ')
    .map((url) => url.trim())
    .filter((url) => url.startsWith('http'))
    .map((url) => ({ label: url.replace(/^https?:\/\/github\.com\//, ''), url }));
}

export function CatalogSection() {
  // 数字全部来自服务端按当前源算好的载荷（覆盖率 / 平台分布 / 品类计数）。
  // 载荷在服务端由 `buildCatalogClientPayload` 从当前目录现算，因此扩容或切源后自动正确。
  const { meta, categoryCounts, coverage, platformCounts: platforms } = useCatalogData();
  const isReal = meta.source === 'real';
  const rebuild = REBUILD_COMMAND[meta.source];

  return (
    <div className="space-y-2.5 text-[11.5px] leading-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={isReal ? 'success' : 'neutral'}>{SOURCE_LABEL[meta.source]}</Badge>
        <span className="text-muted-foreground">{SOURCE_HINT[meta.source]}</span>
      </div>

      {isReal && (
        <Row label="数据来源">
          {parseOrigins(meta.origin).map((item) => (
            <a
              key={item.url}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary-ink underline-offset-2 hover:underline"
            >
              {item.label}
              <ExternalLink className="size-2.5" />
            </a>
          ))}
          <p className="text-muted-foreground">上游为公开发布的抓取样本，非实时接口</p>
        </Row>
      )}

      {(meta.generatedAt || meta.localizedAt) && (
        <Row label="构建时间">
          <span className="tabular-nums text-foreground">{formatStamp(meta.generatedAt)}</span>
          {meta.localizedAt && (
            <span className="text-muted-foreground">
              文案本地化 {formatStamp(meta.localizedAt)}
            </span>
          )}
        </Row>
      )}

      <Row label="规模">
        <span className="text-foreground">
          {meta.count} 件 · {CATEGORIES.length} 品类
        </span>
        <span className="flex flex-wrap gap-1">
          {CATEGORIES.map((category) => (
            <Badge key={category} variant="outline" className="tabular-nums">
              {category} {categoryCounts[category]}
            </Badge>
          ))}
        </span>
        {platforms.length > 0 && (
          <p className="tabular-nums text-muted-foreground">
            平台：{platforms.map((item) => `${item.platform} ${item.count}`).join(' / ')}
          </p>
        )}
      </Row>

      <Row label="真实字段覆盖率">
        <span className="block space-y-1">
          {coverage.map((row) => (
            <span key={row.label} className="flex items-baseline justify-between gap-2">
              <span className="text-foreground">{row.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {row.covered}/{row.total}
              </span>
            </span>
          ))}
        </span>
        <p className="text-muted-foreground">按当前目录实时统计；缺失时界面如实显示「暂无评分 / 评价数」</p>
      </Row>

      {isReal ? (
        <details className="group rounded-[var(--radius-sm)] border border-border">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3 shrink-0 transition-transform group-open:rotate-180" />
            字段真实性分级（{FIELD_TRUTH.length} 项）
          </summary>
          <ul className="space-y-1.5 border-t border-border p-2">
            {FIELD_TRUTH.map((row) => (
              <li key={row.field} className="space-y-0.5">
                <span className="flex items-center gap-1.5">
                  <Badge variant={LEVEL_VARIANT[row.level]}>{FIELD_TRUTH_LEVEL_LABEL[row.level]}</Badge>
                  <span className="text-foreground">{row.field}</span>
                </span>
                {row.level !== 'real' && <p className="text-muted-foreground">{row.detail}</p>}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="rounded-[var(--radius-sm)] border border-border px-2 py-1.5 text-muted-foreground">
          本源的字段覆盖与默认源（real 冻结快照）不同，见 README 的「哪些是真实数据」表；
          字段分级以代码里的 <code className="font-mono">lib/catalog/field-truth.ts</code> 为准。
        </p>
      )}

      {rebuild && (
        <Row label="重建命令">
          <code className="block select-all break-all rounded-[var(--radius-sm)] border border-border bg-surface-muted px-2 py-1 font-mono">
            {rebuild}
          </code>
          <p className="text-muted-foreground">
            本项目使用冻结快照以保证演示与验收可复现，更新数据 = 在终端跑上面的命令。
            <span className="text-foreground"> 面板本身不执行任何构建、不发任何请求。</span>
          </p>
        </Row>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-muted-foreground">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}