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
import { getAiClient, verifyDeepSeekKey } from '@/lib/ai'
import { BackupError, createBackup, fetchBackup, type BackupTarget, type RestoreSource } from '@/lib/backup'
import { restoreBackup } from '@/lib/backup-restore'
import { handleGithubCallback, startGithubLogin } from '@/lib/github-oauth'
import { verifyMaimemoToken } from '@/lib/maimemo'
import {
  backupBindingToConfig,
  clearBackupBinding,
  clearDeepSeekKey,
  clearMaimemoToken,
  getAiThinkingMode,
  getDeepSeekKey,
  getLocalStatus,
  loadBackupBinding,
  loadLegacyBackupDraft,
  saveBackupBinding,
  setAiThinkingMode,
  setDeepSeekKey,
  setMaimemoToken,
  type AiThinkingMode,
  type BackupBinding
} from '@/lib/settings'

const BACKUP_TARGET_LABELS: Record<BackupTarget, string> = {
  github: 'GitHub',
  gitee: 'Gitee',
  webdav: 'WebDAV'
}

/** 币种符号：官方只枚举 CNY / USD，其余原样带上前缀 */
function currencySymbol(currency: string): string
{
  if (currency === 'CNY')
  {
    return '¥'
  }

  if (currency === 'USD')
  {
    return '$'
  }

  return `${currency} `
}

/**
 * DeepSeek 余额（GET /user/balance，官方接口不计费）。
 *
 * 只在 Key 已配置时渲染。查询失败刻意低调处理：余额是附加信息，不该盖过
 * 「Key 是否可用」这个主判断——那个在保存流程里已经用 verify 探过了。
 */
function AiBalanceHint()
{
  const query = useQuery({
    queryKey: ['settings', 'ai-balance'],
    queryFn: () => getAiClient().getBalance(),
    staleTime: 60_000,
    retry: false
  })

  if (query.isPending)
  {
    return (
      <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">正在查询余额…</p>
    )
  }

  if (query.isError)
  {
    return (
      <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
        {query.error instanceof AiAuthError
          ? '余额查询失败：Key 已失效'
          : '余额查询失败：接口暂不可用'}
      </p>
    )
  }

  const { items, isAvailable } = query.data

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-xs)]">
      {items.length === 0 ? (
        <span className="text-[var(--color-text-subtle)]">余额：—</span>
      ) : (
        items.map((item) => (
          <span key={item.currency} className="text-[var(--color-text-muted)]">
            余额
            <b className="ml-1 tabular font-[family-name:var(--font-mono)] text-[var(--color-text)]">
              {currencySymbol(item.currency)}
              {item.total.toFixed(2)}
            </b>
            <span className="ml-1 text-[var(--color-text-subtle)]">
              （赠金 {item.granted.toFixed(2)} / 充值 {item.toppedUp.toFixed(2)}）
            </span>
          </span>
        ))
      )}
      {!isAvailable && (
        <span className="text-[var(--color-forget)]">余额不足，AI 调用会被拒绝</span>
      )}
      <a
        href="https://platform.deepseek.com/usage"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--color-accent)] underline-offset-4 transition-colors hover:underline"
      >
        充值 / 用量 ↗
      </a>
      <button
        type="button"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
        className="text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-text)] hover:underline disabled:opacity-50"
      >
        {query.isFetching ? '刷新中…' : '刷新'}
      </button>
    </div>
  )
}

