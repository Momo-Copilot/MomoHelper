/**
 * 学情 AI 解读（第二步）：代码算指标 → AI 只写解读。
 *
 * 硬性边界（2026-11-16 讨论定案）：
 * - 数字全部由 analyzeReport / analyzeLibrary 生成后塞进摘要，AI 只引用不计算
 * - 充分度档位（few / some / rich）写死在代码，随摘要注入，AI 不得自行判断
 * - 诊断历史是稀疏的主动点击数据，只作线索引用，禁止统计性结论
 * - 输出为 2~3 段自然解读 + 「建议」清单，不要鼓励性废话
 *
 * 防幻觉采用 prompt 强约束 + 软校验：生成后提取摘要外数字，只计数标注
 * （UI 角落提示），不阻塞不重试——硬校验误伤率过高（「约 1/3」这类
 * 合理换算会被拦），不值得。
 *
 * 缓存：按北京日期存 localStorage（momo.reportAi.{date}），跨天自动失效；
 * 重新生成是显式动作，成本每次几厘钱，无需确认。
 */

import type { ChatMessage } from '@momo/ai'
import type {
  DashboardTodayDto,
  LibraryStatsDto,
  ReportSnapshotDto
} from '@momo/types'
import { beijingToday } from '@momo/maimemo'

import { getAiClient } from './ai'
import { getDiagnoseHistory, type DiagnoseRecord } from './diagnose-history'

const CACHE_PREFIX = 'momo.reportAi.'

/** 与遗忘词页 REASON_LABELS 保持同步（七枚举，UI 层映射） */
const REASON_LABELS: Record<string, string> = {
  SPELLING_SIMILAR: '拼写相似',
  ABSTRACT_MEANING: '词义抽象',
  RARE_SENSE: '熟词僻义',
  CN_MEANING_CONFLICT: '中文释义混淆',
  COLLOCATION_WEAK: '搭配不熟',
  ROOT_DIVERGENCE: '词根分叉',
  LACK_CONTEXT: '缺少语境'
}

export interface ReportInsightCache
{
  /** 北京日期，等于缓存 key 后缀 */
  date: string
  /** 解读全文 */
  content: string
  /** ISO 生成时间 */
  at: string
  /** 生成时的思考模式 */
  thinking: boolean
  /** 软校验发现的摘要外数字个数 */
  unverifiedCount: number
}

function cacheKey(): string
{
  return CACHE_PREFIX + beijingToday()
}

/** 读当日缓存；跨天自动失效（key 变了自然读不到旧的） */
export function loadReportInsightCache(): ReportInsightCache | null
{
  try
  {
    const raw = localStorage.getItem(cacheKey())

    if (!raw)
    {
      return null
    }

    const parsed = JSON.parse(raw) as ReportInsightCache

    return typeof parsed.content === 'string' && parsed.content ? parsed : null
  }
  catch
  {
    return null
  }
}

function saveReportInsightCache(value: ReportInsightCache): void
{
  try
  {
    localStorage.setItem(cacheKey(), JSON.stringify(value))
  }
  catch
  {
    // 存储满等异常不阻塞展示
  }
}

/* ============================ 指标摘要 ============================ */

export interface ReportSummary
{
  /** 喂给 AI 的摘要全文 */
  text: string
  /** 摘要中出现的全部数字（软校验白名单，字符串形态便于匹配） */
  numbers: Set<string>
}

const n = (value: number): string => value.toLocaleString('zh-CN')

/** 数字归一化：去千分位逗号 + 去前导零（"1,861"/"1861" 等价，"02"/"2" 等价） */
function normalizeNumber(raw: string): string
{
  return raw.replace(/,/g, '').replace(/^0+/, '') || '0'
}

/**
 * 指标摘要（纯函数）：所有数字的唯一来源。AI 拿到的是这个文本，
 * 不是任何原始数据——它没有算错数字的机会，只有引用错误的机会。
 */
