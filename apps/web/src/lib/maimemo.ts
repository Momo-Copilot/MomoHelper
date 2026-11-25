/**
 * 墨墨 Open API 访问层（经 EdgeOne 同源代理）。
 *
 * 墨墨不允许浏览器跨域直连：带 Origin 的真实 GET/POST 一律 403 且无 CORS 头，
 * 因此请求发往同源 /api/memo/*，由 edge-functions/api/memo/[[default]].js
 * 以服务端身份转发到 open.maimemo.com。
 * 数据封装复用 @momo/maimemo：Envelope 解析、错误映射与 UTC+8 日期处理。
 *
 * 每日快照存 localStorage：替代原后端的快照表 + 定时任务。
 * 墨墨没有历史序列接口，趋势完全依赖快照；纯前端下没有无人值守采集，
 * 打开页面当天才会留一个点，未打开的日期在趋势图上缺一天。
 */

import {
  MaimemoClient,
  MaimemoStudyUnavailableError,
  beijingToday,
  toBeijingDate,
  getStudyProgress,
  getTodayItems,
  queryStudyRecordsFiltered,
  listNotepads
} from '@momo/maimemo'
import type {
  DashboardHistoryDto,
  DashboardTodayDto,
  FocusWordDto,
  TodayWordRowDto
} from '@momo/types'

import { getMaimemoToken } from './settings'

/** 未配置墨墨 Token：页面应引导去设置页，不是错误 */
export class MaimemoNotConfiguredError extends Error
{
  constructor()
  {
    super('尚未配置墨墨 Token，请先到设置页绑定')
    this.name = 'MaimemoNotConfiguredError'
  }
}

/**
 * 墨墨请求走同源代理：EdgeOne 边缘函数把 /api/memo/* 转发给墨墨（服务器间
 * 请求不带 Origin，绕过墨墨对跨域请求的 403 限制）。见 edge-functions/api/memo/[[default]].js
 */
const MAIMEMO_PROXY_BASE = '/api/memo'

/** 每次调用现取 Token：设置页换绑后无需重建任何实例 */
export function getMaimemoClient(): MaimemoClient
{
  const token = getMaimemoToken()

  if (!token)
  {
    throw new MaimemoNotConfiguredError()
  }

  return new MaimemoClient({ token, baseUrl: MAIMEMO_PROXY_BASE })
}

/**
 * 校验新粘贴的 Token：调 notepads 列表（轻量、稳定、不依赖学习数据公测权限）。
 * 401/鉴权失败 → MaimemoAuthError；网络失败 → MaimemoNetworkError；其余视为通过。
 */
export async function verifyMaimemoToken(token: string): Promise<void>
{
  const client = new MaimemoClient({ token, baseUrl: MAIMEMO_PROXY_BASE })
  await listNotepads(client)
}

// ============================ 每日快照 ============================

interface LocalSnapshot
{
  /** 北京时间日期，YYYY-MM-DD */
  date: string
  finished: number
  total: number
  studyTimeMs: number
  capturedAt: string
  /** 当日新学 / 复习词数：后加的字段，旧快照没有，读取时按可选处理 */
  newWords?: number
  reviewWords?: number
}

const SNAPSHOT_KEY = 'momo.dailySnapshots'
/**
 * 保留上限按「不截断有效数据」定，不按一年卡：
 * 每条约 90~120 字节，1200 天也不到 150KB；而考研从起手到上考场约 400 天，
 * 原来的 366 天会在临考前把最早那批记录静默挤掉（slice(-366) 不报错）。
 * 留这个上限只为防御异常数据，不是为了省空间。
 */
const SNAPSHOT_MAX = 1200

function loadSnapshots(): LocalSnapshot[]
{
  try
  {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    const list = raw ? (JSON.parse(raw) as LocalSnapshot[]) : []
    return Array.isArray(list) ? list : []
  }
  catch
  {
    return []
  }
}

function upsertSnapshot(snapshot: LocalSnapshot): void
{
  try
  {
    const list = loadSnapshots().filter((item) => item.date !== snapshot.date)
    list.push(snapshot)
    list.sort((a, b) => a.date.localeCompare(b.date))
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(list.slice(-SNAPSHOT_MAX)))
  }
  catch
  {
    // 快照写失败不影响看板主流程
  }
}

/**
 * 最近一次快照转看板数据：dataReliable = false，UI 标注「可能不是最新」（C2）；
 * 快照不存词表明细，todayWords 为空。
 *
 * 四分项一律给 null（未知）而不是 0：快照里没有逐词明细，回算不出新词 / 复习 /
 * 未完成 / 遗忘，填 0 会让接口故障看起来像「今天没学习」。
 * 唯一的例外是 newWords / reviewWords —— 后来的快照存了这两个数，有就用。
 */
function latestSnapshotAsToday(): DashboardTodayDto
{
  const list = loadSnapshots()
  const snapshot = list[list.length - 1]
  const emptyWords: TodayWordRowDto[] = []

  if (!snapshot)
  {
    return {
      total: 0,
      finished: 0,
      remaining: 0,
      studyTimeMs: 0,
      completionRate: null,
      newWords: null,
      reviewWords: null,
      unfinishedWords: null,
      forgottenWords: null,
      dataReliable: false,
      capturedAt: new Date().toISOString(),
      todayWords: emptyWords
    }
  }

  return {
    total: snapshot.total,
    finished: snapshot.finished,
    remaining: Math.max(0, snapshot.total - snapshot.finished),
    studyTimeMs: snapshot.studyTimeMs,
    completionRate: snapshot.total === 0 ? null : snapshot.finished / snapshot.total,
    // 旧快照没有这两个字段（后加的），缺失时同样是未知
    newWords: snapshot.newWords ?? null,
    reviewWords: snapshot.reviewWords ?? null,
    unfinishedWords: null,
    forgottenWords: null,
    dataReliable: false,
    capturedAt: snapshot.capturedAt,
    todayWords: emptyWords
  }
}

