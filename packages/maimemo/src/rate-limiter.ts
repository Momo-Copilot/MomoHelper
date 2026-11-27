/**
 * 进程内滑动窗口限流器。
 *
 * 墨墨频控：10 秒 20 次 / 60 秒 40 次 / 5 小时 2000 次。
 *
 * 两条自我保护：
 *   1. 前两个窗口只用 80% 额度（16 / 32）。贴着上限跑时，客户端记录的「发出
 *      时间」与服务端记录的「收到时间」有偏差，滑动窗口与固定窗口的边界也会
 *      错位，差一两个请求就撞墙。留出余量比精确压榨更可靠。
 *   2. 一旦真的收到 429，调用 penalize() 进入强制冷却——不再相信本地窗口计算，
 *      直接按服务端的拒绝退避。窗口是理想模型，429 是事实。
 */
interface WindowSpec
{
  limit: number
  windowMs: number
}

const WINDOWS: WindowSpec[] = [
  { limit: 16, windowMs: 10_000 },
  { limit: 32, windowMs: 60_000 },
  { limit: 2000, windowMs: 5 * 60 * 60 * 1000 }
]

/** 收到 429 后默认冷却时长：比 60 秒窗口略长，保证旧记录滑出 */
const PENALTY_MS = 65_000

export class MaimemoRateLimiter
{
  private readonly timestamps: number[][] = WINDOWS.map(() => [])
  /** 惩罚性冷却截止时间（毫秒时间戳）；0 表示无冷却 */
  private cooldownUntil = 0

  /**
   * 获取一次请求配额，必要时等待。
   * 返回是否真的立即获得（用于区分排队与直行，日志用）。
   *
   * `onWait(ms)` 在需要排队时回调，供 UI 显示「正在等待频控」——
   * 全量拉取会因 40 次/60 秒窗口排队，不提示的话进度条会静止不动。
   */
  async acquire(onWait?: (waitMs: number) => void): Promise<boolean>
  {
    let waited = false

    for (;;)
    {
      const now = Date.now()

      // 惩罚性冷却优先：服务端刚拒绝过，先老实等完
      if (this.cooldownUntil > now)
      {
        const remain = this.cooldownUntil - now

        waited = true
        onWait?.(remain)
        await sleep(Math.min(remain, 5_000))
        continue
      }

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

  /**
   * 服务端明确拒绝（HTTP 429）后调用：强制冷却一段时间。
   *
   * 本地窗口计算只是估算，429 才是事实。收到一次就退避，避免「按窗口算还能发
   * → 又 429 → 继续算」的循环把额度耗光。
   */
  penalize(ms: number = PENALTY_MS): void
  {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms)
  }

  /** 剩余冷却毫秒（调试用） */
  cooldownRemaining(): number
  {
    return Math.max(0, this.cooldownUntil - Date.now())
  }
}

function sleep(ms: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, ms))
}
