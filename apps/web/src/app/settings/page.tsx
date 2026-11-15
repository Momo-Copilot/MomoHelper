'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { AiAuthError } from '@momo/ai'
import {
  MaimemoAuthError,
  MaimemoApiError,
  MaimemoNetworkError,
  MaimemoRateLimitError
} from '@momo/maimemo'
import { Icon } from '@/components/icons'
import { ErrorNote, PageHeader, Segmented, Tile } from '@/components/kit'
import { verifyDeepSeekKey } from '@/lib/ai'
import { BackupError, createBackup, fetchBackup, type BackupTarget } from '@/lib/backup'
import { restoreBackup } from '@/lib/backup-restore'
import { handleGithubCallback, startGithubLogin } from '@/lib/github-oauth'
import { verifyMaimemoToken } from '@/lib/maimemo'
import {
  clearDeepSeekKey,
  clearMaimemoToken,
  getAiThinkingMode,
  getDeepSeekKey,
  getLocalStatus,
  setAiThinkingMode,
  setDeepSeekKey,
  setMaimemoToken,
  type AiThinkingMode
} from '@/lib/settings'

/**
 * 设置页：墨墨 Token + DeepSeek Key，全部存本机浏览器 localStorage。
 * 保存前先探测可用性（校验通过才保存，失败不覆盖旧值）。
 */
