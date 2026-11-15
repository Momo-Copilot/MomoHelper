/**
 * 本地设置层（纯前端方案）。
 *
 * 墨墨 Token 与 DeepSeek Key 只存在当前浏览器的 localStorage：
 * 单用户自用工具，无后端、无数据库，凭据不离开本机。
 * 墨墨未公开 Token 过期时间，也没有刷新接口，是否失效以接口鉴权结果为准，
 * 因此这里只记录绑定时间，不做有效期倒计时。
 *
 * 备份配置同理也只存本机：三种远端方式是「单一绑定」，一次只启用一个，
 * 含 WebDAV 密码在内整体持久化，刷新后无需重新输入；重置后才能换别的方式。
 * 注意这与备份包内容无关——上传的 JSON 里始终不含任何凭据。
 */

import type { BackupConfig, BackupTarget } from './backup'

const STORAGE_KEYS = {
  maimemoToken: 'momo.maimemoToken',
  tokenBoundAt: 'momo.tokenBoundAt',
  deepseekKey: 'momo.deepseekKey',
  aiThinking: 'momo.aiThinking',
  backupBinding: 'momo.backupBinding'
} as const

/** 旧版把配置拆在多个 key 里且不存密码，读取时迁移一次 */
const LEGACY_BACKUP_KEYS = [
  'momo.backupTarget',
  'momo.backupRepo',
  'momo.backupToken',
  'momo.backupWebdavUrl',
  'momo.backupWebdavUser'
] as const

export interface MaimemoTokenStatus
{
  hasToken: boolean
  /** 绑定时间（ISO）；旧数据没有记录时为 null */
  boundAt: string | null
}

function read(key: string): string | null
{
  try
  {
    return localStorage.getItem(key)
  }
  catch
  {
    return null
  }
}

function write(key: string, value: string): void
{
  try
  {
    localStorage.setItem(key, value)
  }
  catch
  {
    // 隐私模式 / 存储被禁用时静默失败，读层会因拿不到值而引导重新配置
  }
}

function remove(key: string): void
{
  try
  {
    localStorage.removeItem(key)
  }
  catch
  {
    // 忽略
  }
}

// ============================ 备份配置（单一绑定） ============================

/** 已启用的备份方式；只保留该方式需要的字段，避免三种方式互相串配置 */
export interface BackupBinding
{
  target: BackupTarget
  token?: string
  repo?: string
  remoteUrl?: string
  username?: string
  password?: string
}

/** 旧版分散 key 的草稿值（WebDAV 旧配置没有密码，只用于预填，不算绑定） */
export interface BackupDraft
{
  target: BackupTarget
  token: string
  repo: string
  remoteUrl: string
  username: string
}

function readLegacyBinding(): BackupBinding | null
{
  const target = read('momo.backupTarget')

  if (target !== 'github' && target !== 'gitee' && target !== 'webdav')
  {
    return null
  }

  return {
    target,
    token: read('momo.backupToken') ?? undefined,
    repo: read('momo.backupRepo') ?? undefined,
    remoteUrl: read('momo.backupWebdavUrl') ?? undefined,
    username: read('momo.backupWebdavUser') ?? undefined
  }
}

/** 必填项齐全才算「已绑定」；半截配置一律回到未配置状态 */
function isComplete(value: unknown): value is BackupBinding
{
  if (!value || typeof value !== 'object')
  {
    return false
  }

  const b = value as Record<string, unknown>

  if (b.target !== 'github' && b.target !== 'gitee' && b.target !== 'webdav')
  {
    return false
  }

  if (b.target === 'webdav')
  {
    return (
      typeof b.remoteUrl === 'string' && b.remoteUrl.length > 0 &&
      typeof b.username === 'string' && b.username.length > 0 &&
      typeof b.password === 'string' && b.password.length > 0
    )
  }

  return (
    typeof b.token === 'string' && b.token.length > 0 &&
    typeof b.repo === 'string' && b.repo.length > 0
  )
}

/**
 * 读取当前绑定。首次遇到旧版分散 key 时自动迁移（旧版没存密码，
 * WebDAV 无法迁移，会作为草稿让用户补一次密码）。
 */
