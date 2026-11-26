/**
 * DeepSeek 客户端（OpenAI 兼容协议，原生 fetch 实现）。
 *
 * 不引入 openai SDK，保持依赖体积精简。
 * 模型分配（deepseek-chat / deepseek-reasoner 已于 2026-07-24 停止使用）：
 *   - 全站统一 deepseek-flash（含遗忘诊断、问词、学情解读、词卡补充）
 *
 * 曾经把遗忘诊断单独指向 deepseek-v4-pro（定位深度推理），但熟词僻义页要批量
 * 跑 250+ 个词，pro 的量级成本换不来相应质量提升，已统一回 flash。
 *
 * 思考模式不做代码默认：是否开启由用户在页面上选择后经调用方显式传入
 * （thinking: true / false）；未传时请求不带 thinking 字段，走服务端默认。
 * 开启思考时 temperature 不生效（官方限制，但不会报错）。
 */

export type AiModel = 'deepseek-flash'

/** 单币种余额；金额单位为该币种的基本单位（元 / 美元） */
export interface AiBalanceItem
{
  /** 官方枚举为 CNY / USD，未识别时原样透传 */
  currency: string
  /** 总可用（赠金 + 充值） */
  total: number
  /** 未过期的赠金 */
  granted: number
  /** 充值余额 */
  toppedUp: number
}

export interface AiBalance
{
  /** false = 余额不足以继续调用 API */
  isAvailable: boolean
  items: AiBalanceItem[]
}

/** Key 无效 / 无权限：设置页保存前校验失败走这里，与「接口不可用」区分开 */
export class AiAuthError extends Error
{
  constructor(message = 'AI 服务鉴权失败，请检查 API Key')
  {
    super(message)
    this.name = 'AiAuthError'
  }
}

