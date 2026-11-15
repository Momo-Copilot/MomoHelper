/**
 * 词卡缓存的原始读写（backup 备份/恢复用）。
 *
 * word-card.ts 里的 loadCache/saveCache 是模块私有，这里独立实现同一
 * 存储格式（spelling 小写 → { card, at }），不 import 词卡模块避免循环依赖。
 */

const CACHE_KEY = 'momo.wordCards'

/** 原样读出整张缓存表；无数据或损坏返回空对象 */
export function getWordCardsCache(): Record<string, unknown>
{
  try
  {
    const raw = localStorage.getItem(CACHE_KEY)
    const list = raw ? JSON.parse(raw) as [string, unknown][] : []

    return Object.fromEntries(Array.isArray(list) ? list : [])
  }
  catch
  {
    return {}
  }
}

/** 整表覆写（备份恢复用）；写入失败静默——恢复失败不影响现有缓存 */
export function setWordCardsCache(table: Record<string, unknown>): void
{
  try
  {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.entries(table)))
  }
  catch
  {
    // 忽略
  }
}
