'use client'

/**
 * 未来复习负荷日历。
 *
 * 按月切块、周一开头，颜色表示窗口内的相对负荷——分位在 analyzeForecast
 * 里算好，这里只负责画。点格子看当天数字：移动端没有 hover，
 * 所以选中态是主要交互，默认落在峰值日。
 */

import type { ForecastDto } from '@momo/types'
import { useEffect, useState } from 'react'

import { groupByMonth } from '@/lib/calendar-grid'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 2026-12 → 2026 年 12 月 */
function monthLabel(month: string): string
{
  return `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`
}

function WeekdayHeader()
{
  return (
    <div className="grid grid-cols-7 gap-1">
      {WEEKDAYS.map((label) => (
        <div
          key={label}
          className="pb-1 text-center text-[10px] text-[var(--color-text-subtle)]"
          aria-hidden
        >
          {label}
        </div>
      ))}
    </div>
  )
}

export function ForecastCalendar({ forecast }: { forecast: ForecastDto })
{
  // 初始就落在峰值日：首帧直接有内容，不用等 effect 跑完再补
  const [selected, setSelected] = useState<string | null>(
    forecast.peak?.date ?? forecast.days[0]?.date ?? null
  )

  // 切换窗口 / 数据刷新后重新落到峰值日
  useEffect(
    () =>
    {
      setSelected(forecast.peak?.date ?? forecast.days[0]?.date ?? null)
    },
    [forecast]
  )

  const active = forecast.days.find((day) => day.date === selected) ?? null
  const blocks = groupByMonth(forecast.days)
  const peakDate = forecast.peak?.date ?? null

  return (
    <div>
      {/* 标题由页面提供，这里只放口径数字，避免两处都写「未来复习负荷」 */}
      <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
        共 {forecast.totalInWindow.toLocaleString('zh-CN')} 词待复习 · 有负荷日平均{' '}
        {forecast.busyAverage} 词
      </p>

      {/* 选中日详情：移动端没有 hover，数字只能放在这里 */}
      <div
        className="mt-3 flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-[var(--color-bg-subtle)] px-3 py-2"
        aria-live="polite"
      >
        {active ? (
          <>
            <span className="font-[family-name:var(--font-mono)] text-[var(--text-sm)] tabular">
              {Number(active.date.slice(5, 7))} 月 {Number(active.date.slice(8, 10))} 日
            </span>
            <span className="text-[var(--text-sm)] font-medium">
              {active.count === 0 ? '无复习任务' : `${active.count.toLocaleString('zh-CN')} 词`}
            </span>
            {active.count === 0 && (
              <span className="text-[var(--text-xs)] text-[var(--color-familiar)]">
                空档日，适合加新词
              </span>
            )}
            {active.date === peakDate && active.count > 0 && (
              <span className="text-[var(--text-xs)] text-[var(--color-forget)]">
                窗口内最重的一天
              </span>
            )}
            {active.offset === 0 && (
              <span className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">今天</span>
            )}
            {active.offset > 0 && (
              <span className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                {active.offset} 天后
              </span>
            )}
          </>
        ) : (
          <span className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
            点任意一天看当天负荷
          </span>
        )}
      </div>

      {/* 每个月一块：固定宽度而不是 flex:1——月份格数不同（首月只有几天），
          等分会把短月份拉成和整月一样的宽度，格子大小不一致 */}
      <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
        {blocks.map((block) => (
          <div key={block.month}>
            <p className="mb-1.5 text-[var(--text-xs)] text-[var(--color-text-muted)]">
              {monthLabel(block.month)}
            </p>
            <WeekdayHeader />
            <div className="grid grid-cols-7 gap-1">
              {block.cells.map((cell, index) =>
                cell === null ? (
                  <div key={`blank-${index}`} aria-hidden />
                ) : (
                  <button
                    key={cell.date}
                    type="button"
                    onClick={() => setSelected(cell.date)}
                    aria-pressed={selected === cell.date}
                    aria-label={`${cell.date}，${cell.count} 词待复习`}
                    className={`flex aspect-square items-center justify-center rounded-sm text-[11px] transition-[box-shadow,transform] tabular ${
                      selected === cell.date
                        ? 'ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--color-surface)]'
                        : 'hover:brightness-95'
                    } ${cell.offset === 0 ? 'font-semibold' : ''}`}
                    style={{
                      background: `var(--load-${cell.level})`,
                      // 文字色跟底色反向：深色主题低档压暗要浅字、高档提亮要深字
                      color:
                        cell.level === 0
                          ? 'var(--color-text-subtle)'
                          : `var(--load-ink-${cell.level})`,
                      // 今天加一条内描边，不占布局
                      boxShadow:
                        cell.offset === 0 && selected !== cell.date
                          ? 'inset 0 0 0 1.5px var(--color-accent)'
                          : undefined
                    }}
                  >
                    {Number(cell.date.slice(8, 10))}
                  </button>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 图例：只有颜色编码，必须说明方向 */}
      <div className="mt-4 flex items-center gap-2 text-[10px] text-[var(--color-text-subtle)]">
        <span>轻</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            aria-hidden
            className="h-2.5 w-5 rounded-sm"
            style={{ background: `var(--load-${level})` }}
          />
        ))}
        <span>重</span>
        <span className="ml-2">颜色是这 {forecast.days.length} 天里的相对负荷</span>
      </div>
    </div>
  )
}