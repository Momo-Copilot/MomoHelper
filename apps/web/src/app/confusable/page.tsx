'use client'

/**
 * 易混词对：找出你词库里「长得像但意思不同」的词，摆在一起看。
 *
 * 为什么需要这个页面：这类词是最隐蔽的失分点——单独背每个词都没问题，
 * 放到句子里认错了却察觉不到。墨墨不提供「混淆词」这个概念，它的诊断枚举里
 * 虽然有个 SPELLING_SIMILAR，但那要逐词调 AI 才能撞见，而且只告诉你「有这毛病」，
 * 不告诉你「跟哪个词混」。
 *
 * 检测完全在前端做（见 lib/similar-words 的 buildConfusablePairs）：
 * 变位签名 + 首字母/长度分桶 + 删字签名，把 O(n²) 压到实测几毫秒。
 * 不调 AI、不发请求，与词库页共享同一份 ['library'] 缓存。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useDeferredValue, useMemo, useState } from 'react'

import type { LibraryRecordRowDto } from '@momo/types'
import { MaimemoAuthError } from '@momo/maimemo'
import { Icon } from '@/components/icons'
import { EmptyTile, ErrorNote, PageHeader, Segmented, Tile, TileSkeleton } from '@/components/kit'
import { ResponseBadge } from '@/components/response-badge'
import { WordCardPopover } from '@/components/word-card'
import { alignDiff, buildConfusablePairs, type ConfusablePair } from '@/lib/similar-words'
import { loadLibrary } from '@/lib/library'
import { MaimemoNotConfiguredError } from '@/lib/maimemo'
import { useRef } from 'react'

const QUERY_KEY = ['library'] as const

type SortKey = 'risk' | 'alpha'

/** 显示多少对：词库越大噪音越多，截断到一个页面能看完的量 */
const DISPLAY_LIMIT = 120

/** 两词差异高亮：不同处标红，相同处淡化 */
function DiffPair({ pair }: { pair: ConfusablePair })
{
  const segments = alignDiff(pair.a, pair.b)

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-[family-name:var(--font-display)] text-[length:var(--text-md)]">
        {segments.map((segment, index) =>
          segment.same ? (
            <span key={index}>{segment.a}</span>
          ) : (
            <span
              key={index}
              className="rounded-sm bg-[var(--color-forget-bg)] px-0.5 font-semibold text-[var(--color-forget)]"
            >
              {segment.a || '∅'}
            </span>
          )
        )}
      </span>
      <span className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">↔</span>
      <span className="font-[family-name:var(--font-display)] text-[length:var(--text-md)]">
        {segments.map((segment, index) =>
          segment.same ? (
            <span key={index}>{segment.b}</span>
          ) : (
            <span
              key={index}
              className="rounded-sm bg-[var(--color-forget-bg)] px-0.5 font-semibold text-[var(--color-forget)]"
            >
              {segment.b || '∅'}
            </span>
          )
        )}
      </span>
    </div>
  )
}

/** 差异类型说明 */
function KindLabel({ pair }: { pair: ConfusablePair })
{
  const meta =
    pair.kind === 'anagram'
      ? { label: '字母相同·顺序不同', className: 'bg-[var(--color-vague-bg)] text-[var(--color-vague)]' }
      : pair.kind === 'affix'
        ? { label: '词干延伸', className: 'bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]' }
        : { label: `差 ${pair.distance} 个字母`, className: 'bg-[var(--color-forget-bg)] text-[var(--color-forget)]' }

  return (
    <span className={`rounded-sm px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium ${meta.className}`}>
      {meta.label}
    </span>
  )
}

/** 可点单词：弹词卡看细节 */
function WordChip({ row }: { row: LibraryRecordRowDto })
{
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <span className="relative inline-flex items-center gap-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="点击查看词条释义"
        className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] underline decoration-[var(--color-border-strong)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]"
      >
        {row.spelling}
      </button>
      <span className="tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
        {row.studyCount} 次
      </span>
      <ResponseBadge value={row.lastResponse} />
      {row.tags.includes('STICKING') && (
        <span className="rounded-sm bg-[var(--color-forget-bg)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-forget)]">
          顽固
        </span>
      )}
      {open && (
        <WordCardPopover
          spelling={row.spelling}
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  )
}

