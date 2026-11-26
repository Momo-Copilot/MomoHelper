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
  /** 服务端按标签筛选（官方 enum 仅 STICKING 顽固词），多个标签为 or 关系 */
  tags?: string
  /** 服务端按拼写筛选（最多 1000，忽略其他条件，不可与 vocIds 同时使用） */
  spellings?: string[]
  /** 服务端按单词 ID 筛选（忽略其他条件，不可与 spellings 同时使用） */
  vocIds?: string[]
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
    // next_study_date 为嵌套对象（.start / .end），非扁平字段；
    // undefined 字段会被 JSON.stringify 自动剔除，不会以 null 形式发给服务端
    const data = await client.request<unknown>('POST', '/study/query_study_records', {
      as_count: params.asCount,
      next_study_date:
        params.nextStudyDateStart || params.nextStudyDateEnd
          ? {
              ...(params.nextStudyDateStart ? { start: params.nextStudyDateStart } : {}),
              ...(params.nextStudyDateEnd ? { end: params.nextStudyDateEnd } : {})
            }
          : undefined,
      tags: params.tags,
      spellings: params.spellings,
      voc_ids: params.vocIds,
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
  /** 每页条数，接口硬上限 1000（超过会被静默截断，不要调大） */
  pageSize?: number
  /** 总请求数安全阀：超过就停止，避免极端数据把频控打满 */
  maxRequests?: number
  /** 每翻完一页回吐一次已拉取条数，供 UI 显示进度 */
  onProgress?: (loaded: number, total: number | null) => void
}

/** 各策略实际取到的条数，用于 UI 标注与线上排查 */
export interface StudyRecordFetchDiagnostics
{
  total: number | null
  /** 单请求探针取到多少（0 = 没走到这条） */
  singleShot: number
  /** offset 翻页后累计条数 */
  offsetPaged: number
  /** 日期区间递归累计条数 */
  rangePaged: number
  /** 实际发出的请求数 */
  requests: number
  /** 因单日超量而被迫放弃的区间数（> 0 表示结果可能不全） */
  overflowRanges: number
}

export interface QueryFilteredStudyRecordsResult
{
  records: MaimemoStudyRecord[]
  /** as_count 在同一筛选条件下返回的总数；拿不到为 null */
  total: number | null
  /** true = 结果与 as_count 总数对齐（或单页拉完）；false = 可能被分页截断 */
  complete: boolean
}

/**
 * 服务端筛选条件下拉取学习记录（tags / spellings / voc_ids）。
 *
 * 与 queryStudyRecordsAll 的区别：筛选把结果集缩小到远小于全量的规模，
 * 不需要区间递归，只需 as_count 校准总数 + offset 探测翻页。
 * offset 不被服务端支持时会拿到重复页，按 voc_id 去重后 fresh === 0 自动终止。
 */
export async function queryStudyRecordsFiltered(
  client: MaimemoClient,
  params: Omit<QueryStudyRecordsParams, 'asCount' | 'offset'> = {},
  options: Pick<QueryAllStudyRecordsOptions, 'maxRequests' | 'onProgress'> = {}
): Promise<QueryFilteredStudyRecordsResult>
{
  const maxPages = options.maxRequests ?? 10
  const pageSize = 1000

  const countResult = await queryStudyRecords(client, { ...params, asCount: true })
  const total = countResult.count ?? null

  const seen = new Set<string>()
  const records: MaimemoStudyRecord[] = []

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

  let offset: number | undefined

  for (let page = 0; page < maxPages; page++)
  {
    const result = await queryStudyRecords(client, { ...params, limit: pageSize, offset })
    const fresh = absorb(result.records)
    options.onProgress?.(records.length, total)

    if (result.records.length < pageSize || fresh === 0)
    {
      break // 不满页即已拉完；fresh === 0 说明 offset 未生效且无新数据
    }

    offset = (offset ?? 0) + result.records.length

    if (total !== null && records.length >= total)
    {
      break
    }
  }

  // 拿不到总数时：不满页视为完整，满页则可能被截断
  const complete = total !== null ? records.length >= total : records.length < pageSize

  return { records, total, complete }
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

/** 接口单次响应硬上限：文档写 1000，实测超过也会被静默截断 */
const API_PAGE_LIMIT = 1000

/** 默认请求数上限：频控是 2000 次 / 5 小时，留足余量 */
const DEFAULT_MAX_REQUESTS = 120

const DAY_MS = 86_400_000
const BEIJING_OFFSET_MS = 8 * 3600_000

/**
 * 北京日期序号：把任意时刻归一到「北京时间的第几天」。
 *
 * 区间递归全程用这个整数做单位，不用毫秒——毫秒对半会因奇数天丢余数，
 * 导致左右子区间之间出现空隙（实测漏 873 条）。整数减法天然无缝。
 */
function toBeijingDayIndex(ms: number): number
{
  return Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS)
}

/**
 * 北京日期序号 → 区间起点的 ISO 字符串（该日 00:00:00.000 +08:00）。
 *
 * 格式必须与 MemoSuperform 实测可用的写法一致（`2026-09-14T00:00:00+08:00`）。
 * 不要用 `toISOString()` 的 `Z` 后缀：那是 UTC 表示，北京 00:00 会写成
 * 前一日 16:00Z，服务端按字符串比较时会把边界那一天整体排除。
 */
function dayIndexToRangeStart(dayIndex: number): string
{
  return `${new Date(dayIndex * DAY_MS).toISOString().slice(0, 10)}T00:00:00+08:00`
}

/**
 * 北京日期序号 → 区间终点的 ISO 字符串（该日 23:59:59.999 +08:00）。
 *
 * 必须用当天最后一毫秒，不能用「次日 00:00」。
 */
function dayIndexToRangeEnd(dayIndex: number): string
{
  return `${new Date(dayIndex * DAY_MS).toISOString().slice(0, 10)}T23:59:59.999+08:00`
}

/** 二分起点与终点（北京日期序号）：覆盖 2000 年到 2200 年之间所有复习日期 */
const RANGE_START_DAY = toBeijingDayIndex(Date.UTC(2000, 0, 1))
const RANGE_END_DAY = toBeijingDayIndex(Date.UTC(2200, 11, 31))

/**
 * 全量拉取单词级学习记录。
 *
 * ## 为什么要重写（2026-11-26）
 *
 * 旧实现按「单请求 limit=total → offset 翻页 → 日期窗口」三策略回退，
 * 长期只能拿到部分数据（页面会提示「差额多为未安排复习的词」）。根因三条：
 *
 *   1. 接口 limit 硬上限 1000，传 total=8613 只会返回 1000 条；
 *      旧代码只看 `records.length >= total` 判完整，没有「返回数是否等于
 *      请求数」的校验，于是把截断误当部分成功。
 *   2. offset 是**假可用**：服务端忽略 offset 但返回同一页。旧代码探到
 *      「有新鲜 voc_id」就认定 offset 生效，翻几页后发现没有新词，直接
 *      `return done(false)` 放弃，连日期窗口兜底都不走。
 *   3. 日期窗口按「最后一页的 next_study_date + 1 天」推进，遇到
 *      next_study_date 为空（未安排复习）的词就再也切不动。
 *
 *      next_study_date 为空（未安排复习）的词就再也切不动。
 *
 * ## 现在的做法：区间递归二分
 *
 * 借鉴 MemoSuperform 的 `_fetch_range_tree`：从 [2000-01-01, 2200-12-31]
 * 开始按 next_study_date 拉，**只要返回满页就说明这段被截断了**，把区间对半
 * 劈开递归，直到每段都不满页。
 *
 * 实测数据：8613 词分布在 1039 个复习日上，单日最多 165 条，远小于 1000，
 * 所以二分必然收敛（深度约 log2(73000 天) ≈ 17，安全阀 24 足够）。
 *
 * ## 为什么不用 offset 做主策略
 *
 * offset 未在官方文档声明，实测服务端忽略它。递归二分只依赖 next_study_date
 * 这一有文档保证的参数，稳定得多。offset 仅作为「总数很小」时的快速通道。
 *
 * ## 仍然存在的限制（必须如实告知上层）
 *
 * 完全没有 next_study_date 的词，日期区间查询覆盖不到。实测当前账号 8613 条
 * 全部带日期，但其他账号可能有。这类词只能靠 offset（若服务端某天支持）或
 * 单请求兜底，拿不到时 `complete=false`，UI 需标注。
 */
export async function queryStudyRecordsAll(
  client: MaimemoClient,
  options: QueryAllStudyRecordsOptions = {}
): Promise<QueryAllStudyRecordsResult>
{
  const pageSize = Math.min(options.pageSize ?? API_PAGE_LIMIT, API_PAGE_LIMIT)
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS

  // 先拿总数：既是进度分母，也用于最终完整性判定
  const countResult = await queryStudyRecords(client, { asCount: true })
  const total = countResult.count ?? null

  const seen = new Set<string>()
  const records: MaimemoStudyRecord[] = []
  const diagnostics: StudyRecordFetchDiagnostics = {
    total,
    singleShot: 0,
    offsetPaged: 0,
    rangePaged: 0,
    requests: 1,
    overflowRanges: 0
  }

  /** 去重吸收一页，返回新增条数 */
  function absorb(list: MaimemoStudyRecord[]): number
  {
    let fresh = 0

    for (const record of list)
    {
      if (record.voc_id && !seen.has(record.voc_id))
      {
        seen.add(record.voc_id)
        records.push(record)
        fresh++
      }
    }

    return fresh
  }

  const hasAll = (): boolean => total !== null && records.length >= total
  const outOfBudget = (): boolean => diagnostics.requests >= maxRequests

  /**
   * 递归拉取 [startDay, endDay] 北京日期序号区间（闭区间）。
   *
   * 返回 false 表示这段彻底放弃了（预算耗尽 / 单日超量），调用方据此判定不完整。
   *
   * 拆分规则：拉满 pageSize 就说明这段被 API 截断，对半劈开递归。
   * 用整数天序号切分，保证：
   *   - 左段 [startDay, midDay]、右段 [midDay + 1, endDay] 严格相邻且无空隙
   *   - 每段都严格小于父区间，必然收敛（最细到单日）
   */
  async function fetchRange(startDay: number, endDay: number): Promise<boolean>
  {
    if (startDay > endDay || hasAll() || outOfBudget())
    {
      return !outOfBudget()
    }

    diagnostics.requests++
    const result = await queryStudyRecords(client, {
      limit: pageSize,
      nextStudyDateStart: dayIndexToRangeStart(startDay),
      nextStudyDateEnd: dayIndexToRangeEnd(endDay)
    })

    const page = result.records

    // 不满页 = 这段已经拉全
    if (page.length < pageSize)
    {
      absorb(page)
      options.onProgress?.(records.length, total)
      return true
    }

    // 满页 = 被截断。已经细到单日还满页，说明这一天真有超 1000 个词，无法再分
    if (startDay >= endDay)
    {
      diagnostics.overflowRanges++
      absorb(page)
      options.onProgress?.(records.length, total)
      return false
    }

    // 整数对半：单日区间已在上面返回，这里 startDay < endDay，midDay 必在两者之间
    const midDay = startDay + Math.floor((endDay - startDay) / 2)

    const okLeft = await fetchRange(startDay, midDay)

    if (hasAll() || outOfBudget())
    {
      return okLeft
    }

    const okRight = await fetchRange(midDay + 1, endDay)

    return okLeft && okRight
  }

  // ---------- 快速通道：总数不超过单页时，一次请求就够 ----------
  // 必须校验「返回数是否等于请求数」，否则会把截断当成拉全（旧实现的坑）。
  if (total !== null && total > 0 && total <= pageSize)
  {
    try
    {
      diagnostics.requests++
      const shot = await queryStudyRecords(client, { limit: total })

      diagnostics.singleShot = shot.records.length
      absorb(shot.records)
      options.onProgress?.(records.length, total)

      if (shot.records.length >= total)
      {
        return { records, total, complete: true, diagnostics }
      }
    }
    catch (error)
    {
      // 401 必须上抛；其余（体积 / 超时）不致命，退回区间递归
      if (error instanceof MaimemoAuthError)
      {
        throw error
      }
    }
  }

  // ---------- 主策略：按 next_study_date 区间递归二分 ----------
  const fullyFetched = await fetchRange(RANGE_START_DAY, RANGE_END_DAY)

  diagnostics.rangePaged = records.length

  // 完整性判定：以 as_count 为准；拿不到总数时退化为「没放弃任何区间」
  const complete = total !== null ? records.length >= total : fullyFetched

  return { records, total, complete, diagnostics }
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
