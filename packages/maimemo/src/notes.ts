/**
 * 助记的写入与撤回。
 *
 * 这是整个项目里唯一会**改动用户墨墨数据**的地方，所以几条自我约束：
 * - 只写助记，不碰复习计划、不碰释义、不碰例句
 * - 写入成功后把 note id 存回本地，随时能撤回（DELETE /notes/{id}）
 * - 配额是每天 600 条（例句 / 助记 / 释义合计），页面上必须提示
 */

import { z } from 'zod'

import type { MaimemoClient } from './client'
import { MaimemoApiError } from './errors'
import type { MaimemoNote } from './vocabulary'

const noteSchema = z.object({
  id: z.string(),
  note_type: z.string().optional().default(''),
  note: z.string().optional().default(''),
  status: z.string().optional().default('PUBLISHED')
})

export interface CreateNoteInput
{
  vocId: string
  /** 助记类型，墨墨里会显示成分类标签 */
  noteType: string
  /** 助记正文 */
  note: string
}

/** 新建助记：POST /notes，请求体要求包一层 note */
export async function createNote(
  client: MaimemoClient,
  input: CreateNoteInput
): Promise<MaimemoNote>
{
  const data = await client.request<{ note?: unknown }>('POST', '/notes', {
    note: {
      voc_id: input.vocId,
      note_type: input.noteType,
      note: input.note
    }
  })

  if (!data?.note)
  {
    throw new MaimemoApiError('note_missing', '墨墨没有返回新建的助记')
  }

  const parsed = noteSchema.parse(data.note)

  return {
    id: parsed.id,
    noteType: parsed.note_type,
    note: parsed.note,
    status: parsed.status
  }
}

/** 撤回：删除刚写入的助记。写坏了能退回去，是敢写的前提 */
export async function deleteNote(client: MaimemoClient, id: string): Promise<void>
{
  await client.request<void>('DELETE', `/notes/${encodeURIComponent(id)}`)
}