export function buildReportSummary(
  report: ReportSnapshotDto,
  stats: LibraryStatsDto,
  dashboard?: DashboardTodayDto,
  truncated?: { loaded: number; expected: number }
): ReportSummary
{
  const { risk, tier } = report
  const notStarted = stats.countBuckets.find((bucket) => bucket.key === '0')?.count ?? 0
  const started = stats.total - notStarted
  const lines: string[] = []
  const numbers = new Set<string>()

  const collect = (line: string): void =>
  {
    lines.push(line)

    // 千分位形态（1,861）整段去逗号后入白名单，与软校验侧口径一致；
    // 逗号分段产生的碎片（1 / 861）也无害——它们本来就在摘要里
    for (const match of line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/gu))
    {
      numbers.add(normalizeNumber(match[0]))
    }
  }

  // 口径行：AI 必须知道数据不是全库，别把 1861 当 8614 说
  collect(
    truncated
      ? `【口径】学习记录快照 ${n(truncated.loaded)} 条 / 词库总数 ${n(truncated.expected)}（差额多为未安排复习的词，统计仅覆盖已进入复习计划的词）；数据跨度 ${report.spanDays} 天（档位：${tier}）`
      : `【口径】学习记录快照 ${n(stats.total)} 条（全量）；数据跨度 ${report.spanDays} 天（档位：${tier}）`
  )
  collect(`【总量】已开始学习 ${n(started)} 词，未开始 ${n(notStarted)} 词`)
  collect(
    `【质量】顽固词 ${n(stats.stickingCount)}（墨墨 STICKING 标记）；平均每词学习 ${stats.avgStudyCount} 次；只学过 1 次的词 ${n(stats.singleStudyCount)}`
  )

  // 近 30 天节奏：从日粒度曲线尾部聚合
  const last30 = report.dailyNew.slice(-30)
  const new30 = last30.reduce((sum, row) => sum + row.count, 0)
  const activeDays = last30.filter((row) => row.count > 0).length

  collect(
    `【节奏】近 30 天新学 ${n(new30)} 词（有学习的天 ${activeDays} 天）；最长断更 ${risk.maxGapDays} 天`
  )

  if (risk.gaps.length > 0)
  {
    const recent = [...risk.gaps]
      .reverse()
      .slice(0, 3)
      .map((gap) => `${gap.start} ~ ${gap.end}（${gap.days} 天）`)
      .join('、')

    collect(`【断更区间】最近：${recent}`)
  }

  collect(
    `【沉睡】${n(risk.sleepingCount)} 词 30 天以上没碰（已学词的 ${stats.total ? Math.round((risk.sleepingCount / Math.max(started, 1)) * 100) : 0}%）`
  )

  const peak = risk.reviewPeak

  collect(
    `【复习压力】未来 7 / 14 / 30 天待复习 ${n(risk.reviewUpcoming.within7)} / ${n(risk.reviewUpcoming.within14)} / ${n(risk.reviewUpcoming.within30)} 词` +
      (peak ? `；单日峰值 ${peak.date} 约 ${n(peak.count)} 词` : '') +
      (risk.unscheduledCount > 0 ? `；已学但未安排下次复习 ${n(risk.unscheduledCount)} 词` : '')
  )

  // 今日数据：仅当看板缓存可用时注入（可选，不强制拉取）
  if (dashboard)
  {
    const responses = { FORGET: 0, VAGUE: 0, FAMILIAR: 0 }

    for (const word of dashboard.todayWords)
    {
      const response = word.firstResponse

      if (response && response in responses)
      {
        responses[response]++
      }
    }

    collect(
      `【今日】完成 ${n(dashboard.finished)}/${n(dashboard.total)}，用时 ${Math.round(dashboard.studyTimeMs / 60000)} 分钟；作答：忘记 ${n(responses.FORGET)}、模糊 ${n(responses.VAGUE)}、认识 ${n(responses.FAMILIAR)}`
    )
  }

  // 诊断线索：最近 20 条只取词 + 原因标签；稀疏主动数据，禁止统计结论
  const history = getDiagnoseHistory().slice(0, 20)

  if (history.length > 0)
  {
    const items = history
      .map((record) => `${record.spelling}（${REASON_LABELS[record.data.reason] ?? record.data.reason}）`)
      .join('、')

    collect(`【诊断线索】最近诊断过的词（共 ${history.length} 条，仅可个别提及，不得据此下统计结论）：${items}`)
  }

  return { text: lines.join('\n'), numbers }
}

