import type { MaimemoEnvelope, MaimemoEnvelopeError } from '@momo/types'

import { MaimemoRateLimiter } from './rate-limiter'
import {
  MaimemoApiError,
  MaimemoAuthError,
  MaimemoNetworkError,
  MaimemoRateLimitError
} from './errors'

const DEFAULT_BASE_URL = 'https://open.maimemo.com/open/api/v1/memo'

export interface MaimemoClientOptions
{
  token: string
  baseUrl?: string
  /**
   * 因频控需要排队时回调（毫秒）。全量拉取会排队近 1 分钟，
   * UI 靠它显示「正在等待频控」而不是静止不动的进度条。
   */
  onRateLimitWait?: (waitMs: number) => void
}

export interface RequestOptions
{
  /**
   * 非写操作遇到 429 时最多重试次数（NFR-3.2：不重试写操作，避免重复写入）。
   * 写操作调用方必须显式传 0。
   */
  retries?: number
}

/**
 * 全进程共享的限流器。
 *
 * 必须是模块级单例：频控是「同一个 Token 的出口速率」限制，与客户端实例无关。
 * 若放在实例字段上，每次 `new MaimemoClient()` 都会重置计数（本项目
 * `getMaimemoClient()` 就是每次新建），限流形同虚设——2026-11-26 全量拉取
 * 一次性发 53 个请求直接撞 40 次/60 秒上限，根因就在这里。
 */
const sharedLimiter = new MaimemoRateLimiter()

/**
 * 墨墨 Open API 客户端：统一请求、包裹层解析、限流与错误映射。
 *
 * 解析规则以真机实测为准（api-capability-gap.md 第七节）：
 * 1. 所有响应统一包裹在 { errors, data, success } 中；
 * 2. 鉴权失败返回 HTTP 401 + common_unauthorized；
 * 3. 单词存在性必须判 data.voc，不能依赖 success（C12，由调用方实现）。
 */
export class MaimemoClient
{
  private readonly token: string
  private readonly baseUrl: string
  private readonly onRateLimitWait?: (waitMs: number) => void

  constructor(options: MaimemoClientOptions)
  {
    this.token = options.token
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.onRateLimitWait = options.onRateLimitWait
  }

  /** 发起请求并返回 envelope 的 data 部分 */
  async request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>
  {
    const maxRetries = options?.retries ?? 0
    let attempt = 0

    for (;;)
    {
      await sharedLimiter.acquire(this.onRateLimitWait)

      let response: Response

      try
      {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      }
      catch (error)
      {
        throw new MaimemoNetworkError(
          `墨墨接口网络错误: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      if (response.status === 401)
      {
        throw new MaimemoAuthError()
      }

      if (response.status === 429)
      {
        if (attempt < maxRetries)
        {
          attempt++
          await sleep(backoffMs(attempt))
          continue
        }

        throw new MaimemoRateLimitError()
      }

      // 其余状态码尝试解析包裹层；无法解析时按 HTTP 状态报错
      let envelope: MaimemoEnvelope<unknown>

      try
      {
        envelope = (await response.json()) as MaimemoEnvelope<unknown>
      }
      catch
      {
        throw new MaimemoApiError(
          `http_${response.status}`,
          `墨墨接口返回非 JSON 响应（HTTP ${response.status}）`
        )
      }

      if (envelope.success === false || (envelope.errors?.length ?? 0) > 0)
      {
        const first: MaimemoEnvelopeError | undefined = envelope.errors?.[0]

        if (first?.code === 'common_unauthorized')
        {
          throw new MaimemoAuthError()
        }

        throw new MaimemoApiError(first?.code ?? 'unknown', first?.msg ?? '未知错误')
      }

      return envelope.data as T
    }
  }
}

/** 指数退避：1s、2s、4s…上限 10s */
function backoffMs(attempt: number): number
{
  return Math.min(1000 * 2 ** (attempt - 1), 10_000)
}

function sleep(ms: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, ms))
}
