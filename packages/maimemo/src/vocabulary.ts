import { z } from 'zod'

import type { MaimemoClient } from './client'

/**
 * 词汇查询：拼写 → voc_id（大多数接口需要 voc_id 而非拼写）。
 * 注意：官方开放 API 的词汇接口只返回 id 与拼写，
 * 官方词库释义不在开放范围内（2026-11 官方 OpenAPI 规范确认）。
 */

export interface MaimemoVocabulary
{
  id: string
  spelling: string
}

const vocSchema = z.object({
  id: z.string(),
  spelling: z.string()
})

/** 按拼写查单词（不存在时 data.voc 为空 → 返回 null，不视为错误） */
export async function getVocabularyBySpelling(
  client: MaimemoClient,
  spelling: string
): Promise<MaimemoVocabulary | null>
{
  const data = await client.request<{ voc?: unknown }>(
    'GET',
    `/vocabulary?spelling=${encodeURIComponent(spelling)}`
  )

  // 单词存在性必须判 data.voc，不能依赖 success（C12）
  if (!data?.voc)
  {
    return null
  }

  return vocSchema.parse(data.voc)
}

/** 用户自建释义（仅本人创建的内容，非官方词库） */
export interface MaimemoInterpretation
{
  id: string
  interpretation: string
  tags: string[]
  status: string
}

const interpretationSchema = z.object({
  id: z.string(),
  interpretation: z.string(),
  tags: z.array(z.string()).optional().default([]),
  status: z.string()
})

/** 列出某词的自建释义（多数词为空——官方词库释义不开放） */
export async function listInterpretations(
  client: MaimemoClient,
  vocId: string
): Promise<MaimemoInterpretation[]>
{
  const data = await client.request<{ interpretations?: unknown[] }>(
    'GET',
    `/interpretations?voc_id=${encodeURIComponent(vocId)}`
  )

  return (data?.interpretations ?? []).map((raw) => interpretationSchema.parse(raw))
}

/** 用户自建例句（仅本人创建的内容） */
export interface MaimemoPhrase
{
  id: string
  phrase: string
  interpretation: string
  tags: string[]
  status: string
}

const phraseSchema = z.object({
  id: z.string(),
  phrase: z.string(),
  interpretation: z.string(),
  tags: z.array(z.string()).optional().default([]),
  status: z.string()
})

/** 列出某词的自建例句 */
export async function listPhrases(
  client: MaimemoClient,
  vocId: string
): Promise<MaimemoPhrase[]>
{
  const data = await client.request<{ phrases?: unknown[] }>(
    'GET',
    `/phrases?voc_id=${encodeURIComponent(vocId)}`
  )

  return (data?.phrases ?? []).map((raw) => phraseSchema.parse(raw))
}

/** 用户自建助记（谐音/词根/联想等，仅本人创建的内容） */
export interface MaimemoNote
{
  id: string
  /** 助记类型：联想 / 谐音 / 词根 / 词源 / 固搭 等 */
  noteType: string
  note: string
  status: string
}

const noteSchema = z.object({
  id: z.string(),
  note_type: z.string(),
  note: z.string(),
  status: z.string()
})

/** 列出某词的自建助记 */
export async function listNotes(client: MaimemoClient, vocId: string): Promise<MaimemoNote[]>
{
  const data = await client.request<{ notes?: unknown[] }>(
    'GET',
    `/notes?voc_id=${encodeURIComponent(vocId)}`
  )

  return (data?.notes ?? []).map((raw) =>
  {
    const parsed = noteSchema.parse(raw)

    return {
      id: parsed.id,
      noteType: parsed.note_type,
      note: parsed.note,
      status: parsed.status
    }
  })
}
