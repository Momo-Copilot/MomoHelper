'use client'

/**
 * 学情快照：纯代码聚合的全库复盘指标（零 AI）。
 *
 * 与词库页共享 ['library'] 查询缓存（loadLibrary 同一入口），切换零请求。
 * 所有数字来自 analyzeReport / analyzeLibrary 纯函数，可直接对照墨墨 APP 核对；
 * AI 解读区块是第二步规划，本页先立数字——数字错一个，后面 AI 的解读全是错的。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { MaimemoAuthError, beijingToday } from '@momo/maimemo'
import type { ReportSnapshotDto } from '@momo/types'
import { Icon } from '@/components/icons'
import { PageHeader, Segmented, Tile, TileSkeleton } from '@/components/kit'
import { TrendPanel } from '@/components/trend-panel'
import { ReportHeatmap } from '@/components/report-heatmap'
import { ReportInsightTile } from '@/components/report-insight'
import { analyzeLibrary, analyzeReport } from '@/lib/analyze'
import { downloadReportCard } from '@/lib/export-card'
import { buildHeatmap } from '@/lib/heatmap'
import { loadLibrary } from '@/lib/library'
import { getDashboardHistory, MaimemoNotConfiguredError } from '@/lib/maimemo'

const QUERY_KEY = ['library'] as const

/** 数据充分度档位提示：写在代码里而不是让 AI（或用户）自己判断 */
const TIER_NOTICE: Record<ReportSnapshotDto['tier'], { tone: string; title: string; text: string }> = {
  few: {
    tone: 'border-[var(--color-forget)]/30 bg-[var(--color-forget-bg)] text-[var(--color-forget)]',
    title: '数据不足 7 天',
    text: '只看当前画像即可，下面的「未学新词」区间与趋势暂不可信——新词曲线刚开始铺，别急着下结论。'
  },
  some: {
    tone: 'border-[var(--color-info)]/30 bg-[var(--color-info-bg)] text-[var(--color-info)]',
    title: '数据跨度 7~29 天',
    text: '近期节奏可信；长期趋势与「规律性」判断继续等数据积累。'
  },
  rich: {
    tone: 'border-[var(--color-familiar)]/30 bg-[var(--color-familiar-bg)] text-[var(--color-familiar)]',
    title: '数据跨度 30 天以上',
    text: '画像、节奏、风险三块都可以看了。'
  }
}

