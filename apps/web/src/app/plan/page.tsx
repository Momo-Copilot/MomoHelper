'use client'

/**
 * 冲刺计划：把「还剩多少词」和「还剩多少天」摆在一起。
 *
 * 数据与词库页共享 ['library'] 缓存，零额外请求——负荷曲线来自记录里的
 * next_study_date，推演用 study_count / first_study_date，都是已有字段。
 * 所有数字由 analyzeForecast / analyzeExamPlan 纯函数算出，
 * 文案与阈值在 buildPlanAlerts 里，页面只负责呈现。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { MaimemoAuthError } from '@momo/maimemo'
import type { ExamPlanDto, PlanAlertDto } from '@momo/types'
import { Icon } from '@/components/icons'
import { TokenRequired } from '@/components/token-required'
import { PageHeader, Segmented, Tile, TileSkeleton } from '@/components/kit'
import { ForecastCalendar } from '@/components/plan-forecast'
import { analyzeExamPlan, analyzeForecast, buildPlanAlerts } from '@/lib/analyze'
import { loadLibrary } from '@/lib/library'
import { MaimemoNotConfiguredError } from '@/lib/maimemo'
import { getExamDate, setExamDate } from '@/lib/settings'

const QUERY_KEY = ['library'] as const

const STATUS_META: Record<
  ExamPlanDto['status'],
  { label: string; hint: string; tone: string }
> = {
  ahead: {
    label: '能提前完成',
    hint: '按当前速度，考试前能学完剩余词',
    tone: 'border-[var(--color-familiar)]/30 bg-[var(--color-familiar-bg)] text-[var(--color-familiar)]'
  },
  'on-track': {
    label: '基本跟得上',
    hint: '差得不多，每天多挤一点就能追上',
    tone: 'border-[var(--color-info)]/30 bg-[var(--color-info-bg)] text-[var(--color-info)]'
  },
  behind: {
    label: '明显落后',
    hint: '照现在这个速度，考前学不完',
    tone: 'border-[var(--color-forget)]/30 bg-[var(--color-forget-bg)] text-[var(--color-forget)]'
  },
  unknown: {
    label: '待补数据',
    hint: '设置考试日期后才能推演',
    tone: 'border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]'
  }
}

const ALERT_TONE: Record<PlanAlertDto['tone'], string> = {
  risk: 'border-[var(--color-forget)]/30 bg-[var(--color-forget-bg)] text-[var(--color-forget)]',
  warn: 'border-[var(--color-vague)]/30 bg-[var(--color-vague-bg)] text-[var(--color-vague)]',
  info: 'border-[var(--color-border)] bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]',
  ok: 'border-[var(--color-familiar)]/30 bg-[var(--color-familiar-bg)] text-[var(--color-familiar)]'
}

const ALERT_ICON: Record<PlanAlertDto['tone'], 'alert' | 'trending-down' | 'clipboard' | 'check'> = {
  risk: 'alert',
  warn: 'trending-down',
  info: 'clipboard',
  ok: 'check'
}

/** 小数字块 */
function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string })
{
  return (
    <div>
      <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">{label}</p>
      <p
        className={`mt-0.5 font-[family-name:var(--font-display)] text-[length:var(--text-lg)] leading-tight tabular ${
          tone ?? 'text-[var(--color-text)]'
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">{hint}</p>}
    </div>
  )
}

/** 考试日期编辑：原生 date 控件，改动即存 */
function ExamDateField({
  value,
  onChange
}: {
  value: string | null
  onChange: (next: string | null) => void
})
{
  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        aria-label="考试日期"
        className="h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[length:var(--text-sm)] tabular"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)] underline underline-offset-2 hover:text-[var(--color-text)]"
        >
          清除
        </button>
      )}
    </div>
  )
}

export default function PlanPage()
{
  // 默认 60 天：考研冲刺期真正要看的是「考前那两周会不会爆」，
  // 30 天往往看不到峰值落在考试附近
  const [window, setWindow] = useState<'30' | '60' | '90'>('60')
  const [examDate, setDate] = useState<string | null>(null)
  const [dateReady, setDateReady] = useState(false)
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => loadLibrary() })

  // localStorage 只能在挂载后读，先渲染骨架避免服务端/客户端首帧不一致
  useEffect(
    () =>
    {
      setDate(getExamDate())
      setDateReady(true)
    },
    []
  )

  const records = query.data?.records
  const forecast = useMemo(
    () => (records ? analyzeForecast(records, { days: Number(window) }) : null),
    [records, window]
  )
  const plan = useMemo(
    () => (records ? analyzeExamPlan(records, { examDate }) : null),
    [records, examDate]
  )
  const alerts = useMemo(
    () => (forecast && plan ? buildPlanAlerts(forecast, plan) : []),
    [forecast, plan]
  )

  /** 数据截断：与词库页 / 学情页同一口径 */
  const loaded = records?.length ?? 0
  const expected = query.data?.total ?? loaded
  const isComplete = Boolean(query.data?.complete) && loaded >= expected

  function updateExamDate(next: string | null): void
  {
    setExamDate(next)
    setDate(next)
  }

  if (query.isPending || !dateReady)
  {
    return (
      <div>
        <PageHeader title="冲刺计划" description="正在读取学习记录…" />
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

    // 未配置 / 已失效：统一走 TokenRequired（与今日页同一个组件）
    if (error instanceof MaimemoNotConfiguredError || error instanceof MaimemoAuthError)
    {
      return (
      <div>
        <PageHeader title="冲刺计划" />
        <TokenRequired
          description={
            error instanceof MaimemoAuthError
              ? '墨墨 Token 已失效或无效，到设置页重新绑定即可恢复；也可以先看演示。'
              : '尚未绑定墨墨 Token，绑定后才能算出剩余词数与复习负荷；也可以先看演示。'
          }
        />
      </div>
      )
    }

    return (
      <div>
        <PageHeader title="冲刺计划" />
        <Tile hover={false} className="mt-16 text-center">
          <Icon name="alert" className="mx-auto h-8 w-8 text-[var(--color-vague)]" />
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
            冲刺计划加载失败
          </h1>
          <p className="mx-auto mt-1 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            {error instanceof Error ? error.message : '加载失败，请稍后重试'}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] hover:bg-[var(--color-bg-subtle)]"
            >
              重试
            </button>
          </div>
        </Tile>
      </div>
    )
  }

  if (!plan || !forecast)
  {
    return null
  }

  const status = STATUS_META[plan.status]
  const daysLeft = plan.daysLeft
  const past = daysLeft !== null && daysLeft < 0
  const percent = plan.totalWords === 0 ? 0 : Math.round((plan.studiedWords / plan.totalWords) * 100)
  const hasExam = daysLeft !== null && daysLeft >= 0

  return (
    <div>
      <PageHeader
        title="冲刺计划"
        description="未来复习负荷 + 考前推演 · 与词库页共享同一次拉取"
        actions={
          <Link
            href="/report"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            看学情
          </Link>
        }
      />

      {!isComplete && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-[var(--color-vague)]/30 bg-[var(--color-vague-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-vague)]">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            只取到 {loaded.toLocaleString('zh-CN')} 条，接口总数 {expected.toLocaleString('zh-CN')}
            条。负荷曲线只覆盖已安排复习的词，差额部分不在这张图上。
          </span>
        </p>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* 倒计时 + 推演 */}
        <Tile index={0} hover={false} className="col-span-12">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-[150px]">
              <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                {hasExam ? '距考试' : past ? '考试日期已过' : '考试日期'}
              </p>
              <p className="mt-1 flex items-baseline gap-1.5">
                <span className="font-[family-name:var(--font-display)] text-[length:var(--text-3xl)] leading-none tabular">
                  {hasExam ? daysLeft : past ? Math.abs(daysLeft!) : '—'}
                </span>
                <span className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
                  {hasExam || past ? '天' : ''}
                </span>
              </p>
              <div className={`mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[length:var(--text-xs)] ${status.tone}`}>
                {status.label}
              </div>
            </div>

            <div className="min-w-[220px] flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[length:var(--text-sm)]">
                  已学 {plan.studiedWords.toLocaleString('zh-CN')} / {plan.totalWords.toLocaleString('zh-CN')} 词
                </p>
                <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] tabular">{percent}%</p>
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="词库已学进度"
              >
                <div
                  className="h-full rounded-full bg-[var(--color-accent)]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-text-muted)]">
                还剩 {plan.remainingWords.toLocaleString('zh-CN')} 词没开始学
              </p>

              <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                <Metric
                  label="每天需新学"
                  value={plan.dailyNeeded === null ? '—' : `${Math.ceil(plan.dailyNeeded)}`}
                  hint="按剩余天数摊平"
                />
                <Metric
                  label="近期每天"
                  value={`${Math.round(plan.recentPace)}`}
                  hint="近 14 天日均"
                />
                <Metric
                  label={plan.gap !== null && plan.gap > 0 ? '缺口' : '富余'}
                  value={plan.gap === null ? '—' : `${Math.abs(Math.ceil(plan.gap))}`}
                  hint="相对目标速度"
                  tone={
                    plan.gap === null
                      ? undefined
                      : plan.gap > 0
                        ? 'text-[var(--color-forget)]'
                        : 'text-[var(--color-familiar)]'
                  }
                />
                <Metric
                  label="预计学完"
                  value={plan.projectedFinish ? plan.projectedFinish.slice(5).replace('-', '/') : '—'}
                  hint="按当前速度"
                />
              </div>
            </div>

            <div className="w-full shrink-0 md:w-auto">
              <p className="mb-1.5 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                考试日期
              </p>
              <ExamDateField value={examDate} onChange={updateExamDate} />
              {!hasExam && !past && (
                <p className="mt-1.5 max-w-[220px] text-[11px] leading-relaxed text-[var(--color-text-subtle)]">
                  设一个日期就能算出每天该学多少、来不来得及。
                </p>
              )}
            </div>
          </div>
        </Tile>

        {/* 负荷日历 */}
        <Tile index={1} hover={false} className="col-span-12">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[length:var(--text-sm)]">未来复习负荷</p>
            <Segmented
              ariaLabel="负荷窗口"
              value={window}
              options={[
                ['30', '30 天'],
                ['60', '60 天'],
                ['90', '90 天']
              ]}
              onChange={setWindow}
            />
          </div>
          <ForecastCalendar forecast={forecast} />
        </Tile>

        {/* 风险与建议 */}
        <Tile index={2} hover={false} className="col-span-12">
          <p className="text-[length:var(--text-sm)]">要注意的</p>
          {alerts.length === 0 ? (
            <p className="mt-3 text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
              没有明显的风险信号：未来负荷平稳，也没有积压的复习。
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {alerts.map((alert) => (
                <li
                  key={alert.kind}
                  className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[length:var(--text-sm)] ${ALERT_TONE[alert.tone]}`}
                >
                  <Icon name={ALERT_ICON[alert.tone]} className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">{alert.title}</p>
                    <p className="mt-0.5 text-[length:var(--text-xs)] opacity-90">{alert.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Tile>
      </div>

      <p className="mt-4 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
        负荷 = 墨墨为该词排的下一次复习日期落在当天。「还没开始学」按学习次数为 0 计；
        「近期每天」用近 14 天首次学习的词数除以 14。未安排复习的词不会出现在负荷曲线里。
      </p>
    </div>
  )
}