/**
 * 顽固词攻坚：纯本地的训练记录与选词。
 *
 * 墨墨没有「自测」概念，也没有能回写复习结果的接口，所以这里的判断只存在
 * 本机——它不改变墨墨的复习安排，只决定「这个词明天还该不该练」。
 *
 * 毕业线：最近连续 3 次都答「认识」。中间答错一次就重新计数。
 * 这一点必须在 UI 上写清楚，否则用户会以为练了就等于墨墨那边也记住了。
 */

import { beijingToday } from '@momo/maimemo'
import type { FocusWordDto } from '@momo/types'

const STORAGE_KEY = 'momo.drill'

/** 每个词最多留 6 条结果：够算连续 3 次，又不让 localStorage 无限膨胀 */
const MAX_RESULTS = 6

/** 连续答对几次算攻下 */
export const GRADUATE_STREAK = 3

/** 每日攻坚数量 */
export const DAILY_GOAL = 6

export type DrillOutcome = 'know' | 'vague' | 'forget'

export interface DrillResult
{
  /** ISO 时间 */
  at: string
  outcome: DrillOutcome
}

/** AI 诊断缓存：同一个词不重复烧 token */
export interface DrillDiagnosis
{
  reason: string
  explanation: string
  suggestion: string
  at: string
}

export interface DrillWordState
{
  vocId: string
  spelling: string
  /** 最新在前，最多 MAX_RESULTS 条 */
  results: DrillResult[]
  diagnosis?: DrillDiagnosis
  /** 已写入墨墨的助记 id：有值说明写过了，也意味着可以撤回 */
  noteId?: string
}

export interface DrillStore
{
  words: Record<string, DrillWordState>
}

const EMPTY: DrillStore = { words: {} }

export function loadDrill(): DrillStore
{
  try
  {
    const raw = localStorage.getItem(STORAGE_KEY)

    if (!raw)
    {
      return EMPTY
    }

    const parsed = JSON.parse(raw) as DrillStore

    // 结构校验：旧版本或损坏数据直接丢弃，不要让页面崩在 JSON 形状上
    if (!parsed || typeof parsed !== 'object' || !parsed.words || typeof parsed.words !== 'object')
    {
      return EMPTY
    }

    return parsed
  }
  catch
  {
    return EMPTY
  }
}

