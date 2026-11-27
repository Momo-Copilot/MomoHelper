'use client'

/**
 * 学习趋势面板：今日页与学情页共用。
 *
 * 两个数据源，口径不同，所以做成互斥开关而不是合并：
 *   快照    — 本地每日快照，只有打开过本站的日子有值。真实完成数，精确但短
 *   词库估算 — 用 study_records 的 first/last_study_date 重建。能回溯到最早
 *             背词那天，但复习量只是「最后一次」的下界
 *
 * 合并会让人分不清哪个数字可信，所以宁可让用户自己选。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo, useState } from 'react'

import { ErrorBoundary } from '@/components/error-boundary'
import { TrendChart, type ChartDay } from '@/components/trend-chart'
import { peekTrendEstimate } from '@/lib/library'
import { getDashboardHistory } from '@/lib/maimemo'

const TREND_RANGES: [number, string][] = [
  [14, '14 天'],
  [30, '30 天'],
  [90, '90 天'],
  [365, '365 天']
]

type TrendSource = 'snapshot' | 'library'

const SOURCES: [TrendSource, string][] = [
  ['snapshot', '快照'],
  ['library', '词库估算']
]

function beijingDate(d: Date): string
{
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function formatDuration(ms: number): string
{
  const minutes = Math.round(ms / 60000)

  return minutes < 1 ? '不足 1 分钟' : `${minutes} 分钟`
}

/** 把快照序列补齐成连续日期，缺的日子标记为不可信（画空心虚线柱） */
function buildDays(rows: ChartDay[], days: number): ChartDay[]
{
  const map = new Map(rows.map((row) => [row.date, row]))
  const out: ChartDay[] = []

  for (let i = days - 1; i >= 0; i--)
  {
    const date = beijingDate(new Date(Date.now() - i * 86_400_000))

    out.push(map.get(date) ?? { date, finished: 0, total: 0, studyTimeMs: 0, isReliable: false })
  }

  return out
}

export function TrendPanel({
  defaultRange = 14,
  defaultSource = 'snapshot',
  title = '学习趋势'
}: {
  defaultRange?: number
  defaultSource?: TrendSource
  title?: string
})
{
  const [range, setRange] = useState(defaultRange)
  const [source, setSource] = useState<TrendSource>(defaultSource)
  const [selected, setSelected] = useState<number | null>(null)

  // 快照：纯本地读取，无网络请求。
  // 不用 useMemo —— 365 次循环不到 1ms，而 memo 一旦漏掉依赖（学情页不传
  // refreshKey）就会一直显示过期数据，这个坑不值得省那点计算
  const snapshotDays = buildDays(getDashboardHistory(range).days, range)

  /**
   * 词库估算：拿到的是已聚合好的 365 天结果（不是 8000 多条原始记录）。
   * 只在切到估算时才读，避免首页无谓地开一次 IndexedDB。
   */
  const libraryPeek = useQuery({
    queryKey: ['library', 'trend-estimate'],
    queryFn: () => peekTrendEstimate(365),
    enabled: source === 'library',
    staleTime: 5 * 60 * 1000,
    retry: false
  })

  const estimate = useMemo(
    () =>
      source === 'library' && libraryPeek.data
        ? { ...libraryPeek.data, points: libraryPeek.data.points.slice(-range) }
        : null,
    [source, libraryPeek.data, range]
  )

  const chartDays: ChartDay[] | null = useMemo(
    () =>
    {
      if (source === 'snapshot')
      {
        return snapshotDays
      }

      if (!estimate)
      {
        return null
      }

      return estimate.points.map((point) => ({
        date: point.date,
        finished: point.newWords + point.reviewWords,
        total: 0,
        studyTimeMs: 0,
        isReliable: point.newWords + point.reviewWords > 0,
        newWords: point.newWords,
        reviewWords: point.reviewWords
      }))
    },
    [source, snapshotDays, estimate]
  )

  const libraryMissing = source === 'library' && libraryPeek.isSuccess && !libraryPeek.data
  const total = chartDays ? chartDays.reduce((sum, d) => sum + d.finished, 0) : null
  const recorded = chartDays ? chartDays.filter((d) => d.isReliable).length : 0
  const picked = selected !== null && chartDays ? chartDays[selected] : null

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          {title}（近 {range} 天）
        </p>
        <div className="flex items-center gap-1">
          {TREND_RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() =>
              {
                setRange(value)
                setSelected(null)
              }}
              aria-pressed={range === value}
              className={`rounded-md px-2 py-1 font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] transition-colors ${
                range === value
                  ? 'bg-[var(--color-accent-bg)] font-semibold text-[var(--color-accent)]'
                  : 'text-[var(--color-text-subtle)] hover:bg-[var(--color-bg-subtle)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-1">
          {SOURCES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() =>
              {
                setSource(key)
                setSelected(null)
              }}
              aria-pressed={source === key}
              className={`rounded-md px-2 py-0.5 text-[length:var(--text-xs)] transition-colors ${
                source === key
                  ? 'bg-[var(--color-bg-subtle)] font-semibold text-[var(--color-text)]'
                  : 'text-[var(--color-text-subtle)] hover:text-[var(--color-text-muted)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
          {chartDays
            ? `${total} 词 · ${source === 'snapshot' ? '已记录' : '有记录'} ${recorded}/${chartDays.length} 天`
            : '—'}
        </span>
      </div>

      <div className="mt-3">
        {libraryMissing ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
            <p>本机还没有词库缓存，先去词库页拉一次。</p>
            <Link
              href="/library"
              className="text-[var(--color-accent)] underline-offset-4 hover:underline"
            >
              去词库页 →
            </Link>
          </div>
        ) : chartDays ? (
          chartDays.some((d) => d.finished > 0) ? (
            <>
              <ErrorBoundary>
                <TrendChart days={chartDays} selected={selected} onSelect={setSelected} />
              </ErrorBoundary>

              {source === 'library' && (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="h-2 w-2 rounded-sm bg-[var(--color-info)]" />
                    新学
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="h-2 w-2 rounded-sm bg-[var(--color-familiar)]" />
                    复习（下界）
                  </span>
                </div>
              )}

              {picked && (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-md bg-[var(--color-bg-subtle)] px-3 py-2 text-center text-[length:var(--text-xs)]">
                  <span className="font-[family-name:var(--font-mono)] tabular">{picked.date}</span>
                  {picked.isReliable ? (
                    source === 'library' ? (
                      <>
                        <span>新学 {picked.newWords ?? 0}</span>
                        <span>复习 {picked.reviewWords ?? 0}</span>
                      </>
                    ) : (
                      <>
                        <span>
                          完成 {picked.finished} / {picked.total}
                        </span>
                        <span>学习 {formatDuration(picked.studyTimeMs)}</span>
                      </>
                    )
                  ) : (
                    <span className="text-[var(--color-text-subtle)]">当天没有记录</span>
                  )}
                </div>
              )}

              <p className="mt-1 text-center text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
                {source === 'library'
                  ? `由词库记录估算${estimate?.earliest ? `，最早可回溯到 ${estimate.earliest}` : ''}。复习量只是下界——墨墨每个词只保留最后一次学习日期。`
                  : '空心虚线 = 当天没打开本站，数据未记录（不等于没学）。点击柱子看当天详情。'}
              </p>
            </>
          ) : (
            <p className="flex h-40 items-center justify-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
              {source === 'library' ? '词库里还没有学习记录。' : '快照从今天开始累积，明天回来看趋势。'}
            </p>
          )
        ) : (
          <div className="flex h-40 items-center justify-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
            载入趋势中…
          </div>
        )}
      </div>
    </div>
  )
}
