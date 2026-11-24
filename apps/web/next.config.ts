import { execSync } from 'node:child_process'

import type { NextConfig } from 'next'

/**
 * 静态导出：产物 apps/web/out 交由 EdgeOne Pages 托管；
 * 同源 /api/memo/* 由 edge-functions 下的代理函数处理。
 *
 * 版本号方案：默认用「构建日期」（北京时间 YYYY.MM.DD），配合 git 短 SHA。
 * 每次部署自动更新，不需要手动 bump 任何字段。
 *
 * 想发正式语义版本（比如 1.0.0）时，在 CI 里设 NEXT_PUBLIC_APP_VERSION
 * 即可覆盖，不必改代码。
 *
 * 注意：apps/web/package.json 的 version 不再参与显示——那个字段只留给
 * 包管理器用。以前它被当成版本号来源，结果是「注释说读 package.json，
 * 代码里其实硬编码」，一直显示同一个值。
 */

/** 构建日期，固定按北京时间算，不依赖 CI 机器的时区 */
function buildDateVersion(): string
{
  const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')

  return `${beijing.getUTCFullYear()}.${pad(beijing.getUTCMonth() + 1)}.${pad(beijing.getUTCDate())}`
}

function readBuildInfo(): { version: string; commit: string }
{
  // 环境变量优先（发正式版本时用），否则用构建日期
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? buildDateVersion()

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
