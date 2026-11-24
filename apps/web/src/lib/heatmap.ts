/**
 * 全年学习热力图：把逐日学习数据排成「周一起始的 7 行网格」。
 *
 * 与负荷日历的区别：那张图看未来（next_study_date），这张看过去，所以用绿色
 * 而不是琥珀——绿色是「积累」，不该和「压力」撞色。
 *
 * 数据口径由调用方决定：热力图本身只认 { date, count }，不管 count 是新学
 * 还是学习总量。当前 /report 传的是「新学 ∪ 本地快照」的较大值。
 */

import type { ReportDailyRowDto } from '@momo/types'

import { weekdayOf } from './calendar-grid'

/** 最多展示一年 */
export const HEATMAP_DAYS = 365

export interface HeatCell
{
  date: string
  count: number
  /** 0 = 当天没学，1~4 按窗口内非零日的分位分档 */
  level: 0 | 1 | 2 | 3 | 4
}

export interface HeatmapDto
{
  /** 按周分列，每列 7 天（周一起始）；首尾可能用 null 补齐 */
  weeks: (HeatCell | null)[][]
  /** 窗口内新学总数 */
  total: number
  /** 有学习的天数 */
  activeDays: number
  /** 全程最长连续学习天数 */
  maxStreak: number
  /** 到今天仍在延续的连续天数（今天没学即为 0） */
  currentStreak: number
  /** 窗口内第一个有数据的日期 */
  firstDay: string | null
  /** 窗口内最后一天 */
  lastDay: string | null
}

/** 分位切点：33% / 66% / 90% */
function thresholds(sorted: number[]): [number, number, number]
{
  if (sorted.length === 0)
  {
    return [0, 0, 0]
  }

  const at = (ratio: number): number => sorted[Math.floor((sorted.length - 1) * ratio)]!

  return [at(0.33), at(0.66), at(0.9)]
}

function levelOf(count: number, [t1, t2, t3]: [number, number, number]): 0 | 1 | 2 | 3 | 4
{
  if (count <= 0)
  {
    return 0
  }

  if (count <= t1)
  {
    return 1
  }

  if (count <= t2)
  {
    return 2
  }

  if (count <= t3)
  {
    return 3
  }

  return 4
}

/**
 * @param rows 逐日新学数据（analyzeReport 的 dailyNew，已含 0 值天）
 */
export function buildHeatmap(
  rows: ReportDailyRowDto[],
  options: { days?: number } = {}
): HeatmapDto
{
  const days = Math.max(1, options.days ?? HEATMAP_DAYS)
  const window = rows.slice(-days)

  if (window.length === 0)
  {
    return {
      weeks: [],
      total: 0,
      activeDays: 0,
      maxStreak: 0,
      currentStreak: 0,
      firstDay: null,
      lastDay: null
    }
  }

  const sorted = window
    .filter((row) => row.count > 0)
    .map((row) => row.count)
    .sort((a, b) => a - b)

  const cut = thresholds(sorted)
  const flat = sorted.length > 0 && cut[0] === cut[2]

  const cells: (HeatCell | null)[] = []
  const lead = weekdayOf(window[0]!.date)

  for (let i = 0; i < lead; i++)
  {
    cells.push(null)
  }

  let total = 0
  let activeDays = 0
  let maxStreak = 0
  let run = 0

  for (const row of window)
  {
    total += row.count

    if (row.count > 0)
    {
      activeDays++
      run++
      maxStreak = Math.max(maxStreak, run)
    }
    else
    {
      run = 0
    }

    cells.push({
      date: row.date,
      count: row.count,
      level: flat ? (row.count > 0 ? 2 : 0) : levelOf(row.count, cut)
    })
  }

  // 尾部补齐到整周，日历才不会缺角
  while (cells.length % 7 !== 0)
  {
    cells.push(null)
  }

  const weeks: (HeatCell | null)[][] = []

  for (let i = 0; i < cells.length; i += 7)
  {
    weeks.push(cells.slice(i, i + 7))
  }

  // 当前连续：从最后一天往回数，昨天有学但今天还没学也算断（当天未开始）
  let currentStreak = 0

  for (let i = window.length - 1; i >= 0; i--)
  {
    if (window[i]!.count > 0)
    {
      currentStreak++
    }
    else
    {
      break
    }
  }

  return {
    weeks,
    total,
    activeDays,
    maxStreak,
    currentStreak,
    firstDay: window[0]!.date,
    lastDay: window[window.length - 1]!.date
  }
}
