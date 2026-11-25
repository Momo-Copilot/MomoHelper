/**
 * 备份恢复：把远端拉回的备份包写回本机各存储。
 *
 * 与 backup.ts（打包上传）对应，恢复策略（每类数据一律「不倒退」）：
 *   - diagnoseHistory / wordCards：远端与本机按时间合并（各取最新），
 *     避免覆盖掉本机新产生的记录
 *   - drill：按词合并，同一词取「最新一次作答」更新的一方；助记 noteId 缺失时
 *     从另一方补齐（丢了就撤回不了那条助记）
 *   - librarySnapshot：远端 fetchedAt 更新才整体覆盖，本机更新则跳过
 *   - settings：仅当本机未配置时采纳远端值，本机已配置优先
 */

import { findDiagnosis, getDiagnoseHistory, saveDiagnosis, type DiagnoseRecord } from './diagnose-history'
import type { BackupPayload, RestoreSource } from './backup'
import { loadDrill, saveDrill, type DrillStore, type DrillWordState } from './drill'
import { setWordCardsCache } from './word-card-cache'
import { setAiThinkingMode, setExamDate, getExamDate } from './settings'

export interface RestoreResult
{
  diagnoseMerged: number
  wordCardsMerged: number
  /** 攻坚记录：远端带来了更新的训练状态，或补齐了缺失的 noteId */
  drillMerged: number
  /** 攻坚台独有的诊断回填进诊断历史的条数 */
  diagnoseBackfilled: number
  libraryRestored: boolean
  /** 远端快照比本机旧，主动保留本机数据（不是失败） */
  librarySkipped: boolean
  settingsApplied: boolean
}

/** 词库快照写回结果：写回 / 本机更新跳过 / 数据不可用 */
export type LibraryRestoreAction = 'restored' | 'skipped' | 'failed'

/** 把词库快照写回 IndexedDB；由 library.ts 注册写入器 */
type LibraryWriter = (payload: NonNullable<BackupPayload['librarySnapshot']>) => Promise<LibraryRestoreAction>

let libraryWriter: LibraryWriter | null = null

export function registerLibraryWriter(writer: LibraryWriter): void
{
  libraryWriter = writer
}

