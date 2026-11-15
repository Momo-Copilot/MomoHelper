/**
 * 数据备份层：本机学习数据 ↔ 远端私有存储。
 *
 * 备份包（JSON）内容与默认取舍：
 *   - diagnoseHistory：AI 诊断历史（最贵的数据，重生成要再花 AI 调用）
 *   - wordCards：AI 词卡缓存（省重新生成的等待与费用）
 *   - librarySnapshot：词库学习记录快照（丢了也能重拉，但 9 个请求换秒回值得备）
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
import { getAiThinkingMode } from './settings'
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
  settings: {
    aiThinking: 'on' | 'off' | null
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

async function buildPayload(): Promise<BackupPayload>
{
  const library = libraryReader ? await libraryReader() : null

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    diagnoseHistory: getDiagnoseHistory(),
    wordCards: getWordCardsCache(),
    librarySnapshot: library,
    settings: {
      aiThinking: getAiThinkingMode()
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

  const branch = ((await repoRes.json()) as { default_branch?: string; empty?: boolean }).default_branch ?? 'master'

  // 空仓库（无任何提交）：Gitee contents API 无法创建第一个文件，
  // 报 sha is missing / sha is empty——引导用户先在网页端初始化
  const rootRes = await fetch(
    `${GITEE_API}/repos/${owner}/${repo}/contents/?ref=${branch}&access_token=${cfg.token}`
  )

  if (rootRes.ok)
  {
    const root = await rootRes.json()

    if (Array.isArray(root) && root.length === 0)
    {
      throw new BackupError(
        '仓库是空仓库（没有任何提交），Gitee 接口无法向空仓库创建文件。请打开 Gitee 仓库页面点「初始化仓库」，或删除后重建时勾选「使用 Readme 初始化」，然后重试备份。'
      )
    }
  }

  // 现有文件 sha（更新必带）
  let sha: string | undefined

  const fileRes = await fetch(
    `${GITEE_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}&access_token=${cfg.token}`
  )

  if (fileRes.ok)
  {
    const data = await fileRes.json()

    // 空仓库/文件缺失时 Gitee 返回 200 + []，不是 404
    sha = Array.isArray(data) ? undefined : (data as { sha?: string }).sha
  }
  else if (fileRes.status !== 404)
  {
    throw new BackupError(`读取远端文件失败（HTTP ${fileRes.status}）`)
  }

  const res = await fetch(`${GITEE_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
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
        ? 'Gitee 拒绝写入：仓库可能还没有任何提交（空仓库）。请先在 Gitee 仓库页面初始化仓库（建一个 Readme），再回来备份。'
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

  const data = (await res.json()) as { content?: string; encoding?: string }

  if (data.encoding !== 'base64' || !data.content)
  {
    throw new BackupError('远端文件格式异常')
  }

  return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))
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