/** 大数字块 */
function Stat({
  label,
  value,
  hint,
  tone = 'default'
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'risk' | 'accent'
})
{
  const valueColor =
    tone === 'risk'
      ? 'text-[var(--color-forget)]'
      : tone === 'accent'
        ? 'text-[var(--color-accent)]'
        : 'text-[var(--color-text)]'

  return (
    <div>
      <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">{label}</p>
      <p className={`mt-1 font-[family-name:var(--font-display)] text-2xl leading-tight ${valueColor}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  )
}

/** 日粒度新学柱状图：没学新词的日子自然显形为空白段 */
function DailyChart({ rows, days }: { rows: ReportSnapshotDto['dailyNew']; days: number })
{
  const [hovered, setHovered] = useState<number | null>(null)
  const window = rows.slice(-days)
  const max = Math.max(...window.map((row) => row.count), 1)
  const slot = 14
  const width = window.length * slot
  const chartH = 96
  const baseY = 112
  // 大约每隔 15 根柱子画一个日期刻度，最后一根强制有
  const tickStep = Math.max(1, Math.ceil(window.length / 7))

  return (
    <svg
      viewBox={`0 0 ${width} 132`}
      className="h-32 w-full"
      role="img"
      aria-label={`近 ${days} 天每日新学词数`}
    >
      <line x1="0" y1={baseY} x2={width} y2={baseY} stroke="var(--color-border)" strokeWidth="1" />
      {window.map((row, i) =>
      {
        const h = row.count > 0 ? Math.max(3, (row.count / max) * chartH) : 0
        const x = i * slot + 3
        const y = baseY - h
        const isToday = i === window.length - 1

        return (
          <g key={row.date} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <rect x={i * slot} y="0" width={slot} height="132" fill="transparent" />
            {row.count > 0 && (
              <rect
                x={x}
                y={y}
                width="8"
                height={h}
                rx="2"
                fill={isToday ? 'var(--color-accent)' : 'var(--color-accent-bg)'}
                stroke={isToday ? 'var(--color-accent)' : 'var(--color-accent)'}
                strokeWidth="1"
                opacity={hovered === null || hovered === i ? 1 : 0.4}
                style={{ transition: 'opacity 0.15s' }}
              />
            )}
            {hovered === i && (
              <text
                x={Math.min(Math.max(x + 4, 30), width - 30)}
                y="12"
                textAnchor="middle"
                fontSize="11"
                fill="var(--color-text)"
              >
                {`${row.date.slice(5)} 新学 ${row.count}`}
              </text>
            )}
            {(i % tickStep === 0 || i === window.length - 1) && (
              <text
                x={x + 4}
                y={baseY + 16}
                textAnchor="middle"
                fontSize="9"
                fill="var(--color-text-subtle)"
              >
                {row.date.slice(5)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export default function ReportPage()
{
  const [window, setWindow] = useState<'30' | '90'>('30')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  /** 本地每日快照：日期 → 当天完成词数（含复习），只在打开过今日页的日子有 */
  const [snapshots, setSnapshots] = useState<Record<string, number>>({})
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => loadLibrary() })

  useEffect(
    () =>
    {
      const history = getDashboardHistory(366)
      const map: Record<string, number> = {}

      for (const day of history.days)
      {
        map[day.date] = day.finished
      }

      setSnapshots(map)
    },
    []
  )

  const records = query.data?.records
  const report = useMemo(() => (records ? analyzeReport(records) : null), [records])
  const stats = useMemo(() => (records ? analyzeLibrary(records) : null), [records])

  /**
   * 热力图口径（2026-11 修正）：
   *
   * 原来只数 first_study_date，导致「当天只复习、没学新词」整格空白——用户
   * 明明背了单词，图上一片灰。现在改用 dailyTouched（首学 + 最后学习去重），
   * 再与本地快照的真实完成数取较大值：
   *   有快照的日子  → 当天真实完成数（含复习）
   *   没快照的日子  → 首学 + 最后学习，仍偏小（一个词只在最后一次那天记一笔）
   */
  const heatRows = useMemo(
    () =>
      report
        ? report.dailyTouched.map((row) => ({
            date: row.date,
            count: Math.max(row.count, snapshots[row.date] ?? 0)
          }))
        : [],
    [report, snapshots]
  )

  const heat = useMemo(() => buildHeatmap(heatRows), [heatRows])
  /** 数据截断：与词库页同一口径（complete=false 或实取 < 接口总数） */
  const loaded = records?.length ?? 0
  const expected = query.data?.total ?? loaded
  const isComplete = Boolean(query.data?.complete) && loaded >= expected

  if (query.isPending)
  {
    return (
      <div>
        <PageHeader title="学情快照" description="正在读取学习记录…" />
        <div className="grid grid-cols-12 gap-4">
          <TileSkeleton className="col-span-12" />
          <TileSkeleton className="col-span-12" />
        </div>
      </div>
    )
  }

  if (query.isError)
  {
    const error = query.error
    const needSetup = error instanceof MaimemoNotConfiguredError || error instanceof MaimemoAuthError

    // 与词库页错误态同构：居中卡片 + 图标 + 标题 + 去设置/重试
    return (
      <div>
        <PageHeader title="学情快照" />
        <Tile hover={false} className="mt-10 text-center">
          <Icon name="alert" className="mx-auto h-8 w-8 text-[var(--color-vague)]" />
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
            {needSetup ? '需要先配置墨墨 Token' : '学情快照加载失败'}
          </h1>
          <p className="mx-auto mt-1 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            {error instanceof MaimemoNotConfiguredError
              ? '尚未绑定墨墨 Token，绑定后即可生成学情快照。'
              : error instanceof MaimemoAuthError
                ? '墨墨 Token 已失效或无效，请到设置页重新绑定。'
                : error.message}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            {needSetup ? (
              <Link
                href="/settings"
                className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white hover:bg-[var(--color-accent-hover)]"
              >
                <Icon name="sliders" className="mr-2 h-4 w-4" />
                去设置
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] hover:bg-[var(--color-bg-subtle)]"
              >
                重试
              </button>
            )}
          </div>
        </Tile>
      </div>
    )
  }

  if (!report || !stats)
  {
    return null
  }

  const { risk } = report
  const notStartedInData = stats.countBuckets.find((bucket) => bucket.key === '0')?.count ?? 0
  const started = stats.total - notStartedInData
  // 数据不全时不能用 records 里的 0 次桶：未排期的词压根不在 records 里，
  // 直接算会显示「还没开始 0」，而实际有几千词从未开始
  const notStarted = isComplete
    ? notStartedInData
    : Math.max(0, expected - started)
  const notice = TIER_NOTICE[report.tier]
  const recentGaps = [...risk.gaps].reverse().slice(0, 5)

  async function handleExport(): Promise<void>
  {
    if (exporting || !heat)
    {
      return
    }

    setExporting(true)
    setExportError(null)

    try
    {
      await downloadReportCard({
        date: report!.latestDay ?? beijingToday(),
        totalWords: stats!.total,
        studiedWords: started,
        newWordsTotal: heat.total,
        stickingCount: stats!.stickingCount,
        maxGapDays: risk.maxGapDays,
        streak: heat.currentStreak
      })
    }
    catch (error)
    {
      setExportError(error instanceof Error ? error.message : '导出失败')
    }
    finally
    {
      setExporting(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="学情快照"
        description={`全库复盘 · 数据截至 ${report.latestDay ?? '今天'} · 与词库页共享同一次拉取`}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exporting}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
            >
              <Icon name="file-text" className="h-4 w-4" />
              {exporting ? '生成中…' : '导出卡片'}
            </button>
            <Link
              href="/library"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
            >
              看词库明细
            </Link>
          </div>
        }
      />

      {exportError && (
        <p className="mb-4 rounded-md border border-[var(--color-forget)]/25 bg-[var(--color-forget-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-forget)]">
          导出失败：{exportError}
        </p>
      )}

      {!isComplete && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-[var(--color-vague)]/30 bg-[var(--color-vague-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-vague)]">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            只取到 {loaded.toLocaleString('zh-CN')} 条，接口总数 {expected.toLocaleString('zh-CN')}
            条。差额多为未安排复习的词（没有 next_study_date），墨墨接口暂不提供按此筛选的查询，
            以下统计仅覆盖已进入复习计划的词。
          </span>
        </p>
      )}

      {report.tier !== 'rich' && (
        <div className={`mb-4 rounded-md border px-4 py-3 text-[length:var(--text-sm)] ${notice.tone}`}>
          <span className="font-medium">{notice.title}：</span>
          {notice.text}
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* 风险区：三个最扎心的数字 */}
        <Tile index={0} className="col-span-12 md:col-span-4">
          <Stat
            label="沉睡词（30 天以上没碰）"
            value={risk.sleepingCount.toLocaleString('zh-CN')}
            tone={risk.sleepingCount > 0 ? 'risk' : 'default'}
            hint={`已学 ${started.toLocaleString('zh-CN')} 词中的 ${stats.total ? Math.round((risk.sleepingCount / Math.max(started, 1)) * 100) : 0}%`}
          />
          <div className="mt-4 space-y-1.5">
            {risk.sleepingBuckets.map((bucket) => (
              <div key={bucket.key} className="flex items-center gap-2 text-[length:var(--text-xs)]">
                <span className="w-16 shrink-0 text-[var(--color-text-subtle)]">{bucket.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-forget)]/60"
                    style={{ width: `${Math.round(bucket.ratio * 100)}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right tabular">{bucket.count}</span>
              </div>
            ))}
          </div>
        </Tile>

        <Tile index={1} className="col-span-12 md:col-span-4">
          <Stat
            label="最长未学新词"
            value={risk.maxGapDays > 0 ? `${risk.maxGapDays} 天` : '无'}
            tone={risk.maxGapDays >= 7 ? 'risk' : 'default'}
            hint="连续 3 天以上没学新词才计入"
          />
          <div className="mt-4 space-y-2">
            {recentGaps.length === 0 ? (
              <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                没有超过 3 天没学新词。
              </p>
            ) : (
              recentGaps.map((gap) => (
                <div
                  key={gap.start}
                  className="flex items-center justify-between text-[length:var(--text-xs)] text-[var(--color-text-muted)]"
                >
                  <span className="font-[family-name:var(--font-mono)] tabular">
                    {gap.start.slice(5)} ~ {gap.end.slice(5)}
                  </span>
                  <span className="tabular">{gap.days} 天</span>
                </div>
              ))
            )}
          </div>
        </Tile>

        <Tile index={2} className="col-span-12 md:col-span-4">
          <Stat
            label="复习压力峰值"
            value={risk.reviewPeak ? `${risk.reviewPeak.count} 词` : '—'}
            tone="accent"
            hint={risk.reviewPeak ? `落在 ${risk.reviewPeak.date}` : '没有已安排的复习'}
          />
          <div className="mt-4 space-y-2 text-[length:var(--text-xs)] text-[var(--color-text-muted)]">
            <div className="flex justify-between">
              <span>未来 7 天待复习</span>
              <span className="tabular">{risk.reviewUpcoming.within7.toLocaleString('zh-CN')}</span>
            </div>
            <div className="flex justify-between">
              <span>未来 14 天待复习</span>
              <span className="tabular">{risk.reviewUpcoming.within14.toLocaleString('zh-CN')}</span>
            </div>
            <div className="flex justify-between">
              <span>未来 30 天待复习</span>
              <span className="tabular">{risk.reviewUpcoming.within30.toLocaleString('zh-CN')}</span>
            </div>
            {risk.unscheduledCount > 0 && (
              <div className="flex justify-between text-[var(--color-forget)]">
                <span>已学但未安排复习</span>
                <span className="tabular">{risk.unscheduledCount.toLocaleString('zh-CN')}</span>
              </div>
            )}
          </div>
        </Tile>

        {/* 画像数字块 */}
        <Tile index={3} className="col-span-12">
          <div className="flex items-baseline justify-between">
            <p className="text-[length:var(--text-sm)]">全库画像</p>
            <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              共 {stats.total.toLocaleString('zh-CN')} 词 · 平均学习 {stats.avgStudyCount} 次
            </p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="已开始学习" value={started.toLocaleString('zh-CN')} tone="accent" />
            <Stat label="还没开始" value={notStarted.toLocaleString('zh-CN')} />
            <Stat
              label="顽固词"
              value={stats.stickingCount.toLocaleString('zh-CN')}
              tone={stats.stickingCount > 0 ? 'risk' : 'default'}
              hint="反复忘记，带 STICKING 标签"
            />
            <Stat
              label="只学过 1 次"
              value={stats.singleStudyCount.toLocaleString('zh-CN')}
              hint="刚过一遍，最容易被忘掉"
            />
          </div>
        </Tile>

        {/* 日粒度新学曲线 */}
        <Tile index={4} className="col-span-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[length:var(--text-sm)]">每日新学词数</p>
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                {report.firstDay
                  ? `从 ${report.firstDay} 起共 ${report.spanDays} 天，空白段即当天没学新词`
                  : '暂无开始学习的日期数据'}
              </p>
            </div>
            <Segmented
              ariaLabel="曲线窗口"
              value={window}
              options={[
                ['30', '近 30 天'],
                ['90', '近 90 天']
              ]}
              onChange={setWindow}
            />
          </div>
          <div className="mt-4">
            {report.dailyNew.length === 0 ? (
              <p className="flex h-32 items-center justify-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
                记录里没有任何开始学习的日期。
              </p>
            ) : (
              <DailyChart rows={report.dailyNew} days={Number(window)} />
            )}
          </div>
        </Tile>

        {/* 学习趋势：双数据源，快照看精确值、词库估算看长期形态 */}
        <Tile index={5} className="col-span-12">
          <TrendPanel title="学习趋势" defaultRange={30} />
        </Tile>

        {/* 全年热力图：看积累，和上面的日曲线互补（那张看节奏） */}
        <Tile index={5} className="col-span-12">
          <div>
            <p className="text-[length:var(--text-sm)]">学习热力图</p>
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                每一格是一天，颜色越深当天涉及的词越多；有快照的日子用真实完成数，没快照的日子按首学 + 最后学习估算（偏小）
              </p>
            </div>
            <div className="mt-4">
              <ReportHeatmap rows={heatRows} />
            </div>
        </Tile>

        {/* AI 解读（第二步）：代码算指标 → AI 只写解读；按天缓存 */}
        <ReportInsightTile
          report={report}
          stats={stats}
          truncated={isComplete ? undefined : { loaded, expected }}
        />

        {/* 口径说明：这几个指标最容易被误读成「没在学习」 */}
        <p className="col-span-12 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
          「新学」与「未学新词」只统计某个词<strong className="font-medium">第一次</strong>学习；
          复习旧词不计入，所以这些数字低不代表没在学习——复习量看上面的热力图与今日页。
          {!isComplete && ` 词库明细只拿到 ${loaded.toLocaleString('zh-CN')} / ${expected.toLocaleString('zh-CN')} 词（墨墨接口只返回已排期的词），「还没开始」按总数差额估算。`}
        </p>
      </div>
    </div>
  )
}
