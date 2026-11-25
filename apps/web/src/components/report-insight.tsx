'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { DashboardTodayDto, LibraryStatsDto, ReportSnapshotDto } from '@momo/types'
import { AiAuthError } from '@momo/ai'
import { Icon } from '@/components/icons'
import { Tile } from '@/components/kit'
import { AiNotConfiguredError } from '@/lib/ai'
import {
  buildReportSummary,
  generateReportInsight,
  loadReportInsightCache,
  type ReportInsightCache
} from '@/lib/report-ai'
import { getAiThinkingMode } from '@/lib/settings'

/**
 * 学情 AI 解读（第二步）：指标已由代码算好，AI 只做「读指标 → 写解读」。
 * 按天缓存（localStorage），生成时流式显示；今日数据从看板查询缓存里读，
 * 没有就只带全库指标，不因 AI 解读强迫先开看板。
 */

/** 自下而上找实际滚动容器（overflow-y 可滚且有溢出），找不到就是文档本身 */
function findScrollParent(el: HTMLElement): HTMLElement | null
{
  let node = el.parentElement

  while (node)
  {
    const overflowY = window.getComputedStyle(node).overflowY

    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight > node.clientHeight + 1
    )
    {
      return node
    }

    node = node.parentElement
  }

  const root = document.scrollingElement

  return root instanceof HTMLElement ? root : document.documentElement
}

/** 真实可视区底边：移动端工具栏/手势条不占布局视口（innerHeight） */
function viewportBottom(): number
{
  const vv = window.visualViewport

  return vv ? vv.offsetTop + vv.height : window.innerHeight
}

/** 可视底到正文底边的基础留白：留一截而不是贴边，
 *  移动端地址栏/工具栏收缩会二次改变可视高度，贴边对齐常常差最后十几像素 */
const BASE_RESERVE = 48

/**
 * 把元素底边贴到可视区底部上方（留白），直接改 scrollTop。
 * 不走 scrollIntoView：block/behavior 在各浏览器（尤其老 iOS WebView）语义
 * 不一致，对超过一屏的整段正文也容易判「已可见」而不动。
 *
 * 留白 = max(BASE_RESERVE, 底部被遮挡高度 + BASE_RESERVE)：移动端 innerHeight
 * 包含被工具栏/手势条盖住的区域，只按 innerHeight 对齐会把最后一行盖掉半截。
 * 设置后再用 rAF 校准一帧：地址栏收缩会在同一帧之后才改变可视高度。
 */
function stickToViewportBottom(el: HTMLElement): void
{
  const scroller = findScrollParent(el)

  if (!scroller)
  {
    return
  }

  const align = () =>
  {
    const bottom = viewportBottom()
    const occluded = Math.max(0, window.innerHeight - bottom)
    const reserve = Math.min(200, Math.max(BASE_RESERVE, occluded + BASE_RESERVE))
    const delta = el.getBoundingClientRect().bottom + reserve - bottom

    // 只往下滚（跟随内容增长），已经到位就不再动
    if (delta <= 0.5)
    {
      return
    }

    const max = scroller.scrollHeight - scroller.clientHeight
    scroller.scrollTop = Math.min(scroller.scrollTop + delta, Math.max(0, max))
  }

  align()

  requestAnimationFrame(() =>
  {
    if (el.isConnected)
    {
      align()
    }
  })
}

