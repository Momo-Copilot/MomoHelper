import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { NextConfig } from 'next'

/**
 * 静态导出：产物 apps/web/out 交由 EdgeOne Pages 托管；
 * 同源 /api/memo/* 由 edge-functions 下的代理函数处理。
 *
 * 版本号方案：semver 来自 package.json（发版手动 bump），
 * 构建时注入当前 git commit 短 SHA，线上可核对代码版本。
 * NEXT_PUBLIC_ 前缀让客户端组件可直接读取。
 */

/**
 * 读本包 package.json 的 version。
 *
 * 这里原本直接写死 '0.1.0'，注释却说「来自 package.json」——于是无论发多少版，
 * 侧栏永远显示 v0.1.0。改成真读，bump package.json 才生效。
 */
function readPackageVersion(): string
{
  try
  {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }

    return pkg.version ?? '0.0.0'
  }
  catch
  {
    // 读不到就退回占位值，不要让构建因此失败
    return '0.0.0'
  }
}

function readBuildInfo(): { version: string; commit: string }
{
  // 优先用 CI 注入的环境变量，否则读 package.json
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? readPackageVersion()

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

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_COMMIT_SHA: commit
  }
}

export default nextConfig
