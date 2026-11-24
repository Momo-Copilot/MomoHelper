/**
 * 负荷日历的格网布局：把逐日数据切成「按月一块、周一起始」的网格。
 *
 * 抽成纯函数是为了能脱离组件单测——月份边界、闰年、跨年这些地方
 * 最容易错一格，而在页面上只能靠肉眼发现。
 */

import type { ForecastDayDto } from '@momo/types'

/** 0 = 周一 … 6 = 周日；纯 UTC 计算，不受浏览器时区影响 */
export function weekdayOf(date: string): number
{
  const [year, month, day] = date.split('-').map(Number)

  return (new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay() + 6) % 7
}

/** 按月切块，首月前面补 null 对齐到周一 */
export function groupByMonth(
  days: ForecastDayDto[]
): { month: string; cells: (ForecastDayDto | null)[] }[]
{
  const byMonth = new Map<string, ForecastDayDto[]>()

  for (const day of days)
  {
    const key = day.date.slice(0, 7)
    const list = byMonth.get(key)

    if (list)
    {
      list.push(day)
    }
    else
    {
      byMonth.set(key, [day])
    }
  }

  return [...byMonth].map(([month, list]) => ({
    month,
    cells: [...new Array<ForecastDayDto | null>(weekdayOf(list[0]!.date)).fill(null), ...list]
  }))
}
