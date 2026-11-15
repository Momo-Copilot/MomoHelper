import type {
  MaimemoStudyProgress,
  MaimemoStudyRecord,
  MaimemoStudyTodayItem
} from '@momo/types'
import { z } from 'zod'

import type { MaimemoClient } from './client'
import { MaimemoAuthError, MaimemoStudyUnavailableError } from './errors'

/**
 * 学习数据接口（公测，不保证可用）。
 * 任何失败都包装为 MaimemoStudyUnavailableError，上层走本地快照降级路径。
 */

const progressSchema = z.object({
  progress: z.object({
    finished: z.number(),
    total: z.number(),
    study_time: z.number()
  })
})

const todayItemsSchema = z.object({
  today_items: z.array(z.any()).optional()
})

const recordsSchema = z.object({
  records: z.array(z.any()).optional(),
  count: z.number().optional()
})

/** 获取今日学习进度。study_time 为毫秒。 */
export async function getStudyProgress(client: MaimemoClient): Promise<MaimemoStudyProgress>
{
  try
  {
    const data = await client.request<unknown>('POST', '/study/get_study_progress', {})
    const parsed = progressSchema.parse(data)
    return parsed.progress
  }
  catch (error)
  {
    rethrowStudyError(error)
  }
}

/** 获取今日学习词表（含遗忘 / 未完成标记） */
export async function getTodayItems(client: MaimemoClient): Promise<MaimemoStudyTodayItem[]>
{
  try
  {
    // limit 显式拉满：接口默认仅返回 50 条，看板统计需要全量今日词表
    const data = await client.request<unknown>('POST', '/study/get_today_items', {
      limit: 1000
    })
    const parsed = todayItemsSchema.parse(data)
    return (parsed.today_items ?? []) as MaimemoStudyTodayItem[]
  }
  catch (error)
  {
    rethrowStudyError(error)
  }
}

export interface QueryStudyRecordsParams
{
  /** 只返回总词数 */
  asCount?: boolean
  nextStudyDateStart?: string
  nextStudyDateEnd?: string
  limit?: number
  /** 偏移量（接口未在文档中声明，实测若被忽略会返回重复数据，调用方需自行判定） */
  offset?: number
}

export interface QueryStudyRecordsResult
{
  count?: number
  records: MaimemoStudyRecord[]
}

/** 查询单词级学习记录（支持 as_count、next_study_date 区间） */
export async function queryStudyRecords(
  client: MaimemoClient,
  params: QueryStudyRecordsParams = {}
): Promise<QueryStudyRecordsResult>
{
  try
  {
    // next_study_date 为嵌套对象（.start / .end），非扁平字段
    const data = await client.request<unknown>('POST', '/study/query_study_records', {
      as_count: params.asCount,
      next_study_date:
        params.nextStudyDateStart || params.nextStudyDateEnd
          ? {
              ...(params.nextStudyDateStart ? { start: params.nextStudyDateStart } : {}),
              ...(params.nextStudyDateEnd ? { end: params.nextStudyDateEnd } : {})
            }
          : undefined,
      limit: params.limit,
      offset: params.offset
    })

    const parsed = recordsSchema.parse(data)

    return {
      count: parsed.count,
      records: (parsed.records ?? []) as MaimemoStudyRecord[]
    }
  }
  catch (error)
  {
    rethrowStudyError(error)
  }
}

export interface QueryAllStudyRecordsOptions
{
  /** 每页条数，接口默认上限 1000 */
  pageSize?: number
  /** 安全阀：每种策略最多翻多少页，避免异常数据下无限循环 */
  maxPages?: number
  /** 每翻完一页回吐一次已拉取条数，供 UI 显示进度 */
  onProgress?: (loaded: number, total: number | null) => void
}

/** 各策略实际取到的条数，用于 UI 标注与线上排查 */
export interface StudyRecordFetchDiagnostics
{
  total: number | null
  /** 单请求全量取到多少（0 = 没走到这条） */
  singleShot: number
  /** offset 翻页后累计条数 */
  offsetPaged: number
  /** 日期窗口翻页后累计条数 */
  windowPaged: number
}

export interface QueryAllStudyRecordsResult
{
  records: MaimemoStudyRecord[]
  /** as_count 返回的总词数；拿不到为 null（不影响结果） */
  total: number | null
  /** false = 被分页边界或安全阀截断，UI 需标注数据可能不全 */
  complete: boolean
  diagnostics: StudyRecordFetchDiagnostics
}

/** 单请求拉全的条数上限：再大响应体可能拖到边缘函数超时 */
const MAX_SINGLE_SHOT = 12_000

/**
 * 全量拉取单词级学习记录（8000+ 词时分页取全）。
 *
 * 关键约束：未安排复习的词 next_study_date 为空，日期窗口过滤会把它们整体排除，
 * 只靠窗口翻页永远取不全（实测 8614 词里只有 2212 条带复习日期）。
 * 因此按可靠性从高到低试三种策略，取到 as_count 总数即停：
 *   1. 单请求 limit = total：不带任何过滤，能覆盖全部词
 *   2. offset 翻页：文档未声明，探一页验证是否生效
 *   3. next_study_date 滑动窗口：兜底，只能覆盖有复习日期的词
 *
 * next_study_date 是北京时间 00:00 的 UTC 表示（如 2027-07-04T16:00:00.000Z），
 * 窗口起点追加 24h 得到的 ISO 与接口返回值同格式，不会因时区解析偏 8 小时。
 *
 * 频控无压力：最坏约 11 个请求，远低于 20 次 / 10 秒的限额。
 */