export function saveDrill(store: DrillStore): void
{
  try
  {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
  catch
  {
    // 写失败不影响当次练习体验
  }
}

/** 记录一次自测结果，返回新 store（不修改入参，方便 React 状态比较） */
export function recordOutcome(
  store: DrillStore,
  word: { vocId: string; spelling: string },
  outcome: DrillOutcome,
  at = new Date().toISOString()
): DrillStore
{
  const prev = store.words[word.vocId]

  return {
    ...store,
    words: {
      ...store.words,
      [word.vocId]: {
        vocId: word.vocId,
        spelling: word.spelling,
        results: [{ at, outcome }, ...(prev?.results ?? [])].slice(0, MAX_RESULTS),
        // 诊断结果跨天保留：词还是那个词，为什么难记不会天天变
        diagnosis: prev?.diagnosis,
        noteId: prev?.noteId
      }
    }
  }
}

/** 写入 / 更新诊断缓存 */
export function recordDiagnosis(
  store: DrillStore,
  word: { vocId: string; spelling: string },
  diagnosis: DrillDiagnosis
): DrillStore
{
  const prev = store.words[word.vocId]

  return {
    ...store,
    words: {
      ...store.words,
      [word.vocId]: {
        vocId: word.vocId,
        spelling: word.spelling,
        results: prev?.results ?? [],
        diagnosis,
        noteId: prev?.noteId
      }
    }
  }
}

/** 记录写入墨墨后拿到的助记 id —— 有它才谈得上「撤回」 */
export function recordNote(
  store: DrillStore,
  word: { vocId: string; spelling: string },
  noteId: string
): DrillStore
{
  const prev = store.words[word.vocId]

  return {
    ...store,
    words: {
      ...store.words,
      [word.vocId]: {
        vocId: word.vocId,
        spelling: word.spelling,
        results: prev?.results ?? [],
        diagnosis: prev?.diagnosis,
        noteId
      }
    }
  }
}

/** 撤回成功后清掉本地记录，避免下次又显示「已写入」 */
export function clearNote(store: DrillStore, vocId: string): DrillStore
{
  const prev = store.words[vocId]

  if (!prev)
  {
    return store
  }

  return {
    ...store,
    words: {
      ...store.words,
      [vocId]: { ...prev, noteId: undefined }
    }
  }
}

/** 最近连续答对 GRADUATE_STREAK 次即毕业 */
export function isGraduated(state?: DrillWordState): boolean
{
  const results = state?.results ?? []

  if (results.length < GRADUATE_STREAK)
  {
    return false
  }

  return results.slice(0, GRADUATE_STREAK).every((item) => item.outcome === 'know')
}

export function countOutcome(state: DrillWordState | undefined, outcome: DrillOutcome): number
{
  return (state?.results ?? []).filter((item) => item.outcome === outcome).length
}

/** 距毕业还差几次连续认识；已毕业为 0 */
export function streakToGo(state?: DrillWordState): number
{
  const results = state?.results ?? []
  let streak = 0

  for (const item of results)
  {
    if (item.outcome !== 'know')
    {
      break
    }

    streak++
  }

  return Math.max(0, GRADUATE_STREAK - streak)
}

/**
 * 今天是否已经答对过。
 *
 * 只有「答对」才后置——今天答错的词恰恰要继续练，不能因为在名单里出现过
 * 就让位给别的词。
 */
function solvedToday(state: DrillWordState | undefined, day: string): boolean
{
  const last = state?.results[0]

  if (!last || last.outcome !== 'know')
  {
    return false
  }

  const at = new Date(last.at)

  return Number.isNaN(at.getTime()) ? false : toBeijingDay(at) === day
}

function toBeijingDay(date: Date): string
{
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 最近一次作答的排序权重：越差越靠前 */
function lastRank(state: DrillWordState | undefined): number
{
  const last = state?.results[0]?.outcome

  if (last === 'forget')
  {
    return 0
  }

  if (last === 'vague')
  {
    return 1
  }

  if (last === 'know')
  {
    return 2
  }

  return 3
}

/**
 * 今日攻坚名单。
 *
 * 排序规则（越靠前越该练）：
 *   1. 今天已经答对过的排最后——已经会了，不占今天的名额
 *   2. 遗忘次数多的靠前
 *   3. 最近一次表现差的靠前（忘记 < 模糊 < 认识 < 无记录）
 *   4. 学习次数多的靠前——学了很多遍还记不住，更值得练
 *   5. 拼写兜底，保证同一批数据每次顺序一致
 *
 * 已毕业的词直接排除：它们要么真记住了，要么只是手顺点了三次认识，
 * 无论哪种都不该继续占名额。
 */
export function pickTodayWords(
  candidates: FocusWordDto[],
  store: DrillStore,
  options: { limit?: number; today?: string } = {}
): FocusWordDto[]
{
  const limit = options.limit ?? DAILY_GOAL
  const today = options.today ?? beijingToday()

  const alive = candidates.filter((word) => !isGraduated(store.words[word.vocId]))

  alive.sort((a, b) =>
  {
    const sa = store.words[a.vocId]
    const sb = store.words[b.vocId]

    // 今天已答对的排最后
    const pa = solvedToday(sa, today) ? 1 : 0
    const pb = solvedToday(sb, today) ? 1 : 0

    if (pa !== pb)
    {
      return pa - pb
    }

    // 忘得多的排前面
    const fa = countOutcome(sa, 'forget')
    const fb = countOutcome(sb, 'forget')

    if (fa !== fb)
    {
      return fb - fa
    }

    const la = lastRank(sa)
    const lb = lastRank(sb)

    if (la !== lb)
    {
      return la - lb
    }

    const ca = a.studyCount ?? 0
    const cb = b.studyCount ?? 0

    if (ca !== cb)
    {
      return cb - ca
    }

    return a.spelling.localeCompare(b.spelling, 'en')
  })

  return alive.slice(0, Math.max(0, limit))
}

/** 全局统计：给页面顶部展示「已攻下 / 在练」 */
export function drillSummary(store: DrillStore): { graduated: number; practicing: number }
{
  let graduated = 0
  let practicing = 0

  for (const state of Object.values(store.words))
  {
    if (state.results.length === 0)
    {
      continue
    }

    if (isGraduated(state))
    {
      graduated++
    }
    else
    {
      practicing++
    }
  }

  return { graduated, practicing }
}

/** 指定日期（默认今天）各作答结果的次数，结算页用 */
export function dayCounts(
  store: DrillStore,
  today = beijingToday()
): Record<DrillOutcome, number>
{
  const counts: Record<DrillOutcome, number> = { know: 0, vague: 0, forget: 0 }

  for (const state of Object.values(store.words))
  {
    for (const item of state.results)
    {
      const at = new Date(item.at)

      if (!Number.isNaN(at.getTime()) && toBeijingDay(at) === today)
      {
        counts[item.outcome]++
      }
    }
  }

  return counts
}
