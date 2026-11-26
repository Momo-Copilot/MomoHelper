/**
 * 进程内滑动窗口限流器。
 *
 * 墨墨频控：10 秒 20 次 / 60 秒 40 次 / 5 小时 2000 次。
 * 三个窗口必须同时满足；接近阈值时排队等待，而不是直接报错。
 * 浏览器单页面单出口即可满足，无需共享计数。
 */
interface WindowSpec
{
  limit: number
  windowMs: number
}

const WINDOWS: WindowSpec[] = [
  { limit: 20, windowMs: 10_000 },
  { limit: 40, windowMs: 60_000 },
  { limit: 2000, windowMs: 5 * 60 * 60 * 1000 }
]

export class MaimemoRateLimiter
{
  private readonly timestamps: number[][] = WINDOWS.map(() => [])

  /**
   * 获取一次请求配额，必要时等待。
   * 返回是否真的立即获得（用于区分排队与直行，日志用）。
   *
   * `onWait(ms)` 在需要排队时回调，供 UI 显示「正在等待频控」——
   * 全量拉取会因 40 次/60 秒窗口排队近 1 分钟，不提示的话进度条会静止不动，
   * 用户以为卡死了。
   */
  async acquire(onWait?: (waitMs: number) => void): Promise<boolean>
  {
    let waited = false

    for (;;)
    {
      const now = Date.now()

      // 先清过期，再检查各窗口是否有余量
      let blockedUntil = 0
      let canPass = true

      for (let i = 0; i < WINDOWS.length; i++)
      {
        const spec = WINDOWS[i]!
        const list = this.timestamps[i]!
        const cutoff = now - spec.windowMs

        while (list.length > 0 && list[0]! <= cutoff)
        {
          list.shift()
        }

        if (list.length >= spec.limit)
        {
          canPass = false
          // 等到最早一条记录滑出窗口
          blockedUntil = Math.max(blockedUntil, list[0]! + spec.windowMs - now + 1)
        }
      }

      if (canPass)
      {
        for (let i = 0; i < WINDOWS.length; i++)
        {
          this.timestamps[i]!.push(now)
        }

        return !waited
      }

      waited = true
      // 分段睡：一次最多 5 秒，便于外部取消时尽快响应
      const slice = Math.min(blockedUntil, 5_000)

      onWait?.(blockedUntil)
      await sleep(slice)
    }
  }
}

function sleep(ms: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, ms))
}