export async function queryStudyRecordsAll(
  client: MaimemoClient,
  options: QueryAllStudyRecordsOptions = {}
): Promise<QueryAllStudyRecordsResult>
{
  const pageSize = options.pageSize ?? 1000
  const maxPages = options.maxPages ?? 40

  const countResult = await queryStudyRecords(client, { asCount: true })
  const total = countResult.count ?? null

  const seen = new Set<string>()
  const records: MaimemoStudyRecord[] = []
  const diagnostics: StudyRecordFetchDiagnostics = {
    total,
    singleShot: 0,
    offsetPaged: 0,
    windowPaged: 0
  }

  /** 去重吸收一页，返回新增条数 */
  function absorb(list: MaimemoStudyRecord[]): number
  {
    let fresh = 0

    for (const record of list)
    {
      if (seen.has(record.voc_id))
      {
        continue
      }

      seen.add(record.voc_id)
      records.push(record)
      fresh++
    }

    return fresh
  }

  const hasAll = (): boolean => total !== null && records.length >= total

  const done = (complete: boolean): QueryAllStudyRecordsResult => ({
    records,
    total,
    complete,
    diagnostics
  })

  // ---------- 策略 1：单请求拉全 ----------
  // 文档写 limit 上限 1000，但实测可能放行更大值。这条最关键：
  // 未安排复习的词没有 next_study_date，永远不会被日期窗口覆盖，只能靠无过滤查询拿到。
  let seed: MaimemoStudyRecord[] = []

  if (total !== null && total > 0 && total <= MAX_SINGLE_SHOT)
  {
    try
    {
      const shot = await queryStudyRecords(client, { limit: total })

      seed = shot.records
      diagnostics.singleShot = seed.length
      absorb(seed)
      options.onProgress?.(records.length, total)

      if (hasAll())
      {
        return done(true)
      }
    }
    catch (error)
    {
      // 401 必须上抛；其余（体积/超时）不致命，继续翻页
      if (error instanceof MaimemoAuthError)
      {
        throw error
      }
    }
  }

  // ---------- 策略 2：offset 翻页 ----------
  // 文档没声明 offset，探一页就知道：能探出新 voc_id 说明生效。
  if (seed.length > 0 && !hasAll())
  {
    let offset = seed.length
    let supported = false
    let batch = await queryStudyRecords(client, { limit: pageSize, offset })

    if (batch.records.some((record) => !seen.has(record.voc_id)))
    {
      supported = true
    }

    for (let page = 0; supported && page < maxPages; page++)
    {
      const fresh = absorb(batch.records)

      offset += batch.records.length
      diagnostics.offsetPaged = records.length
      options.onProgress?.(records.length, total)

      if (batch.records.length < pageSize || fresh === 0 || hasAll())
      {
        break
      }

      batch = await queryStudyRecords(client, { limit: pageSize, offset })
    }

    if (hasAll())
    {
      return done(true)
    }

    if (supported)
    {
      // offset 可用但没翻完（撞上 maxPages），比日期窗口可靠，不再往下试
      return done(false)
    }
  }

  // ---------- 策略 3：next_study_date 滑动窗口兜底 ----------
  let start: string | undefined
  let complete = true

  for (let page = 0; page < maxPages; page++)
  {
    const result = await queryStudyRecords(client, {
      limit: pageSize,
      nextStudyDateStart: start
    })

    // 边界可能重叠（同一复习日跨页），按 voc_id 去重
    const fresh = absorb(result.records)

    diagnostics.windowPaged = records.length
    options.onProgress?.(records.length, total)

    if (result.records.length < pageSize)
    {
      break
    }

    if (fresh === 0)
    {
      // 满页却没有一条新词：说明 next_study_date 窗口过滤没生效，翻下去也是原地打转
      complete = false
      break
    }

    const lastDate = lastStudyDate(result.records)

    if (!lastDate)
    {
      // 满页但尾部没有复习日期：无法再切窗口，尾部可能漏词
      complete = false
      break
    }

    const next = shiftStudyDate(lastDate, 1)

    if (next === start)
    {
      // 同一天塞满整页，窗口切不动
      complete = false
      break
    }

    start = next

    if (page === maxPages - 1)
    {
      complete = false
    }
  }

  return done(total === null ? complete : complete && hasAll())
}

/** 从后往前找最后一个存在的 next_study_date */
function lastStudyDate(records: MaimemoStudyRecord[]): string | undefined
{
  for (let i = records.length - 1; i >= 0; i--)
  {
    const date = records[i]?.next_study_date

    if (date)
    {
      return date
    }
  }

  return undefined
}

/** 日期加 N 天，返回与接口一致的 ISO 字符串（纯日期输入按北京 00:00 解释） */
function shiftStudyDate(value: string, days: number): string
{
  const base = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000+08:00`)
    : new Date(value)

  return new Date(base.getTime() + days * 86_400_000).toISOString()
}

/**
 * 公测接口失败的统一处理（降级入口）。
 *
 * 401 鉴权失败必须原样上抛：页面要引导用户重新绑定 Token，
 * 而不是把失效凭据伪装成「接口暂不可用、显示旧快照」。
 * 其余失败（含业务错误、频控、网络）一律转译为不可用错误，由上层降级。
 */
function rethrowStudyError(error: unknown): never
{
  if (error instanceof MaimemoStudyUnavailableError || error instanceof MaimemoAuthError)
  {
    throw error
  }

  throw new MaimemoStudyUnavailableError(
    `学习数据接口不可用: ${error instanceof Error ? error.message : String(error)}`
  )
}
