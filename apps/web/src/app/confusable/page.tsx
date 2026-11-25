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
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import type { LibraryRecordRowDto } from '@momo/types'
import { MaimemoAuthError } from '@momo/maimemo'
import { Icon } from '@/components/icons'
import { EmptyTile, ErrorNote, PageHeader, Segmented, Tile, TileSkeleton } from '@/components/kit'
import { WordCardPopover } from '@/components/word-card'
import { alignDiff, buildConfusablePairs, type ConfusablePair, type DiffSegment } from '@/lib/similar-words'
import { loadLibrary } from '@/lib/library'
import { MaimemoNotConfiguredError } from '@/lib/maimemo'

const QUERY_KEY = ['library'] as const

type SortKey = 'risk' | 'alpha'

/**
 * 首次渲染多少对、每次「显示更多」追加多少对。
 *
 * 只控制渲染量，不参与统计：顶部数字始终反映真实检测结果，
 * 否则会出现「说找到 400 对、列表只有 120 条」的自相矛盾。
 */
const DISPLAY_STEP = 120

/**
 * 词对的一侧：差异高亮 + 学习数据合成一处。
 *
 * 早先这里是两个组件——DiffPair 画高亮、WordChip 画次数与标签，
 * 结果每个词在同一张卡里出现两遍，一张卡要吃四行，留白浪费严重。
 * 合并后每个词只出现一次，一对词压到一行内。
 */
function PairSide({
  segments,
  side,
  row
}: {
  segments: DiffSegment[]
  side: 'a' | 'b'
  row?: LibraryRecordRowDto
})
{
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (!row)
  {
    return null
  }

  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="点击查看词条释义"
        className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] underline decoration-[var(--color-border-strong)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]"
      >
        {segments.map((segment, index) =>
          segment.same ? (
            <span key={index}>{segment[side]}</span>
          ) : (
            <span
              key={index}
              className="rounded-sm bg-[var(--color-forget-bg)] px-0.5 font-semibold text-[var(--color-forget)]"
            >
              {segment[side] || '∅'}
            </span>
          )
        )}
      </button>
      {/*
       * 次数与圆点绑成一个 nowrap 整体：分开时圆点会被单独挤到第二行
       * （commodity 63 ● 恰好比一列宽几个像素，flex-wrap 就把它拆了）。
       */}
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
        <span className="tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
          {row.studyCount}
        </span>
        <ResponseDot value={row.lastResponse} />
      </span>
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

