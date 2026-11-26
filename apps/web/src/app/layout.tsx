import type { Metadata } from 'next'

import './globals.css'
import { Providers } from './providers'
import { MobileNav, SideNav } from '@/components/side-nav'

export const metadata: Metadata = {
  title: '墨小墨',
  description: '贴着墨墨工作流的学习诊断、内容增强与复盘工具'
}

/**
 * 微软 Clarity 项目 ID（公开标识，不是密钥，写在代码里没有安全风险）。
 *
 * 只在生产构建注入：本地 dev 的点击与录屏不该进线上统计，否则调试一遍
 * 页面就等于往项目里灌一堆噪音。想临时在本地验证脚本是否加载，用
 * `next build` 后看产物，或把下面的判断去掉再跑一次 dev。
 */
const CLARITY_ID = 'zjo7ifza9u'
const CLARITY_ENABLED = process.env.NODE_ENV === 'production'

/**
 * Google Tag Manager 容器 ID。
 *
 * 注意：这里用官方标准 snippet，不是「async src + gtag('js')」那种简化写法。
 * gtm.js 需要 dataLayer 里先有一条 `{ 'gtm.start': 时间戳, event: 'gtm.js' }`
 * 才会触发容器内的 Page View 等触发器；只加载脚本不 push 这条，后台能收到
 * 访问但事件是空的。gtag() 属于 GA4 的 gtag.js，与 GTM 不是一回事，这里不需要。
 *
 * 国内网络下 googletagmanager.com 多数不可达，脚本会静默失败（async 不影响
 * 页面渲染），属于预期现象。
 */
const GTM_ID = 'GTM-MPZSDPSV'
const GTM_ENABLED = process.env.NODE_ENV === 'production'

const GTM_SNIPPET = `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');`

export default function RootLayout({ children }: { children: React.ReactNode })
{
  return (
    <html lang="zh-CN">
      <head>
        <script
          dangerouslySetInnerHTML={{
            /* 首屏定主题：手动选择 > 系统偏好，避免静态 HTML 先白后暗闪烁 */
            __html:
              "(function(){try{var t=localStorage.getItem('momo.theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()"
          }}
        />
        {/* Google Tag Manager：脚本放 head，官方要求的 noscript 兜底在 body 开头 */}
        {GTM_ENABLED && (
          <script
            dangerouslySetInnerHTML={{
              __html: GTM_SNIPPET
            }}
          />
        )}
      </head>
      <body className="min-h-screen">
        {GTM_ENABLED && (
          <noscript
            dangerouslySetInnerHTML={{
              __html: `<iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}" height="0" width="0" style="display:none;visibility:hidden"></iframe>`
            }}
          />
        )}
        <Providers>
          <div className="flex min-h-screen">
            <SideNav />
            <div className="flex min-w-0 flex-1 flex-col">
              <MobileNav />
              <main className="min-w-0 flex-1 px-5 py-8 md:px-10 md:py-10">
                <div className="mx-auto w-full max-w-[1240px]">{children}</div>
              </main>
            </div>
          </div>
        </Providers>

        {/*
         * 微软 Clarity（行为分析 / 录屏）。
         *
         * 用原生 script 而不是 next/script：静态导出下 Script 组件会把内容塞进
         * RSC payload、等客户端 hydration 才注入；直接写标签则随 HTML 一起到达，
         * 更可靠。Clarity 自身的 loader 是 async 动态插标签，不会阻塞首屏。
         *
         * 注意：后台务必开启 Mask all text —— 本站页面含词库、诊断结果等学习内容，
         * 不遮罩的话录屏会把这些文本一并传出去。
         */}
        {CLARITY_ENABLED && (
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(c,l,a,r,i,t,y){
    c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", "${CLARITY_ID}");`
            }}
          />
        )}
      </body>
    </html>
  )
}
