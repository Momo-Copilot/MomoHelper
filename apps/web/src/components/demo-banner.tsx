'use client'

/**
 * 演示模式横幅。
 *
 * 必须显眼：访客看到 8614 个单词、267 条诊断记录，很容易以为这就是自己的数据。
 * 所以固定在最顶部，写明「演示数据」并给一个退出入口。
 */

import { useEffect, useState } from 'react'

import { exitDemo, isDemoMode } from '@/lib/demo'

export function DemoBanner()
{
  // 首帧先不渲染，避免服务端（无 localStorage）与客户端不一致
  const [visible, setVisible] = useState(false)

  useEffect(() =>
  {
    setVisible(isDemoMode())
  }, [])

  if (!visible)
  {
    return null
  }

  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[var(--color-accent)]/25 bg-[var(--color-accent-bg)] px-4 py-1.5 text-[length:var(--text-xs)] text-[var(--color-accent)]">
      <span className="font-medium">演示数据</span>
      <span className="text-[var(--color-text-muted)]">
        这 8614 个单词来自一位真实用户的墨墨记录，用于展示分析效果，不是你的数据
      </span>
      <button
        type="button"
        onClick={() =>
        {
          exitDemo()
          window.location.href = '/'
        }}
        className="rounded-sm px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-[var(--color-accent)]/10"
      >
        退出演示
      </button>
    </div>
  )
}
