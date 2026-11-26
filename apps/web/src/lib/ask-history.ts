/**
 * 问词历史（本地）。
 *
 * 只存完整回答：流式过程中的半截内容不落盘，避免每来一个 delta 就写一次
 * localStorage。上限 100 条——每条回答约 0.5–2 KB，总体 < 200 KB，可控。
 *
 * 与其他本地数据一样不进备份（备份只覆盖诊断历史 / 词卡 / 攻坚 / 词库 / 快照）。
 * 这里存的是「问过什么、AI 答了什么」，属于可再生成的对话记录。
 */

export interface AskRecord
{
  id: string
  question: string
  /** 提问时关联的单词，可为空 */
  spelling: string
  answer: string
  thinking: 'on' | 'off'
  /** ISO 时间 */
  at: string
}

const KEY = 'momo.askHistory'
const MAX = 100

function newId(): string
{
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto

  if (crypto?.randomUUID)
  {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 读历史；结构不合法的条目直接丢弃，不让一条脏数据毁掉整个列表 */
function read(): AskRecord[]
{
  try
  {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []

    if (!Array.isArray(parsed))
    {
      return []
    }

    return parsed.filter((item): item is AskRecord =>
    {
      const record = item as Partial<AskRecord> | null

      return (
        !!record &&
        typeof record.id === 'string' &&
        typeof record.question === 'string' &&
        typeof record.answer === 'string' &&
        typeof record.at === 'string'
      )
    })
  }
  catch
  {
    return []
  }
}

function write(list: AskRecord[]): void
{
  try
  {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  }
  catch
  {
    // 存储满 / 隐私模式：写失败不影响本次问答
  }
}

/** 全部历史，最新在前 */
export function listAskHistory(): AskRecord[]
{
  return read()
}

/** 追加一条（最新在前），返回更新后的列表 */
export function addAskRecord(input: Omit<AskRecord, 'id'>): AskRecord[]
{
  const next = [{ ...input, id: newId() }, ...read()].slice(0, MAX)

  write(next)

  return next
}

/** 删除一条，返回更新后的列表 */
export function removeAskRecord(id: string): AskRecord[]
{
  const next = read().filter((item) => item.id !== id)

  write(next)

  return next
}

/** 清空全部 */
export function clearAskHistory(): AskRecord[]
{
  write([])

  return []
}
