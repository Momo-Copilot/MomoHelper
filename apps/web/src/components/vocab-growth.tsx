/**
 * 词汇量增长曲线：累计折线 + 当月新增柱。
 *
 * 两个量级差得很远（累计几千、当月几十），同轴画柱会把柱子压成一条线。
 * 所以柱子单独按「窗口内最大月增量」缩放，只占底部 30% 高度——看趋势用折线，
 * 看节奏用柱子，互不干扰。
 */

import { useState } from 'react'

import type { VocabGrowthPointDto } from '@/lib/analyze'

function slotFor(count: number): number
{
  if (count <= 12) return 48
  if (count <= 24) return 32
  if (count <= 48) return 20

  return 12
}

export function VocabGrowthChart({ points }: { points: VocabGrowthPointDto[] })
{
  const [hovered, setHovered] = useState<number | null>(null)

  if (points.length === 0)
  {
    return (
      <p className="flex h-40 items-center justify-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
        还没有首次学习的记录。
      </p>
    )
  }

  const slot = slotFor(points.length)
  const width = points.length * slot
  const chartH = 120
  const baseY = 138
  const barArea = chartH * 0.3

  const maxCum = points.reduce((acc, p) => (p.cumulative > acc ? p.cumulative : acc), 1)
  const maxLearned = points.reduce((acc, p) => (p.learned > acc ? p.learned : acc), 1)

  const barWidth = Math.max(slot - (slot >= 32 ? 22 : slot >= 20 ? 12 : 6), 1.5)
  const barOffset = (slot - barWidth) / 2

  // 折线点：每个月的累计值
  const linePoints = points
    .map((p, i) => `${i * slot + slot / 2},${baseY - (p.cumulative / maxCum) * chartH}`)
    .join(' ')

  // 面积填充：折线 + 回到基线
  const areaPoints = `0,${baseY} ${linePoints} ${width},${baseY}`

  const tickEvery = Math.max(1, Math.ceil(points.length / 8))

  return (
    <svg
      viewBox={`0 0 ${width} 160`}
      className="h-40 w-full"
      role="img"
      aria-label="词汇量增长：累计学过的词数与每月新增"
    >
      <line x1="0" y1={baseY} x2={width} y2={baseY} stroke="var(--color-border)" strokeWidth="1" />

      {/* 折线下的淡色面积，强化「累计」的视觉重量 */}
      <polygon points={areaPoints} fill="var(--color-accent)" opacity="0.08" />

      {points.map((point, i) =>
      {
        const barH = point.learned > 0 ? Math.max(2, (point.learned / maxLearned) * barArea) : 0
        const cx = i * slot + slot / 2
        const cy = baseY - (point.cumulative / maxCum) * chartH
        const dim = hovered !== null && hovered !== i

        return (
          <g
            key={point.month}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <rect x={i * slot} y="0" width={slot} height="160" fill="transparent" />
            <title>
              {`${point.month}：当月新学 ${point.learned}，累计 ${point.cumulative.toLocaleString('zh-CN')}`}
            </title>
            {barH > 0 && (
              <rect
                x={i * slot + barOffset}
                y={baseY - barH}
                width={barWidth}
                height={barH}
                rx={barWidth >= 6 ? 2 : 0.5}
                fill="var(--color-border-strong)"
                opacity={dim ? 0.35 : 1}
                style={{ transition: 'opacity 0.15s' }}
              />
            )}
            <circle
              cx={cx}
              cy={cy}
              r={hovered === i ? 3.5 : 2}
              fill="var(--color-accent)"
              opacity={dim ? 0.4 : 1}
            />
          </g>
        )
      })}

      {/* 折线画在点之上，避免被柱子盖住 */}
      <polyline
        points={linePoints}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {points.map((point, i) =>
        (i % tickEvery === 0 || i === points.length - 1) && (
          <text
            key={`tick-${point.month}`}
            x={i * slot + slot / 2}
            y="154"
            textAnchor="middle"
            fontSize="10"
            fill="var(--color-text-subtle)"
          >
            {point.month}
          </text>
        )
      )}
    </svg>
  )
}
