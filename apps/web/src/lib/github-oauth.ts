/**
 * GitHub OAuth 登录（浏览器侧）。
 *
 * 流程：
 *   1. login() 跳转 GitHub 授权页（state 随机生成存 sessionStorage 防 CSRF）
 *   2. GitHub 带 code 回调到本站回调路径（/settings?oauth=github&code=...&state=...）
 *   3. 页面挂载时 handleCallback() 检测回调参数 → 本函数持 code 调
 *      EdgeOne 函数 /api/github-oauth（secret 在服务端环境变量里）换 access_token
 *   4. token 存 localStorage（momo.backupToken），备份层直接复用
 *
 * Token 类型：GitHub OAuth App 的 user access token 默认不过期（可选开启过期），
 * 本实现按不过期处理；若 App 开启了过期，失败时用户重新登录即可。
 */

const STORAGE_KEY = 'momo.backupToken'
const STATE_KEY = 'momo.oauthState'
/** 备份目标连带切换为 github（OAuth 拿到的 token 就是给 GitHub 备份用的） */
const TARGET_KEY = 'momo.backupTarget'

export interface OAuthCallbackResult
{
  token: string | null
  /** 用户取消或 GitHub 报错时的说明 */
  message: string | null
}

/** 发起登录：跳到 GitHub 授权页 */
export function startGithubLogin(): void
{
  const clientId = process.env.NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID ?? ''

  if (!clientId)
  {
    throw new Error('未配置 GitHub OAuth Client ID（NEXT_PUBLIC_GITHUB_OAUTH_CLIENT_ID）')
  }

  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  sessionStorage.setItem(STATE_KEY, state)

  const redirectUri = `${window.location.origin}/settings`
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo',
    state,
    allow_signup: 'true'
  })

  window.location.assign(`https://github.com/login/oauth/authorize?${params.toString()}`)
}

/**
 * 回调处理：URL 带 code+state 时调用。
 * 校验 state → 调边缘函数换 token → 存 localStorage → 清理 URL 参数。
 * 不是回调场景返回 { token: null, message: null }（页面正常渲染）。
 */
export async function handleGithubCallback(): Promise<OAuthCallbackResult>
{
  if (typeof window === 'undefined')
  {
    return { token: null, message: null }
  }

  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error_description')

  if (oauthError)
  {
    cleanupUrl(url)

    return { token: null, message: `GitHub 授权未完成：${oauthError}` }
  }

  if (!code || !state)
  {
    return { token: null, message: null }
  }

  // state 校验：不匹配可能是 CSRF，拒绝兑换
  const expected = sessionStorage.getItem(STATE_KEY)

  if (!expected || expected !== state)
  {
    cleanupUrl(url)

    return { token: null, message: '授权状态校验失败（state 不匹配），请重新登录' }
  }

  sessionStorage.removeItem(STATE_KEY)
  cleanupUrl(url)

  try
  {
    const res = await fetch('/api/github-oauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: `${window.location.origin}/settings` })
    })
    const data = (await res.json()) as { access_token?: string; error?: string; message?: string }

    if (!res.ok || !data.access_token)
    {
      return {
        token: null,
        message: `换取 token 失败：${data.message ?? data.error ?? `HTTP ${res.status}`}`
      }
    }

    localStorage.setItem(STORAGE_KEY, data.access_token)
    localStorage.setItem(TARGET_KEY, 'github')

    return { token: data.access_token, message: null }
  }
  catch (error)
  {
    return {
      token: null,
      message: `网络错误：${error instanceof Error ? error.message : '无法连接授权服务'}`
    }
  }
}

/** 用完即清 URL 参数，避免刷新页面重复兑换（GitHub code 是一次性的） */
function cleanupUrl(url: URL): void
{
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')

  window.history.replaceState(null, '', url.pathname + url.search)
}
