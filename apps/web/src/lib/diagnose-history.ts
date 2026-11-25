/**
 * 遗忘词诊断历史（纯前端方案，localStorage 持久化）。
 *
 * 用途：遗忘词页右栏「已诊断」标记 + 二次查看免再请求；
 * 同时也是攻坚台诊断的唯一归档（drill 里那份只是缓存）。
 *
 * 单用户自用工具，不追求跨设备同步，存本机即可。
 * 上限 500 条：原为 200（按天滚动的遗忘词够用），但诊断现在跨页共用，
 * 攻坚台 259 个词一次就能把 200 撑满，回填时会静默丢掉几十条。
 * 单条约 0.4KB，500 条约 200KB，localStorage 可承受。
 */

import type { ForgetDiagnosis } from '@momo/ai'

import { getAiThinkingMode } from './settings'

const HISTORY_KEY = 'momo.diagnoseHistory'
const MAX_ITEMS = 500

export interface DiagnoseRecord
{
  spelling: string
  /** 诊断时间（ISO） */
  at: string
  /** 诊断时用的思考模式，回看时区分参考价值 */
  thinking: boolean
  data: ForgetDiagnosis
}

function readAll(): DiagnoseRecord[]
{
  try
  {
    const raw = localStorage.getItem(HISTORY_KEY)

    if (!raw)
    {
      return []
    }

    const parsed = JSON.parse(raw) as DiagnoseRecord[]

    return Array.isArray(parsed) ? parsed.filter((item) => item?.spelling && item?.data) : []
  }
  catch
  {
    return []
  }
}

function writeAll(records: DiagnoseRecord[]): void
{
  try
  {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(records.slice(0, MAX_ITEMS)))
  }
  catch
  {
    // 存储满 / 隐私模式：静默失败，本次会话仍可正常诊断
  }
}

/** 全部历史，最新在前（用于右栏直接回看与已诊断标记） */
export function getDiagnoseHistory(): DiagnoseRecord[]
{
  return readAll()
}

/** 查单个词的最近一次诊断 */
export function findDiagnosis(spelling: string): DiagnoseRecord | undefined
{
  const key = spelling.toLowerCase()

  return readAll().find((item) => item.spelling.toLowerCase() === key)
}

/**
 * 记录一次诊断（同词去重，最新在前）。
 * 在诊断成功回调里调用。
 *
 * @param at 诊断发生时间（ISO）。默认取当前时间；从备份恢复时必须传入原始
 *   时间戳，否则所有历史记录的 at 都会被改成恢复的瞬间 —— 既丢掉「哪天诊断了
 *   哪个词」的时间线，也让「按 at 取更新的一条」这个合并语义彻底失效。
 */
export function saveDiagnosis(
  spelling: string,
  data: ForgetDiagnosis,
  thinking: boolean,
  at?: string
): void
{
  const record: DiagnoseRecord = {
    spelling,
    at: at && !Number.isNaN(Date.parse(at)) ? at : new Date().toISOString(),
    thinking,
    data
  }

  const key = spelling.toLowerCase()
  const rest = readAll().filter((item) => item.spelling.toLowerCase() !== key)

  writeAll([record, ...rest].sort((a, b) => b.at.localeCompare(a.at)))
}

/** 清空历史（设置页或调试入口用） */
export function clearDiagnoseHistory(): void
{
  try
  {
    localStorage.removeItem(HISTORY_KEY)
  }
  catch
  {
    // 忽略
  }
}

/** 便捷：读历史同时带当前思考模式（历史记录里 thinking 为存量字段，仅供展示） */
export function currentThinking(): boolean | null
{
  return getAiThinkingMode() === 'on'
}