export function loadBackupBinding(): BackupBinding | null
{
  const raw = read(STORAGE_KEYS.backupBinding)

  if (raw)
  {
    try
    {
      const parsed: unknown = JSON.parse(raw)

      return isComplete(parsed) ? parsed : null
    }
    catch
    {
      return null
    }
  }

  const legacy = readLegacyBinding()

  if (legacy && isComplete(legacy))
  {
    saveBackupBinding(legacy)
    return legacy
  }

  return null
}

/** 未绑定时用旧版残留值预填表单（WebDAV 仍需重新输入密码） */
export function loadLegacyBackupDraft(): BackupDraft | null
{
  const legacy = readLegacyBinding()

  return legacy
    ? {
        target: legacy.target,
        token: legacy.token ?? '',
        repo: legacy.repo ?? '',
        remoteUrl: legacy.remoteUrl ?? '',
        username: legacy.username ?? ''
      }
    : null
}

/** 保存绑定并清掉旧版分散 key，避免以后又读回半截配置 */
export function saveBackupBinding(binding: BackupBinding): void
{
  write(STORAGE_KEYS.backupBinding, JSON.stringify(binding))

  for (const key of LEGACY_BACKUP_KEYS)
  {
    remove(key)
  }
}

/** 重置：只清本机配置，云端已有备份文件不受影响 */
export function clearBackupBinding(): void
{
  remove(STORAGE_KEYS.backupBinding)

  for (const key of LEGACY_BACKUP_KEYS)
  {
    remove(key)
  }
}

/** 绑定 → 备份层入参。WebDAV 不传 path（目录由服务地址决定） */
export function backupBindingToConfig(binding: BackupBinding): BackupConfig
{
  return binding.target === 'webdav'
    ? {
        target: 'webdav',
        remoteUrl: binding.remoteUrl,
        username: binding.username,
        password: binding.password
      }
    : {
        target: binding.target,
        token: binding.token,
        repo: binding.repo,
        path: 'momohelper/backup.json'
      }
}

// ============================ 墨墨 Token ============================

export function getMaimemoToken(): string | null
{
  return read(STORAGE_KEYS.maimemoToken)
}

/** 绑定成功后调用：记录绑定时间，供设置页展示 */
export function setMaimemoToken(token: string): void
{
  write(STORAGE_KEYS.maimemoToken, token.trim())
  write(STORAGE_KEYS.tokenBoundAt, new Date().toISOString())
}

export function clearMaimemoToken(): void
{
  remove(STORAGE_KEYS.maimemoToken)
  remove(STORAGE_KEYS.tokenBoundAt)
}

export function getMaimemoTokenStatus(): MaimemoTokenStatus
{
  const token = getMaimemoToken()

  if (!token)
  {
    return { hasToken: false, boundAt: null }
  }

  return { hasToken: true, boundAt: read(STORAGE_KEYS.tokenBoundAt) }
}

// ============================ DeepSeek Key ============================

export function getDeepSeekKey(): string | null
{
  return read(STORAGE_KEYS.deepseekKey)
}

export function setDeepSeekKey(key: string): void
{
  write(STORAGE_KEYS.deepseekKey, key.trim())
}

export function clearDeepSeekKey(): void
{
  remove(STORAGE_KEYS.deepseekKey)
}

// ============================ AI 思考模式 ============================

/** 思考模式只有开 / 关两种取值；null = 用户尚未选择 */
export type AiThinkingMode = 'on' | 'off'

/**
 * 读取思考模式（全局唯一配置点在设置页）。
 * 未选择返回 null，由 AI 调用前引导用户去设置页配置。
 */
export function getAiThinkingMode(): AiThinkingMode | null
{
  const value = read(STORAGE_KEYS.aiThinking)

  return value === 'on' || value === 'off' ? value : null
}

/** 记录思考模式（设置页统一配置，全局生效） */
export function setAiThinkingMode(mode: AiThinkingMode): void
{
  write(STORAGE_KEYS.aiThinking, mode)
}

/**
 * 设置页与侧栏共用的本地状态快照。
 * 两处必须使用同一个 queryFn，避免同一 queryKey 缓存进不同形状的数据。
 */
export interface LocalStatus
{
  token: MaimemoTokenStatus
  hasAiKey: boolean
}

export function getLocalStatus(): LocalStatus
{
  return {
    token: getMaimemoTokenStatus(),
    hasAiKey: getDeepSeekKey() !== null
  }
}
