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

/**
 * 毕业后的冷却天数：到期重新进入候选池复查一次。
 *
 * 三次「认识」只是弱信号——可能那天状态好，也可能只是手顺。考研是长周期，
 * 一个词三个月后忘了很正常，所以毕业不该是永久判决。复查答对继续毕业，
 * 答错就回到正常训练。用 results[0].at 当毕业时间，不额外存字段。
 */
export const GRADUATION_COOLDOWN_DAYS = 30

/** 每日攻坚数量：够覆盖当天的顽固词 + 遗忘词，又不至于练到走神 */
export const DAILY_GOAL = 10

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

/**
 * 毕业冷却还剩几天；0 = 可回候选池（未毕业，或冷却已过）。
 *
 * 脏时间戳（NaN）按 0 处理：宁可让这个词早点回池复查，也不要它因为一条坏
 * 记录被永久锁在毕业名单里。
 */
export function graduationCooldownLeft(
  state: DrillWordState | undefined,
  now = new Date()
): number
{
  if (!isGraduated(state))
  {
    return 0
  }

  const at = new Date(state!.results[0]!.at).getTime()

  if (Number.isNaN(at))
  {
    return 0
  }

  const remain = GRADUATION_COOLDOWN_DAYS * 86_400_000 - (now.getTime() - at)

  return remain > 0 ? Math.ceil(remain / 86_400_000) : 0
}

export function countOutcome(state: DrillWordState | undefined, outcome: DrillOutcome): number
{
  return (state?.results ?? []).filter((item) => item.outcome === outcome).length
}

/** 毕业冷却已过、该回池复查了 */
export function isDueReview(state: DrillWordState | undefined, now = new Date()): boolean
{
  return isGraduated(state) && graduationCooldownLeft(state, now) === 0
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
 *   2. 毕业冷却到期、该回池复查的排最前——它们已经 30 天没碰了，
 *      不提前就永远排不过那些「刚忘过」的词，回池等于没回
 *   3. 遗忘次数多的靠前
 *   4. 最近一次表现差的靠前（忘记 < 模糊 < 认识 < 无记录）
 *   5. 学习次数多的靠前——学了很多遍还记不住，更值得练
 *   6. 拼写兜底，保证同一批数据每次顺序一致
 *
 * 已毕业的词在冷却期内排除：它们要么真记住了，要么只是手顺点了三次认识，
 * 无论哪种都不该每天占名额。但冷却（GRADUATION_COOLDOWN_DAYS）到期后会重新
 * 回到候选池复查——毕业不是永久判决。
 */
export function pickTodayWords(
  candidates: FocusWordDto[],
  store: DrillStore,
  options: { limit?: number; today?: string; now?: Date } = {}
): FocusWordDto[]
{
  const limit = options.limit ?? DAILY_GOAL
  const today = options.today ?? beijingToday()
  const now = options.now ?? new Date()

  const alive = candidates.filter(
    (word) => graduationCooldownLeft(store.words[word.vocId], now) === 0
  )

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

    // 毕业到期该复查的排前面：它们已经很久没碰，不提前就永远排不上
    const ra = isDueReview(sa, now) ? 0 : 1
    const rb = isDueReview(sb, now) ? 0 : 1

    if (ra !== rb)
    {
      return ra - rb
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

/**
 * 全局统计：给页面顶部展示「已攻下 / 待复查 / 在练」。
 *
 * 已攻下 = 毕业且仍在冷却期内的（暂时不用管）；
 * 待复查 = 毕业但冷却已过，下次进页面会重新出现在候选池；
 * 在练   = 有训练记录但还没毕业。
 */
export function drillSummary(
  store: DrillStore,
  now = new Date()
): { graduated: number; dueReview: number; practicing: number }
{
  let graduated = 0
  let dueReview = 0
  let practicing = 0

  for (const state of Object.values(store.words))
  {
    if (state.results.length === 0)
    {
      continue
    }

    if (!isGraduated(state))
    {
      practicing++
      continue
    }

    if (isDueReview(state, now))
    {
      dueReview++
    }
    else
    {
      graduated++
    }
  }

  return { graduated, dueReview, practicing }
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
