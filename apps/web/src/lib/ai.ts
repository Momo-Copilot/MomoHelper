/**
 * DeepSeek 浏览器直连层。
 *
 * api.deepseek.com 对浏览器 CORS 全开（2026-11-11 实测：反射 Origin、
 * 放行 authorization 头），Key 只存本机 localStorage，fetch 直连。
 * 流式问答走浏览器原生 ReadableStream（streamComplete 内部已封装）。
 *
 * prompt 与输出校验复用 @momo/ai：buildAskMessages / diagnoseForget，
 * AI 输出一律经 Zod 校验后才交给 UI。
 */

import {
  AiClient,
  buildAskMessages,
  diagnoseForget,
  type AskContext,
  type ChatMessage,
  type ForgetDiagnosis
} from '@momo/ai'
import { queryStudyRecords } from '@momo/maimemo'

import { getMaimemoToken, getDeepSeekKey } from './settings'
import { getMaimemoClient } from './maimemo'

/** 未配置 DeepSeek Key：页面应引导去设置页，不是错误 */
export class AiNotConfiguredError extends Error
{
  constructor()
  {
    super('尚未配置 DeepSeek API Key，请先到设置页填写')
    this.name = 'AiNotConfiguredError'
  }
}

export function getAiClient(): AiClient
{
  const apiKey = getDeepSeekKey()

  if (!apiKey)
  {
    throw new AiNotConfiguredError()
  }

  return new AiClient({ apiKey })
}

/** 校验新填的 Key：设置页保存前探测（401/403 = Key 无效） */
export async function verifyDeepSeekKey(apiKey: string): Promise<void>
{
  const probe = new AiClient({ apiKey })
  await probe.verify()
}

/** 从学习记录里找该词的上下文；墨墨未配置或接口不可用时仅传拼写（不阻塞问答） */
async function findRecordContext(spelling: string): Promise<AskContext>
{
  try
  {
    if (!getMaimemoToken())
    {
      return { spelling }
    }

    const client = getMaimemoClient()
    // 服务端按拼写定位（spellings 最多 1000、忽略其他条件），
    // 原拼写 + 小写两种形态一起传，规避服务端大小写匹配差异
    const spellings = [...new Set([spelling, spelling.toLowerCase()])]
    const records = await queryStudyRecords(client, { spellings })
    const record = records.records[0]

    if (!record)
    {
      return { spelling }
    }

    return {
      spelling,
      studyCount: record.study_count,
      isSticking: record.tags.includes('STICKING')
    }
  }
  catch
  {
    // AC-5.3 的精神：有真实数据就注入，没有就直说缺失，不编造也不阻塞
    return { spelling }
  }
}

/**
 * AI 问词（流式）：注入真实学习数据（学习次数 / 顽固标记）后逐段回调增量文本。
 * 墨墨侧 Token 与 DeepSeek 侧 Key 分别缺一时：Token 缺失仍可纯 AI 回答，
 * Key 缺失抛 AiNotConfiguredError 由 UI 引导。
 * thinking 由用户在问词页选择（开 / 关），这里只透传，不做代码默认。
 */
export async function askStream(
  question: string,
  spelling: string | undefined,
  thinking: boolean,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void>
{
  const ai = getAiClient()
  const context = spelling ? await findRecordContext(spelling) : {}
  const messages: ChatMessage[] = buildAskMessages(question, context)

  await ai.streamComplete(
    {
      model: 'deepseek-flash',
      label: 'AI 问词',
      messages,
      maxTokens: 1200,
      temperature: 0.5,
      thinking,
      signal
    },
    onDelta
  )
}

/** 遗忘原因诊断：deepseek-flash + 固定七枚举，结合真实学习记录；思考模式由用户选择（FR-3.6） */
export async function diagnoseWord(spelling: string, thinking: boolean): Promise<ForgetDiagnosis>
{
  const ai = getAiClient()

  let studyCount: number | undefined
  let lastResponse: string | undefined
  let tags: string[] = []

  try
  {
    if (getMaimemoToken())
    {
      const client = getMaimemoClient()
      // 服务端按拼写定位（原拼写 + 小写两种形态），不再全量拉 1000 条
      const spellings = [...new Set([spelling, spelling.toLowerCase()])]
      const records = await queryStudyRecords(client, { spellings })
      const record = records.records[0]

      if (record)
      {
        studyCount = record.study_count
        lastResponse = record.last_response
        tags = record.tags
      }
    }
  }
  catch
  {
    // 学习数据不可用时继续诊断，上下文缺失由 prompt 容忍
  }

  const generated = await diagnoseForget(ai, {
    spelling,
    thinking,
    studyCount,
    lastResponse,
    tags
  })
  return generated.data
}
