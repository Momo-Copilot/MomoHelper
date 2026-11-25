import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import type { NextConfig } from 'next'

/**
 * 静态导出：产物 apps/web/out 交由 EdgeOne Pages 托管；
 * 同源 /api/memo/* 由 edge-functions 下的代理函数处理。
 *
 * 版本号方案：apps/web/package.json 的 version 是唯一真相源（semver），
 * 构建期读该文件，EdgeOne Git 集成自动部署无需额外环境变量。
 * 发正式版本时可用 NEXT_PUBLIC_APP_VERSION 覆盖整个版本号。
 *
 * ── 什么时候 bump（重要，别按 commit 数升）─────────────────────────
 * 曾经的做法是「每个提交都动版本号」，结果 3 小时里从 0.2.1 连跳到 0.4.0，
 * 9 个版本号对应 9 个 commit，其中大半是同一模块的连续微调。版本号被
 * 快速烧掉，反而失去「这个版本大概是什么状态」的指示作用。
 *
 * 现在的规则 —— 按「交付批次」bump，不是按提交：
 *   - 一次交付 = 一个功能做完 / 一批修复告一段落，才动一次版本号
 *   - 同一模块连续修补（如配色、间距、单行折行），只在最后那次 bump
 *   - 只改了内部实现、对用户无感的（重构、注释、依赖升级）不 bump
 *   - feat 升 minor；fix/chore/polish 升 patch；里程碑才升 major
 *
 * 小版本号是稀缺资源：0.x 阶段总共有 100 个 patch 位，1.0.0 留给
 * 「核心功能稳定、可对外推荐使用」那一刻，不该被日常微调消耗掉。
 * 需要区分具体代码版本用 git SHA（侧栏已显示），不必靠版本号。
 * ────────────────────────────────────────────────────────────────
 */

/** 从 config 自身位置定位 package.json，避免 EdgeOne 构建 cwd 不同读错文件 */
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

function readBuildInfo(): { version: string; commit: string }
{
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? pkg.version

  let commit = process.env.NEXT_PUBLIC_COMMIT_SHA ?? ''

  if (!commit)
  {
    try
    {
      commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    }
    catch
    {
      // 无 git 环境（如 CI 检出无 .git）时留空，UI 显示 version 即可
      commit = ''
    }
  }

  return { version, commit }
}

const { version, commit } = readBuildInfo()

const isDev = process.env.NODE_ENV === 'development'

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  /**
   * 仅开发环境把 /api/memo/* 转发给墨墨。
   *
   * 线上靠 edge-functions/api/memo/[[default]].js，但那是 EdgeOne 的运行时，
   * `next dev` 不执行它 —— 本地直接请求 /api/memo/* 会 404，表现为「没配 Token」
   * 之外的另一种失败，很容易误判成代码问题。
   *
   * 不能在生产配置里保留 rewrites：`output: 'export'` 与 rewrites 冲突，build 会报错。
   */
  ...(isDev
    ? {
        async rewrites()
        {
          return [
            {
              source: '/api/memo/:path*',
              destination: 'https://open.maimemo.com/open/api/v1/memo/:path*'
            }
          ]
        }
      }
    : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_COMMIT_SHA: commit
  }
}

export default nextConfig
