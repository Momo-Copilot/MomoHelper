'use client'

/**
 * 看板 · 学情快照入口卡。
 *
 * 只读 IndexedDB 缓存（peekLibraryCache，绝不触发全量拉取）：
 * 没拉过词库时本卡不出现，看板页保持轻量。
 * 数字与 /report 页同一套 analyzeReport 纯函数，两处永远一致。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo } from 'react'

import { Icon } from '@/components/icons'
import { Tile } from '@/components/kit'
import { analyzeReport } from '@/lib/analyze'
import { peekLibraryCache } from '@/lib/library'

export function ReportTeaser()
{
  const query = useQuery({
    queryKey: ['library', 'peek'],
    queryFn: peekLibraryCache,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })

  const records = query.data?.records
  const report = useMemo(() => (records ? analyzeReport(records) : null), [records])

  if (!report)
  {
    return null
  }

  const { risk } = report

  return (
    <Tile index={6} as="div" className="col-span-12 border-l-4 !border-l-[var(--color-accent)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[var(--text-sm)]">
            <span className="font-medium">学情快照</span>
            <span className="text-[var(--color-text-muted)]">
              沉睡词{' '}
              <span className="tabular font-[family-name:var(--font-mono)] font-semibold text-[var(--color-forget)]">
                {risk.sleepingCount.toLocaleString('zh-CN')}
              </span>
            </span>
            <span className="text-[var(--color-text-muted)]">
              最长断更{' '}
              <span className="tabular font-[family-name:var(--font-mono)] font-semibold">
                {risk.maxGapDays > 0 ? `${risk.maxGapDays} 天` : '无'}
              </span>
            </span>
            {risk.reviewPeak && (
              <span className="text-[var(--color-text-muted)]">
                复习峰值{' '}
                <span className="tabular font-[family-name:var(--font-mono)] font-semibold text-[var(--color-accent)]">
                  {risk.reviewPeak.date.slice(5)} {risk.reviewPeak.count} 词
                </span>
              </span>
            )}
          </p>
          <p className="mt-1 text-[var(--text-xs)] text-[var(--color-text-subtle)]">
            来自词库缓存 · 全库画像、断更区间与复习压力详见学情页
          </p>
        </div>
        <Link
          href="/report"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent-bg)] px-3.5 text-[var(--text-sm)] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/15"
        >
          查看学情快照
          <Icon name="arrow-right" className="h-4 w-4" />
        </Link>
      </div>
    </Tile>
  )
}
