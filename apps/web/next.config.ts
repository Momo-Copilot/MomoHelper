import { execSync } from 'node:child_process'

import type { NextConfig } from 'next'

/**
 * 静态导出：产物 apps/web/out 交由 EdgeOne Pages 托管；
 * 同源 /api/memo/* 由 edge-functions 下的代理函数处理。
 *
 * 版本号方案：0.<次>.<patch>，patch 取 git 提交总数，每次推送自动 +1。
 * 想升主次版本（里程碑）改下面的 BASE_VERSION，其余不用管。
 *
 * 为什么不用 package.json 的 version：那要靠人记得去 bump，而 EdgeOne 是
 * Git 集成自动部署，提交数天然单调递增，比「记得改」可靠。
 *
 * 发正式版本时可在 CI 里设 NEXT_PUBLIC_APP_VERSION 直接覆盖整个版本号。
 */

/** 主次版本号：功能成型时手动改这里（如 0.1 → 0.2） */
const BASE_VERSION = '0.1'

/**
 * 解析版本号。
 *
 * 浅克隆（depth=1）会让提交数恒为 1，那样每次部署都显示同一个号——所以
 * 检测到 ≤1 时退回「月日」编码（如 1125），至少每天不同。
 */
function resolveVersion(): string
{
  const explicit = process.env.NEXT_PUBLIC_APP_VERSION

  if (explicit)
  {
    return explicit
  }

  try
  {
    const raw = execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    const count = Number.parseInt(raw, 10)

    if (Number.isFinite(count) && count > 1)
    {
      return `${BASE_VERSION}.${count}`
    }
  }
  catch
  {
    // 无 git 环境（CI 检出无 .git），走下面的兜底
  }

  const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const monthDay = (beijing.getUTCMonth() + 1) * 100 + beijing.getUTCDate()

  return `${BASE_VERSION}.${monthDay}`
}

function readBuildInfo(): { version: string; commit: string }
{
  const version = resolveVersion()

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
