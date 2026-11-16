/**
 * 词库聚合：把 8000+ 条学习记录压成页面要展示的几个分布。
 *
 * 纯函数、无副作用、不碰网络与存储——方便单测，也方便在 useMemo 里反复算。
 * 日期一律先转北京时间日期再取月份，避免 ISO 里的 UTC 16:00 被判到前一个月。
 */

import { beijingToday, toBeijingDate } from '@momo/maimemo'
import type {
  LibraryBucketDto,
  LibraryMonthRowDto,
  LibraryRecordRowDto,
  LibraryStatsDto,
  ReportDailyRowDto,
  ReportRiskDto,
  ReportSnapshotDto,
  StudyResponse
} from '@momo/types'

/** 掌握度分桶：学习次数越多说明见得越多。0 次 = 加入词库但还没学过 */
const COUNT_BUCKETS: { key: string; label: string; min: number; max: number }[] = [
  { key: '0', label: '0 次', min: 0, max: 0 },
  { key: '1', label: '1 次', min: 1, max: 1 },
  { key: '2-5', label: '2–5 次', min: 2, max: 5 },
  { key: '6-10', label: '6–10 次', min: 6, max: 10 },
  { key: '11-20', label: '11–20 次', min: 11, max: 20 },
  { key: '20+', label: '20 次以上', min: 21, max: Number.POSITIVE_INFINITY }
]

/** 作答分布：last_response 非白名单值（空串、缺字段、未知枚举）一律归「未作答」 */
const RESPONSE_VALUES = new Set<StudyResponse>(['FORGET', 'VAGUE', 'FAMILIAR'])

const RESPONSE_LABELS: { key: string; label: string; value: StudyResponse | null }[] = [
  { key: 'FORGET', label: '忘记', value: 'FORGET' },
  { key: 'VAGUE', label: '模糊', value: 'VAGUE' },
  { key: 'FAMILIAR', label: '认识', value: 'FAMILIAR' },
  { key: 'NONE', label: '未作答', value: null }
]

const TAG_LABELS: { key: string; label: string }[] = [
  { key: 'STICKING', label: '顽固词' },
  { key: 'WELL_FAMILIAR', label: '熟词' },
  { key: 'NONE', label: '无标签' }
]

