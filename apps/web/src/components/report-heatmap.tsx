'use client'

/**
 * 全年学习热力图（GitHub 贡献图风格）。
 *
 * 看的是「积累」而不是「压力」，所以用绿色系；格子只用颜色编码，
 * 精确数字放在 title 里——365 个格子上都写数字会糊成一片。
 */

import type { ReportDailyRowDto } from '@momo/types'
import { useMemo, useState } from 'react'

import { buildHeatmap, HEATMAP_DAYS } from '@/lib/heatmap'

export function ReportHeatmap({ rows }: { rows: ReportDailyRowDto[] })
{
  const [days, setDays] = useState<365 | 180>(HEATMAP_DAYS as 365)
  const map = useMemo(() => buildHeatmap(rows, { days }), [rows, days])

  if (map.weeks.length === 0)
  {
    return (
      <p className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
        还没有开始学习的日期数据，热力图等有了记录才会出现。
      </p>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[length:var(--text-xs)] text-[var(--color-text-muted)]">
          <span>
            累计 <b className="text-[var(--color-text)]">{map.total.toLocaleString('zh-CN')}</b> 词
          </span>
          <span>
            学习 <b className="text-[var(--color-text)]">{map.activeDays}</b> 天
          </span>
          <span>
            最长连续 <b className="text-[var(--color-text)]">{map.maxStreak}</b> 天
          </span>
          {map.currentStreak > 0 && (
            <span className="text-[var(--color-familiar)]">当前连续 {map.currentStreak} 天</span>
          )}
        </p>
        <div className="flex gap-1">
          {[
            [365, '一年'],
            [180, '半年']
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDays(value as 365 | 180)}
              aria-pressed={days === value}
              className={`rounded-sm px-2 py-0.5 text-[length:var(--text-xs)] transition-colors ${
                days === value
                  ? 'bg-[var(--color-accent-bg)] font-medium text-[var(--color-accent)]'
                  : 'text-[var(--color-text-subtle)] hover:text-[var(--color-text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 overflow-x-auto pb-1">
        <div className="flex min-w-max gap-[3px]">
          {map.weeks.map((week, index) => (
            <div key={index} className="flex flex-col gap-[3px]">
              {week.map((cell, row) =>
                cell === null ? (
                  <div key={`blank-${row}`} className="h-3 w-3" aria-hidden />
                ) : (
                  <div
                    key={cell.date}
                    title={`${cell.date} · ${cell.count} 词`}
                    className="h-3 w-3 rounded-[2px]"
                    style={{ background: `var(--heat-${cell.level})` }}
                  />
                )
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--color-text-subtle)]">
        <span>
          {map.firstDay} → {map.lastDay}
        </span>
        <span className="flex items-center gap-1.5">
          少
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              aria-hidden
              className="h-2.5 w-2.5 rounded-[2px]"
              style={{ background: `var(--heat-${level})` }}
            />
          ))}
          多
        </span>
      </div>
    </div>
  )
}
