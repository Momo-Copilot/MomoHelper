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
 * 读应用包的 version。
 *
 * 不能假设构建命令在哪个目录执行：EdgeOne Pages 可能从仓库根跑 `pnpm build`，
 * 也可能先 `cd apps/web`。前者如果直接读 `cwd/package.json`，拿到的是根包
 * （version 0.0.0），版本号就会静默变成 0.0.0。所以两个路径都试，并且用
 * name 字段确认读到的是应用包本身，而不是根包或别的 workspace 包。
 */
function readPackageVersion(): string
{
  const candidates = [
    join(process.cwd(), 'package.json'),
    join(process.cwd(), 'apps', 'web', 'package.json')
  ]

  for (const file of candidates)
  {
    try
    {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string }

      if (pkg.name === '@momo/web')
      {
        return pkg.version ?? '0.0.0'
      }
    }
    catch
    {
      // 文件不存在或不是合法 JSON，试下一个
    }
  }

  // 读不到就退回占位值，不要让构建因此失败
  return '0.0.0'
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
