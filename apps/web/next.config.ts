import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import type { NextConfig } from 'next'

/**
 * 静态导出：产物 apps/web/out 交由 EdgeOne Pages 托管；
 * 同源 /api/memo/* 由 edge-functions 下的代理函数处理。
 *
 * 版本号方案：apps/web/package.json 的 version 是唯一真相源（semver）。
 * 改代码时按性质手动 bump：feat 升 minor、fix/chore 升 patch、里程碑升 major。
 * 构建期读该文件，EdgeOne Git 集成自动部署无需额外环境变量。
 * 发正式版本时可用 NEXT_PUBLIC_APP_VERSION 覆盖整个版本号。
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

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_COMMIT_SHA: commit
  }
}

export default nextConfig