/** 远端与本机诊断历史合并：同一词取 at 更新的那条 */
function mergeDiagnoseHistory(remote: unknown[]): DiagnoseRecord[]
{
  const byKey = new Map<string, DiagnoseRecord>()

  for (const item of getDiagnoseHistory())
  {
    byKey.set(item.spelling.toLowerCase(), item)
  }

  let merged = 0

  for (const raw of remote)
  {
    const record = raw as DiagnoseRecord

    if (!record?.spelling || !record?.data || typeof record?.at !== 'string')
    {
      continue
    }

    const key = record.spelling.toLowerCase()
    const local = byKey.get(key)

    if (!local || local.at < record.at)
    {
      byKey.set(key, record)
      merged++
    }
  }

  return [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * 攻坚记录合并：按词取「最新一次作答」更新的一方。
 *
 * 不逐条合并 results —— 两边的顺序/条数可能不同，硬拼会把「最近连续 3 次」
 * 这种依赖顺序的判断弄乱。整条取更新的一方，毕业状态自然跟着走。
 *
 * 例外：noteId 不能因为本机更新就丢掉远端的——它是撤回助记的唯一凭据，
 * 丢了下一次就再也删不掉那条已经写进墨墨的助记。
 */
function mergeDrill(
  remote: unknown,
  local: DrillStore
): { store: DrillStore; merged: number }
{
  if (!remote || typeof remote !== 'object')
  {
    return { store: local, merged: 0 }
  }

  const incoming = remote as DrillStore

  if (!incoming.words || typeof incoming.words !== 'object')
  {
    return { store: local, merged: 0 }
  }

  const words: Record<string, DrillWordState> = { ...local.words }
  let merged = 0

  for (const [vocId, remoteState] of Object.entries(incoming.words))
  {
    if (!remoteState || typeof remoteState !== 'object' || !Array.isArray(remoteState.results))
    {
      continue
    }

    const localState = words[vocId]

    if (!localState)
    {
      words[vocId] = remoteState
      merged++
      continue
    }

    const localAt = localState.results[0]?.at ?? ''
    const remoteAt = remoteState.results[0]?.at ?? ''

    if (remoteAt > localAt)
    {
      words[vocId] = { ...remoteState, noteId: localState.noteId ?? remoteState.noteId }
      merged++
    }
    else if (!localState.noteId && remoteState.noteId)
    {
      words[vocId] = { ...localState, noteId: remoteState.noteId }
    }
  }

  return { store: { words }, merged }
}

/**
 * 把攻坚台独有的诊断回填进诊断历史。
 *
 * 背景：攻坚台点「诊断」时只写 drill state（recordDiagnosis），
 * 从不写 diagnoseHistory；而遗忘词页诊断只写 diagnoseHistory。
 * 两条路径各存一份，导致 drill 里 259 条诊断中有 244 条在历史里查不到，
 * 且重叠的几条内容还不一致。
 *
 * 回填规则：历史里没有该词、或 drill 的那条更新时才补，不覆盖更新的本机记录。
 * 返回补入条数。
 */
function backfillDiagnoseFromDrill(store: DrillStore): number
{
  let filled = 0

  for (const state of Object.values(store.words))
  {
    if (!state?.diagnosis || !state.spelling)
    {
      continue
    }

    const diag = state.diagnosis

    if (!diag.reason || typeof diag.at !== 'string')
    {
      continue
    }

    const existing = findDiagnosis(state.spelling)

    if (existing && existing.at >= diag.at)
    {
      continue
    }

    // drill 只存了 reason/explanation/suggestion，缺少 isSpeculative。
    // 按「诊断恒为推测」的既有约定补 true（与 forgetReasonSchema 默认值一致）。
    saveDiagnosis(
      state.spelling,
      {
        reason: diag.reason as DiagnoseRecord['data']['reason'],
        explanation: diag.explanation,
        suggestion: diag.suggestion,
        isSpeculative: true
      },
      false,
      diag.at
    )
    filled++
  }

  return filled
}

export async function restoreBackup(source: RestoreSource): Promise<RestoreResult>
{
  const { payload } = source
  const result: RestoreResult = {
    diagnoseMerged: 0,
    wordCardsMerged: 0,
    drillMerged: 0,
    diagnoseBackfilled: 0,
    libraryRestored: false,
    librarySkipped: false,
    settingsApplied: false
  }

  // 诊断历史：合并写入（saveDiagnosis 内部会去重、限 200 条）
  const merged = mergeDiagnoseHistory(payload.diagnoseHistory ?? [])

  for (const record of merged)
  {
    // 必须带原始 at：否则恢复后所有记录时间都变成「刚才」，
    // 下次再恢复时「取更新的一条」就再也比不出先后了
    saveDiagnosis(record.spelling, record.data, record.thinking, record.at)
  }

  result.diagnoseMerged = merged.length

  // 攻坚记录：按词合并，取作答更新的一方（旧备份没有这个字段，直接跳过）
  if (payload.drill)
  {
    const drill = mergeDrill(payload.drill, loadDrill())

    saveDrill(drill.store)
    result.drillMerged = drill.merged

    // 攻坚台把诊断存在自己那份 state 里，历史上并不回写 diagnoseHistory，
    // 于是同一个词会出现「drill 里有诊断、历史里没有」的分裂。
    // 恢复时把 drill 独有的诊断补进历史，让两边收敛到同一份。
    result.diagnoseBackfilled = backfillDiagnoseFromDrill(drill.store)
  }

  // 词卡缓存：远端有而本机没有的词补进来（时间戳旧的会被 TTL 自然淘汰）
  if (payload.wordCards && typeof payload.wordCards === 'object')
  {
    let local: Record<string, unknown> = {}

    try
    {
      const raw = localStorage.getItem('momo.wordCards')
      const list = raw ? (JSON.parse(raw) as [string, unknown][]) : []

      local = Object.fromEntries(Array.isArray(list) ? list : [])
    }
    catch
    {
      // 本机缓存损坏则直接用远端
    }

    const table: Record<string, unknown> = { ...local }

    for (const [key, value] of Object.entries(payload.wordCards))
    {
      const mine = table[key] as { at?: string } | undefined
      const theirs = value as { at?: string } | undefined

      // 本机没有 → 补入；本机有但更旧 → 用远端覆盖。
      // 原先只补缺，导致「本机是旧版简卡、远端是完整卡」时永远不更新。
      if (!mine || (theirs?.at && (!mine.at || theirs.at > mine.at)))
      {
        table[key] = value
        result.wordCardsMerged++
      }
    }

    setWordCardsCache(table)
  }

  // 词库快照：写入器可用且远端有数据才恢复；远端更旧时由写入器返回 skipped
  if (payload.librarySnapshot?.records && libraryWriter)
  {
    const action = await libraryWriter(payload.librarySnapshot)

    result.libraryRestored = action === 'restored'
    result.librarySkipped = action === 'skipped'
  }

  // 思考模式：仅本机未配置时采纳远端
  const remoteThinking = payload.settings?.aiThinking ?? null

  if (!getAiThinkingModeLocal() && (remoteThinking === 'on' || remoteThinking === 'off'))
  {
    setAiThinkingMode(remoteThinking)
    result.settingsApplied = true
  }

  // 考试日期：本机未设置时才采纳远端（旧备份没这个字段，按未设置处理）
  const remoteExam = payload.settings?.examDate ?? null

  if (!getExamDate() && remoteExam && /^\d{4}-\d{2}-\d{2}$/.test(remoteExam))
  {
    setExamDate(remoteExam)
    result.settingsApplied = true
  }

  return result
}

/** 局部 import 避免 settings 循环依赖的兜底读 */
function getAiThinkingModeLocal(): 'on' | 'off' | null
{
  try
  {
    const value = localStorage.getItem('momo.aiThinking')

    return value === 'on' || value === 'off' ? value : null
  }
  catch
  {
    return null
  }
}
