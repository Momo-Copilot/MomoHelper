/**
 * 趋势柱状图：手写 SVG，无第三方图表库。
 *
 * 两种模式：
 *   快照模式  — 每根柱子 = 当天完成词数，实心 / 圆点 / 空心虚线三种状态
 *   估算模式  — 堆叠柱，底部新学、顶部复习（复习量是下界）
 */

import { useState } from 'react'

import type { DashboardTrendPointDto } from '@momo/types'

export type ChartDay = DashboardTrendPointDto & { newWords?: number; reviewWords?: number }

function beijingDate(d: Date): string
{
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function formatDuration(ms: number): string
{
  const minutes = Math.round(ms / 60000)

  return minutes < 1 ? '不足 1 分钟' : `${minutes} 分钟`
}

export function TrendChart({
  days,
  selected,
  onSelect
}: {
  days: ChartDay[]
  selected: number | null
  onSelect: (index: number | null) => void
})
{
  const [hovered, setHovered] = useState<number | null>(null)
  // 用 reduce 而不是 Math.max(...arr)：数组很长时展开成函数参数既慢又容易踩上限
  const max = days.reduce((acc, d) => (d.finished > acc ? d.finished : acc), 1)
  const today = beijingDate(new Date())

  /**
   * 柱距随天数自适应。
   * 原来固定 40px：365 天时总宽 14600，缩进 1440 的容器后每根柱子只剩 2px，
   * 看着像一排噪点。分段收窄后，长范围也能看清整体形状。
   */
  const slot = days.length <= 14 ? 40 : days.length <= 31 ? 24 : days.length <= 92 ? 12 : 6
  const barWidth = Math.max(slot - (slot >= 24 ? 18 : slot >= 12 ? 5 : 3), 1.5)
  const barOffset = (slot - barWidth) / 2
  const radius = slot >= 40 ? 5 : slot >= 24 ? 3 : slot >= 12 ? 1.5 : 0.5
  const minBarHeight = slot >= 24 ? 6 : slot >= 12 ? 3 : 2

  const width = days.length * slot
  const chartH = 120
  const baseY = 138

  /** 估算模式：一根柱子拆成「新学（底）+ 复习（顶）」两段 */
  const stacked = days.some((d) => d.newWords !== undefined || d.reviewWords !== undefined)

  return (
    <svg
      viewBox={`0 0 ${width} 160`}
      className="h-40 w-full"
      role="img"
      aria-label={`近 ${days.length} 天每日学习趋势`}
    >
      <line x1="0" y1={baseY} x2={width} y2={baseY} stroke="var(--color-border)" strokeWidth="1" />
      {days.map((day, i) =>
      {
        const recorded = day.isReliable
        const newWords = day.newWords ?? 0
        const reviewWords = day.reviewWords ?? 0
        const newH = newWords > 0 ? Math.max(minBarHeight, (newWords / max) * chartH) : 0
        const reviewH = reviewWords > 0 ? Math.max(minBarHeight, (reviewWords / max) * chartH) : 0
        const h = day.finished > 0 ? Math.max(minBarHeight, (day.finished / max) * chartH) : 0

        const x = i * slot + barOffset
        const cx = i * slot + slot / 2
        const y = baseY - h
        const isToday = day.date === today
        const dim = (hovered !== null || selected !== null) && hovered !== i && selected !== i
        const isSelected = selected === i
        const label = recorded
          ? stacked
            ? `${day.date}：新学 ${newWords} · 复习 ${reviewWords}`
            : `${day.date}：完成 ${day.finished}/${day.total}，学习 ${formatDuration(day.studyTimeMs)}`
          : `${day.date}：当天没打开本站，数据未记录（不等于没学）`

        return (
          /* 点击/悬停挂在整个 slot 分组上，而不是一层透明 rect：
             rect 只要被柱子盖住就收不到点击（柱子没有自己的 onClick），
             结果是只有 slot 两侧的窄缝能点中——正是「要点的很靠左边」的原因。
             把事件放在 <g> 上，命中范围恒等于整个 slot，与绘制顺序无关。 */
          <g
            key={day.date}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSelect(isSelected ? null : i)}
            style={{ cursor: 'pointer' }}
          >
            <title>{label}</title>
            {isSelected && (
              <rect
                x={i * slot + 1}
                y="2"
                width={Math.max(slot - 2, 1)}
                height="152"
                rx={2}
                fill="var(--color-accent)"
                opacity="0.08"
              />
            )}
            {!recorded ? (
              /* 没打开本站 / 没记录：空心虚线柱。与「有记录但为 0」的圆点区分开 */
              <rect
                x={x}
                y={baseY - 12}
                width={barWidth}
                height="12"
                rx={radius}
                fill="none"
                stroke="var(--color-border-strong)"
                strokeWidth={slot >= 12 ? 1.5 : 0.8}
                strokeDasharray="3 3"
                opacity={dim ? 0.45 : 1}
                style={{ transition: 'opacity 0.2s' }}
              />
            ) : stacked ? (
              <>
                {newH > 0 && (
                  <rect
                    x={x}
                    y={baseY - newH}
                    width={barWidth}
                    height={newH}
                    rx={radius}
                    fill="var(--color-info)"
                    opacity={dim ? 0.45 : 1}
                    style={{ transition: 'opacity 0.2s' }}
                  />
                )}
                {reviewH > 0 && (
                  <rect
                    x={x}
                    y={baseY - newH - reviewH}
                    width={barWidth}
                    height={reviewH}
                    rx={radius}
                    fill="var(--color-familiar)"
                    opacity={dim ? 0.45 : 1}
                    style={{ transition: 'opacity 0.2s' }}
                  />
                )}
              </>
            ) : day.finished > 0 ? (
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={h}
                rx={radius}
                fill={isToday ? 'var(--color-accent)' : 'var(--color-familiar)'}
                opacity={dim ? 0.45 : 1}
                style={{ transition: 'opacity 0.2s' }}
              />
            ) : (
              <circle
                cx={cx}
                cy={baseY - 4}
                r={slot >= 12 ? 3 : 1.5}
                fill="var(--color-border-strong)"
                opacity={dim ? 0.45 : 1}
              />
            )}
            {hovered === i && day.finished > 0 && (
              <text
                x={cx}
                y={y - 8}
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                fill="var(--color-text)"
              >
                {stacked ? day.finished : day.finished}
              </text>
            )}
            {(i === 0 || i === days.length - 1 || isToday) && (
              <text x={cx} y="154" textAnchor="middle" fontSize="10" fill="var(--color-text-subtle)">
                {isToday ? '今天' : day.date.slice(5)}
              </text>
            )}
            {/* 兜底命中层：放在最后（最上层）且铺满整个 slot。
                <g> 只对已绘制的图形做命中测试，没有柱子的日期（空心虚线柱上方
                的空白、0 值圆点周围的区域）会点不到。这一层保证任意位置都能点。 */}
            <rect
              x={i * slot}
              y="0"
              width={slot}
              height="160"
              fill="transparent"
              onClick={() => onSelect(isSelected ? null : i)}
            />
          </g>
        )
      })}
    </svg>
  )
}

