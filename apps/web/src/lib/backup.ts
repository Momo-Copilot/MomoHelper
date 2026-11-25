/**
 * 数据备份层：本机学习数据 ↔ 远端私有存储。
 *
 * 备份包（JSON）内容与默认取舍：
 *   - diagnoseHistory：AI 诊断历史（最贵的数据，重生成要再花 AI 调用）
 *   - wordCards：AI 词卡缓存（省重新生成的等待与费用）
 *   - librarySnapshot：词库学习记录快照（丢了也能重拉；恢复时仅当远端
 *     fetchedAt 更新才写回，本机更新则保留本机，避免把当前数据退回去）
 *   - drill：顽固词攻坚记录（作答历史 / 毕业状态 / 诊断缓存 / 助记 noteId）。
 *     纯本地数据，丢了等于练过的全白练，所以必须备
 *   - settings：思考模式等非敏感偏好
 *   - 凭据（墨墨 Token / DeepSeek Key）默认不备份：换设备重粘一次即可，
 *     且把明文凭据放进远端仓库的收益远小于泄露风险
 *
 * 三个远端 adapter 共用同一接口，取 token 方式不同：
 *   - GitHub：PAT 或 OAuth（经边缘函数换取），REST contents API
 *   - Gitee：PAT 或 OAuth，REST contents API（国内直连快）
 *   - WebDAV：账号密码（Basic Auth），可选经边缘函数代理绕 CORS
 */

import { getDiagnoseHistory } from './diagnose-history'
import { loadDrill, type DrillStore } from './drill'
import { readDailySnapshotsForBackup } from './maimemo'
import { getAiThinkingMode, getExamDate } from './settings'
import { getWordCardsCache } from './word-card-cache'

const BACKUP_VERSION = 1

export type BackupTarget = 'github' | 'gitee' | 'webdav'

export interface BackupPayload
{
  version: number
  exportedAt: string
  diagnoseHistory: unknown[]
  wordCards: Record<string, unknown>
  librarySnapshot: {
    records: unknown[]
    meta: unknown
  } | null
  /**
   * 顽固词攻坚记录（作答历史 / 毕业状态 / 诊断缓存 / 已写入的助记 id）。
   * 可选：旧备份没有这个字段，恢复时按「无远端记录」处理。
   */
  drill?: DrillStore
  /**
   * 每日学习快照：连续打卡、14 天趋势、热力图的数据源。
   *
   * 这是全站唯一「花钱也拿不回来」的数据 —— 墨墨接口只给当前状态，
   * 不会告诉你某天学了多少。丢了就是永久缺口。
   * 可选：旧备份没有这个字段。
   */
  dailySnapshots?: unknown[]
  settings: {
    aiThinking: 'on' | 'off' | null
    /** 考试日期 YYYY-MM-DD；旧备份没有这个字段 */
    examDate?: string | null
  }
}

export interface BackupConfig
{
  target: BackupTarget
  /** GitHub/Gitee：PAT 或 OAuth access token；WebDAV 不用 */
  token?: string
  /** WebDAV 专属 */
  remoteUrl?: string
  username?: string
  password?: string
  /** GitHub/Gitee：owner/repo（备份文件所在仓库） */
  repo?: string
  /** 仓库内路径，默认 momohelper/backup.json */
  path?: string
}

export interface BackupResult
{
  exportedAt: string
  size: number
}

class BackupError extends Error {}

/* ============================ 备份包组装 ============================ */

/** IndexedDB 词库快照读不出同步值，这里注入一个读取器避免循环依赖 */
type LibraryReader = () => Promise<{
  records: unknown[]
  meta: unknown
} | null>

let libraryReader: LibraryReader | null = null

/** 由 library.ts 注册（避免 backup ↔ library 循环 import） */
export function registerLibraryReader(reader: LibraryReader): void
{
  libraryReader = reader
}

/**
 * 兜底加载词库模块，确保注册器已挂上。
 *
 * 注册是副作用，只在 library.ts 被求值时执行。而设置页只 import 了
 * backup/backup-restore，从不 import library —— 用户直接进设置页点备份时，
 * 注册没发生，libraryReader 为 null，备份包里 librarySnapshot 恒为 null。
 * 表现是「备份成功」，实际词库根本没进去，且因为库是按路由懒加载的，
 * 先逛过词库页再回设置页又恰好正常，很容易漏测。
 *
 * 动态 import 让注册与「是否访问过词库页」解耦。
 */
