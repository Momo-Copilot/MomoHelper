'use client'

/**
 * 词库页：把 query_study_records 的全量记录摊开看。
 *
 * 三个视图共用同一次全量拉取（IndexedDB 缓存），切换零请求：
 *   掌握度 = study_count / tags / last_response 的分布
 *   时间线 = add_date 与 first_study_date 的月度走势
 *   词表   = 全部 9 个字段逐行浏览
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { MaimemoAuthError, MaimemoRateLimitError } from '@momo/maimemo'
import { Icon } from '@/components/icons'
import { TokenRequired } from '@/components/token-required'
import { PageHeader, Segmented, Tile, TileSkeleton } from '@/components/kit'
import { LibraryIntervalView } from '@/components/library-interval'
import { LibraryStatsView } from '@/components/library-stats'
import { LibraryTableView } from '@/components/library-table'
import { LibraryTimelineView } from '@/components/library-timeline'
import { analyzeIntervals, analyzeLibrary } from '@/lib/analyze'
import { loadLibrary } from '@/lib/library'
import { MaimemoNotConfiguredError } from '@/lib/maimemo'

type ViewKey = 'stats' | 'interval' | 'timeline' | 'table'

const VIEWS: [ViewKey, string][] = [
  ['stats', '掌握度'],
  ['interval', '间隔'],
  ['timeline', '时间线'],
  ['table', '词表']
]

const QUERY_KEY = ['library'] as const

export default function LibraryPage()
{
  const [view, setView] = useState<ViewKey>('stats')
  /** 来自 ?word= 的定位词（词云点击跳进来时用） */
  const [initialWord, setInitialWord] = useState('')
  const [progress, setProgress] = useState<{
    loaded: number
    total: number | null
    /** > 0 表示正在因频控排队，UI 要提示而不是让进度条静止 */
    waitingMs: number
  } | null>(null)
  const queryClient = useQueryClient()

  // 不用 useSearchParams：那要包 Suspense 边界，这里只需首帧带一次定位词。
  // 放在 effect 里读，避免服务端无 window 时与客户端首渲染不一致。
  useEffect(
    () =>
    {
      const word = new URLSearchParams(window.location.search).get('word')?.trim()

      if (word)
      {
        setInitialWord(word)
        setView('table')
      }
    },
    []
  )

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => loadLibrary()
  })

  const refresh = useMutation({
    mutationFn: () =>
      loadLibrary({
        force: true,
        // 每成功拉回一页就把等待标记清掉：进度在动就说明不在排队
        onProgress: (loaded, total) => setProgress({ loaded, total, waitingMs: 0 }),
        onRateLimitWait: (waitMs) =>
          setProgress((prev) => (prev ? { ...prev, waitingMs: waitMs } : prev))
      }),
    onSuccess: (data) =>
    {
      queryClient.setQueryData(QUERY_KEY, data)
      setProgress(null)
    },
    onSettled: () => setProgress(null)
  })

  const records = query.data?.records
  const stats = useMemo(() => (records ? analyzeLibrary(records) : null), [records])
  const intervals = useMemo(() => (records ? analyzeIntervals(records) : null), [records])

  const busy = refresh.isPending && progress !== null
  const refreshLabel = refresh.isPending
    ? progress
      ? progress.waitingMs > 0
        ? `等待频控 ${Math.ceil(progress.waitingMs / 1000)}s（已拉 ${progress.loaded}${progress.total ? ` / ${progress.total}` : ''}）`
        : `拉取中 ${progress.loaded}${progress.total ? ` / ${progress.total}` : ''}`
      : '准备中…'
    : '重新拉取'

  if (query.isPending)
  {
    return (
      <div>
        <PageHeader title="词库" description="正在读取学习记录…" />
        <div className="grid grid-cols-12 gap-4">
          <TileSkeleton className="col-span-12" />
          <TileSkeleton className="col-span-12" />
        </div>
      </div>
    )
  }
  if (query.isError)
  {
    const error = query.error

    // 未配置 / 已失效：统一走 TokenRequired（与今日页同一个组件）
    if (error instanceof MaimemoNotConfiguredError || error instanceof MaimemoAuthError)
    {
      return (
        <TokenRequired
          description={
            error instanceof MaimemoAuthError
              ? '墨墨 Token 已失效或无效，到设置页重新绑定即可恢复；也可以先看演示。'
              : '尚未绑定墨墨 Token，绑定后即可读取全量学习记录；也可以先看演示。'
          }
        />
      )
    }

    return (
        <Tile hover={false} className="mt-16 text-center">
          <Icon name="alert" className="mx-auto h-8 w-8 text-[var(--color-vague)]" />
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
            词库加载失败
          </h1>
          <p className="mx-auto mt-1 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            {error instanceof Error ? error.message : '加载失败，请稍后重试'}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] hover:bg-[var(--color-bg-subtle)]"
            >
              重试
            </button>
          </div>
        </Tile>
    )
  }

  const data = query.data
  const loaded = data.records.length
  const expected = data.total ?? loaded
  const isComplete = data.complete && loaded >= expected
  const wordLabel = isComplete
    ? `${loaded.toLocaleString('zh-CN')} 词`
    : `${loaded.toLocaleString('zh-CN')} / ${expected.toLocaleString('zh-CN')} 词`
  const fetchedLabel = new Date(data.fetchedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  })

  return (
    <div>
      <PageHeader
        title="词库"
        description={`${wordLabel} · 更新于 ${fetchedLabel}`}
        actions={
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[length:var(--text-sm)] shadow-[var(--shadow-tile)] transition-all hover:-translate-y-px hover:shadow-[var(--shadow-tile-hover)] disabled:opacity-50"
          >
            <Icon
              name="refresh"
              className={`h-4 w-4 ${busy || refresh.isPending ? 'animate-spin' : ''}`}
            />
            {refreshLabel}
          </button>
        }
      />

      {!isComplete && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-[var(--color-vague)]/30 bg-[var(--color-vague-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-vague)]">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            只取到 {loaded.toLocaleString('zh-CN')} 条，接口总数 {expected.toLocaleString('zh-CN')}
            条。差额多为未安排复习的词（没有 next_study_date）——日期区间查询覆盖不到这类词，
            不是请求失败。以下统计仅覆盖已进入复习计划的词。
          </span>
        </p>
      )}

      {refresh.isError && (
        <p className="mb-4 rounded-md border border-[var(--color-forget)]/25 bg-[var(--color-forget-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-forget)]">
          {refresh.error instanceof MaimemoRateLimitError ? (
            <>
              触发了墨墨的请求频控。已经拉到的部分已经存下来了，等 1 分钟再点「重新拉取」会从断点继续，不用从头再来。
            </>
          ) : (
            <>重新拉取失败：{refresh.error.message}</>
          )}
        </p>
      )}

      <div className="mb-4">
        <Segmented
          ariaLabel="词库视图"
          value={view}
          options={VIEWS}
          onChange={(next) => setView(next)}
        />
      </div>

      {stats && view === 'stats' && <LibraryStatsView stats={stats} />}
      {intervals && view === 'interval' && <LibraryIntervalView data={intervals} />}
      {stats && view === 'timeline' && <LibraryTimelineView months={stats.months} />}
      {view === 'table' && (
        <Tile hover={false}>
          <LibraryTableView records={data.records} initialKeyword={initialWord} />
        </Tile>
      )}
    </div>
  )
}