export function ReportInsightTile({
  report,
  stats,
  truncated
}: {
  report: ReportSnapshotDto
  stats: LibraryStatsDto
  truncated?: { loaded: number; expected: number }
})
{
  const queryClient = useQueryClient()
  const [cached, setCached] = useState<ReportInsightCache | null>(null)
  /** 生成中累积的流式文本（与缓存分开：中途刷新页面丢弃即可） */
  const [streaming, setStreaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needKey, setNeedKey] = useState(false)
  /** 生成期间重读到的思考模式（展示用；每次生成都实时重读） */
  const thinkingRef = useRef(false)
  /** 流式正文的锚点：生成时用它跟随滚动 */
  const bodyRef = useRef<HTMLParagraphElement>(null)
  /** 自动跟随开关：由滚动手势驱动，用户上翻暂停、回到底部附近恢复 */
  const followRef = useRef(true)
  /** 是否经历过一轮生成：结束补对齐只在生成后触发，页面初次渲染不抢滚动 */
  const wasBusyRef = useRef(false)
  /** 底部被工具栏/手势条遮挡的高度：>0 时正文下方要补滚动空间，滚到底才露得出最后一行 */
  const [occludedBottom, setOccludedBottom] = useState(0)

  useEffect(
    () =>
    {
      setCached(loadReportInsightCache())
    },
    []
  )

  // 跟随开关只由滚动手势更新：正文底边距视口底部超过 240px 视为用户
  // 主动上翻（内容自然增长不触发 scroll，不会被误判）。capture 捕获，
  // 滚动发生在任何容器上都收得到。
  useEffect(
    () =>
    {
      const onScroll = () =>
      {
        const el = bodyRef.current

        if (!el)
        {
          return
        }

        followRef.current =
          el.getBoundingClientRect().bottom <= viewportBottom() + 240
      }

      document.addEventListener('scroll', onScroll, { passive: true, capture: true })

      return () => document.removeEventListener('scroll', onScroll, { capture: true })
    },
    []
  )

  const shown = streaming !== null ? streaming : cached?.content

  // 记录底部遮挡高度：布局视口（innerHeight）比可视视口多出来的那块，
  // 就是移动端工具栏/手势条盖住的高度。窗口或可视视口变化时重算。
  useEffect(
    () =>
    {
      const update = () =>
      {
        setOccludedBottom(Math.max(0, Math.round(window.innerHeight - viewportBottom())))
      }

      update()
      window.addEventListener('resize', update)
      window.visualViewport?.addEventListener('resize', update)

      return () =>
      {
        window.removeEventListener('resize', update)
        window.visualViewport?.removeEventListener('resize', update)
      }
    },
    []
  )

  // 流式增量到达：跟随中就把正文底边贴到视口底部
  useEffect(
    () =>
    {
      if (!busy || !shown || !followRef.current)
      {
        return
      }

      const el = bodyRef.current

      if (!el)
      {
        return
      }

      stickToViewportBottom(el)
    },
    [busy, shown]
  )

  // 生成结束：免责声明插入会让下方重新排版，跟随中再对齐一次，
  // 保证结尾（含免责声明）完整可见
  useEffect(
    () =>
    {
      if (busy)
      {
        wasBusyRef.current = true
        return
      }

      if (!wasBusyRef.current)
      {
        return
      }

      wasBusyRef.current = false

      const el = bodyRef.current

      if (!el || !followRef.current)
      {
        return
      }

      stickToViewportBottom(el)
    },
    [busy]
  )

  async function run(): Promise<void>
  {
    setBusy(true)
    setError(null)
    setNeedKey(false)
    setStreaming('')

    // 每次生成前实时重读思考模式（用户可能刚在设置页改过）
    const mode = getAiThinkingMode()

    if (!mode)
    {
      setBusy(false)
      setStreaming(null)
      setNeedKey(false)
      setError('请先到「设置 → AI 思考模式」选择开或关，再生成解读')
      return
    }

    thinkingRef.current = mode === 'on'
    // 用户主动点了生成 = 想看着它长出来，重置跟随开关：
    // 上一次留下（或页面滚动误判）的 false 不能带进新一轮生成
    followRef.current = true

    // 今日数据：读看板查询缓存（['dashboard', 'today']），没有就只带全库指标。
    // 降级快照（dataReliable = false）没有逐词明细，四分项都是未知，不能进摘要——
    // 否则 AI 会把「拿不到数据」写成「今天一个词都没学」。
    const cachedDashboard = queryClient.getQueryData<DashboardTodayDto>(['dashboard', 'today'])
    const dashboard = cachedDashboard?.dataReliable ? cachedDashboard : undefined
    const summary = buildReportSummary(report, stats, dashboard, truncated)

    try
    {
      const result = await generateReportInsight(
        summary,
        report.tier,
        thinkingRef.current,
        (delta) => setStreaming((prev) => (prev ?? '') + delta)
      )

      setCached(result)
      setStreaming(null)
    }
    catch (err)
    {
      setStreaming(null)

      if (err instanceof AiNotConfiguredError)
      {
        setNeedKey(true)
      }
      else if (err instanceof AiAuthError)
      {
        // Key 失效：与「未配置」区分——一个要去填，一个要去换
        setError('DeepSeek Key 已失效或无效，请到「设置」页重新填写')
      }
      else
      {
        setError(err instanceof Error ? err.message : '生成失败，请稍后重试')
      }
    }
    finally
    {
      setBusy(false)
    }
  }

  return (
    <Tile index={6} hover={false} className="col-span-12">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[length:var(--text-sm)] font-medium text-[var(--color-text-muted)]">
          <Icon name="zap" className="h-4 w-4 text-[var(--color-accent)]" />
          AI 解读
          {cached && !busy && (
            <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] font-normal text-[var(--color-text-subtle)]">
              {new Date(cached.at).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Shanghai'
              })}
              {cached.thinking ? ' · 深度思考' : ''}
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-3.5 text-[length:var(--text-xs)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
        >
          <Icon
            name="refresh"
            className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`}
          />
          {cached ? '重新生成' : '生成 AI 解读'}
        </button>
      </div>

      {/* 引导：未配置 Key / 思考模式 */}
      {needKey && (
        <p className="mt-3 text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          尚未配置 DeepSeek API Key，
          <Link
            href="/settings"
            className="underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--color-accent)]"
          >
            去设置页填写
          </Link>
          后回来生成。
        </p>
      )}

      {error && !needKey && (
        <p className="mt-3 rounded-md border border-[var(--color-forget)]/25 bg-[var(--color-forget-bg)] px-3 py-2 text-[length:var(--text-sm)] text-[var(--color-forget)]">
          {error}
        </p>
      )}

      {/* 解读正文：流式显示与缓存共用一个容器 */}
      {shown ? (
        <>
          <p
            ref={bodyRef}
            className="mt-4 whitespace-pre-wrap text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text)]"
          >
            {shown}
            {busy && (
              <span className="ml-0.5 inline-block h-3.5 w-2 animate-pulse bg-[var(--color-accent)] align-middle" />
            )}
          </p>
          {!busy && cached && cached.unverifiedCount > 0 && (
            <p className="mt-3 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              含 {cached.unverifiedCount} 处摘要外数字，已自动标注供核对；解读仅供参考。
            </p>
          )}
          {!busy && cached && cached.unverifiedCount === 0 && (
            <p className="mt-3 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              解读基于上方代码计算的指标生成，数字已核对无超出来源；仅供参考。
            </p>
          )}
          {/* 正文下方补滚动空间（仅底部真有遮挡时）：滚到底时正文下方
              只剩卡片与页边距，不够工具栏的遮挡量，最后一行就露不出来。
              高度随遮挡量自适应，不限生成中——结束移除会让页面收缩又把它遮住 */}
          {occludedBottom > 0 && (
            <div aria-hidden style={{ height: Math.min(280, occludedBottom + 140) }} />
          )}
        </>
      ) : (
        !busy && (
          <p className="mt-4 text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            指标已由代码算好，AI 只负责把数字翻译成判断和行动——生成内容按天缓存，当天可反复查看。
          </p>
        )
      )}
    </Tile>
  )
}