/** 差异类型说明 */
function KindLabel({ pair }: { pair: ConfusablePair })
{
  /**
   * 标签压到 2–4 个汉字：完整说法挂在 title 上。
   * 原来写「字母相同·顺序不同」占 90px，卡片里塞不下两个词 + 两处标记，
   * 结果每条都折成两行，两列布局的密度优势被抵消掉一半。
   */
  const meta =
    pair.kind === 'anagram'
      ? {
          label: '颠倒',
          title: '字母相同，只是顺序不同',
          className: 'bg-[var(--color-vague-bg)] text-[var(--color-vague)]'
        }
      : pair.kind === 'affix'
        ? {
            label: '词干',
            title: '一个是另一个的词干延伸',
            className: 'bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]'
          }
        : {
            label: `差${pair.distance}`,
            title: `拼写相差 ${pair.distance} 个字母`,
            className: 'bg-[var(--color-forget-bg)] text-[var(--color-forget)]'
          }

  return (
    <span
      title={meta.title}
      className={`shrink-0 rounded-sm px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  )
}

/**
 * 作答状态圆点：纯色小点，含义由列表顶部的图例说明。
 *
 * 列表里不写字，避免每张卡被「认/模/忘」撑宽或挤到第二行；
 * 图例承担解释职责，所以这里必须保证颜色与图例完全一致。
 */
function ResponseDot({ value }: { value?: string | null })
{
  const meta =
    value === 'FORGET'
      ? { color: 'var(--color-forget)', label: '忘记' }
      : value === 'VAGUE'
        ? { color: 'var(--color-vague)', label: '模糊' }
        : value === 'FAMILIAR'
          ? { color: 'var(--color-familiar)', label: '认识' }
          : null

  if (!meta)
  {
    return null
  }

  return (
    <span
      title={meta.label}
      aria-label={meta.label}
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: meta.color }}
    />
  )
}

export default function ConfusablePage()
{
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => loadLibrary() })

  const [sortKey, setSortKey] = useState<SortKey>('risk')
  const [minStudy, setMinStudy] = useState(0)
  const [keyword, setKeyword] = useState('')
  /** 当前渲染多少对：切换筛选条件时回到首屏量，避免一次刷出几千条 */
  const [visibleCount, setVisibleCount] = useState(DISPLAY_STEP)

  const deferredKeyword = useDeferredValue(keyword)

  /** 筛选条件变化时重置分页，避免沿用上一次「显示更多」累积的条数 */
  useEffect(() =>
  {
    setVisibleCount(DISPLAY_STEP)
  }, [sortKey, minStudy, deferredKeyword])

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
   *
   * limit 设为 Infinity：这里要的是「真实有多少对」，先截断再统计会
   * 让顶部数字永远卡在上限（曾经写成 400，于是词库再大也只显示 400）。
   * 渲染量由下面的 visibleCount 单独控制。
   */
  const pairs = useMemo(() =>
  {
    if (records.length === 0)
    {
      return []
    }

    const spellings = records.map((row) => row.spelling).filter((item): item is string => Boolean(item))

    return buildConfusablePairs(spellings, { minLength: 5, limit: Number.POSITIVE_INFINITY })
  }, [records])

  /** 按「两边都练得多/都容易忘」加权后的全量清单（不截断，供统计与分页共用） */
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
  }, [pairs, bySpelling, minStudy, deferredKeyword, sortKey])

  /** 实际渲染的子集：只在渲染层截断，统计始终走全量 ranked */
  const visible = ranked.slice(0, visibleCount)

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
  const hasFilter = minStudy > 0 || deferredKeyword.trim().length > 0

  /**
   * 覆盖度：墨墨只返回已安排复习（有 next_study_date）的词，
   * 接口总数往往大于实际取到的条数。用「已读取」而不是「全库」，
   * 再补一行说明缺的那部分查不到，避免把结论说成覆盖全部词库。
   */
  const loaded = records.length
  const expected = query.data?.total ?? loaded
  const isComplete = (query.data?.complete ?? false) && loaded >= expected

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
        {!isComplete && (
          <p className="col-span-12 flex items-start gap-2 rounded-md border border-[var(--color-vague)]/30 bg-[var(--color-vague-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-vague)]">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              只取到 {loaded.toLocaleString('zh-CN')} 条，接口总数 {expected.toLocaleString('zh-CN')}
              条。差额多为未安排复习的词（没有 next_study_date），墨墨接口暂不提供按此筛选的查询，
              易混词检测只覆盖已进入复习计划的词。
            </span>
          </p>
        )}

        <Tile index={0} hover={false} className="col-span-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[length:var(--text-sm)]">
                已读取 <b className="tabular">{loaded.toLocaleString('zh-CN')}</b> 词中，找到{' '}
                <b className="tabular text-[var(--color-forget)]">{ranked.length.toLocaleString('zh-CN')}</b>{' '}
                对高危混淆
                {hasFilter && (
                  <span className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                    （已按当前筛选条件统计）
                  </span>
                )}
              </p>
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                其中 <b className="tabular">{riskyCount.toLocaleString('zh-CN')}</b> 对你已经反复练过（两边合计 ≥ 4 次）
                —— 练得多还像，说明一直在混着记
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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                当前显示 {visible.length.toLocaleString('zh-CN')} / {ranked.length.toLocaleString('zh-CN')} 对
              </p>
              {/* 图例：列表里只有圆点，含义全靠这里说明 */}
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                <span className="text-[var(--color-text-muted)]">词后数字=学习次数</span>
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: 'var(--color-familiar)' }}
                  />
                  认识
                </span>
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: 'var(--color-vague)' }}
                  />
                  模糊
                </span>
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: 'var(--color-forget)' }}
                  />
                  忘记
                </span>
              </p>
            </div>
            {/*
             * 两列紧凑排布：每对只占一个小卡。
             * 用 auto-fill + minmax 而不是固定断点：左侧 248px 侧栏会吃掉视口宽度，
             * 按视口写的 xl:grid-cols-2 在 1280 屏下内容区只有 ~950px，
             * 容易出现「明明够宽却还是单列」。auto-fill 直接按真实可用宽度决定列数，
             * 宽屏自动两列、窄屏自动回落单列，不需要维护断点。
             *
             * 下限 360px：标记改回圆点后单侧只需约 130px，比 400px 更省横向空间，
             * 1280 屏下仍稳定两列。
             */}
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
              {visible.map((item, index) =>
              {
                const segments = alignDiff(item.pair.a, item.pair.b)

                return (
                  <li
                    key={`${item.pair.a}|${item.pair.b}`}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2"
                  >
                    {/*
                     * 三栏对称：左词 / 箭头 / 右词；类型标签固定在最右。
                     * 用 grid 而不是 flex-wrap：长词在各自栏内换行，箭头永远停在正中
                     * （flex-wrap 时箭头会悬在行尾，两个词上下错开，读起来像断句）。
                     * 标签单独占一列，无论词多长都对齐在同一处。
                     */}
                    <div className="flex items-start gap-2">
                      <span className="tabular mt-0.5 shrink-0 font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-start gap-x-2">
                        <PairSide segments={segments} side="a" row={item.left} />
                        <span className="text-[length:var(--text-xs)] leading-5 text-[var(--color-text-subtle)]">↔</span>
                        <PairSide segments={segments} side="b" row={item.right} />
                      </div>
                      <KindLabel pair={item.pair} />
                    </div>
                  </li>
                )
              })}
            </ul>
            {visible.length < ranked.length && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + DISPLAY_STEP)}
                  className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
                >
                  再显示 {Math.min(DISPLAY_STEP, ranked.length - visible.length)} 对
                </button>
              </div>
            )}
          </Tile>
        )}

        <p className="col-span-12 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
          判定方式：纯前端拼写比对，不调 AI。右侧标签表示差异类型 ——
          <b>差N</b> 是拼写相差 N 个字母（affect / effect）、
          <b>颠倒</b> 是字母相同仅顺序不同（quiet / quite）、
          <b>词干</b> 是一个词是另一个的词干延伸（economic / economical）。
          短于 5 个字母的词不参与（差一字母就换义的噪音太大）。
          排序已把「两边都练过很多遍」的组合提前 —— 练得多还混，才是真的危险。
        </p>
      </div>
    </div>
  )
}
