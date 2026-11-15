/**
 * WebDAV 通用转发代理（EdgeOne Edge Functions）。
 *
 * 为什么需要：多数 WebDAV 服务（坚果云等）不允许任意站点跨域直连，
 * 浏览器 PUT/GET/MKCOL/PROPFIND 会被 CORS 拦截。本函数在同源域名下
 * 提供转发层：前端请求 /api/webdav?url=<目标>&method=<方法>，
 * 由边缘节点以服务端身份转发给 WebDAV 服务。
 *
 * 鉴权：前端把 WebDAV 账号密码放 Authorization 头（Basic），本函数原样透传。
 * 凭据只存在于用户浏览器 localStorage，不在本函数落地、不入日志。
 *
 * 安全：
 *   - 只允许 http/https 目标
 *   - 响应加 Access-Control-Allow-Origin 同源白名单（本站 origin）
 *   - 不做 SSRF 防护的黑名单（内网地址）——单用户自用工具，配置由用户本人输入；
 *     如后续开放多用户，须补内网地址过滤
 */

export default async function onRequest(context) {
  const { request } = context

  const url = new URL(request.url)

  // OPTIONS 预检：本站同源请求一般不会触发，但保险起见直接放行
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': url.origin,
        'Access-Control-Allow-Methods': 'GET, PUT, MKCOL, DELETE, PROPFIND, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth',
        'Access-Control-Max-Age': '86400'
      }
    })
  }

  const target = url.searchParams.get('url')
  const method = (url.searchParams.get('method') ?? request.method).toUpperCase()

  if (!target) {
    return new Response(JSON.stringify({ error: 'missing url param' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  let targetUrl
  try {
    targetUrl = new URL(target)
  } catch {
    return new Response(JSON.stringify({ error: 'invalid url' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return new Response(JSON.stringify({ error: 'only http/https allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // 透传请求体（PUT 有 body；GET/MKCOL/PROPFIND 无）
  let body
  if (method !== 'GET' && method !== 'HEAD' && method !== 'MKCOL') {
    body = await request.text().catch(() => undefined)
  }

  const headers = new Headers()
  const auth = request.headers.get('Authorization')
  if (auth) {
    headers.set('Authorization', auth)
  }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  // PROPFIND 需要 Depth 头（列目录用，本工具目前只 PUT/GET/MKCOL，预留）
  const depth = request.headers.get('Depth')
  if (depth) {
    headers.set('Depth', depth)
  }

  let upstream
  try {
    upstream = await fetch(targetUrl.toString(), {
      method,
      headers,
      body,
      redirect: 'follow'
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'webdav_network_error', message: String(error) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // 透传响应体与状态码，补同源 CORS 头
  const upstreamBody = await upstream.text()
  const responseHeaders = new Headers()
  const contentType = upstream.headers.get('Content-Type')
  if (contentType) {
    responseHeaders.set('Content-Type', contentType)
  }
  const etag = upstream.headers.get('ETag')
  if (etag) {
    responseHeaders.set('ETag', etag)
  }
  responseHeaders.set('Access-Control-Allow-Origin', url.origin)
  responseHeaders.set('Vary', 'Origin')

  return new Response(upstreamBody, {
    status: upstream.status,
    headers: responseHeaders
  })
}