async function ensureLibraryRegistered(): Promise<void>
{
  if (libraryReader)
  {
    return
  }

  try
  {
    await import('./library')
  }
  catch
  {
    // 词库模块加载失败（旧浏览器无 IndexedDB 等）时照常备份其余数据，
    // 不因为一个可选字段让整次备份失败
  }
}

/**
 * 备份前瘦身：drill 里与诊断历史重复的诊断不再重复打包。
 *
 * 实测一份备份 240KB 里有 167KB 是 drill 中 259 条诊断全文，
 * 而同一个词在 diagnoseHistory 往往已有同一份（或更新的一份）。
 * 备份包里同一内容存两遍，既浪费体积，恢复时又可能带出两份不一致。
 *
 * 规则（只影响备份产物，不改本机存储）：按词比较，若历史里那条的 at 不早于
 * drill 的，就丢掉 drill 的 diagnosis —— 恢复时 backfillDiagnoseFromDrill
 * 会从历史照常还原，语义不变；若 drill 的那条更新，则保留，避免丢新数据。
 */
function slimDrillForBackup(store: DrillStore, history: unknown[]): DrillStore
{
  /** spelling(小写) → 历史里该词最新一条的 at */
  const historyAt = new Map<string, string>()

  for (const item of history)
  {
    const record = item as { spelling?: string; at?: string }

    if (!record?.spelling || typeof record.at !== 'string')
    {
      continue
    }

    const key = record.spelling.toLowerCase()
    const prev = historyAt.get(key)

    if (!prev || record.at > prev)
    {
      historyAt.set(key, record.at)
    }
  }

  const words: DrillStore['words'] = {}

  for (const [vocId, state] of Object.entries(store.words ?? {}))
  {
    const diag = state?.diagnosis
    const known = state?.spelling ? historyAt.get(state.spelling.toLowerCase()) : undefined

    if (!diag?.at || !known || known < diag.at)
    {
      words[vocId] = state
      continue
    }

    // 历史里已有同词且不更旧 → 包里不再重复
    const { diagnosis: _dropped, ...rest } = state
    words[vocId] = rest as typeof state
  }

  return { words }
}

async function buildPayload(): Promise<BackupPayload>
{
  await ensureLibraryRegistered()

  const library = libraryReader ? await libraryReader() : null
  const diagnoseHistory = getDiagnoseHistory()

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    diagnoseHistory,
    wordCards: getWordCardsCache(),
    librarySnapshot: library,
    drill: slimDrillForBackup(loadDrill(), diagnoseHistory),
    dailySnapshots: readDailySnapshotsForBackup(),
    settings: {
      aiThinking: getAiThinkingMode(),
      examDate: getExamDate()
    }
  }
}

/** 从备份包恢复：逐项写回本机（见 restore-*.ts 中各写入端） */
export interface RestoreSource
{
  payload: BackupPayload
  exportedAt: string
}

/* ============================ GitHub ============================ */

const GITHUB_API = 'https://api.github.com'

