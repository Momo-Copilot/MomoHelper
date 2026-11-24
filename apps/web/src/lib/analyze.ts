/**
 * 词库聚合：把 8000+ 条学习记录压成页面要展示的几个分布。
 *
 * 纯函数、无副作用、不碰网络与存储——方便单测，也方便在 useMemo 里反复算。
 * 日期一律先转北京时间日期再取月份，避免 ISO 里的 UTC 16:00 被判到前一个月。
 */

import { beijingToday, toBeijingDate } from '@momo/maimemo'
import type {
  ExamPlanDto,
  ForecastDayDto,
  ForecastDto,
  LibraryBucketDto,
  LibraryMonthRowDto,
  LibraryRecordRowDto,
  LibraryStatsDto,
  PlanAlertDto,
  ReportDailyRowDto,
  ReportRiskDto,
  ReportSnapshotDto,
  StudyResponse,
  WordCloudDto,
  WordCloudWordDto
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

/* ============================= 遗忘词云 ============================= */

/** 遗忘强度三项权重：最近作答忘记 / 墨墨顽固词标签 / 复习遍数 */
const CLOUD_WEIGHT_FORGET = 40
const CLOUD_WEIGHT_STICKING = 30
const CLOUD_WEIGHT_COUNT = 30

/** 复习遍数归一：学 1 次记 0 分，学满 10 次及以上记满分 */
const CLOUD_COUNT_FULL = 10

/** 色阶档位阈值（升序）：分数越过一个阈值升一档，共 5 档 */
const CLOUD_TIER_THRESHOLDS = [40, 55, 70, 85]

/** 词云默认渲染上限：再多就碎成噪点（移动端由调用方传更小值） */
export const WORD_CLOUD_LIMIT = 160

function cloudTierOf(score: number): number
{
  let tier = 0

  for (const threshold of CLOUD_TIER_THRESHOLDS)
  {
    if (score >= threshold)
    {
      tier++
    }
  }

  return tier
}

/** 字号 14–40：幂次压缩让中间档不至于和最大档差太远，避免一个巨无霸压住版面 */
function cloudSizeOf(score: number): number
{
  const ratio = Math.pow(Math.min(100, Math.max(0, score)) / 100, 0.85)

  return Math.round(14 + ratio * 26)
}

/**
 * 遗忘词云数据（纯函数）。
 *
 * 口径（墨墨不提供逐次作答历史，「遗忘次数」拿不到，只能代理）：
 * - 最近作答 = 忘记            → 40 分（最强的「刚忘过」信号）
 * - 带 STICKING 标签           → 30 分（墨墨自己认定的顽固词）
 * - 复习遍数归一 (count−1)/9   → 0–30 分（反复学说明之前没记住）
 *
 * 两条信号（最近忘记 / STICKING）至少有一条才进词云：两个都没有的词，
 * 无论复习多少遍都不算遗忘信号。
 *
 * 分数只用于排序与视觉映射，不等于真实遗忘次数——UI 文案不要说「忘了 N 次」。
 */
export function buildWordCloud(
  records: LibraryRecordRowDto[],
  options: { limit?: number } = {}
): WordCloudDto
{
  const limit = options.limit ?? WORD_CLOUD_LIMIT
  const words: WordCloudWordDto[] = []

  for (const record of records)
  {
    const spelling = record.spelling ?? ''

    // 空拼写渲染不出任何东西，直接跳过
    if (!spelling)
    {
      continue
    }

    const forget = record.lastResponse === 'FORGET'
    const sticking = record.tags.includes('STICKING')

    if (!forget && !sticking)
    {
      continue
    }

    const count = record.studyCount ?? 0
    const countRatio = Math.min(1, Math.max(0, (count - 1) / (CLOUD_COUNT_FULL - 1)))
    const score = Math.round(
      (forget ? CLOUD_WEIGHT_FORGET : 0) +
        (sticking ? CLOUD_WEIGHT_STICKING : 0) +
        CLOUD_WEIGHT_COUNT * countRatio
    )

    words.push({
      vocId: record.vocId,
      spelling,
      score,
      tier: cloudTierOf(score),
      size: cloudSizeOf(score),
      studyCount: count,
      lastResponse: record.lastResponse,
      lastStudyDate: beijingDayOf(record.lastStudyDate) ?? undefined,
      sticking
    })
  }

  // 强度降序；同分再按复习遍数、字母序，保证同一批数据每次排序完全一致
  words.sort(
    (a, b) =>
      b.score - a.score ||
      b.studyCount - a.studyCount ||
      a.spelling.localeCompare(b.spelling, 'en')
  )

  const signalCount = words.length

  return {
    total: records.length,
    signalCount,
    words: words.slice(0, Math.max(0, limit)),
    hiddenCount: Math.max(0, signalCount - limit)
  }
}

/* ============================= 冲刺计划 ============================= */

/** 近期速度的统计窗口（天）：14 天够平滑，又不至于被上个月的状态拖太久 */
const PACE_DAYS = 14

/** 负荷分位切点：窗口内非零日升序取 33% / 66% / 90% */
function loadThresholds(sorted: number[]): [number, number, number]
{
  if (sorted.length === 0)
  {
    return [0, 0, 0]
  }

  const at = (ratio: number): number => sorted[Math.floor((sorted.length - 1) * ratio)]!

  return [at(0.33), at(0.66), at(0.9)]
}

function loadLevelOf(count: number, [t1, t2, t3]: [number, number, number]): 0 | 1 | 2 | 3 | 4
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
 * 未来复习负荷（纯函数）。
 *
 * 数据来自 next_study_date：墨墨给每个词排的下一次复习日。未安排复习的词
 * 没有这个字段，所以本曲线只覆盖「已进入复习计划」的词——和 /report 的
 * 复习压力同口径，页面上必须说明。
 *
 * 分档用窗口内相对分位而不是绝对阈值：词库规模从每天几十到几百都有，
 * 写死阈值会让小词库永远只有最浅一档、大词库永远爆红。
 */
export function analyzeForecast(
  records: LibraryRecordRowDto[],
  options: { days?: number; today?: string } = {}
): ForecastDto
{
  const today = options.today ?? beijingToday()
  const window = Math.max(1, options.days ?? 30)
  const byDay = new Map<string, number>()

  let overdueCount = 0
  let scheduledCount = 0

  for (const record of records)
  {
    const nextDay = beijingDayOf(record.nextStudyDate)

    if (!nextDay)
    {
      continue
    }

    scheduledCount++

    const ahead = dayDiff(today, nextDay)

    if (ahead === null)
    {
      continue
    }

    // 过期日期不算未来负荷，但单独计数：积压本身就是信号
    if (ahead < 0)
    {
      overdueCount++
      continue
    }

    byDay.set(nextDay, (byDay.get(nextDay) ?? 0) + 1)
  }

  // 逐日补 0：今天 → 今天 + window - 1，空档日也占位（日历要能看出来）
  const days: ForecastDayDto[] = []

  for (let offset = 0; offset < window; offset++)
  {
    const date = addDays(today, offset)

    days.push({ date, offset, count: byDay.get(date) ?? 0, level: 0 })
  }

  const sorted = days
    .filter((day) => day.count > 0)
    .map((day) => day.count)
    .sort((a, b) => a - b)

  const thresholds = loadThresholds(sorted)
  /** 窗口内负荷全都一样时没有层次可分，统一给中间档，避免整片最浅色 */
  const flat = sorted.length > 0 && thresholds[0] === thresholds[2]

  let totalInWindow = 0
  let peak: { date: string; count: number } | null = null

  for (const day of days)
  {
    totalInWindow += day.count
    day.level = flat ? (day.count > 0 ? 2 : 0) : loadLevelOf(day.count, thresholds)

    // 并列取最早：按日期升序遍历，严格大于才替换
    if (day.count > 0 && (peak === null || day.count > peak.count))
    {
      peak = { date: day.date, count: day.count }
    }
  }

  return {
    days,
    totalInWindow,
    peak,
    busyAverage: sorted.length === 0 ? 0 : Math.round(totalInWindow / sorted.length),
    idleDays: days.filter((day) => day.count === 0).length,
    overdueCount,
    scheduledCount
  }
}

/**
 * 考前推演（纯函数）：把「还剩多少词」和「还剩多少天」摆在一起。
 *
 * 「已学」沿用词库页口径 study_count > 0，与掌握度 0 次桶互补；
 * 「当前速度」取近 14 天日均新学，用 first_study_date（缺失回退 add_date）
 * 定位，和 /report 的每日新学曲线同源。
 */
export function analyzeExamPlan(
  records: LibraryRecordRowDto[],
  options: { examDate?: string | null; today?: string; paceDays?: number } = {}
): ExamPlanDto
{
  const today = options.today ?? beijingToday()
  const examDate = options.examDate ?? null
  const paceDays = Math.max(1, options.paceDays ?? PACE_DAYS)

  const totalWords = records.length
  let studiedWords = 0
  let recentNew = 0

  for (const record of records)
  {
    if ((record.studyCount ?? 0) > 0)
    {
      studiedWords++
    }

    const started = startedDayOf(record)

    if (!started)
    {
      continue
    }

    const age = dayDiff(started, today)

    // 只数最近 paceDays 天内开始的词；今天开始的也算（age = 0）
    if (age !== null && age >= 0 && age < paceDays)
    {
      recentNew++
    }
  }

  const remainingWords = Math.max(0, totalWords - studiedWords)
  const recentPace = recentNew / paceDays

  const daysLeft = examDate ? dayDiff(today, examDate) : null

  let dailyNeeded: number | null = null

  if (daysLeft !== null && daysLeft >= 0)
  {
    // 考试当天还有剩余词就来不及了，不给出一个假的「每天 N 个」
    dailyNeeded = daysLeft === 0 ? (remainingWords === 0 ? 0 : null) : remainingWords / daysLeft
  }

  const gap = dailyNeeded === null ? null : dailyNeeded - recentPace
  const daysToFinish = recentPace > 0 ? remainingWords / recentPace : remainingWords === 0 ? 0 : null
  const projectedFinish = daysToFinish === null ? null : addDays(today, Math.ceil(daysToFinish))

  let status: ExamPlanDto['status'] = 'unknown'

  if (daysLeft !== null && dailyNeeded !== null)
  {
    if (remainingWords === 0 || recentPace >= dailyNeeded)
    {
      status = 'ahead'
    }
    else if (recentPace >= dailyNeeded * 0.85)
    {
      status = 'on-track'
    }
    else
    {
      status = 'behind'
    }
  }

  return {
    examDate,
    daysLeft,
    totalWords,
    studiedWords,
    remainingWords,
    recentPace,
    dailyNeeded,
    gap,
    daysToFinish,
    projectedFinish,
    status
  }
}

/**
 * 计划页的风险与建议（纯函数，返回已排好序的文案）。
 *
 * 阈值写在这里而不是页面里：这些判断是业务口径，需要能被单独测。
 * 「考前 7 天有峰値」排最前——那是唯一还来得及干预的情况。
 */
export function buildPlanAlerts(
  forecast: ForecastDto,
  plan: ExamPlanDto,
  options: { nearExamDays?: number } = {}
): PlanAlertDto[]
{
  const nearDays = options.nearExamDays ?? 7
  const alerts: PlanAlertDto[] = []
  const { peak } = forecast
  const peakDate = peak

  let peakHandled = false

  if (peakDate && plan.examDate && plan.daysLeft !== null && plan.daysLeft >= 0)
  {
    const gapToExam = dayDiff(peakDate.date, plan.examDate)

    if (gapToExam !== null && gapToExam >= 0 && gapToExam < nearDays)
    {
      peakHandled = true
      alerts.push({
        kind: 'peak-near-exam',
        tone: 'risk',
        title: `考前几天是复习高峰：${peakDate.date} 要复习 ${peakDate.count} 词`,
        detail: `距考试只剩 ${gapToExam} 天，这天却是未来 ${forecast.days.length} 天里最重的一天。现在就别再往里加新词了，能提前清掉的先清掉。`
      })
    }
  }

  if (peakDate && !peakHandled && forecast.busyAverage > 0 && peakDate.count >= forecast.busyAverage * 2)
  {
    alerts.push({
      kind: 'peak',
      tone: 'warn',
      title: `${peakDate.date} 有 ${peakDate.count} 词待复习`,
      detail: `是有负荷日均值（${forecast.busyAverage} 词）的 ${(peakDate.count / forecast.busyAverage).toFixed(1)} 倍。前一天尽量别加新词。`
    })
  }

  if (plan.status === 'behind' && plan.gap !== null && plan.dailyNeeded !== null && plan.daysLeft !== null)
  {
    alerts.push({
      kind: 'behind',
      tone: 'warn',
      title: '按现在的速度，考前过不完',
      detail: `还剩 ${plan.remainingWords.toLocaleString('zh-CN')} 词、${plan.daysLeft} 天，每天要 ${Math.ceil(plan.dailyNeeded)} 个；近期实际每天 ${Math.round(plan.recentPace)} 个，差 ${Math.ceil(plan.gap)} 个。`
    })
  }

  if (forecast.overdueCount > 0)
  {
    alerts.push({
      kind: 'overdue',
      tone: 'info',
      title: `${forecast.overdueCount.toLocaleString('zh-CN')} 个词的复习日期已经过了`,
      detail: '墨墨下次打开会把它们并回当天计划，所以实际负荷可能比上面更高。'
    })
  }

  if (forecast.idleDays >= 3)
  {
    alerts.push({
      kind: 'idle',
      tone: 'info',
      title: `未来 ${forecast.days.length} 天里有 ${forecast.idleDays} 天空档`,
      detail: '这些日子没有复习任务，是加新词最安全的时候。'
    })
  }

  if (plan.status === 'ahead' && plan.remainingWords > 0 && plan.projectedFinish)
  {
    alerts.push({
      kind: 'ahead',
      tone: 'ok',
      title: '照现在的速度，能提前过完',
      detail: `按每天约 ${Math.round(plan.recentPace)} 个算，${plan.projectedFinish} 前后能学完剩下的 ${plan.remainingWords.toLocaleString('zh-CN')} 词。`
    })
  }

  return alerts
}
