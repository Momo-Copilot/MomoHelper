/**
 * GitHub OAuth 换 token 端点（EdgeOne Edge Functions）。
 *
 * GitHub OAuth App 不支持 PKCE、token 端点不支持 CORS、换 token 必须带
 * client_secret——三者决定了这一步必须有服务端参与。本函数只做一件事：
 * 接收浏览器带回的 code，持 secret 向 GitHub 换 access_token 后原样返回。
 *
 * 环境变量（EdgeOne 控制台配置，不进代码库）：
 *   GITHUB_OAUTH_CLIENT_ID
 *   GITHUB_OAUTH_CLIENT_SECRET
 *
 * 安全说明：
 *   - secret 只存在于环境变量，浏览器与代码库中都不可见
 *   - 本函数无状态、不存储 token；token 只在响应中经过一次本站同源通道
 *   - state 参数由前端生成并校验（防 CSRF），本函数不参与
 *   - 单用户自用工具，未做频率限制；公开部署时应加
 */

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

export default async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)

  // CORS 预检（本站同源一般不触发，保险放行）
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': url.origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      }
    })
  }

  const clientId = context.env?.GITHUB_OAUTH_CLIENT_ID ?? globalThis.GITHUB_OAUTH_CLIENT_ID
  const clientSecret =
    context.env?.GITHUB_OAUTH_CLIENT_SECRET ?? globalThis.GITHUB_OAUTH_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return new Response(
      JSON.stringify({ error: 'server_not_configured', message: '边缘函数缺少 OAuth 环境变量' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  let code = ''
  let redirectUri = ''

  if (request.method === 'POST') {
    try {
      const body = (await request.json()) ?? {}
      code = typeof body.code === 'string' ? body.code : ''
      redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : ''
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  } else {
    // GET 形式：回调页可直接带上 query 参数跳到本函数
    code = url.searchParams.get('code') ?? ''
    redirectUri = url.searchParams.get('redirect_uri') ?? ''
  }

  if (!code) {
    return new Response(JSON.stringify({ error: 'missing_code' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code
  })

  if (redirectUri) {
    params.set('redirect_uri', redirectUri)
  }

  let upstream
  try {
    upstream = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: params.toString()
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'github_network_error', message: String(error) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const data = (await upstream.json().catch(() => null)) ?? {}

  // GitHub 失败时返回 { error, error_description }，成功返回 access_token
  if (data.error) {
    return new Response(
      JSON.stringify({
        error: data.error,
        message: data.error_description ?? 'GitHub 拒绝了这次授权'
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const responseHeaders = new Headers({ 'Content-Type': 'application/json' })
  responseHeaders.set('Access-Control-Allow-Origin', url.origin)
  responseHeaders.set('Vary', 'Origin')
  responseHeaders.set('Cache-Control', 'no-store')

  return new Response(JSON.stringify(data), { status: 200, headers: responseHeaders })
}
