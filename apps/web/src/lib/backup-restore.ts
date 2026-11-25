/**
 * 备份恢复：把远端拉回的备份包写回本机各存储。
 *
 * 与 backup.ts（打包上传）对应，恢复策略（四类数据一律「不倒退」）：
 *   - diagnoseHistory / wordCards：远端与本机按时间合并（各取最新），
 *     避免覆盖掉本机新产生的记录
 *   - librarySnapshot：远端 fetchedAt 更新才整体覆盖，本机更新则跳过
 *   - settings：仅当本机未配置时采纳远端值，本机已配置优先
 */

import { getDiagnoseHistory, saveDiagnosis, type DiagnoseRecord } from './diagnose-history'
import type { BackupPayload, RestoreSource } from './backup'
import { setWordCardsCache } from './word-card-cache'
import { setAiThinkingMode } from './settings'

export interface RestoreResult
{
  diagnoseMerged: number
  wordCardsMerged: number
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

export async function restoreBackup(source: RestoreSource): Promise<RestoreResult>
{
  const { payload } = source
  const result: RestoreResult = {
    diagnoseMerged: 0,
    wordCardsMerged: 0,
    libraryRestored: false,
    librarySkipped: false,
    settingsApplied: false
  }

  // 诊断历史：合并写入（saveDiagnosis 内部会去重、限 200 条）
  const merged = mergeDiagnoseHistory(payload.diagnoseHistory ?? [])

  for (const record of merged)
  {
    saveDiagnosis(record.spelling, record.data, record.thinking)
  }

  result.diagnoseMerged = merged.length

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
      if (!table[key])
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