/** 接口不可用或网络异常，与 Key 本身无关 */
export class AiUnavailableError extends Error
{
  constructor(message = 'AI 服务暂不可用，请稍后重试')
  {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

export interface AiClientOptions
{
  apiKey: string
  baseUrl?: string
}

export interface ChatMessage
{
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionParams
{
  model: AiModel
  messages: ChatMessage[]
  /** 调试日志里显示的用途名，如「遗忘诊断」；不参与请求体 */
  label?: string
  /** JSON 模式：prompt 中必须出现 "json" 字样并给出格式示例，否则可能返回空内容 */
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
  /** 中止信号：浏览器端「停止生成」用，abort 时 fetch 抛 AbortError */
  signal?: AbortSignal
  /**
   * 思考模式开关，由用户在页面上显式选择（代码不做默认）：
   * true / false 作为 thinking.type 发送；不传则不带该字段，走服务端默认。
   * 开启思考时 temperature 不生效（官方限制，但不会报错）。
   */
  thinking?: boolean
}

export interface CompletionResult
{
  content: string
  promptTokens: number
  completionTokens: number
}

/* ============================ 调试日志 ============================ */

/**
 * AI 调用日志，默认开启。
 *
 * 目的：在浏览器控制台直接看到每次发给模型的完整 prompt，核对「模型到底收到
 * 了什么」。只打印请求参数与消息正文，**不打印 Authorization 头**，Key 不会
 * 出现在日志里。
 *
 * 关闭：控制台执行 localStorage.setItem('momo.debugAi', '0') 后刷新。
 */
function aiDebugEnabled(): boolean
{
  // 不直接引用 window / Storage：本包可能在没有 DOM lib 的环境下编译（Node 端）。
  // 用最小结构化类型从 globalThis 取，取不到就当作关闭。
  const store = (
    globalThis as { localStorage?: { getItem(key: string): string | null } }
  ).localStorage

  if (!store)
  {
    return false
  }

  try
  {
    return store.getItem('momo.debugAi') !== '0'
  }
  catch
  {
    return false
  }
}

function logAiRequest(kind: string, params: CompletionParams): number
{
  const startedAt = Date.now()

  if (!aiDebugEnabled())
  {
    return startedAt
  }

  console.groupCollapsed(`%c🤖 ${params.label ?? kind}`, 'color:#28b69d;font-weight:600', {
    model: params.model,
    temperature: params.temperature ?? '(默认)',
    maxTokens: params.maxTokens ?? '(默认)',
    thinking: params.thinking === undefined ? '(服务端默认)' : params.thinking ? 'on' : 'off',
    jsonMode: params.jsonMode === true
  })

  for (const message of params.messages)
  {
    console.log(`%c[${message.role}]`, 'color:#7f948d;font-weight:600', message.content)
  }

  console.log('%c关闭日志：localStorage.setItem("momo.debugAi", "0") 后刷新', 'color:#8a8a8a')
  console.groupEnd()

  return startedAt
}

function logAiResponse(
  kind: string,
  params: CompletionParams,
  startedAt: number,
  detail: Record<string, unknown>
): void
{
  if (!aiDebugEnabled())
  {
    return
  }

  console.log(
    `%c✓ ${params.label ?? kind} · ${Date.now() - startedAt}ms`,
    'color:#28b69d;font-weight:600',
    detail
  )
}

export class AiClient
{
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(options: AiClientOptions)
  {
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')
  }

  async complete(params: CompletionParams): Promise<CompletionResult>
  {
    const startedAt = logAiRequest('AI 补全', params)

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: params.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        ...(params.thinking === undefined
          ? {}
          : { thinking: { type: params.thinking ? 'enabled' : 'disabled' } }),
        ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {})
      })
    })

    if (response.status === 401 || response.status === 403)
    {
      throw new AiAuthError()
    }

    if (!response.ok)
    {
      const text = await response.text().catch(() => '')
      throw new AiUnavailableError(
        `DeepSeek 接口错误 HTTP ${response.status}: ${text.slice(0, 200)}`
      )
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[]
      usage?: { prompt_tokens: number; completion_tokens: number }
    }

    const choice = data.choices[0]

    logAiResponse('AI 补全', params, startedAt, {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      content: choice?.message?.content ?? ''
    })

    return {
      content: choice?.message?.content ?? '',
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0
    }
  }

  /**
   * 校验 Key 是否可用（保存前探测，AC-1.2 同款思路）。
   *
   * 先试 GET /models（不计费）；自建代理常不实现该端点，
   * 此时退化为一次 max_tokens=1 的最小对话请求。
   */
  async verify(): Promise<void>
  {
    let probe: Response

    try
    {
      probe = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      })
    }
    catch
    {
      throw new AiUnavailableError()
    }

    if (probe.ok)
    {
      return
    }

    if (probe.status === 401 || probe.status === 403)
    {
      throw new AiAuthError()
    }

    if (probe.status !== 404 && probe.status !== 405)
    {
      throw new AiUnavailableError(`DeepSeek 接口异常 HTTP ${probe.status}`)
    }

    await this.complete({
      model: 'deepseek-flash',
      label: 'Key 校验',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      thinking: false
    })
  }

  /**
   * 查询账号余额（GET /user/balance，官方文档「查询余额」）。
   *
   * 与补全接口共用同一个 Key；接口本身不计费。金额在官方响应里是**字符串**
   * （避免浮点误差），这里转成 number 只用于展示与判断，展示时统一 toFixed(2)。
   *
   * 返回是按币种分组的数组：一个账号可能同时有 CNY 与 USD 余额，
   * 不能假设只有一条。isAvailable 为 false 表示余额耗尽、调用会被拒。
   */
  async getBalance(): Promise<AiBalance>
  {
    let response: Response

    try
    {
      response = await fetch(`${this.baseUrl}/user/balance`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json'
        }
      })
    }
    catch
    {
      throw new AiUnavailableError()
    }

    if (response.status === 401 || response.status === 403)
    {
      throw new AiAuthError()
    }

    if (!response.ok)
    {
      const text = await response.text().catch(() => '')

      throw new AiUnavailableError(
        `DeepSeek 余额接口错误 HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      )
    }

    const raw = (await response.json()) as {
      is_available?: unknown
      balance_infos?: unknown
    }

    const infos = Array.isArray(raw.balance_infos) ? raw.balance_infos : []
    const items: AiBalanceItem[] = []

    for (const rawItem of infos)
    {
      const info = rawItem as Record<string, unknown>
      const total = toAmount(info.total_balance)

      // 没有可用总额的条目直接跳过：展示层不需要一个「余额未知」的币种
      if (total === null)
      {
        continue
      }

      items.push({
        currency: typeof info.currency === 'string' ? info.currency : 'CNY',
        total,
        granted: toAmount(info.granted_balance) ?? 0,
        toppedUp: toAmount(info.topped_up_balance) ?? 0
      })
    }

    return { isAvailable: raw.is_available === true, items }
  }

  /** 流式补全（SSE），逐段回调增量文本，用于 AI 问词（NFR-1.3 首字 < 3s） */
  async streamComplete(
    params: CompletionParams,
    onDelta: (text: string) => void
  ): Promise<void>
  {
    const startedAt = logAiRequest('AI 流式', params)
    let emitted = 0

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: params.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        ...(params.thinking === undefined
          ? {}
          : { thinking: { type: params.thinking ? 'enabled' : 'disabled' } }),
        stream: true
      })
    })

    // 401 / 403 必须与「接口不可用」分开：前者要引导用户去设置页换 Key，
    // 后者只需提示稍后重试。流式与非流式（complete）的错误分类保持一致，
    // 否则同一个失效 Key，问词页说「HTTP 401」、诊断却说「请检查 API Key」。
    if (response.status === 401 || response.status === 403)
    {
      throw new AiAuthError()
    }

    if (!response.ok)
    {
      const text = await response.text().catch(() => '')

      throw new AiUnavailableError(
        `DeepSeek 流式接口错误 HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      )
    }

    if (!response.body)
    {
      throw new AiUnavailableError('DeepSeek 返回了空响应体，无法读取流式内容')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try
    {
      for (;;)
      {
        const { done, value } = await reader.read()

        if (done)
        {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        // SSE 事件以空行分隔
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''

        for (const event of events)
        {
          for (const line of event.split('\n'))
          {
            if (!line.startsWith('data:'))
            {
              continue
            }

            const payload = line.slice(5).trim()

            if (payload === '[DONE]')
            {
              return
            }

            try
            {
              const chunk = JSON.parse(payload) as {
                choices: { delta?: { content?: string } }[]
              }

              const delta = chunk.choices[0]?.delta?.content

              if (delta)
              {
                emitted += delta.length
                onDelta(delta)
              }
            }
            catch
            {
              // 忽略无法解析的心跳/分片
            }
          }
        }
      }
    }
    finally
    {
      // 正常结束、[DONE]、用户中止都会走到这里，统一记一条收尾日志
      logAiResponse('AI 流式', params, startedAt, { chars: emitted })
    }
  }
}

/**
 * 官方金额字段是字符串（如 "110.00"），避免浮点误差。
 * 转成 number 只用于展示与判断；解析不了返回 null，由调用方决定跳过。
 */
function toAmount(value: unknown): number | null
{
  if (typeof value === 'number')
  {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== 'string')
  {
    return null
  }

  const parsed = Number.parseFloat(value)

  return Number.isFinite(parsed) ? parsed : null
}
