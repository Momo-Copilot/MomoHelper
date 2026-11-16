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
import { useMemo, useState } from 'react'

import { MaimemoAuthError } from '@momo/maimemo'
import type { ReportSnapshotDto } from '@momo/types'
import { ErrorNote, PageHeader, Segmented, Tile, TileSkeleton } from '@/components/kit'
import { analyzeLibrary, analyzeReport } from '@/lib/analyze'
import { loadLibrary } from '@/lib/library'
import { MaimemoNotConfiguredError } from '@/lib/maimemo'

const QUERY_KEY = ['library'] as const

/** 数据充分度档位提示：写在代码里而不是让 AI（或用户）自己判断 */
const TIER_NOTICE: Record<ReportSnapshotDto['tier'], { tone: string; title: string; text: string }> = {
  few: {
    tone: 'border-[var(--color-forget)]/30 bg-[var(--color-forget-bg)] text-[var(--color-forget)]',
    title: '数据不足 7 天',
    text: '只看当前画像即可，下面的断更区间与趋势暂不可信——新词曲线刚开始铺，别急着下结论。'
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
      <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">{label}</p>
      <p className={`mt-1 font-[family-name:var(--font-display)] text-2xl leading-tight ${valueColor}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-[var(--text-xs)] text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  )
}

/** 日粒度新学柱状图：断更区间自然显形为空白段 */
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
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => loadLibrary() })

  const records = query.data?.records
  const report = useMemo(() => (records ? analyzeReport(records) : null), [records])
  const stats = useMemo(() => (records ? analyzeLibrary(records) : null), [records])

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

    return (
      <div>
        <PageHeader title="学情快照" />
        <ErrorNote
          message={
            needSetup
              ? '需要先配置墨墨 Token：到设置页绑定后回来刷新。'
              : `学习记录读取失败：${error instanceof Error ? error.message : '未知错误'}`
          }
        />
      </div>
    )
  }

  if (!report || !stats)
  {
    return null
  }

  const { risk } = report
  const notStarted = stats.countBuckets.find((bucket) => bucket.key === '0')?.count ?? 0
  const started = stats.total - notStarted
  const notice = TIER_NOTICE[report.tier]
  const recentGaps = [...risk.gaps].reverse().slice(0, 5)

  return (
    <div>
      <PageHeader
        title="学情快照"
        description={`全库复盘 · 数据截至 ${report.latestDay ?? '今天'} · 与词库页共享同一次拉取`}
        actions={
          <Link
            href="/library"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            看词库明细
          </Link>
        }
      />

      {report.tier !== 'rich' && (
        <div className={`mb-4 rounded-md border px-4 py-3 text-[var(--text-sm)] ${notice.tone}`}>
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
              <div key={bucket.key} className="flex items-center gap-2 text-[var(--text-xs)]">
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
            label="最长断更"
            value={risk.maxGapDays > 0 ? `${risk.maxGapDays} 天` : '无'}
            tone={risk.maxGapDays >= 7 ? 'risk' : 'default'}
            hint="连续 3 天以上零首学才计入"
          />
          <div className="mt-4 space-y-2">
            {recentGaps.length === 0 ? (
              <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                没有超过 3 天的断更区间。
              </p>
            ) : (
              recentGaps.map((gap) => (
                <div
                  key={gap.start}
                  className="flex items-center justify-between text-[var(--text-xs)] text-[var(--color-text-muted)]"
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
          <div className="mt-4 space-y-2 text-[var(--text-xs)] text-[var(--color-text-muted)]">
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
            <p className="text-[var(--text-sm)]">全库画像</p>
            <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
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
              <p className="text-[var(--text-sm)]">每日新学词数</p>
              <p className="mt-1 text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                {report.firstDay
                  ? `从 ${report.firstDay} 起共 ${report.spanDays} 天，空白段即断更`
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
              <p className="flex h-32 items-center justify-center text-[var(--text-sm)] text-[var(--color-text-subtle)]">
                记录里没有任何开始学习的日期。
              </p>
            ) : (
              <DailyChart rows={report.dailyNew} days={Number(window)} />
            )}
          </div>
        </Tile>
      </div>
    </div>
  )
}