export default function ConfusablePage()
{
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => loadLibrary() })

  const [sortKey, setSortKey] = useState<SortKey>('risk')
  const [minStudy, setMinStudy] = useState(0)
  const [keyword, setKeyword] = useState('')

  const deferredKeyword = useDeferredValue(keyword)

  const records = query.data?.records ?? []

  /** 拼写 → 记录，用于给混淆对补上学习次数与标签 */
  const bySpelling = useMemo(() =>
  {
    const map = new Map<string, LibraryRecordRowDto>()

    for (const row of records)
    {
      if (row.spelling)
      {
        map.set(row.spelling.toLowerCase(), row)
      }
    }

    return map
  }, [records])

  /**
   * 全库混淆对检测。
   *
   * 用 useMemo 缓存：词库不变就不重算。实测 8000 词约几十毫秒，
   * 首次进页面能感觉到一点点延迟，但比每次过滤都重算好得多。
   */
  const pairs = useMemo(() =>
  {
    if (records.length === 0)
    {
      return []
    }

    const spellings = records.map((row) => row.spelling).filter((item): item is string => Boolean(item))

    return buildConfusablePairs(spellings, { minLength: 5, limit: 400 })
  }, [records])

  /** 按「两边都练得多/都容易忘」加权后的清单 */
  const ranked = useMemo(() =>
  {
    const needle = deferredKeyword.trim().toLowerCase()

    return pairs
      .map((pair) =>
      {
        const left = bySpelling.get(pair.a)
        const right = bySpelling.get(pair.b)
        // 风险加权：两边学习次数越多、越容易忘，越值得看
        const study = (left?.studyCount ?? 0) + (right?.studyCount ?? 0)
        const forgets = (left?.lastResponse === 'FORGET' ? 1 : 0) + (right?.lastResponse === 'FORGET' ? 1 : 0)
        const sticking = (left?.tags.includes('STICKING') ? 1 : 0) + (right?.tags.includes('STICKING') ? 1 : 0)
        const risk = pair.score + study * 0.6 + forgets * 12 + sticking * 15

        return { pair, left, right, study, risk }
      })
      .filter((item) => Boolean(item.left) && Boolean(item.right))
      .filter((item) => item.study >= minStudy)
      .filter((item) =>
        needle
          ? item.pair.a.includes(needle) || item.pair.b.includes(needle)
          : true
      )
      .sort((a, b) =>
        sortKey === 'risk' ? b.risk - a.risk : a.pair.a.localeCompare(b.pair.a)
      )
      .slice(0, DISPLAY_LIMIT)
  }, [pairs, bySpelling, minStudy, deferredKeyword, sortKey])

  if (query.isPending)
  {
    return (
      <div>
        <PageHeader title="易混词对" description="正在比对全库拼写…" />
        <TileSkeleton className="mt-4" />
      </div>
    )
  }

  if (query.isError)
  {
    const error = query.error
    const message =
      error instanceof MaimemoNotConfiguredError
        ? '还没有配置墨墨 Token，去设置页绑定后才能读取词库。'
        : error instanceof MaimemoAuthError
          ? '墨墨 Token 已失效，去设置页重新粘贴。'
          : error.message

    return (
      <div>
        <PageHeader title="易混词对" />
        <ErrorNote message={message} />
      </div>
    )
  }

  const riskyCount = ranked.filter((item) => item.study >= 4).length

  return (
    <div>
      <PageHeader
        title="易混词对"
        description="长得像、意思却完全不同的词 —— 单独背都对，放进句子里就认错"
        actions={
          <Link
            href="/library"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            去词库搜词
          </Link>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <Tile index={0} hover={false} className="col-span-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[length:var(--text-sm)]">
                全库 <b className="tabular">{records.length.toLocaleString('zh-CN')}</b> 词中，找到{' '}
                <b className="tabular text-[var(--color-forget)]">{pairs.length}</b> 对高危混淆
              </p>
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                其中 {riskyCount} 对你已经反复练过 —— 练得多还像，说明一直在混着记
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative">
                <Icon
                  name="search"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
                />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="只看含某词的词对"
                  aria-label="筛选词对"
                  className="h-9 w-40 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] pl-9 pr-3 text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none sm:w-52"
                />
              </label>
              <Segmented
                ariaLabel="排序方式"
                value={sortKey}
                options={[
                  ['risk', '按风险'],
                  ['alpha', '字母序']
                ]}
                onChange={(next) => setSortKey(next as SortKey)}
              />
              <Segmented
                ariaLabel="学习次数下限"
                value={String(minStudy)}
                options={[
                  ['0', '全部'],
                  ['4', '练过 4 次+'],
                  ['10', '练过 10 次+']
                ]}
                onChange={(next) => setMinStudy(Number(next))}
              />
            </div>
          </div>
        </Tile>

        {ranked.length === 0 ? (
          <EmptyTile
            index={1}
            title="没有找到混淆词对"
            description="要么词库还不够大，要么你的词都长得很有个性。放宽学习次数下限试试。"
          />
        ) : (
          <Tile index={1} hover={false} className="col-span-12">
            <ul className="divide-y divide-[var(--color-border)]">
              {ranked.map((item, index) => (
                <li key={`${item.pair.a}|${item.pair.b}`} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <DiffPair pair={item.pair} />
                        <KindLabel pair={item.pair} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                        {item.left && <WordChip row={item.left} />}
                        {item.right && <WordChip row={item.right} />}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Tile>
        )}

        <p className="col-span-12 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
          判定方式：纯前端拼写比对，不调 AI。三类信号 ——
          <b>差 1–2 个字母</b>（affect / effect）、
          <b>字母相同但顺序不同</b>（quiet / quite）、
          <b>词干延伸</b>（economic / economical）。
          短于 5 个字母的词不参与（差一字母就换义的噪音太大）。
          排序已把「两边都练过很多遍」的组合提前 —— 练得多还混，才是真的危险。
        </p>
      </div>
    </div>
  )
}
