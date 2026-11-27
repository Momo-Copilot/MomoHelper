'use client'

/**
 * `?demo=1` 进入时的引导：把样本数据（快照 / 考试日期）写进 localStorage 再刷新一次。
 *
 * 为什么需要这一步：趋势图、考前推演读的是同步的 localStorage，不能等异步加载。
 * 先落盘再 reload，首帧就是完整数据。
 *
 * 这个入口主要给两件事用：分享一条「直接看演示」的链接、无头浏览器截图。
 */

import { useEffect } from 'react'

import { enterDemo, loadDemoData } from '@/lib/demo'

export function DemoBootstrap()
{
  useEffect(() =>
  {
    if (typeof window === 'undefined')
    {
      return
    }

    if (!window.location.search.includes('demo=1'))
    {
      return
    }

    // 已经写过就不再折腾，避免无限刷新
    if (window.localStorage.getItem('momo.demoSnapshots'))
    {
      return
    }

    let cancelled = false

    loadDemoData()
      .then((demo) =>
      {
        if (cancelled)
        {
          return
        }

        enterDemo()
        window.localStorage.setItem('momo.demoSnapshots', JSON.stringify(demo.dailySnapshots))
        window.localStorage.setItem('momo.demoExamDate', demo.examDate)
        window.location.reload()
      })
      .catch(() => undefined)

    return () =>
    {
      cancelled = true
    }
  }, [])

  return null
}
