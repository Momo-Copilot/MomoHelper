'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { MaimemoAuthError } from '@momo/maimemo'
import type { DashboardTrendPointDto } from '@momo/types'
import { Icon } from '@/components/icons'
import { ErrorNote, PageHeader, Tile, TileSkeleton } from '@/components/kit'
import { ReportTeaser } from '@/components/report-teaser'
import { TodayWordsCard } from '@/components/today-words'
import { TrendPanel } from '@/components/trend-panel'
import { getDashboardToday, MaimemoNotConfiguredError } from '@/lib/maimemo'
import { getExamDate } from '@/lib/settings'

function beijingDate(d: Date): string
{
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function formatDuration(ms: number): string
{
  const minutes = Math.round(ms / 60000)

  if (minutes < 1)
  {
    return '不足 1 分钟'
  }

  return `${minutes} 分钟`
}

/**
 * 考试倒计时条：只在设置过考试日期后出现。
 *
 * 刻意只显示天数、不显示剩余词数——后者要全量拉词库，今日页不该为一条
 * 提示多付一次请求。具体数字留给 /plan。
 */
function ExamCountdownBar()
{
  const [daysLeft, setDaysLeft] = useState<number | null>(null)

  useEffect(
    () =>
    {
      const examDate = getExamDate()

      if (!examDate)
      {
        return
      }

      // 两个日期都取 UTC 零点，差值直接是天数，不受浏览器时区影响
      const diff = Math.round(
        (Date.parse(`${examDate}T00:00:00Z`) - Date.parse(`${beijingDate(new Date())}T00:00:00Z`)) /
          86_400_000
      )

      setDaysLeft(diff)
    },
    []
  )

  if (daysLeft === null || daysLeft < 0)
  {
    return null
  }

  return (
    <Link
      href="/plan"
      className="mb-4 flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-[length:var(--text-sm)] transition-colors hover:border-[var(--color-border-strong)]"
    >
      <span className="flex items-center gap-1.5">
        <Icon name="calendar" className="h-4 w-4 text-[var(--color-accent)]" />
        <span className="text-[var(--color-text-muted)]">距考试还有</span>
        <span className="font-[family-name:var(--font-display)] text-[length:var(--text-md)] font-semibold tabular">
          {daysLeft}
        </span>
        <span className="text-[var(--color-text-muted)]">天</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
        冲刺计划
        <Icon name="chevron-right" className="h-3.5 w-3.5" />
      </span>
    </Link>
  )
}

const METRICS = [
  { key: 'newWords', label: '新词', icon: 'plus', color: 'var(--color-info)' },
  { key: 'reviewWords', label: '复习', icon: 'repeat', color: 'var(--color-familiar)' },
  { key: 'unfinishedWords', label: '未完成', icon: 'circle-dashed', color: 'var(--color-vague)' },
  { key: 'forgottenWords', label: '遗忘', icon: 'zap', color: 'var(--color-forget)' }
] as const

/** 今日看板：浏览器直连墨墨，成功即留存当日快照 */
export default function DashboardPage()
{
  const query = useQuery({
    queryKey: ['dashboard', 'today'],
    queryFn: () => getDashboardToday()
  })


  if (query.isPending)
  {
    return (
      <div className="grid grid-cols-12 gap-4">
        <TileSkeleton className="col-span-12 lg:col-span-5" />
        <TileSkeleton className="col-span-12 lg:col-span-7" />
        <TileSkeleton className="col-span-12 lg:col-span-8" />
        <TileSkeleton className="col-span-12 lg:col-span-4" />
      </div>
    )
  }

  if (query.isError)
  {
    const err = query.error
    const needSetup = err instanceof MaimemoNotConfiguredError || err instanceof MaimemoAuthError

    return (
      <Tile hover={false} className="mt-16 text-center">
        <Icon name="alert" className="mx-auto h-8 w-8 text-[var(--color-vague)]" />
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
          {needSetup ? '需要先配置墨墨 Token' : '看板加载失败'}
        </h1>
        <p className="mx-auto mt-1 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          {err instanceof MaimemoNotConfiguredError
            ? '尚未绑定墨墨 Token，绑定后即可看到今日学习情况。'
            : err instanceof MaimemoAuthError
              ? '墨墨 Token 已失效或无效，请到设置页重新绑定。'
              : err.message}
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
    )
  }

  const data = query.data
  const rate = data.completionRate ?? 0
  /** 降级快照拿不到遗忘数（null）：此时不弹遗忘预览，也不占额外卡片位 */
  const forgotten = data.forgottenWords ?? 0
  const ringR = 62
  const ringC = 2 * Math.PI * ringR

  return (
    <div>
      <PageHeader
        title="今日学习"
        description={new Date().toLocaleDateString('zh-CN', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          weekday: 'long',
          timeZone: 'Asia/Shanghai'
        })}
        actions={
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[length:var(--text-sm)] shadow-[var(--shadow-tile)] transition-all hover:-translate-y-px hover:shadow-[var(--shadow-tile-hover)] disabled:opacity-50"
          >
            <Icon
              name="refresh"
              className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`}
            />
            {query.isFetching ? '刷新中…' : '刷新数据'}
          </button>
        }
      />

      <ExamCountdownBar />

      {!data.dataReliable && (
        <p className="mb-4 flex items-center gap-2 rounded-md border border-[var(--color-vague)]/30 bg-[var(--color-vague-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-vague)]">
          <Icon name="alert" className="h-4 w-4 shrink-0" />
          墨墨学习数据接口暂不可用，以下为最近一次可靠快照（
          {new Date(data.capturedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}）。
        </p>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* 进度环大瓷贴 */}
        <Tile index={0} className="col-span-12 lg:col-span-5">
          <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">完成进度</p>
          <div className="mt-4 flex items-center gap-6">
            <div className="relative h-[152px] w-[152px] shrink-0">
              <svg viewBox="0 0 152 152" className="h-full w-full -rotate-90">
                <circle
                  cx="76"
                  cy="76"
                  r={ringR}
                  fill="none"
                  stroke="var(--color-bg-subtle)"
                  strokeWidth="12"
                />
                <circle
                  cx="76"
                  cy="76"
                  r={ringR}
                  fill="none"
                  stroke="var(--color-familiar)"
                  strokeWidth="12"
                  strokeLinecap="round"
                  strokeDasharray={ringC}
                  strokeDashoffset={ringC * (1 - rate)}
                  className="ring-progress"
                  style={{ '--ring-circ': ringC } as React.CSSProperties}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <p className="num-in tabular font-[family-name:var(--font-mono)] text-2xl font-semibold leading-none" key={data.finished}>
                  {data.finished}
                  <span className="text-sm font-normal text-[var(--color-text-subtle)]">
                    {' '}/ {data.total}
                  </span>
                </p>
                <p className="mt-1.5 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                  {data.completionRate === null ? '今日暂无计划' : `完成率 ${Math.round(rate * 100)}%`}
                </p>
              </div>
            </div>
            <dl className="min-w-0 flex-1 space-y-3">
              <div className="rounded-md bg-[var(--color-bg-subtle)] px-3.5 py-2.5">
                <dt className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">剩余待学</dt>
                <dd className="num-in tabular font-[family-name:var(--font-mono)] text-lg font-semibold" key={data.remaining}>
                  {data.remaining}
                </dd>
              </div>
              <div className="rounded-md bg-[var(--color-bg-subtle)] px-3.5 py-2.5">
                <dt className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                  <Icon name="clock" className="h-3.5 w-3.5" />
                  学习时长
                </dt>
                <dd className="num-in text-[length:var(--text-md)] font-semibold" key={data.studyTimeMs}>
                  {formatDuration(data.studyTimeMs)}
                </dd>
              </div>
            </dl>
          </div>
        </Tile>

        {/* 四分项 2×2 */}
        <Tile index={1} className="col-span-12 lg:col-span-7">
          <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">今日概览</p>
          <dl className="mt-4 grid grid-cols-2 gap-3">
            {METRICS.map((metric) => (
              <div
                key={metric.key}
                className="group flex items-center gap-3.5 rounded-md border border-[var(--color-border)] px-4 py-3.5 transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)]"
              >
                <span
                  aria-hidden
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md"
                  style={{ background: `color-mix(in oklch, ${metric.color} 12%, transparent)` }}
                >
                  <Icon name={metric.icon} className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <dd className="num-in tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xl)] font-semibold leading-tight" key={data[metric.key] ?? 'unknown'}>
                    {data[metric.key] ?? '—'}
                  </dd>
                  <dt className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                    {metric.label}
                  </dt>
                </div>
              </div>
            ))}
          </dl>
        </Tile>

        {/* 趋势 */}
        <Tile index={2} className="col-span-12 lg:col-span-8">
          <TrendPanel />
        </Tile>

        {/* 快捷入口 */}
        <Tile index={3} className="col-span-12 lg:col-span-4">
          <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">快捷入口</p>
          <ul className="mt-4 space-y-2">
            {(
              [
                { href: '/ask', icon: 'message', label: 'AI 问词', desc: '结合学习数据提问' },
                { href: '/forget', icon: 'trending-down', label: '遗忘词分析', desc: '今日遗忘与顽固词' },
                { href: '/library', icon: 'book', label: '词库总览', desc: '掌握度分布与全量词表' },
                { href: '/settings', icon: 'sliders', label: '设置凭据', desc: 'Token 与 AI Key' }
              ] as const
            ).map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="group flex items-center gap-3.5 rounded-md border border-[var(--color-border)] px-4 py-3 transition-all hover:-translate-y-px hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-tile)]"
                >
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
                  >
                    <Icon name={item.icon} className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-[length:var(--text-sm)] font-medium">{item.label}</span>
                    <span className="block text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                      {item.desc}
                    </span>
                  </span>
                  <Icon
                    name="chevron-right"
                    className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </Tile>

        {/* 今日遗忘词预览（条件出现） */}
        {forgotten > 0 && (
          <Tile index={4} className="col-span-12 border-l-4 !border-l-[var(--color-forget)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[length:var(--text-sm)]">
                <span className="tabular font-[family-name:var(--font-mono)] font-semibold text-[var(--color-forget)]">
                  {forgotten}
                </span>{' '}
                个词今日首次作答遗忘，建议进入诊断。
              </p>
              <Link
                href="/forget"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-forget-bg)] px-3.5 text-[length:var(--text-sm)] font-medium text-[var(--color-forget)] transition-colors hover:bg-[var(--color-forget)]/15"
              >
                遗忘词分析
                <Icon name="arrow-right" className="h-4 w-4" />
              </Link>
            </div>
          </Tile>
        )}

        {/* 学情快照入口：仅本地已有词库缓存时出现（只读缓存，不触发拉取） */}
        <ReportTeaser />

        {/* 今日词表明细：全部词逐行展示 + 双筛选（复用看板数据，无额外请求） */}
        <Tile index={forgotten > 0 ? 5 : 4} hover={false} className="col-span-12">
          <TodayWordsCard words={data.todayWords} />
        </Tile>
      </div>
    </div>
  )
}
