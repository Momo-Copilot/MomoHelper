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

/**
 * 仓库不存在时自动创建私有仓库（首次备份零准备）。
 * 仅当 owner 与 Token 所属用户一致时可建（建在别人名下需要更高权限，报错引导）。
 */
async function ensureGithubRepo(cfg: BackupConfig, owner: string, repo: string): Promise<void>
{
  const userRes = await fetch(`${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' }
  })

  if (!userRes.ok)
  {
    throw new BackupError(`Token 校验失败（HTTP ${userRes.status}），请检查 Token 是否有效`)
  }

  const login = ((await userRes.json()) as { login?: string }).login

  if (login !== owner)
  {
    throw new BackupError(
      `仓库 ${owner}/${repo} 不存在，且 Token 属于 ${login}，无法在 ${owner} 名下自动建仓；请先把仓库建好，或把仓库名改为 ${login}/<仓库名>`
    )
  }

  const createRes = await fetch(`${GITHUB_API}/user/repos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: repo, private: true, auto_init: true })
  })

  if (!createRes.ok)
  {
    const detail = (await createRes.text()).slice(0, 160)

    throw new BackupError(
      `自动创建仓库失败（HTTP ${createRes.status}）：${detail}。请手动创建仓库后重试。`
    )
  }
}

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
  let repoMissing = false

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
    else if (res.status === 404)
    {
      // 文件不存在或仓库不存在——PUT 后再区分，仓库缺失时自动建
      repoMissing = true
    }
    else
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

  const doPut = async (): Promise<Response> =>
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
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
    })

  let res = await doPut()

  // 仓库不存在 → 自动建私有仓 → 重试一次（sha 已知为空）
  if (res.status === 404 && repoMissing)
  {
    await ensureGithubRepo(cfg, owner, repo)
    res = await doPut()
  }

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
 * 仓库不存在时自动创建私有仓库（与 GitHub 同策略）。
 * owner 与 Token 所属用户不一致时报错引导（Gitee 个人令牌建不了企业/他人仓库）。
 */
async function ensureGiteeRepo(cfg: BackupConfig, owner: string, repo: string): Promise<void>
{
  const userRes = await fetch(`${GITEE_API}/user?access_token=${cfg.token}`)

  if (!userRes.ok)
  {
    throw new BackupError(`Token 校验失败（HTTP ${userRes.status}），请检查私人令牌是否有效`)
  }

  const login = ((await userRes.json()) as { login?: string }).login

  if (login !== owner)
  {
    throw new BackupError(
      `仓库 ${owner}/${repo} 不存在，且令牌属于 ${login}，无法在 ${owner} 名下自动建仓；请先建好仓库，或把仓库名改为 ${login}/<仓库名>`
    )
  }

  const createRes = await fetch(`${GITEE_API}/user/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: cfg.token, name: repo, private: true, auto_init: true })
  })

  if (!createRes.ok)
  {
    const detail = (await createRes.text()).slice(0, 160)

    throw new BackupError(
      `自动创建仓库失败（HTTP ${createRes.status}）：${detail}。请手动创建仓库后重试。`
    )
  }
}

async function giteePut(cfg: BackupConfig, content: string): Promise<void>
{
  const path = cfg.path ?? 'momohelper/backup.json'
  const [owner, repo] = (cfg.repo ?? '').split('/')

  if (!owner || !repo)
  {
    throw new BackupError('仓库格式应为 owner/repo')
  }

  // Gitee 内容接口按分支操作，先取默认分支；仓库不存在时自动建
  let repoRes = await fetch(`${GITEE_API}/repos/${owner}/${repo}?access_token=${cfg.token}`)

  if (repoRes.status === 404)
  {
    await ensureGiteeRepo(cfg, owner, repo)
    repoRes = await fetch(`${GITEE_API}/repos/${owner}/${repo}?access_token=${cfg.token}`)
  }

  if (!repoRes.ok)
  {
    throw new BackupError(
      repoRes.status === 404
        ? '仓库不存在或无权访问，请确认 owner/repo 与 Token 权限'
        : `读取仓库失败（HTTP ${repoRes.status}）`
    )
  }

  const branch = ((await repoRes.json()) as { default_branch?: string }).default_branch ?? 'master'

  // 现有文件 sha（更新必带）
  let sha: string | undefined

  const fileRes = await fetch(
    `${GITEE_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}&access_token=${cfg.token}`
  )

  if (fileRes.ok)
  {
    sha = ((await fileRes.json()) as { sha?: string }).sha
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
    throw new BackupError(`上传失败（HTTP ${res.status}）：${(await res.text()).slice(0, 160)}`)
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

  const res = await fetch(
    `${GITEE_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?access_token=${cfg.token}`
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
  const path = cfg.path ?? 'momohelper/backup.json'

  return `${base}/${path}`
}

function webdavAuthHeader(cfg: BackupConfig): string
{
  return `Basic ${btoa(`${cfg.username ?? ''}:${cfg.password ?? ''}`)}`
}

/** 逐级建目录：WebDAV 不支持递归 MKCOL，父目录不存在会 409 */
async function webdavEnsureDir(cfg: BackupConfig): Promise<void>
{
  const base = (cfg.remoteUrl ?? '').replace(/\/$/, '')
  const path = cfg.path ?? 'momohelper/backup.json'
  const dir = path.split('/').slice(0, -1)
  let current = base

  for (const segment of dir)
  {
    current = `${current}/${segment}`

    const res = await fetch(proxyUrl(current, 'MKCOL'), {
      method: 'POST',
      headers: { Authorization: webdavAuthHeader(cfg) }
    })

    // 405 = 已存在，属正常
    if (!res.ok && res.status !== 405)
    {
      throw new BackupError(`创建远端目录失败（HTTP ${res.status}）`)
    }
  }
}

async function webdavPut(cfg: BackupConfig, content: string): Promise<void>
{
  await webdavEnsureDir(cfg)

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