export default function SettingsPage()
{
  const queryClient = useQueryClient()

  const statusQuery = useQuery({
    queryKey: ['settings', 'status'],
    queryFn: getLocalStatus,
    staleTime: 0,
    retry: false
  })

  const token = statusQuery.data?.token ?? null

  const [tokenInput, setTokenInput] = useState('')
  const [showTokenInput, setShowTokenInput] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [tokenOk, setTokenOk] = useState(false)

  const [keyInput, setKeyInput] = useState('')
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [keyOk, setKeyOk] = useState(false)

  /** 仅客户端首次渲染后读取，避免静态导出阶段触碰 localStorage 造成水合不一致 */
  const [hasKey, setHasKey] = useState<boolean | null>(null)

  /** AI 思考模式（全局唯一配置点）：null = 未配置 */
  const [thinking, setThinking] = useState<AiThinkingMode | null>(null)

  /* ============================ 数据备份 ============================ */

  const [backupTarget, setBackupTarget] = useState<BackupTarget>('github')
  const [backupToken, setBackupToken] = useState('')
  const [backupRepo, setBackupRepo] = useState('')
  const [webdavUrl, setWebdavUrl] = useState('')
  const [webdavUser, setWebdavUser] = useState('')
  const [webdavPass, setWebdavPass] = useState('')
  const [backupBusy, setBackupBusy] = useState<'backup' | 'restore' | null>(null)
  const [backupNotice, setBackupNotice] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  /** OAuth 登录是否可用（前端配置了 client_id） */
  const oauthClientId = process.env.NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID ?? ''

  useEffect(
    () =>
    {
      // 恢复上次使用的备份配置（不含密码类字段——安全考虑不持久化）
      setBackupTarget((localStorage.getItem('momo.backupTarget') as BackupTarget) ?? 'github')
      setBackupRepo(localStorage.getItem('momo.backupRepo') ?? '')
      setWebdavUrl(localStorage.getItem('momo.backupWebdavUrl') ?? '')
      setWebdavUser(localStorage.getItem('momo.backupWebdavUser') ?? '')
      setBackupToken(localStorage.getItem('momo.backupToken') ?? '')
    },
    []
  )

  // GitHub OAuth 回调处理：URL 带 code+state 时换 token 并填入
  useEffect(
    () =>
    {
      void handleGithubCallback().then((result) =>
      {
        if (result.token)
        {
          setBackupToken(result.token)
          setBackupTarget('github')
          setBackupNotice('GitHub 授权成功，Token 已填入，选择仓库后即可备份。')
        }
        else if (result.message)
        {
          setBackupError(result.message)
        }
      })
    },
    []
  )

  function saveBackupPrefs(target: BackupTarget, repo: string, remote: string, user: string, token: string): void
  {
    try
    {
      localStorage.setItem('momo.backupTarget', target)

      if (repo)
      {
        localStorage.setItem('momo.backupRepo', repo)
      }

      if (remote)
      {
        localStorage.setItem('momo.backupWebdavUrl', remote)
      }

      if (user)
      {
        localStorage.setItem('momo.backupWebdavUser', user)
      }

      if (token)
      {
        localStorage.setItem('momo.backupToken', token)
      }
    }
    catch
    {
      // 忽略
    }
  }

  function buildBackupConfig()
  {
    return backupTarget === 'webdav'
      ? {
          target: backupTarget as BackupTarget,
          remoteUrl: webdavUrl.trim(),
          username: webdavUser.trim(),
          password: webdavPass,
          path: 'momohelper/backup.json'
        }
      : {
          target: backupTarget as BackupTarget,
          token: backupToken.trim(),
          repo: backupRepo.trim(),
          path: 'momohelper/backup.json'
        }
  }

  async function runBackup(): Promise<void>
  {
    setBackupBusy('backup')
    setBackupError(null)
    setBackupNotice(null)

    try
    {
      const cfg = buildBackupConfig()
      const result = await createBackup(cfg)

      saveBackupPrefs(cfg.target, cfg.repo ?? '', cfg.remoteUrl ?? '', cfg.username ?? '', cfg.token ?? '')
      setBackupNotice(`备份完成：${new Date(result.exportedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${(result.size / 1024).toFixed(1)} KB`)
    }
    catch (error)
    {
      setBackupError(error instanceof BackupError ? error.message : `备份失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
    finally
    {
      setBackupBusy(null)
    }
  }

  async function runRestore(): Promise<void>
  {
    setBackupBusy('restore')
    setBackupError(null)
    setBackupNotice(null)

    try
    {
      const cfg = buildBackupConfig()
      const source = await fetchBackup(cfg)
      const result = await restoreBackup(source)

      saveBackupPrefs(cfg.target, cfg.repo ?? '', cfg.remoteUrl ?? '', cfg.username ?? '', cfg.token ?? '')
      setBackupNotice(
        `恢复完成（远端备份时间 ${new Date(source.exportedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）：` +
        `诊断合并 ${result.diagnoseMerged} 条 · 词卡补入 ${result.wordCardsMerged} 条` +
        `${result.libraryRestored ? ' · 词库快照已写回' : ''}${result.settingsApplied ? ' · 已采纳远端思考模式' : ''}。刷新页面生效。`
      )
    }
    catch (error)
    {
      setBackupError(error instanceof BackupError ? error.message : `恢复失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
    finally
    {
      setBackupBusy(null)
    }
  }

  useEffect(
    () =>
    {
      setHasKey(getDeepSeekKey() !== null)
      setThinking(getAiThinkingMode())

      if (getDeepSeekKey() === null)
      {
        setShowKeyInput(true)
      }
    },
    []
  )

  // 未绑定墨墨 Token 时直接展开输入框
  useEffect(
    () =>
    {
      if (statusQuery.isSuccess && token && !token.hasToken)
      {
        setShowTokenInput(true)
      }
    },
    [statusQuery.isSuccess, token]
  )

  function invalidateStatus(): void
  {
    void queryClient.invalidateQueries({ queryKey: ['settings', 'status'] })
  }

  const bindToken = useMutation({
    mutationFn: async (value: string) =>
    {
      // 先校验再保存；失败抛错，不覆盖旧 Token
      await verifyMaimemoToken(value)
      setMaimemoToken(value)
    },
    onSuccess: () =>
    {
      setTokenInput('')
      setShowTokenInput(false)
      setTokenError(null)
      setTokenOk(true)
      invalidateStatus()
      window.setTimeout(() => setTokenOk(false), 2500)
    },
    onError: (error) =>
    {
      if (error instanceof MaimemoAuthError)
      {
        setTokenError('Token 无效：墨墨返回鉴权失败，请到「墨墨 App → 更多设置 → 实验功能 → 开放 API」重新复制后再试')
      }
      else if (error instanceof MaimemoApiError)
      {
        setTokenError(`墨墨接口返回错误 [${error.code}]，可能是账号权限或接口暂不可用，请稍后重试`)
      }
      else if (error instanceof MaimemoNetworkError)
      {
        setTokenError('网络连接失败：无法连接墨墨接口代理，请检查网络或稍后重试')
      }
      else if (error instanceof MaimemoRateLimitError)
      {
        setTokenError('触发墨墨请求频控，请稍等几十秒再试')
      }
      else
      {
        setTokenError(error instanceof Error ? error.message : '校验失败，请稍后重试')
      }
    }
  })

  const unbindToken = useMutation({
    mutationFn: async () =>
    {
      clearMaimemoToken()
    },
    onSuccess: () =>
    {
      setShowTokenInput(true)
      setTokenError(null)
      invalidateStatus()
    }
  })

  const saveKey = useMutation({
    mutationFn: async (value: string) =>
    {
      // 保存前探测：401/403 = Key 无效；连不上则不保存
      await verifyDeepSeekKey(value)
      setDeepSeekKey(value)
    },
    onSuccess: () =>
    {
      setKeyInput('')
      setShowKeyInput(false)
      setKeyError(null)
      setKeyOk(true)
      setHasKey(true)
      invalidateStatus()
      window.setTimeout(() => setKeyOk(false), 2500)
    },
    onError: (error) =>
    {
      setKeyError(
        error instanceof AiAuthError
          ? 'Key 无效：AI 服务返回鉴权失败'
          : error instanceof Error
            ? error.message
            : '校验失败：无法连接 AI 服务，请稍后重试'
      )
    }
  })

  const clearKey = useMutation({
    mutationFn: async () =>
    {
      clearDeepSeekKey()
    },
    onSuccess: () =>
    {
      setShowKeyInput(true)
      setKeyError(null)
      setHasKey(false)
      invalidateStatus()
    }
  })

  return (
    <div className="mx-auto max-w-[720px]">
      <PageHeader
        title="设置"
        description="凭据只存在本机浏览器；墨墨请求经本站同源代理转发，代理不存储数据"
      />

      {/* 墨墨 Token */}
      <Tile index={0} hover={false}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
            >
              <Icon name="link" className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[var(--text-md)] font-semibold">墨墨 Token</h2>
              <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                墨墨 App → 更多设置 → 实验功能 中开启并复制；鉴权失败时重新复制
              </p>
            </div>
          </div>
          {token?.hasToken && !showTokenInput && (
            <button
              type="button"
              onClick={() => setShowTokenInput(true)}
              className="rounded-md border border-[var(--color-border-strong)] px-3.5 py-1.5 text-[var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
            >
              重新绑定
            </button>
          )}
        </div>

        {token?.hasToken && !showTokenInput ? (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--color-bg-subtle)] px-4 py-3">
              <p className="flex items-center gap-2 text-[var(--text-sm)]">
                <Icon name="check" className="h-4 w-4 text-[var(--color-familiar)]" />
                已绑定 · 鉴权失败时重新复制
              </p>
              <span className="tabular font-[family-name:var(--font-mono)] text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                {token.boundAt
                  ? `绑定于 ${new Date(token.boundAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
                  : '绑定时间未记录'}
              </span>
            </div>
            <p className="mt-2 text-[var(--text-xs)] text-[var(--color-text-subtle)]">
              墨墨未公开 Token 过期时间，也没有刷新接口；是否失效以接口返回的鉴权结果为准。
            </p>
            <div className="mt-3">
              <button
                type="button"
                disabled={unbindToken.isPending}
                onClick={() => unbindToken.mutate()}
                className="text-[var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-forget)] hover:underline"
              >
                解除绑定
              </button>
            </div>
          </div>
        ) : (
          <form
            className="mt-4"
            onSubmit={(event) =>
            {
              event.preventDefault()
              const value = tokenInput.trim()

              if (value)
              {
                bindToken.mutate(value)
              }
            }}
          >
            <textarea
              rows={3}
              value={tokenInput}
              maxLength={512}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="粘贴墨墨个人 Token"
              className="w-full resize-none rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 py-2.5 font-[family-name:var(--font-mono)] text-[var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={bindToken.isPending || !tokenInput.trim()}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-5 text-[var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                {bindToken.isPending ? '验证中…' : '验证并保存'}
              </button>
              {token?.hasToken && (
                <button
                  type="button"
                  onClick={() =>
                  {
                    setShowTokenInput(false)
                    setTokenError(null)
                    setTokenInput('')
                  }}
                  className="text-[var(--text-sm)] text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-text)]"
                >
                  取消
                </button>
              )}
            </div>
          </form>
        )}

        {tokenError && (
          <div className="mt-3">
            <ErrorNote message={tokenError} />
          </div>
        )}
        {tokenOk && (
          <p className="mt-3 flex items-center gap-1.5 text-[var(--text-sm)] text-[var(--color-familiar)]">
            <Icon name="check" className="h-4 w-4" />
            Token 已保存，看板与遗忘词可以使用了。
          </p>
        )}
      </Tile>

      {/* DeepSeek Key */}
      <Tile index={1} hover={false} className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-info-bg)] text-[var(--color-info)]"
            >
              <Icon name="key" className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[var(--text-md)] font-semibold">DeepSeek API Key</h2>
              <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                在 platform.deepseek.com 获取；AI 诊断与问词都走它
              </p>
            </div>
          </div>
          {hasKey && !showKeyInput && (
            <button
              type="button"
              onClick={() => setShowKeyInput(true)}
              className="rounded-md border border-[var(--color-border-strong)] px-3.5 py-1.5 text-[var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
            >
              重新填写
            </button>
          )}
        </div>

        {hasKey && !showKeyInput ? (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--color-bg-subtle)] px-4 py-3">
              <p className="flex items-center gap-2 text-[var(--text-sm)]">
                <Icon name="check" className="h-4 w-4 text-[var(--color-familiar)]" />
                已配置
              </p>
              <button
                type="button"
                disabled={clearKey.isPending}
                onClick={() => clearKey.mutate()}
                className="text-[var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-forget)] hover:underline"
              >
                清除
              </button>
            </div>
          </div>
        ) : (
          <form
            className="mt-4"
            onSubmit={(event) =>
            {
              event.preventDefault()
              const value = keyInput.trim()

              if (value)
              {
                saveKey.mutate(value)
              }
            }}
          >
            <input
              type="password"
              autoComplete="off"
              value={keyInput}
              maxLength={300}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder="sk-..."
              className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={saveKey.isPending || !keyInput.trim()}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-5 text-[var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                {saveKey.isPending ? '验证中…' : '验证并保存'}
              </button>
              {hasKey && (
                <button
                  type="button"
                  onClick={() =>
                  {
                    setShowKeyInput(false)
                    setKeyError(null)
                    setKeyInput('')
                  }}
                  className="text-[var(--text-sm)] text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-text)]"
                >
                  取消
                </button>
              )}
            </div>
          </form>
        )}

        {keyError && (
          <div className="mt-3">
            <ErrorNote message={keyError} />
          </div>
        )}
        {keyOk && (
          <p className="mt-3 flex items-center gap-1.5 text-[var(--text-sm)] text-[var(--color-familiar)]">
            <Icon name="check" className="h-4 w-4" />
            Key 已保存，AI 诊断与问词可以使用了。
          </p>
        )}
      </Tile>

      <Tile index={2} hover={false} className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-vague-bg)] text-[var(--color-vague)]"
            >
              <Icon name="message" className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[var(--text-md)] font-semibold">AI 思考模式</h2>
              <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                开启回答更深入但更慢，关闭更快；问词与遗忘词诊断共用
              </p>
            </div>
          </div>
          <Segmented
            ariaLabel="AI 思考模式"
            value={thinking ?? ''}
            options={[
              ['on', '开'],
              ['off', '关']
            ]}
            onChange={(next) =>
            {
              if (next === 'on' || next === 'off')
              {
                setAiThinkingMode(next)
                setThinking(next)
              }
            }}
          />
        </div>
        <p className="mt-3 text-[var(--text-xs)] text-[var(--color-text-subtle)]">
          {thinking
            ? thinking === 'on'
              ? '当前：开启 —— 诊断与问词会多花一些时间，结论更细致。'
              : '当前：关闭 —— 诊断与问词响应更快。'
            : '尚未配置：发起 AI 诊断或提问前需要先在这里选择。'}
        </p>
      </Tile>

      <Tile index={3} hover={false} className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
            >
              <Icon name="book" className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[var(--text-md)] font-semibold">数据备份</h2>
              <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                诊断历史、词卡缓存、词库快照备份到你的私有远端；凭据不包含
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <Segmented
            ariaLabel="备份目标"
            value={backupTarget}
            options={[
              ['github', 'GitHub'],
              ['gitee', 'Gitee'],
              ['webdav', 'WebDAV']
            ]}
            onChange={(next) =>
            {
              setBackupTarget(next as BackupTarget)
              setBackupError(null)
              setBackupNotice(null)
            }}
          />

          {backupTarget === 'webdav' ? (
            <>
              <input
                value={webdavUrl}
                onChange={(event) => setWebdavUrl(event.target.value)}
                placeholder="服务地址，如 https://dav.jianguoyun.com/dav/"
                className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
              />
              <div className="flex gap-3">
                <input
                  value={webdavUser}
                  onChange={(event) => setWebdavUser(event.target.value)}
                  placeholder="账号"
                  autoComplete="off"
                  className="h-10 flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 text-[var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
                />
                <input
                  type="password"
                  value={webdavPass}
                  onChange={(event) => setWebdavPass(event.target.value)}
                  placeholder="密码 / 应用密码"
                  autoComplete="new-password"
                  className="h-10 flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
                />
              </div>
            </>
          ) : (
            <>
              {backupTarget === 'github' && oauthClientId && (
                <button
                  type="button"
                  onClick={() =>
                  {
                    try
                    {
                      startGithubLogin()
                    }
                    catch (error)
                    {
                      setBackupError(error instanceof Error ? error.message : 'OAuth 未配置')
                    }
                  }}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--color-border-strong)] px-4 text-[var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
                >
                  <Icon name="link" className="h-4 w-4" />
                  使用 GitHub 授权登录
                </button>
              )}
              <input
                type="password"
                value={backupToken}
                onChange={(event) => setBackupToken(event.target.value)}
                placeholder={backupTarget === 'github' ? 'GitHub Token（OAuth 登录或手动粘贴，需 Contents 读写权限）' : 'Gitee 私人令牌'}
                autoComplete="off"
                className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
              />
              <input
                value={backupRepo}
                onChange={(event) => setBackupRepo(event.target.value)}
                placeholder="仓库名，如 bonanliu/momohelper-backup（需提前创建，建议私有）"
                className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 text-[var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
              />
            </>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={backupBusy !== null}
              onClick={() => void runBackup()}
              className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              {backupBusy === 'backup' ? '备份中…' : '立即备份'}
            </button>
            <button
              type="button"
              disabled={backupBusy !== null}
              onClick={() => void runRestore()}
              className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
            >
              {backupBusy === 'restore' ? '恢复中…' : '从云端恢复'}
            </button>
          </div>

          <p className="text-[var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
            备份内容：AI 诊断历史（合并去重）、AI 词卡缓存（只补缺）、词库学习记录快照、思考模式。
            <span className="font-medium text-[var(--color-text-muted)]">不含墨墨 Token 与 DeepSeek Key</span>
            （换设备重新粘贴即可，避免明文凭据上云）。
            {backupTarget === 'webdav' && ' 若服务不支持跨域，上传会被浏览器拦截，需配置代理后重试。'}
          </p>
        </div>

        {backupError && (
          <div className="mt-3">
            <ErrorNote message={backupError} />
          </div>
        )}
        {backupNotice && (
          <p className="mt-3 flex items-start gap-1.5 text-[var(--text-sm)] leading-relaxed text-[var(--color-familiar)]">
            <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
            {backupNotice}
          </p>
        )}
      </Tile>

      <Tile index={4} hover={false} className="mt-4">
        <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">
          说明：本工具是纯前端应用，你的墨墨 Token 与 DeepSeek Key
          只保存在这台设备的浏览器里。DeepSeek 由浏览器直连；墨墨请求经本站
          同源代理 /api/memo/* 转发，代理只转发、不存储。清除浏览器站点数据会同时清除凭据与学习快照。
        </p>
      </Tile>
    </div>
  )
}