// ============================ 今日看板 ============================

/**
 * 今日看板：实时拉取进度 + 今日词表并聚合，成功即留存当日快照。
 * 学习数据接口公测不可用时（C2）降级为最近快照；
 * Token 失效（401）继续上抛，由页面引导重新绑定。
 */
export async function getDashboardToday(): Promise<DashboardTodayDto>
{
  const client = getMaimemoClient()

  try
  {
    const [progress, items] = await Promise.all([
      getStudyProgress(client),
      getTodayItems(client)
    ])

    const newWords = items.filter((item) => item.is_new).length
    const reviewWords = items.filter((item) => !item.is_new).length
    const unfinishedWords = items.filter((item) => !item.is_finished).length
    // 遗忘口径：首次作答为忘记即算，不要求 is_finished——墨墨对首次答忘记的词
    // 当天会再安排复习，完成前 is_finished 一直是 false，加上该条件会把
    // 「点过忘记但还没复习完」的词全部漏掉（与词表明细标记、遗忘页口径一致）
    const forgottenWords = items.filter((item) => item.first_response === 'FORGET').length

    // 词表明细按 order 排序（今日词表卡逐行展示）
    const todayWords: TodayWordRowDto[] = [...items]
      .sort((a, b) => a.order - b.order)
      .map((item) => ({
        vocId: item.voc_id,
        spelling: item.voc_spelling,
        order: item.order,
        isNew: item.is_new,
        isFinished: item.is_finished,
        firstResponse: item.first_response
      }))

    upsertSnapshot({
      date: beijingToday(),
      finished: progress.finished,
      total: progress.total,
      studyTimeMs: progress.study_time,
      capturedAt: new Date().toISOString(),
      // 存下新学/复习拆分：现在只用来算「当天学了多少」，将来要区分两者时
      // 旧快照补不回来，所以从今天起就开始留
      newWords,
      reviewWords
    })

    return {
      total: progress.total,
      finished: progress.finished,
      remaining: Math.max(0, progress.total - progress.finished),
      studyTimeMs: progress.study_time,
      completionRate: progress.total === 0 ? null : progress.finished / progress.total,
      newWords,
      reviewWords,
      unfinishedWords,
      forgottenWords,
      dataReliable: true,
      capturedAt: new Date().toISOString(),
      todayWords
    }
  }
  catch (error)
  {
    if (error instanceof MaimemoStudyUnavailableError)
    {
      return latestSnapshotAsToday()
    }

    throw error
  }
}

/** 学习趋势：近 N 天本地快照序列（纯本地读取，无网络请求） */
export function getDashboardHistory(days: number): DashboardHistoryDto
{
  const startDate = toBeijingDate(new Date(Date.now() - (days - 1) * 86_400_000))
  const rows = loadSnapshots().filter((item) => item.date >= startDate)

  return {
    days: rows.map((row) => ({
      date: row.date,
      finished: row.finished,
      total: row.total,
      studyTimeMs: row.studyTimeMs,
      isReliable: true
    }))
  }
}

// ============================ 遗忘词 ============================

export interface ForgottenResult
{
  words: FocusWordDto[]
}

/**
 * 今日遗忘词：首次作答为「忘记」即列出（FR-3.1）。
 *
 * 不要求 is_finished：墨墨对首次答忘记的词当天会再安排复习，完成前
 * is_finished 一直是 false——旧条件把「点过忘记但还没复习完」的词全部
 * 漏掉，遗忘页呈空（2026-11-18 线上问题：看板词表有忘记标记、遗忘页为空）。
 *
 * 公测接口失败时错误直接上抛（页面显示错误 + 重试），而不是静默降级为
 * 空列表——本页没有本地备份数据，把「接口失败」伪装成「今天没有遗忘」
 * 会误导用户。
 */
export async function getTodayForgotten(): Promise<ForgottenResult>
{
  const client = getMaimemoClient()
  const items = await getTodayItems(client)

  return {
    words: items
      .filter((item) => item.first_response === 'FORGET')
      .map((item) => ({
        vocId: item.voc_id,
        spelling: item.voc_spelling,
        isNew: item.is_new,
        firstResponse: item.first_response,
        tags: []
      }))
  }
}

/** 顽固词：学习记录标签含 STICKING（FR-3.5）；接口失败同今日遗忘词，直接上抛 */
export async function getStickingWords(): Promise<ForgottenResult>
{
  const client = getMaimemoClient()

  // 服务端按 STICKING 标签筛选：此前无过滤拉 1000 条再前端过滤，
  // 词库超过 1000 词时后面的顽固词会被整体漏掉
  const result = await queryStudyRecordsFiltered(client, { tags: 'STICKING' })

  return {
    words: result.records
      // 服务端筛选异常失效时兜底：最多退化为「前 1000 条里的顽固词」
      .filter((item) => item.tags.includes('STICKING'))
      .map((item) => ({
        vocId: item.voc_id,
        spelling: item.voc_spelling,
        isNew: false,
        lastResponse: item.last_response,
        studyCount: item.study_count,
        tags: item.tags
      }))
  }
}