async function githubPut(cfg: BackupConfig, content: string): Promise<void>
{
  const path = cfg.path ?? 'momohelper/backup.json'
  const [owner, repo] = (cfg.repo ?? '').split('/')

  if (!owner || !repo)
  {
    throw new BackupError('仓库格式应为 owner/repo')
  }

  // 先查现有文件 sha（contents API 更新必须带 sha；不存在则 404 走新建）
  let sha: string | undefined

  try
  {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
      {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github+json'
        }
      }
    )

    if (res.ok)
    {
      sha = ((await res.json()) as { sha?: string }).sha
    }
    else if (res.status !== 404)
    {
      throw new BackupError(`读取远端文件失败（HTTP ${res.status}），请检查 Token 权限`)
    }
  }
  catch (error)
  {
    if (error instanceof BackupError)
    {
      throw error
    }
    // 网络错误继续走 PUT，让上传请求本身报出更明确的错误
  }

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `MomoHelper backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        content: btoa(unescape(encodeURIComponent(content))),
        sha
      })
    }
  )

  if (!res.ok)
  {
    throw new BackupError(`上传失败（HTTP ${res.status}）：${(await res.text()).slice(0, 160)}`)
  }
}

async function githubGet(cfg: BackupConfig): Promise<string>
{
  const path = cfg.path ?? 'momohelper/backup.json'
  const [owner, repo] = (cfg.repo ?? '').split('/')

  if (!owner || !repo)
  {
    throw new BackupError('仓库格式应为 owner/repo')
  }

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json'
      }
    }
  )

  if (res.status === 404)
  {
    throw new BackupError('远端还没有备份文件，请先执行一次备份')
  }

  if (!res.ok)
  {
    throw new BackupError(`下载失败（HTTP ${res.status}），请检查 Token 权限`)
  }

  const data = (await res.json()) as { content?: string; encoding?: string }

  if (data.encoding !== 'base64' || !data.content)
  {
    throw new BackupError('远端文件格式异常')
  }

  // GitHub 返回的 base64 带 \n 且是 UTF-8，需要双向解码
  return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))
}

/* ============================ Gitee ============================ */

const GITEE_API = 'https://gitee.com/api/v5'

/**
 * Gitee contents API 与 GitHub 语义不同（实测）：
 *   - 新建文件：POST，不要 sha（嵌套目录会自动创建）
 *   - 更新文件：PUT，必须带现有文件的 sha
 * 以前统一用 PUT，首次备份（备份文件不存在）必然报
 * {"messages":["sha is missing","sha is empty"]}，与仓库里有没有 README 无关。
 */
async function giteePut(cfg: BackupConfig, content: string): Promise<void>
{
  const path = cfg.path ?? 'momohelper/backup.json'
  const [owner, repo] = (cfg.repo ?? '').split('/')

  if (!owner || !repo)
  {
    throw new BackupError('仓库格式应为 owner/repo')
  }

  // Gitee 内容接口按分支操作，先取默认分支
  const repoRes = await fetch(`${GITEE_API}/repos/${owner}/${repo}?access_token=${cfg.token}`)

  if (!repoRes.ok)
  {
    throw new BackupError(
      repoRes.status === 404
        ? '仓库不存在或无权访问，请确认 owner/repo 与 Token 权限'
        : `读取仓库失败（HTTP ${repoRes.status}）`
    )
  }

  const branch = ((await repoRes.json()) as { default_branch?: string }).default_branch ?? 'master'

  // 现有文件 sha（更新必带）；文件缺失时 Gitee 返回 200 + [] 而非 404
  let sha: string | undefined

  const fileRes = await fetch(
    `${GITEE_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}&access_token=${cfg.token}`
  )

  if (fileRes.ok)
  {
    const data = await fileRes.json()

    // 文件缺失时 Gitee 返回 200 + []，不是 404
    sha = Array.isArray(data) ? undefined : (data as { sha?: string }).sha
  }
  else if (fileRes.status !== 404)
  {
    throw new BackupError(`读取远端文件失败（HTTP ${fileRes.status}）`)
  }

  // 首次备份走 POST 新建，之后走 PUT 更新
  const res = await fetch(`${GITEE_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: sha ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: cfg.token,
      content: btoa(unescape(encodeURIComponent(content))),
      sha,
      branch,
      message: `MomoHelper backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    })
  })

  if (!res.ok)
  {
    const detail = (await res.text()).slice(0, 160)

    throw new BackupError(
      detail.includes('sha is missing') || detail.includes('sha is empty')
        ? 'Gitee 拒绝写入：仓库可能还没有任何提交（零提交仓库）。请在 Gitee 仓库页面点「初始化仓库」建一个 Readme 后重试。'
        : `上传失败（HTTP ${res.status}）：${detail}`
    )
  }
}

async function giteeGet(cfg: BackupConfig): Promise<string>
{
  const path = cfg.path ?? 'momohelper/backup.json'
  const [owner, repo] = (cfg.repo ?? '').split('/')

  if (!owner || !repo)
  {
    throw new BackupError('仓库格式应为 owner/repo')
  }

  // Gitee contents GET 必须带 ref（不带会返回 {"message":"ref"}）
  const repoRes = await fetch(`${GITEE_API}/repos/${owner}/${repo}?access_token=${cfg.token}`)

  if (!repoRes.ok)
  {
    throw new BackupError(
      repoRes.status === 404 ? '仓库不存在或无权访问' : `读取仓库失败（HTTP ${repoRes.status}）`
    )
  }

  const branch = ((await repoRes.json()) as { default_branch?: string }).default_branch ?? 'master'

  const res = await fetch(
    `${GITEE_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}&access_token=${cfg.token}`
  )

  if (res.status === 404)
  {
    throw new BackupError('远端还没有备份文件，请先执行一次备份')
  }

  if (!res.ok)
  {
    throw new BackupError(`下载失败（HTTP ${res.status}）`)
  }

  const data: unknown = await res.json()

  // 文件缺失时 Gitee 返回 200 + []，而不是 404
  if (Array.isArray(data))
  {
    throw new BackupError('远端还没有备份文件，请先执行一次备份')
  }

  const file = data as { content?: string; encoding?: string }

  if (file.encoding !== 'base64' || !file.content)
  {
    throw new BackupError('远端文件格式异常')
  }

  return decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))))
}

/* ============================ WebDAV ============================ */

/** WebDAV 统一经本站边缘函数代理转发（/api/webdav/proxy）：绕开坚果云等服务的 CORS 限制 */
const WEBDAV_PROXY = '/api/webdav/proxy'

/** 目标 URL + 方法 → 代理 URL */
function proxyUrl(target: string, method: string): string
{
  const params = new URLSearchParams({ url: target, method })
  return `${WEBDAV_PROXY}?${params.toString()}`
}

function webdavTargetUrl(cfg: BackupConfig): string
{
  const base = (cfg.remoteUrl ?? '').replace(/\/$/, '')
  // 备份文件直接放在服务地址指向的目录下，目录层级完全由服务地址控制
  const path = cfg.path ?? 'backup.json'

  return `${base}/${path}`
}

function webdavAuthHeader(cfg: BackupConfig): string
{
  return `Basic ${btoa(`${cfg.username ?? ''}:${cfg.password ?? ''}`)}`
}

async function webdavPut(cfg: BackupConfig, content: string): Promise<void>
{
  const res = await fetch(proxyUrl(webdavTargetUrl(cfg), 'PUT'), {
    method: 'POST',
    headers: {
      Authorization: webdavAuthHeader(cfg),
      'Content-Type': 'application/json'
    },
    body: content
  })

  if (!res.ok)
  {
    throw new BackupError(`上传失败（HTTP ${res.status}），请检查账号密码与服务地址`)
  }
}

async function webdavGet(cfg: BackupConfig): Promise<string>
{
  const res = await fetch(proxyUrl(webdavTargetUrl(cfg), 'GET'), {
    method: 'GET',
    headers: { Authorization: webdavAuthHeader(cfg) }
  })

  if (res.status === 404)
  {
    throw new BackupError('远端还没有备份文件，请先执行一次备份')
  }

  if (!res.ok)
  {
    throw new BackupError(`下载失败（HTTP ${res.status}）`)
  }

  return res.text()
}

/* ============================ 对外入口 ============================ */

function validateCfg(cfg: BackupConfig): void
{
  if (cfg.target === 'webdav')
  {
    if (!cfg.remoteUrl)
    {
      throw new BackupError('请填写 WebDAV 服务地址')
    }
  }
  else
  {
    if (!cfg.token)
    {
      throw new BackupError('请先配置访问 Token')
    }

    if (!cfg.repo)
    {
      throw new BackupError('请填写仓库名（owner/repo）')
    }
  }
}

export async function createBackup(cfg: BackupConfig): Promise<BackupResult>
{
  validateCfg(cfg)

  const payload = await buildPayload()
  const content = JSON.stringify(payload)

  if (cfg.target === 'github')
  {
    await githubPut(cfg, content)
  }
  else if (cfg.target === 'gitee')
  {
    await giteePut(cfg, content)
  }
  else
  {
    await webdavPut(cfg, content)
  }

  return { exportedAt: payload.exportedAt, size: content.length }
}

/** 拉取远端备份包并解析；形状校验失败会明确报错 */
export async function fetchBackup(cfg: BackupConfig): Promise<RestoreSource>
{
  validateCfg(cfg)

  let content: string

  if (cfg.target === 'github')
  {
    content = await githubGet(cfg)
  }
  else if (cfg.target === 'gitee')
  {
    content = await giteeGet(cfg)
  }
  else
  {
    content = await webdavGet(cfg)
  }

  let payload: BackupPayload

  try
  {
    payload = JSON.parse(content) as BackupPayload
  }
  catch
  {
    throw new BackupError('远端备份文件不是有效 JSON')
  }

  if (payload?.version !== BACKUP_VERSION || !Array.isArray(payload.diagnoseHistory))
  {
    throw new BackupError('备份包版本或结构不匹配，可能来自旧版应用')
  }

  return { payload, exportedAt: payload.exportedAt }
}

export { BackupError }
