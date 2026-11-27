/**
 * 演示模式：新访客没绑定 Token 时，也能看到完整界面长什么样。
 *
 * 数据来自一位真实用户导出的学习记录（8614 词），打包在
 * `public/demo/demo-data.json`，只在进入演示模式时才下载（gzip 后约 550 KB）。
 *
 * 三条硬规则：
 *   1. 演示数据只读——所有写操作（快照、攻坚记录、备份）在演示模式下直接跳过，
 *      否则访客的点击会写进他自己的本机存储
 *   2. 演示状态用 localStorage 记住，不污染 Token / AI Key / 备份配置
 *   3. 页面上必须显示横幅，否则用户会以为看到的是自己的数据
 */

import type {
  DashboardTodayDto,
  FocusWordDto,
  LibraryRecordRowDto
} from '@momo/types'

/** 演示状态标记；真实凭据存在另外的 key 里，互不影响 */
const DEMO_KEY = 'momo.demo'

export interface DemoSnapshotRow
{
  date: string
  finished: number
  total: number
  studyTimeMs: number
  capturedAt: string
}

export interface DemoData
{
  generatedAt: string
  note: string
  /** 演示用考试日期，与真实用户无关 */
  examDate: string
  dashboard: DashboardTodayDto
  forgotten: { words: FocusWordDto[] }
  sticking: { words: FocusWordDto[] }
  records: LibraryRecordRowDto[]
  dailySnapshots: DemoSnapshotRow[]
}

/** URL 上的 `?demo=1`：便于分享演示链接、也方便无头浏览器截图 */
const DEMO_PARAM = 'demo=1'

/** 同步判断：很多渲染分支要在首帧决定是否走演示数据 */
export function isDemoMode(): boolean
{
  if (typeof window === 'undefined')
  {
    return false
  }

  if (window.location.search.includes(DEMO_PARAM))
  {
    return true
  }

  try
  {
    return window.localStorage.getItem(DEMO_KEY) === '1'
  }
  catch
  {
    return false
  }
}

export function enterDemo(): void
{
  try
  {
    window.localStorage.setItem(DEMO_KEY, '1')
  }
  catch
  {
    // 隐私模式下写不进去，忽略：本次会话仍可用，刷新后回到未登录态
  }
}

export function exitDemo(): void
{
  try
  {
    window.localStorage.removeItem(DEMO_KEY)
    // 演示专用的样本数据一并清掉，别留在访客机器上
    window.localStorage.removeItem('momo.demoSnapshots')
    window.localStorage.removeItem('momo.demoExamDate')
    window.localStorage.removeItem('momo.demoDrill')
  }
  catch
  {
    // 同上
  }
}

/**
 * 进入演示：先把样本数据下载好并写进本地，再整页刷新。
 *
 * 为什么必须先写再刷新：趋势、推演这些地方读的是同步的 localStorage
 * （getDashboardHistory / getExamDate），不能等异步加载。先落盘再 reload，
 * 首帧就是完整的。
 */
export async function startDemo(): Promise<void>
{
  const demo = await loadDemoData()

  window.localStorage.setItem(DEMO_KEY, '1')
  window.localStorage.setItem('momo.demoSnapshots', JSON.stringify(demo.dailySnapshots))
  window.localStorage.setItem('momo.demoExamDate', demo.examDate)

  window.location.href = '/'
}

let cache: Promise<DemoData> | null = null

/** 加载演示数据（带内存缓存，切页面不会重复下载） */
export function loadDemoData(): Promise<DemoData>
{
  cache ??= fetch('/demo/demo-data.json')
    .then(async (response) =>
    {
      if (!response.ok)
      {
        throw new Error(`演示数据加载失败（HTTP ${response.status}）`)
      }

      return (await response.json()) as DemoData
    })
    .catch((error: unknown) =>
    {
      // 失败后清掉缓存，让用户重试时不至于永远拿到同一个 rejected promise
      cache = null
      throw error
    })

  return cache
}
