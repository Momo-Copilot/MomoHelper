'use client'

/**
 * 全年学习热力图（GitHub 贡献图风格）。
 *
 * 看的是「积累」而不是「压力」，所以用绿色系；格子只用颜色编码，
 * 精确数字放在 title 里——365 个格子上都写数字会糊成一片。
 */

import type { ReportDailyRowDto } from '@momo/types'
import { useMemo, useRef, useState } from 'react'

import { buildHeatmap, HEATMAP_DAYS, type HeatCell } from '@/lib/heatmap'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 11 月 14 日 · 周五 · 38 词 */
function formatDay(cell: HeatCell): string
{
  const [, month, day] = cell.date.split('-')
  const weekday = WEEKDAYS[new Date(`${cell.date}T00:00:00Z`).getUTCDay()] ?? ''

  return `${Number(month)} 月 ${Number(day)} 日 · 周${weekday} · ${cell.count} 词`
}

export function ReportHeatmap({ rows }: { rows: ReportDailyRowDto[] })
{
  const [days, setDays] = useState<365 | 180>(HEATMAP_DAYS as 365)
  /** 悬浮信息：坐标相对外层容器，这样气泡不会被 overflow 容器裁掉 */
  const [hover, setHover] = useState<{ cell: HeatCell; x: number; y: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
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
            累计学习 <b className="text-[var(--color-text)]">{map.total.toLocaleString('zh-CN')}</b> 词
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

      {/* 外层 relative + 气泡挂在这里：气泡若放在 overflow-x-auto 里面会被裁掉 */}
      <div ref={wrapRef} className="relative mt-3" onMouseLeave={() => setHover(null)}>
        <div className="overflow-x-auto pb-1">
          {/* mx-auto + w-max：内容比卡片窄时居中，比卡片宽时才横向滚动。
              只写 min-w-max 会让网格永远贴左边，右边留一大块空白 */}
          <div className="mx-auto flex w-max gap-[3px]">
            {map.weeks.map((week, index) => (
              <div key={index} className="flex flex-col gap-[3px]">
                {week.map((cell, row) =>
                  cell === null ? (
                    <div key={`blank-${row}`} className="h-3 w-3" aria-hidden />
                  ) : (
                    <div
                      key={cell.date}
                      role="img"
                      aria-label={`${cell.date}，${cell.count} 词`}
                      onMouseEnter={(event) =>
                      {
                        const rect = wrapRef.current?.getBoundingClientRect()

                        if (!rect)
                        {
                          return
                        }

                        // 就地夹住，避免气泡在左右两端被容器裁掉
                        const width = wrapRef.current?.clientWidth ?? 0
                        const x = Math.min(
                          Math.max(event.clientX - rect.left, 70),
                          Math.max(70, width - 70)
                        )

                        setHover({ cell, x, y: event.clientY - rect.top })
                      }}
                      className="h-3 w-3 rounded-[2px]"
                      style={{ background: `var(--heat-${cell.level})` }}
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </div>

        {hover && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md bg-[var(--color-text)] px-2 py-1 text-[11px] text-[var(--color-bg)] shadow-[var(--shadow-pop)]"
            style={{
              left: hover.x,
              // 顶部几行没有上方空间，翻到下侧，否则气泡会顶出卡片
              top: hover.y > 42 ? hover.y - 6 : hover.y + 18,
              transform: hover.y > 42 ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
            }}
          >
            {formatDay(hover.cell)}
          </div>
        )}
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