/**
 * 设置页：墨墨 Token + DeepSeek Key，全部存本机浏览器 localStorage。
 * 保存前先探测可用性（校验通过才保存，失败不覆盖旧值）。
 * 备份为「单一绑定」：一次只启用 GitHub/Gitee/WebDAV 之一，
 * 配置整体存本机（含 WebDAV 密码），重置后才可换用其他方式。
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

  /** 已启用的备份方式；null = 尚未配置，此时才允许三选一 */
  const [binding, setBinding] = useState<BackupBinding | null>(null)
  /** localStorage 只能客户端读：首帧显示占位，避免水合不一致与表单闪现 */
  const [bindingReady, setBindingReady] = useState(false)

  /** 未绑定时的表单草稿：不持久化，切换目标即清空，绝不串到别的方式 */
  const [backupTarget, setBackupTarget] = useState<BackupTarget>('github')
  const [backupToken, setBackupToken] = useState('')
  const [backupRepo, setBackupRepo] = useState('')
  const [webdavUrl, setWebdavUrl] = useState('')
  const [webdavUser, setWebdavUser] = useState('')
  const [webdavPass, setWebdavPass] = useState('')
  const [backupBusy, setBackupBusy] = useState<'backup' | 'restore' | null>(null)
  const [backupNotice, setBackupNotice] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  /** 已拉回、等待用户确认的远端备份 */
  const [restorePending, setRestorePending] = useState<RestoreSource | null>(null)
  /** OAuth 登录是否可用（前端配置了 client_id） */
  const oauthClientId = process.env.NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID ?? ''

  useEffect(
    () =>
    {
      const saved = loadBackupBinding()

      setBinding(saved)

      // 旧版分散 key 只作为草稿预填（WebDAV 旧配置没存密码，需补一次）
      if (!saved)
      {
        const draft = loadLegacyBackupDraft()

        if (draft)
        {
          setBackupTarget(draft.target)
          setBackupToken(draft.token)
          setBackupRepo(draft.repo)
          setWebdavUrl(draft.remoteUrl)
          setWebdavUser(draft.username)
        }
      }

      setBindingReady(true)
    },
    []
  )

  // GitHub OAuth 回调处理：URL 带 code+state 时换 token 并填入草稿
  useEffect(
    () =>
    {
      void handleGithubCallback().then((result) =>
      {
        if (result.token)
        {
          if (loadBackupBinding())
          {
            setBackupError('GitHub 授权成功，但当前已绑定其他备份方式；如需改用 GitHub，请先点「重置配置」。')
            return
          }

          setBackupToken(result.token)
          setBackupTarget('github')
          setBackupNotice('GitHub 授权成功，Token 已填入；点「立即备份」即会保存并锁定该配置。')
        }
        else if (result.message)
        {
          setBackupError(result.message)
        }
      })
    },
    []
  )

  function clearBackupDraft(): void
  {
    setBackupToken('')
    setBackupRepo('')
    setWebdavUrl('')
    setWebdavUser('')
    setWebdavPass('')
  }

  /** 切换目标时清空草稿：Gitee 的 Token/仓库不会带到 GitHub 上 */
  function switchBackupTarget(next: BackupTarget): void
  {
    setBackupTarget(next)
    clearBackupDraft()
    setBackupError(null)
    setBackupNotice(null)
  }

  /** 表单 → 绑定对象；必填不齐时给出提示并返回 null */
  function draftToBinding(): BackupBinding | null
  {
    if (backupTarget === 'webdav')
    {
      const remoteUrl = webdavUrl.trim()
      const username = webdavUser.trim()

      if (!remoteUrl || !username || !webdavPass)
      {
        setBackupError('请填写 WebDAV 服务地址、账号和密码')
        return null
      }

      return { target: 'webdav', remoteUrl, username, password: webdavPass }
    }

    const token = backupToken.trim()
    const repo = backupRepo.trim()

    if (!token || !repo)
    {
      setBackupError('请填写访问 Token 和仓库名')
      return null
    }

    return { target: backupTarget, token, repo }
  }

  /** 本次操作要用的绑定：已绑定直接用；否则校验草稿并立即保存锁定 */
  function activeBinding(): BackupBinding | null
  {
    if (binding)
    {
      return binding
    }

    const draft = draftToBinding()

    if (!draft)
    {
      return null
    }

    saveBackupBinding(draft)
    setBinding(draft)
    clearBackupDraft()
    return draft
  }

  function resetBackupBinding(): void
  {
    if (!window.confirm('重置后会清除本机保存的备份配置（含 WebDAV 密码），云端已有的备份文件不会删除。确定重置吗？'))
    {
      return
    }

    clearBackupBinding()
    setBinding(null)
    setBackupTarget('github')
    clearBackupDraft()
    setBackupError(null)
    setBackupNotice('已重置，可重新选择备份方式。')
  }

  function saveOnly(): void
  {
    setBackupError(null)
    setBackupNotice(null)

    if (activeBinding())
    {
      setBackupNotice('配置已保存并锁定，之后刷新无需重新输入；如需换用其他方式，请先重置。')
    }
  }

  async function runBackup(): Promise<void>
  {
    setBackupError(null)
    setBackupNotice(null)

    const active = activeBinding()

    if (!active)
    {
      return
    }

    setBackupBusy('backup')

    try
    {
      const result = await createBackup(backupBindingToConfig(active))

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

  /**
   * 恢复分两步：先只读远端、把「会写什么」摆出来，用户确认后才动本机。
   *
   * 词库快照是这里唯一会被整体替换的数据，点一下就执行太草率；
   * 先把备份时间与各类数据的规模亮出来，用户才知道自己在恢复哪一份。
   */
  async function prepareRestore(): Promise<void>
  {
    setBackupError(null)
    setBackupNotice(null)
    setRestorePending(null)

    const active = activeBinding()

    if (!active)
    {
      return
    }

    setBackupBusy('restore')

    try
    {
      setRestorePending(await fetchBackup(backupBindingToConfig(active)))
    }
    catch (error)
    {
      setBackupError(
        error instanceof BackupError
          ? error.message
          : `读取远端备份失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    }
    finally
    {
      setBackupBusy(null)
    }
  }

  async function confirmRestore(): Promise<void>
  {
    if (!restorePending)
    {
      return
    }

    setBackupError(null)
    setBackupNotice(null)
    setBackupBusy('restore')

    try
    {
      const result = await restoreBackup(restorePending)

      setBackupNotice(
        `恢复完成（远端备份时间 ${new Date(restorePending.exportedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）：` +
        `诊断合并 ${result.diagnoseMerged} 条 · 词卡补入 ${result.wordCardsMerged} 条` +
        `${result.drillMerged > 0 ? ` · 攻坚合并 ${result.drillMerged} 词` : ''}` +
        `${result.libraryRestored ? ' · 词库快照已写回' : ''}` +
        `${result.librarySkipped ? ' · 词库快照保留本机（本机数据更新）' : ''}` +
        `${result.settingsApplied ? ' · 已采纳远端思考模式' : ''}。刷新页面生效。`
      )
      setRestorePending(null)
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
      // 换了 Key 就要换余额：旧余额属于上一个账号
      void queryClient.invalidateQueries({ queryKey: ['settings', 'ai-balance'] })
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
      // 清掉余额缓存，避免清除 Key 后还显示上一个账号的数字
      queryClient.removeQueries({ queryKey: ['settings', 'ai-balance'] })
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
              <h2 className="text-[length:var(--text-md)] font-semibold">墨墨 Token</h2>
              <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                墨墨 App → 更多设置 → 实验功能 中开启并复制；鉴权失败时重新复制
              </p>
            </div>
          </div>
          {token?.hasToken && !showTokenInput && (
            <button
              type="button"
              onClick={() => setShowTokenInput(true)}
              className="rounded-md border border-[var(--color-border-strong)] px-3.5 py-1.5 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
            >
              重新绑定
            </button>
          )}
        </div>

        {token?.hasToken && !showTokenInput ? (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--color-bg-subtle)] px-4 py-3">
              <p className="flex items-center gap-2 text-[length:var(--text-sm)]">
                <Icon name="check" className="h-4 w-4 text-[var(--color-familiar)]" />
                已绑定 · 鉴权失败时重新复制
              </p>
              <span className="tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                {token.boundAt
                  ? `绑定于 ${new Date(token.boundAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
                  : '绑定时间未记录'}
              </span>
            </div>
            <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              墨墨未公开 Token 过期时间，也没有刷新接口；是否失效以接口返回的鉴权结果为准。
            </p>
            <div className="mt-3">
              <button
                type="button"
                disabled={unbindToken.isPending}
                onClick={() => unbindToken.mutate()}
                className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-forget)] hover:underline"
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
              className="w-full resize-none rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 py-2.5 font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={bindToken.isPending || !tokenInput.trim()}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
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
                  className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-text)]"
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
          <p className="mt-3 flex items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--color-familiar)]">
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
              <h2 className="text-[length:var(--text-md)] font-semibold">DeepSeek API Key</h2>
              <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                在 platform.deepseek.com 获取；AI 诊断与问词都走它
              </p>
            </div>
          </div>
          {hasKey && !showKeyInput && (
            <button
              type="button"
              onClick={() => setShowKeyInput(true)}
              className="rounded-md border border-[var(--color-border-strong)] px-3.5 py-1.5 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
            >
              重新填写
            </button>
          )}
        </div>

        {hasKey && !showKeyInput ? (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--color-bg-subtle)] px-4 py-3">
              <p className="flex items-center gap-2 text-[length:var(--text-sm)]">
                <Icon name="check" className="h-4 w-4 text-[var(--color-familiar)]" />
                已配置
              </p>
              <button
                type="button"
                disabled={clearKey.isPending}
                onClick={() => clearKey.mutate()}
                className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-forget)] hover:underline"
              >
                清除
              </button>
            </div>
            <AiBalanceHint />
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
              className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                type="submit"
                disabled={saveKey.isPending || !keyInput.trim()}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
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
                  className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-text)]"
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
          <p className="mt-3 flex items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--color-familiar)]">
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
              <h2 className="text-[length:var(--text-md)] font-semibold">AI 思考模式</h2>
              <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
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
        <p className="mt-3 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
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
              <h2 className="text-[length:var(--text-md)] font-semibold">数据备份</h2>
              <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                诊断历史、词卡缓存、词库快照备份到你的私有远端；备份包不含登录凭据
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {!bindingReady ? (
            <p className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">读取本机备份配置中…</p>
          ) : binding ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[var(--color-bg-subtle)] px-4 py-3">
                <div>
                  <p className="text-[length:var(--text-sm)] font-medium">
                    当前备份方式：{BACKUP_TARGET_LABELS[binding.target]}
                  </p>
                  <p className="mt-1 break-all font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                    {binding.target === 'webdav'
                      ? `${binding.remoteUrl} · ${binding.username} · 密码已保存`
                      : `${binding.repo} · Token 已保存`}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-familiar)]">
                  <Icon name="check" className="h-4 w-4" />
                  已启用
                </span>
              </div>

              <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
                配置（含 WebDAV 密码）只保存在这台设备的浏览器里，刷新后无需重新输入。三种方式一次只启用一个，如需改用其他方式请先重置。
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={() => void runBackup()}
                  className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                >
                  {backupBusy === 'backup' ? '备份中…' : '立即备份'}
                </button>
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={() => void prepareRestore()}
                  className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
                >
                  {backupBusy === 'restore' ? '恢复中…' : '从云端恢复'}
                </button>
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={resetBackupBinding}
                  className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-forget)] hover:underline"
                >
                  重置配置
                </button>
              </div>
            </>
          ) : (
            <>
              <Segmented
                ariaLabel="备份目标"
                value={backupTarget}
                options={[
                  ['github', 'GitHub'],
                  ['gitee', 'Gitee'],
                  ['webdav', 'WebDAV']
                ]}
                onChange={(next) => switchBackupTarget(next as BackupTarget)}
              />

              {backupTarget === 'webdav' ? (
                <>
                  <input
                    value={webdavUrl}
                    onChange={(event) => setWebdavUrl(event.target.value)}
                    placeholder="服务地址（含目录），如 https://dav.example.com/WebDAV/momo"
                    className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
                  />
                  <div className="flex gap-3">
                    <input
                      value={webdavUser}
                      onChange={(event) => setWebdavUser(event.target.value)}
                      placeholder="账号"
                      autoComplete="off"
                      className="h-10 flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
                    />
                    <input
                      type="password"
                      value={webdavPass}
                      onChange={(event) => setWebdavPass(event.target.value)}
                      placeholder="密码 / 应用密码"
                      autoComplete="new-password"
                      className="h-10 flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
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
                      className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
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
                    className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
                  />
                  <input
                    value={backupRepo}
                    onChange={(event) => setBackupRepo(event.target.value)}
                    placeholder="仓库名，如 bonanliu/momohelper-backup（需提前创建，建议私有）"
                    className="h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
                  />
                  {backupTarget === 'gitee' && (
                    <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
                      Gitee 仓库需至少有一次提交（新建时勾选「使用 Readme 初始化」即可）；备份文件会自动建在 momohelper/ 目录下。
                    </p>
                  )}
                </>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={() => void runBackup()}
                  className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                >
                  {backupBusy === 'backup' ? '备份中…' : '立即备份'}
                </button>
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={() => void prepareRestore()}
                  className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
                >
                  {backupBusy === 'restore' ? '恢复中…' : '从云端恢复'}
                </button>
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={saveOnly}
                  className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-text)] hover:underline"
                >
                  仅保存配置
                </button>
              </div>

              <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
                填写后点任一操作即保存配置并
                <span className="font-medium text-[var(--color-text-muted)]">锁定该方式</span>
                ；刷新无需重新输入（WebDAV 密码也只存本机浏览器）。切换目标会清空当前输入。
              </p>
            </>
          )}

          <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
            备份内容：AI 诊断历史（合并去重）、AI 词卡缓存（只补缺）、顽固词攻坚记录（按词取更新）、词库学习记录快照、思考模式。
            <span className="font-medium text-[var(--color-text-muted)]">不含墨墨 Token 与 DeepSeek Key</span>
            （换设备重新粘贴即可，避免明文凭据上云）。
            {(binding?.target ?? backupTarget) === 'webdav' && ' 若服务不支持跨域，上传会被浏览器拦截，需配置代理后重试。'}
          </p>

          {restorePending && (
            <div className="mt-4 rounded-md border border-[var(--color-info)]/30 bg-[var(--color-info-bg)] p-4">
              <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-info)]">确认从云端恢复？</p>
              <p className="mt-1 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-muted)]">
                远端备份时间 {new Date(restorePending.exportedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                {' · '}词库快照 {(restorePending.payload.librarySnapshot?.records.length ?? 0).toLocaleString('zh-CN')} 词
                {' · '}诊断历史 {restorePending.payload.diagnoseHistory.length} 条
                {' · '}词卡 {Object.keys(restorePending.payload.wordCards ?? {}).length} 张
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-muted)]">
                <li>诊断历史：按时间合并，同一词取更新的一条，不丢本机记录</li>
                <li>词卡缓存：只补本机没有的词</li>
                <li>攻坚记录：同一词取作答更新的一方，助记撤回凭据不会丢</li>
                <li>词库快照：仅当远端更新时覆盖，本机更新则保留本机</li>
                <li>思考模式：本机已配置时不改动</li>
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={() => void confirmRestore()}
                  className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                >
                  {backupBusy === 'restore' ? '恢复中…' : '确认恢复'}
                </button>
                <button
                  type="button"
                  disabled={backupBusy !== null}
                  onClick={() => setRestorePending(null)}
                  className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-text)] hover:underline"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {backupError && (
          <div className="mt-3">
            <ErrorNote message={backupError} />
          </div>
        )}
        {backupNotice && (
          <p className="mt-3 flex items-start gap-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-familiar)]">
            <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
            {backupNotice}
          </p>
        )}
      </Tile>

      <Tile index={4} hover={false} className="mt-4">
        <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          说明：本工具是纯前端应用，你的墨墨 Token 与 DeepSeek Key
          只保存在这台设备的浏览器里。DeepSeek 由浏览器直连；墨墨请求经本站
          同源代理 /api/memo/* 转发，代理只转发、不存储。清除浏览器站点数据会同时清除凭据、备份配置（含 WebDAV 密码）与学习快照。
        </p>
      </Tile>
    </div>
  )
}
