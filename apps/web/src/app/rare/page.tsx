'use client'

/**
 * 熟词僻义雷达。
 *
 * 原本想按「释义数量 ≥ 3」筛，但官方词库释义不开放（vocabulary 只返回
 * id 和 spelling），用户自建释义又基本都是空的。所以这里改用 AI 诊断的
 * RARE_SENSE 枚举：由 AI 结合学习记录判断「是不是因为只记住了常见意思」。
 *
 * 诊断结果与攻坚台共用同一份本地缓存（momo.drill）——在一个页面诊断过的词，
 * 另一个页面直接能看到，不重复烧 token。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import type { FocusWordDto } from '@momo/types'
import { Icon } from '@/components/icons'
import { PageHeader, Tile, TileSkeleton } from '@/components/kit'
import { diagnoseWord } from '@/lib/ai'
import { loadDrill, recordDiagnosis, saveDrill, type DrillDiagnosis, type DrillStore } from '@/lib/drill'
import { getStickingWords } from '@/lib/maimemo'
import { getAiThinkingMode } from '@/lib/settings'

/** 每批诊断多少个：AI 串行调用，25 个约 1~2 分钟 */
const BATCH = 25

export default function RarePage()
{
  const [store, setStore] = useState<DrillStore>({ words: {} })
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)

  const sticking = useQuery({ queryKey: ['forget', 'sticking'], queryFn: getStickingWords })

  useEffect(
    () =>
    {
      setStore(loadDrill())
      setReady(true)
    },
    []
  )

  const candidates = sticking.data?.words ?? []

  /** 已诊断出「熟词僻义」的词，按学习次数降序——学得越久还记不住越值得看 */
  const rare = useMemo(
    () =>
      candidates
        .map((word) => ({ word, diagnosis: store.words[word.vocId]?.diagnosis }))
        .filter((item): item is { word: FocusWordDto; diagnosis: DrillDiagnosis } =>
          item.diagnosis?.reason === 'RARE_SENSE'
        )
        .sort((a, b) => (b.word.studyCount ?? 0) - (a.word.studyCount ?? 0)),
    [candidates, store]
  )

  const pending = useMemo(
    () =>
      candidates
        .filter((word) => !store.words[word.vocId]?.diagnosis)
        // 学习次数多的先查：学了很多遍还记不住，最可能是「只记住了常见义」。
        // 按接口原顺序（下次复习日期）取批，最可疑的词可能排在两百名开外。
        .sort((a, b) => (b.studyCount ?? 0) - (a.studyCount ?? 0)),
    [candidates, store]
  )

  async function diagnoseBatch(): Promise<void>
  {
    if (busy)
    {
      return
    }

    const targets = pending.slice(0, BATCH)

    if (targets.length === 0)
    {
      return
    }

    setBusy(true)
    setError(null)
    setProgress({ done: 0, total: targets.length })

    try
    {
      const thinking = getAiThinkingMode() === 'on'

      for (let i = 0; i < targets.length; i++)
      {
        const word = targets[i]!
        const result = await diagnoseWord(word.spelling, thinking)

        setStore((prev) =>
        {
          const next = recordDiagnosis(prev, word, {
            reason: result.reason,
            explanation: result.explanation,
            suggestion: result.suggestion,
            at: new Date().toISOString()
          })
          saveDrill(next)
          return next
        })

        setProgress({ done: i + 1, total: targets.length })
      }
    }
    catch (cause)
    {
      setError(
        cause instanceof Error
          ? cause.message
          : '诊断中断了，可能是 AI Key 未配置或接口限流'
      )
      // 出错就别继续连着打接口，让用户先看清原因
      setAuto(false)
    }
    finally
    {
      setBusy(false)
    }
  }

  // 连续诊断：每批跑完自动接下一批，直到没有待诊断的词或用户取消。
  // 依赖里放 pending.length 而不是 pending 本身，避免每次 setStore 都重跑。
  useEffect(
    () =>
    {
      if (!auto || busy || !ready || pending.length === 0)
      {
        return
      }

      void diagnoseBatch()
    },
    [auto, busy, ready, pending.length]
  )

  if (sticking.isPending || !ready)
  {
    return (
      <div>
        <PageHeader title="熟词僻义" description="正在读取顽固词…" />
        <TileSkeleton className="mt-4" />
      </div>
    )
  }

  const diagnosed = candidates.length - pending.length

  return (
    <div>
      <PageHeader
        title="熟词僻义"
        description="你早就「认识」的词，恰恰最危险——考研最爱在这些词上做文章"
        actions={
          <Link
            href="/drill"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            去攻坚台
          </Link>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <Tile index={0} hover={false} className="col-span-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[length:var(--text-sm)]">
                已发现 <b className="text-[var(--color-forget)]">{rare.length}</b> 个熟词僻义
              </p>
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                顽固词 {candidates.length} 个，已诊断 {diagnosed} 个
                {pending.length > 0 && `，还有 ${pending.length} 个没看过`}
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <button
                type="button"
                onClick={() => void diagnoseBatch()}
                disabled={busy || pending.length === 0}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon name="zap" className="h-4 w-4" />
                {busy
                  ? `诊断中 ${progress.done}/${progress.total}`
                  : pending.length === 0
                    ? '全部诊断过了'
                    : `诊断下一批（${Math.min(BATCH, pending.length)} 个）`}
              </button>
              <label className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                <input
                  type="checkbox"
                  checked={auto}
                  disabled={pending.length === 0}
                  onChange={(event) => setAuto(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
                连续诊断（跑完自动接下一批）
              </label>
            </div>
          </div>

          {busy && (
            <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              本批 {progress.total} 个词串行诊断中，每个一次 AI 调用，别关页面。
            </p>
          )}

          {error && (
            <p className="mt-3 rounded-md border border-[var(--color-forget)]/25 bg-[var(--color-forget-bg)] px-3 py-2 text-[length:var(--text-xs)] text-[var(--color-forget)]">
              {error}
            </p>
          )}
        </Tile>

        {rare.length === 0 ? (
          <Tile index={1} hover={false} className="col-span-12 py-12 text-center">
            <Icon name="search" className="mx-auto h-8 w-8 text-[var(--color-text-subtle)]" />
            <p className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
              还没发现熟词僻义
            </p>
            <p className="mx-auto mt-2 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
              {pending.length > 0
                ? '顽固词都还没诊断过。跑一批 AI 分析，它会告诉你哪些词是「只记住了常见意思」。'
                : '所有顽固词都诊断完了，暂时没有因为熟词僻义记不住的。'}
            </p>
          </Tile>
        ) : (
          rare.map((item, index) => (
            <Tile key={item.word.vocId} index={index + 1} hover={false} className="col-span-12 md:col-span-6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-[family-name:var(--font-display)] text-[length:var(--text-xl)] leading-tight">
                    {item.word.spelling}
                  </p>
                  <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                    学习 {item.word.studyCount ?? 0} 次
                    {item.word.lastResponse === 'FORGET' && (
                      <span className="ml-2 text-[var(--color-forget)]">最近答错</span>
                    )}
                  </p>
                </div>
                <span className="shrink-0 rounded-sm bg-[var(--color-forget-bg)] px-2 py-0.5 text-[length:var(--text-xs)] text-[var(--color-forget)]">
                  熟词僻义
                </span>
              </div>

              <p className="mt-3 text-[length:var(--text-sm)] leading-relaxed">
                {item.diagnosis.explanation}
              </p>
              <p className="mt-2 rounded-md bg-[var(--color-bg-subtle)] px-3 py-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-muted)]">
                建议：{item.diagnosis.suggestion}
              </p>
            </Tile>
          ))
        )}

        <p className="col-span-12 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
          判定方式：只覆盖墨墨标为「顽固」的词（不是整个词库——官方不提供释义，无法按释义数量筛），
          按学习次数从高到低逐个调 AI 诊断，原因判为「熟词僻义」的收进这里。诊断结果缓存在本机，
          和攻坚台共用，不会重复消耗额度。
        </p>
      </div>
    </div>
  )
}