/* ============================ Prompt ============================ */

const TIER_RULES: Record<ReportSnapshotDto['tier'], string> = {
  few: '数据不足 7 天：只解读当前画像与今日状态，明确说数据积累尚早，禁止任何趋势判断。',
  some: '数据 7~29 天：可以谈近期节奏与质量，禁止长期趋势与规律性判断。',
  rich: '数据 30 天以上：允许谈趋势、断更规律与风险，但仍须基于摘要数字。'
}

function buildMessages(summary: ReportSummary, tier: ReportSnapshotDto['tier']): ChatMessage[]
{
  const system: ChatMessage = {
    role: 'system',
    content: [
      '你是一名考研背单词学习分析师，基于结构化指标摘要为用户写一段学情解读。',
      '语气直接、具体，像懂学习方法的学长，不是客服。',
      '',
      '硬性规则（违反任何一条即为失败输出）：',
      '1. 只能引用摘要中出现的数字，禁止计算新数字（包括百分比换算）；摘要没有的数字一个都不要出现。',
      '2. 档位规则：' + TIER_RULES[tier],
      '3. 【诊断线索】是用户主动点击产生的稀疏数据，只能作为个别词的线索提及，禁止据此下任何统计性结论（如"40% 的诊断是 X"）。',
      '4. 结论必须指向行动；禁止鼓励性废话（"你已经很棒了""保持下去"这类一律不要）。',
      '5. 诚实对待数据局限：快照被截断就说明覆盖不全，趋势有洞就直说，不要脑补。',
      '',
      '输出格式：2~3 段自然解读（可跨维度关联，如断更与作答质量的关系），',
      '最后一段以"建议："开头，列 2~3 条具体可执行的动作（每条一行，以 - 开头）。',
      '不要输出标题、分节符、markdown 加粗。'
    ].join('\n')
  }

  const user: ChatMessage = {
    role: 'user',
    content: `以下是我近期的学习指标摘要，请按要求写解读：\n\n${summary.text}`
  }

  return [system, user]
}

/* ============================ 软校验 ============================ */

/**
 * 提取输出中摘要没有的数字（软校验，不阻塞）。
 * 两侧统一 normalizeNumber（去逗号 + 去前导零）；
 * 输出中的日期区间（"11-02"）按连字符分段比对，每段命中即视为已核实。
 */
export function countUnverifiedNumbers(content: string, numbers: Set<string>): number
{
  let unverified = 0

  for (const match of content.matchAll(/\d[\d,]*(?:\.\d+)?/gu))
  {
    const raw = normalizeNumber(match[0])

    if (numbers.has(raw))
    {
      continue
    }

    const parts = raw.split('-')

    if (parts.length > 1 && parts.every((part) => numbers.has(normalizeNumber(part))))
    {
      continue
    }

    unverified++
  }

  return unverified
}

/* ============================ 生成入口 ============================ */

/**
 * 生成学情 AI 解读（流式）。onDelta 收增量文本；完成后写当日缓存并返回。
 * DeepSeek Key 缺失抛 AiNotConfiguredError（UI 引导去设置）。
 */
export async function generateReportInsight(
  summary: ReportSummary,
  tier: ReportSnapshotDto['tier'],
  thinking: boolean,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<ReportInsightCache>
{
  const ai = getAiClient()
  let content = ''

  await ai.streamComplete(
    {
      model: 'deepseek-flash',
      label: '学情解读',
      messages: buildMessages(summary, tier),
      maxTokens: 1200,
      temperature: 0.5,
      thinking,
      signal
    },
    (delta) =>
    {
      content += delta
      onDelta(delta)
    }
  )

  const result: ReportInsightCache = {
    date: beijingToday(),
    content,
    at: new Date().toISOString(),
    thinking,
    unverifiedCount: countUnverifiedNumbers(content, summary.numbers)
  }

  saveReportInsightCache(result)
  return result
}

export type { DiagnoseRecord }
