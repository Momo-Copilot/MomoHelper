/**
 * 单词词卡数据源：我的自建 + AI 双区块展示。
 *
 * 右栏面板点单词 → 弹词卡：
 * 1. 「我的自建」：墨墨 Token 已绑时，拉取自建释义/助记/例句；
 *    三者皆空时显示「暂无数据」提示（官方词库释义不在开放 API 范围内）。
 * 2. 「AI 生成」：DeepSeek 生成音标/释义/例句，作为补充信息始终展示。
 *
 * 结果按词缓存到 localStorage（有效期 24h），重复点击不发请求。
 */

import { explainWord, type WordExplanation } from '@momo/ai'
import {
  getVocabularyBySpelling,
  listInterpretations,
  listNotes,
  listPhrases,
  type MaimemoInterpretation,
  type MaimemoNote,
  type MaimemoPhrase
} from '@momo/maimemo'

import { getAiClient } from './ai'
import { getMaimemoClient } from './maimemo'
import { getAiThinkingMode, getMaimemoToken } from './settings'

/** 我的自建区块（墨墨开放 API 范围内的三类自建内容） */
export interface MineSection
{
  definitions: string[]
  /** 助记（note_type + 内容） */
  notes: { type: string; text: string }[]
  /** 例句（句子 + 翻译） */
  phrases: { text: string; translation: string }[]
  /** 三类皆空为 true，UI 显示「暂无数据」 */
  empty: boolean
}

/** AI 生成区块 */
export interface AiSection
{
  phonetic: string
  definitions: string[]
  example?: string
  exampleTranslation?: string
}

/** 词卡统一展示形状 */
export interface WordCard
{
  spelling: string
  mine: MineSection
  /** null = AI 未获取到（未配 Key 或请求失败） */
  ai: AiSection | null
  fetchedAt: string
}

const CACHE_KEY = 'momo.wordCards'
const CACHE_TTL_MS = 24 * 3600_000

interface CacheEntry
{
  card: WordCard
  at: string
}

function loadCache(): Map<string, CacheEntry>
{
  try
  {
    const raw = localStorage.getItem(CACHE_KEY)
    const list = raw ? (JSON.parse(raw) as [string, CacheEntry][]) : []
    return new Map(Array.isArray(list) ? list : [])
  }
  catch
  {
    return new Map()
  }
}

function saveCache(cache: Map<string, CacheEntry>): void
{
  try
  {
    // 上限 300 词，超出丢弃最旧
    const entries = [...cache.entries()].slice(-300)
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries))
  }
  catch
  {
    // 忽略
  }
}

function cacheCard(card: WordCard): void
{
  saveCache(new Map([...loadCache(), [card.spelling.toLowerCase(), { card, at: card.fetchedAt }]]))
}

export function getCachedWordCard(spelling: string): WordCard | null
{
  const entry = loadCache().get(spelling.toLowerCase())
  if (!entry) return null

  if (Date.now() - new Date(entry.at).getTime() >= CACHE_TTL_MS)
  {
    return null
  }

  // 结构校验：旧版缓存（单卡片结构，无 mine/ai 字段）直接作废，
  // 否则渲染读 card.mine.empty 会 TypeError 崩掉整个页面
  const card = entry.card as Partial<WordCard>

  if (
    !card ||
    typeof card.mine !== 'object' ||
    card.mine === null ||
    !Array.isArray(card.mine.definitions) ||
    !Array.isArray(card.mine.notes) ||
    !Array.isArray(card.mine.phrases)
  )
  {
    return null
  }

  return entry.card
}

/** AI 生成：DeepSeek 补充词条信息（思考模式跟随全局选择） */
async function generateByAi(spelling: string): Promise<AiSection | null>
{
  try
  {
    const client = getAiClient()
    const thinking = getAiThinkingMode() === 'on'
    const { data } = await explainWord(client, { spelling, thinking })

    return {
      phonetic: data.phonetic,
      definitions: data.definitions
        .split(/[;；\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
      example: data.example,
      exampleTranslation: data.exampleTranslation
    }
  }
  catch
  {
    // 未配 Key / 请求失败：AI 区块整体隐藏，不阻塞「我的自建」展示
    return null
  }
}

/** 墨墨自建内容 → 我的区块 */
function toMineSection(
  interpretations: MaimemoInterpretation[],
  notes: MaimemoNote[],
  phrases: MaimemoPhrase[]
): MineSection
{
  const definitions = interpretations
    .filter((item) => item.status !== 'DELETED')
    .map((item) => item.interpretation)
  const noteRows = notes
    .filter((item) => item.status !== 'DELETED')
    .map((item) => ({ type: item.noteType, text: item.note }))
  const phraseRows = phrases
    .filter((item) => item.status !== 'DELETED')
    .map((item) => ({ text: item.phrase, translation: item.interpretation }))

  return {
    definitions,
    notes: noteRows,
    phrases: phraseRows,
    empty: definitions.length === 0 && noteRows.length === 0 && phraseRows.length === 0
  }
}

/** 空 AI 区块（未配 AI Key 时兜底，让缓存结构完整） */
function emptyAi(): AiSection
{
  return { phonetic: '', definitions: [] }
}

/**
 * 取词卡：先查缓存 → 并行拉「我的自建」与 AI → 双区块返回。
 * 墨墨接口失败（未绑 Token / 网络异常）不阻塞：自建区块标记为空。
 */
export async function getWordCard(spelling: string): Promise<WordCard>
{
  const cached = getCachedWordCard(spelling)

  if (cached)
  {
    return cached
  }

  const fetchedAt = new Date().toISOString()

  // 我的自建：Token 未绑或接口失败都按「无数据」处理
  let mine: MineSection = {
    definitions: [],
    notes: [],
    phrases: [],
    empty: true
  }

  if (getMaimemoToken())
  {
    try
    {
      const maimemo = getMaimemoClient()
      const voc = await getVocabularyBySpelling(maimemo, spelling)

      if (voc)
      {
        const [interpretations, notes, phrases] = await Promise.all([
          listInterpretations(maimemo, voc.id),
          listNotes(maimemo, voc.id),
          listPhrases(maimemo, voc.id)
        ])

        mine = toMineSection(interpretations, notes, phrases)
      }
    }
    catch
    {
      // 墨墨失败不阻塞 AI 区块
    }
  }

  const ai = (await generateByAi(spelling)) ?? emptyAi()
  const card: WordCard = { spelling, mine, ai, fetchedAt }

  cacheCard(card)

  return card
}
