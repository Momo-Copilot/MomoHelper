/**
 * 词汇量增长曲线：累计折线 + 当月新增柱。
 *
 * 两个量级差得很远（累计几千、当月几十），同轴画柱会把柱子压成一条线。
 * 所以柱子单独按「窗口内最大月增量」缩放，只占底部 30% 高度——看趋势用折线，
 * 看节奏用柱子，互不干扰。
 */

import { useState } from 'react'

import type { VocabGrowthPointDto } from '@/lib/analyze'

/** 把任意最大值向上取整成「好看的刻度」：8000 → 步长 2000，7300 → 步长 2000 */
function niceStep(raw: number): number
{
  if (raw <= 0)
  {
    return 1
  }

  const pow = 10 ** Math.floor(Math.log10(raw))
  const n = raw / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10

  return nice * pow
}

/** 刻度文字：8000 → 8k，避免 Y 轴挤成一条 */
function formatTick(value: number): string
{
  return value >= 1000 ? `${value / 1000}k` : String(value)
}

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
  
  const rawMax = points.reduce((acc, p) => (p.cumulative > acc ? p.cumulative : acc), 1)

  // 纵轴分 4 段，步长取整到「好看的数字」
  const step = niceStep(rawMax / 4)
  const axisMax = step * 4
  const ticks = [0, step, step * 2, step * 3, axisMax]

  /** 左侧留给刻度文字 */
  const AXIS_W = 38
  /** 数值 → SVG 纵坐标（0 在 baseY，最大值在 baseY - chartH） */
  const yFor = (value: number): number => baseY - (value / axisMax) * chartH

  const barWidth = Math.max(slot - (slot >= 32 ? 22 : slot >= 20 ? 12 : 6), 1.5)
  const barOffset = (slot - barWidth) / 2

  // 折线点：每个月的累计值
  const linePoints = points
    .map((p, i) => `${i * slot + slot / 2},${yFor(p.cumulative)}`)
    .join(' ')

  // 面积填充：折线 + 回到基线
  const areaPoints = `0,${baseY} ${linePoints} ${width},${baseY}`

  const tickEvery = Math.max(1, Math.ceil(points.length / 8))

  return (
    <svg
      viewBox={`0 0 ${width + AXIS_W} 160`}
      className="h-40 w-full"
      role="img"
      aria-label="词汇量增长：累计学过的词数与每月新增"
    >
      {/* 纵轴刻度：放在 SVG 内而不是 HTML 覆盖层 —— 容器宽高比与 viewBox 不一致时
          SVG 会等比缩放并留白，HTML 标签对不齐 */}
      {ticks.map((value) => (
        <text
          key={`tick-${value}`}
          x={AXIS_W - 6}
          y={yFor(value) + 3}
          textAnchor="end"
          fontSize="10"
          fill="var(--color-text-subtle)"
        >
          {formatTick(value)}
        </text>
      ))}

      <g transform={`translate(${AXIS_W},0)`}>
      {/* 横向网格：每档一条虚线，和左侧刻度对齐 */}
      {ticks.map((value) => (
        <line
          key={`grid-${value}`}
          x1="0"
          y1={yFor(value)}
          x2={width}
          y2={yFor(value)}
          stroke="var(--color-border)"
          strokeWidth="1"
          strokeDasharray={value === 0 ? undefined : '3 4'}
          opacity={value === 0 ? 1 : 0.55}
        />
      ))}

      {/* 折线下的淡色面积，强化「累计」的视觉重量 */}
      <polygon points={areaPoints} fill="var(--color-accent)" opacity="0.08" />

      {points.map((point, i) =>
      {
        // 同一纵轴：有了刻度，柱子高度必须和刻度对得上，不能独立缩放
        const barH = point.learned > 0 ? Math.max(1.5, (point.learned / axisMax) * chartH) : 0
        const cx = i * slot + slot / 2
        const cy = yFor(point.cumulative)
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
      </g>
    </svg>
  )
}
