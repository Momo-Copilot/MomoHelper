'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { DashboardTodayDto, LibraryStatsDto, ReportSnapshotDto } from '@momo/types'
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

  useEffect(
    () =>
    {
      setCached(loadReportInsightCache())
    },
    []
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

    // 今日数据：读看板查询缓存（['dashboard', 'today']），没有就只带全库指标
    const dashboard = queryClient.getQueryData<DashboardTodayDto>(['dashboard', 'today'])
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

  const shown = streaming !== null ? streaming : cached?.content

  return (
    <Tile index={6} hover={false} className="col-span-12">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[var(--text-sm)] font-medium text-[var(--color-text-muted)]">
          <Icon name="zap" className="h-4 w-4 text-[var(--color-accent)]" />
          AI 解读
          {cached && !busy && (
            <span className="font-[family-name:var(--font-mono)] text-[var(--text-xs)] font-normal text-[var(--color-text-subtle)]">
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
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-3.5 text-[var(--text-xs)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
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
        <p className="mt-3 text-[var(--text-sm)] text-[var(--color-text-muted)]">
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
        <p className="mt-3 rounded-md border border-[var(--color-forget)]/25 bg-[var(--color-forget-bg)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-forget)]">
          {error}
        </p>
      )}

      {/* 解读正文：流式显示与缓存共用一个容器 */}
      {shown ? (
        <>
          <p className="mt-4 whitespace-pre-wrap text-[var(--text-sm)] leading-relaxed text-[var(--color-text)]">
            {shown}
            {busy && (
              <span className="ml-0.5 inline-block h-3.5 w-2 animate-pulse bg-[var(--color-accent)] align-middle" />
            )}
          </p>
          {!busy && cached && cached.unverifiedCount > 0 && (
            <p className="mt-3 text-[var(--text-xs)] text-[var(--color-text-subtle)]">
              含 {cached.unverifiedCount} 处摘要外数字，已自动标注供核对；解读仅供参考。
            </p>
          )}
          {!busy && cached && cached.unverifiedCount === 0 && (
            <p className="mt-3 text-[var(--text-xs)] text-[var(--color-text-subtle)]">
              解读基于上方代码计算的指标生成，数字已核对无超出来源；仅供参考。
            </p>
          )}
        </>
      ) : (
        !busy && (
          <p className="mt-4 text-[var(--text-sm)] text-[var(--color-text-muted)]">
            指标已由代码算好，AI 只负责把数字翻译成判断和行动——生成内容按天缓存，当天可反复查看。
          </p>
        )
      )}
    </Tile>
  )
}