/** 任意日期字段 → 北京时间 YYYY-MM-DD；无法解析返回 null */
export function beijingDayOf(value?: string): string | null
{
  if (!value)
  {
    return null
  }

  // 接口日期可能是纯日期，也可能是「北京时间 00:00 的 UTC 表示」
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000+08:00` : value
  )

  if (Number.isNaN(date.getTime()))
  {
    return null
  }

  return toBeijingDate(date)
}

/** 近 N 个月的 YYYY-MM 序列（升序，末位为当前月） */
export function recentMonthKeys(count = 12, today = beijingToday()): string[]
{
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const keys: string[] = []

  for (let i = count - 1; i >= 0; i--)
  {
    // Date.UTC 会自动处理跨年（month 为负时回退到上一年）
    keys.push(new Date(Date.UTC(year, month - 1 - i, 1)).toISOString().slice(0, 7))
  }

  return keys
}

function toBucket(
  key: string,
  label: string,
  count: number,
  total: number
): LibraryBucketDto
{
  return { key, label, count, ratio: total === 0 ? 0 : count / total }
}

export function analyzeLibrary(
  records: LibraryRecordRowDto[],
  options: { months?: number } = {}
): LibraryStatsDto
{
  const total = records.length
  const monthCount = options.months ?? 12

  let studyCountSum = 0
  let singleStudyCount = 0
  let stickingCount = 0

  const bucketCounts = COUNT_BUCKETS.map(() => 0)
  const responseCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  const addedByMonth = new Map<string, number>()
  const firstByMonth = new Map<string, number>()

  for (const record of records)
  {
    const count = record.studyCount ?? 0

    studyCountSum += count

    if (count === 1)
    {
      singleStudyCount++
    }

    for (let i = 0; i < COUNT_BUCKETS.length; i++)
    {
      const bucket = COUNT_BUCKETS[i]!

      if (count >= bucket.min && count <= bucket.max)
      {
        bucketCounts[i]!++
        break
      }
    }

    // 归一化为白名单枚举：接口实测返回过空串（而非缺字段）表示未作答，
    // 防御性兜底任何非 FORGET/VAGUE/FAMILIAR 的值，保证分桶总和等于记录总数
    const response = RESPONSE_VALUES.has(record.lastResponse as StudyResponse)
      ? record.lastResponse
      : null
    const responseKey = response ?? 'NONE'
    responseCounts.set(responseKey, (responseCounts.get(responseKey) ?? 0) + 1)

    const hasSticking = record.tags.includes('STICKING')
    const hasFamiliar = record.tags.includes('WELL_FAMILIAR')

    if (hasSticking)
    {
      stickingCount++
    }

    const tagKey = hasSticking ? 'STICKING' : hasFamiliar ? 'WELL_FAMILIAR' : 'NONE'
    tagCounts.set(tagKey, (tagCounts.get(tagKey) ?? 0) + 1)

    const addedMonth = beijingDayOf(record.addDate)?.slice(0, 7)
    const firstMonth = beijingDayOf(record.firstStudyDate)?.slice(0, 7)

    if (addedMonth)
    {
      addedByMonth.set(addedMonth, (addedByMonth.get(addedMonth) ?? 0) + 1)
    }

    if (firstMonth)
    {
      firstByMonth.set(firstMonth, (firstByMonth.get(firstMonth) ?? 0) + 1)
    }
  }

  // 窗口之前的加入数作为累计基数
  const months = recentMonthKeys(monthCount)
  const windowStart = months[0] ?? ''
  let cumulative = 0

  for (const [month, count] of addedByMonth)
  {
    if (month < windowStart)
    {
      cumulative += count
    }
  }

  const monthRows: LibraryMonthRowDto[] = months.map((month) =>
  {
    const added = addedByMonth.get(month) ?? 0
    const firstStudied = firstByMonth.get(month) ?? 0

    cumulative += added

    return {
      month,
      added,
      firstStudied,
      retention: added === 0 ? null : firstStudied / added,
      cumulative
    }
  })

  return {
    total,
    avgStudyCount: total === 0 ? 0 : Math.round((studyCountSum / total) * 10) / 10,
    singleStudyCount,
    stickingCount,
    countBuckets: COUNT_BUCKETS.map((bucket, i) =>
      toBucket(bucket.key, bucket.label, bucketCounts[i]!, total)
    ),
    tagBuckets: TAG_LABELS.map((tag) =>
      toBucket(tag.key, tag.label, tagCounts.get(tag.key) ?? 0, total)
    ),
    responseBuckets: RESPONSE_LABELS.map((item) =>
      toBucket(item.key, item.label, responseCounts.get(item.value ?? 'NONE') ?? 0, total)
    ),
    months: monthRows
  }
}

/* ============================= 学情快照指标 ============================= */

/** 断更判定阈值：连续零首学天数达到该值才算断更区间 */
const GAP_MIN_DAYS = 3

/** 沉睡分桶（数学区间左闭右开）：[7,14) / [14,30) / [30,60) / [60,∞) */
const SLEEP_BUCKETS: { key: string; label: string; min: number; max: number }[] = [
  { key: '7-13', label: '7–13 天', min: 7, max: 14 },
  { key: '14-29', label: '14–29 天', min: 14, max: 30 },
  { key: '30-59', label: '30–59 天', min: 30, max: 60 },
  { key: '60+', label: '60 天以上', min: 60, max: Number.POSITIVE_INFINITY }
]

/** 沉睡风险口径：距上次学习 >= 30 天 */
const SLEEPING_THRESHOLD = 30

/** 每词「开始学习日」：first_study_date 缺失时回退 add_date（接口必返字段） */
function startedDayOf(record: LibraryRecordRowDto): string | null
{
  return beijingDayOf(record.firstStudyDate) ?? beijingDayOf(record.addDate)
}

/** YYYY-MM-DD 差值（b − a，单位天，均按北京日期边界）；任一为 null 返回 null */
function dayDiff(a: string | null, b: string | null): number | null
{
  if (!a || !b)
  {
    return null
  }

  const parse = (value: string): number =>
    Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)))

  return (parse(b) - parse(a)) / 86_400_000
}

/** YYYY-MM-DD 加 n 天（处理跨月跨年） */
function addDays(date: string, n: number): string
{
  const base = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))

  return new Date(base + n * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 学情快照聚合（纯函数，零 AI）：日粒度新学曲线、沉睡词、断更区间、复习峰值。
 *
 * 口径说明（写给将来接 AI 解读时的自己）：
 * - 「开始学习」= first_study_date，缺失回退 add_date（spec 必返），单日分母永远完整
 * - 「沉睡」只统计已学词（last_study_date 存在），分母是已学词数
 * - 复习分布只看未来（next_study_date >= 今天）；过期日期会出现在墨墨当日
 *   计划里，属于今日看板的职责，这里不重复统计
 * - 断更区间从最早开始日到今天全量扫描，连续零首学 >= 3 天记一段
 */
export function analyzeReport(
  records: LibraryRecordRowDto[],
  today = beijingToday()
): ReportSnapshotDto
{
  const firstByDay = new Map<string, number>()
  const nextByDay = new Map<string, number>()
  /** 已学词距今天数（last_study_date 存在才收） */
  const idleDays: number[] = []
  let unscheduled = 0
  let studied = 0
  let earliest: string | null = null
  let latest: string | null = null

  for (const record of records)
  {
    const started = startedDayOf(record)

    if (started)
    {
      firstByDay.set(started, (firstByDay.get(started) ?? 0) + 1)

      if (earliest === null || started < earliest)
      {
        earliest = started
      }

      if (latest === null || started > latest)
      {
        latest = started
      }
    }

    const lastDay = beijingDayOf(record.lastStudyDate)

    if (lastDay)
    {
      studied++
      const idle = dayDiff(lastDay, today)

      if (idle !== null && idle >= 1)
      {
        idleDays.push(idle)
      }
    }

    const nextDay = beijingDayOf(record.nextStudyDate)

    if (nextDay)
    {
      const ahead = dayDiff(today, nextDay)

      // 过期复习日期（ahead < 0）不算未来压力，墨墨当日计划会带出它们
      if (ahead !== null && ahead >= 0)
      {
        nextByDay.set(nextDay, (nextByDay.get(nextDay) ?? 0) + 1)
      }
    }
    else if (started)
    {
      // 已开始学习却没排下一次复习：真正的「悬空词」
      unscheduled++
    }
  }

  const spanDays = earliest ? (dayDiff(earliest, today) ?? 0) : 0
  const tier: ReportSnapshotDto['tier'] = spanDays < 7 ? 'few' : spanDays < 30 ? 'some' : 'rich'

  // 日粒度曲线：最早开始日 → 今天，逐日补 0（断更区间就藏在 0 值里）
  const dailyNew: ReportDailyRowDto[] = []

  if (earliest)
  {
    for (let day = earliest; day <= today; day = addDays(day, 1))
    {
      dailyNew.push({ date: day, count: firstByDay.get(day) ?? 0 })
    }
  }

  // 断更区间：连续 count === 0 的天数段（>= 3 天），闭区间按日数计
  const gaps: ReportRiskDto['gaps'] = []

  if (dailyNew.length > 1)
  {
    let runStart: number | null = null

    for (let i = 0; i < dailyNew.length; i++)
    {
      const empty = dailyNew[i]!.count === 0

      if (empty && runStart === null)
      {
        runStart = i
      }

      const runEnded = !empty && runStart !== null
      const isTail = empty && i === dailyNew.length - 1

      if ((runEnded || isTail) && runStart !== null)
      {
        // 非空日结束的段不包含当天；尾部全零段包含到最后一天
        const end = runEnded ? i - 1 : i
        const days = end - runStart + 1

        if (days >= GAP_MIN_DAYS)
        {
          gaps.push({
            start: dailyNew[runStart]!.date,
            end: dailyNew[end]!.date,
            days
          })
        }

        runStart = null
      }
    }
  }

  const maxGapDays = gaps.reduce((max, gap) => Math.max(max, gap.days), 0)

  // 沉睡分桶与计数
  const bucketCounts = SLEEP_BUCKETS.map(() => 0)
  let sleepingCount = 0

  for (const idle of idleDays)
  {
    for (let i = 0; i < SLEEP_BUCKETS.length; i++)
    {
      const bucket = SLEEP_BUCKETS[i]!

      if (idle >= bucket.min && idle < bucket.max)
      {
        bucketCounts[i]!++
        break
      }
    }

    if (idle >= SLEEPING_THRESHOLD)
    {
      sleepingCount++
    }
  }

  const sleepingBuckets = SLEEP_BUCKETS.map((bucket, i) =>
    toBucket(bucket.key, bucket.label, bucketCounts[i]!, studied)
  )

  // 复习峰值与未来压力（含今天到期）
  let reviewPeak: ReportRiskDto['reviewPeak'] = null
  let within7 = 0
  let within14 = 0
  let within30 = 0

  for (const [date, count] of nextByDay)
  {
    // 并列时取最早的一天：越早到期越紧迫
    if (
      reviewPeak === null ||
      count > reviewPeak.count ||
      (count === reviewPeak.count && date < reviewPeak.date)
    )
    {
      reviewPeak = { date, count }
    }
  }

  for (const [date, count] of nextByDay)
  {
    const ahead = dayDiff(today, date) ?? -1

    if (ahead <= 7)
    {
      within7 += count
    }

    if (ahead <= 14)
    {
      within14 += count
    }

    if (ahead <= 30)
    {
      within30 += count
    }
  }

  const risk: ReportRiskDto = {
    sleepingCount,
    sleepingBuckets,
    gaps,
    maxGapDays,
    reviewPeak,
    reviewUpcoming: { within7, within14, within30 },
    unscheduledCount: unscheduled
  }

  return { tier, spanDays, firstDay: earliest, latestDay: latest, dailyNew, risk }
}
