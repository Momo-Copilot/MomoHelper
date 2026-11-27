'use client'

/**
 * 词库 · 词表浏览器。
 *
 * 8000+ 词在前端内存里过滤/排序，不分页请求接口：
 * 搜索（单词或 voc_id）、标签筛选、四种排序、每页 100 行本地分页。
 * 字段覆盖接口返回的全部 9 项，列多时横向滚动，voc_id 放最后。
 */

import { useDeferredValue, useMemo, useRef, useState } from 'react'

import type { LibraryRecordRowDto } from '@momo/types'
import { Segmented } from '@/components/kit'
import { Icon } from '@/components/icons'
import { ResponseBadge } from '@/components/response-badge'
import { WordButton } from '@/components/word-button'
import { beijingDayOf } from '@/lib/analyze'
import { alignDiff, findSimilarWords, type SimilarWord } from '@/lib/similar-words'

const PAGE_SIZE = 100

type TagFilter = 'all' | 'sticking' | 'familiar'
type SortKey = 'next' | 'count' | 'added' | 'alpha'

const SORT_OPTIONS: [SortKey, string][] = [
  ['next', '下次复习'],
  ['count', '学习次数'],
  ['added', '加入时间'],
  ['alpha', '字母序']
]

const TAG_META: Record<string, { label: string; className: string }> = {
  STICKING: {
    label: 'STICKING',
    className: 'bg-[var(--color-forget-bg)] text-[var(--color-forget)]'
  },
  WELL_FAMILIAR: {
    label: 'FAMILIAR',
    className: 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]'
  }
}

/** 日期比较：空值永远排最后（「没有下次复习」不该挤在最前面） */
function compareDate(a?: string, b?: string, direction: 'asc' | 'desc' = 'asc'): number
{
  if (!a && !b)
  {
    return 0
  }

  if (!a)
  {
    return 1
  }

  if (!b)
  {
    return -1
  }

  return direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
}

const SORTERS: Record<SortKey, (a: LibraryRecordRowDto, b: LibraryRecordRowDto) => number> = {
  next: (a, b) => compareDate(a.nextStudyDate, b.nextStudyDate, 'asc'),
  count: (a, b) => b.studyCount - a.studyCount,
  added: (a, b) => compareDate(a.addDate, b.addDate, 'desc'),
  alpha: (a, b) => (a.spelling ?? '').localeCompare(b.spelling ?? '', 'en')
}

/** 可点击单词：点按弹词卡（与遗忘词页一致），点其他位置自动关闭 */

/** 相似度类型标签：告诉用户这一条是「差字母」还是「顺序不同」 */
function SimilarityTag({ kind }: { kind: SimilarWord['kind'] })
{
  const meta =
    kind === 'anagram'
      ? { label: '顺序', title: '字母相同，顺序不同', className: 'bg-[var(--color-vague-bg)] text-[var(--color-vague)]' }
      : kind === 'affix'
        ? { label: '词干', title: '一个是另一个的词干延伸', className: 'bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]' }
        : { label: '近似', title: '差 1–2 个字母', className: 'bg-[var(--color-forget-bg)] text-[var(--color-forget)]' }

  return (
    <span
      title={meta.title}
      className={`shrink-0 rounded-sm px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  )
}

function DayCell({ value }: { value?: string })
{
  const day = beijingDayOf(value)

  return day ? (
    <span className="whitespace-nowrap tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-muted)]">
      {day}
    </span>
  ) : (
    <span className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">—</span>
  )
}

/** 两词差异高亮：不同处标红加粗，相同处保持原样 */
function DiffText({ word, target }: { word: string; target: string })
{
  const segments = alignDiff(target, word)

  return (
    <span className="font-[family-name:var(--font-display)] tabular">
      {segments.map((segment, index) =>
        segment.same ? (
          <span key={index}>{segment.b}</span>
        ) : (
          <span
            key={index}
            className="rounded-sm bg-[var(--color-forget-bg)] px-0.5 font-semibold text-[var(--color-forget)]"
          >
            {segment.b}
          </span>
        )
      )}
    </span>
  )
}

function PageButton({
  children,
  disabled,
  onClick
}: {
  children: React.ReactNode
  disabled: boolean
  onClick: () => void
})
{
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-3 text-[length:var(--text-xs)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

export function LibraryTableView({
  records,
  initialKeyword = ''
}: {
  records: LibraryRecordRowDto[]
  /** 从词云等入口带过来的定位词：直接填进搜索框 */
  initialKeyword?: string
})
{
  const [keyword, setKeyword] = useState(initialKeyword)
  const [tagFilter, setTagFilter] = useState<TagFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('next')
  const [page, setPage] = useState(0)
  /** 模糊搜索：拼不准时也能找到「长得像」的词 */
  const [fuzzy, setFuzzy] = useState(false)

  // 8000 条过滤 + 排序放 deferred：输入时不掉帧
  const deferredKeyword = useDeferredValue(keyword)

  // 模糊搜索的候选词表：只取拼写，喂给相似度算法（8000 词实测 6–13ms）
  const spellings = useMemo(
    () => records.map((row) => row.spelling ?? '').filter(Boolean),
    [records]
  )

  /**
   * 模糊模式下的相似词。
   *
   * 与精确搜索互斥：精确模式找「包含这个片段的词」，模糊模式找「长得像这个词的词」。
   * 两者同时生效会让结果含义混乱，所以开关是二选一。
   */
  const similar = useMemo<SimilarWord[]>(() =>
  {
    if (!fuzzy || deferredKeyword.trim().length < 3)
    {
      return []
    }

    return findSimilarWords(deferredKeyword, spellings, 20)
  }, [fuzzy, deferredKeyword, spellings])

  const filtered = useMemo(() =>
  {
    const needle = deferredKeyword.trim().toLowerCase()

    let rows = records

    if (needle)
    {
      rows = fuzzy
        ? // 模糊模式：按相似度排序的候选词（而不是子串包含）
          similar
            .map((item) => rows.find((row) => (row.spelling ?? '').toLowerCase() === item.candidate))
            .filter((row): row is LibraryRecordRowDto => Boolean(row))
        : rows.filter((row) => (row.spelling ?? '').toLowerCase().includes(needle))
    }

    if (tagFilter === 'sticking')
    {
      rows = rows.filter((row) => row.tags.includes('STICKING'))
    }
    else if (tagFilter === 'familiar')
    {
      rows = rows.filter((row) => row.tags.includes('WELL_FAMILIAR'))
    }

    // 模糊模式保序（相似度已由 similar 排好），再排序会把「最像的」打乱
    return fuzzy && needle ? [...rows] : [...rows].sort(SORTERS[sortKey])
  }, [records, deferredKeyword, tagFilter, sortKey, fuzzy, similar])

  /** 模糊模式下每行显示差异高亮要用的目标词 */
  const diffTarget = fuzzy && deferredKeyword.trim().length >= 3 ? deferredKeyword.trim().toLowerCase() : null
  const similarMap = useMemo(() =>
  {
    const map = new Map<string, SimilarWord>()

    for (const item of similar)
    {
      map.set(item.candidate, item)
    }

    return map
  }, [similar])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
          />
          <input
            value={keyword}
            onChange={(event) =>
            {
              setKeyword(event.target.value)
              setPage(0)
            }}
            placeholder={fuzzy ? '拼不准也能搜，如 efect / quite' : '搜索单词'}
            aria-label="搜索单词"
            className="h-9 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] pl-9 pr-3 text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
            {
              setFuzzy(!fuzzy)
              setPage(0)
            }}
            aria-pressed={fuzzy}
            title="相似词搜索：按编辑距离与字母顺序找「长得像」的词"
            className={
              fuzzy
                ? 'inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]'
                : 'inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-3 text-[length:var(--text-sm)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
            }
          >
            <Icon name="swap" className="h-4 w-4" />
            相似词
          </button>
          <Segmented
            ariaLabel="标签筛选"
            value={tagFilter}
            options={[
              ['all', '全部'],
              ['sticking', '顽固'],
              ['familiar', '熟词']
            ]}
            onChange={(next) =>
            {
              setTagFilter(next as TagFilter)
              setPage(0)
            }}
          />
          <Segmented
            ariaLabel="排序方式"
            value={sortKey}
            options={SORT_OPTIONS}
            onChange={(next) =>
            {
              setSortKey(next as SortKey)
              setPage(0)
            }}
          />
        </div>
      </div>

      {fuzzy && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-[var(--color-accent-bg)] px-3 py-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-muted)]">
          <Icon name="swap" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span>
            相似词模式：按拼写相似度找词，
            <span className="rounded-sm bg-[var(--color-forget-bg)] px-1 font-semibold text-[var(--color-forget)]">
              标红
            </span>
            处是与「{deferredKeyword.trim() || '输入'}」不同的字母。结果按相似度排序，
            与精确搜索互斥。
          </span>
        </p>
      )}

      <div className="mt-4 overflow-x-auto rounded-md border border-[var(--color-border)]">
        <table className="w-max min-w-full border-collapse text-left">
          <thead>
            <tr className="whitespace-nowrap bg-[var(--color-bg-subtle)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              <th className="w-12 px-3 py-2.5 font-normal">#</th>
              <th className="px-3 py-2.5 font-normal">单词</th>
              <th className="w-20 px-3 py-2.5 text-right font-normal" title="study_count">
                学习次数
              </th>
              <th className="w-24 px-3 py-2.5 text-center font-normal" title="last_response">
                最近作答
              </th>
              <th className="w-28 px-3 py-2.5 font-normal">标签</th>
              <th className="w-28 px-3 py-2.5 font-normal" title="add_date">
                加入日期
              </th>
              <th className="w-28 px-3 py-2.5 font-normal" title="first_study_date">
                首学日期
              </th>
              <th className="w-28 px-3 py-2.5 font-normal" title="last_study_date">
                最近学习
              </th>
              <th className="w-28 px-3 py-2.5 font-normal" title="next_study_date">
                下次复习
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-10 text-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]"
                >
                  没有符合条件的词。
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={row.vocId}
                  className="border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-bg-subtle)]"
                >
                  <td className="px-3 py-2 tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                    {safePage * PAGE_SIZE + i + 1}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      {diffTarget ? (
                        <WordButton spelling={row.spelling} render={(word) => <DiffText word={word} target={diffTarget} />} />
                      ) : (
                        <WordButton spelling={row.spelling} />
                      )}
                      {similarMap.get((row.spelling ?? '').toLowerCase()) && (
                        <SimilarityTag kind={similarMap.get((row.spelling ?? '').toLowerCase())!.kind} />
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular font-[family-name:var(--font-mono)] text-[length:var(--text-sm)]">
                    {row.studyCount}
                  </td>
                  <td className="px-3 py-2 text-center text-[length:var(--text-xs)]">
                    <ResponseBadge value={row.lastResponse} />
                  </td>
                  <td className="px-3 py-2">
                    {row.tags.length === 0 ? (
                      <span className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {row.tags.map((tag) =>
                        {
                          const meta = TAG_META[tag]

                          return meta ? (
                            <span
                              key={tag}
                              className={`rounded-sm px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium ${meta.className}`}
                            >
                              {meta.label}
                            </span>
                          ) : (
                            <span
                              key={tag}
                              className="rounded-sm bg-[var(--color-bg-subtle)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-muted)]"
                            >
                              {tag}
                            </span>
                          )
                        })}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <DayCell value={row.addDate} />
                  </td>
                  <td className="px-3 py-2">
                    <DayCell value={row.firstStudyDate} />
                  </td>
                  <td className="px-3 py-2">
                    <DayCell value={row.lastStudyDate} />
                  </td>
                  <td className="px-3 py-2">
                    {row.nextStudyDate ? (
                      <span className="whitespace-nowrap tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] font-medium text-[var(--color-accent)]">
                        {beijingDayOf(row.nextStudyDate)}
                      </span>
                    ) : (
                      <span className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
          共 {filtered.length.toLocaleString('zh-CN')} 词 · 第 {safePage + 1} / {totalPages} 页 ·
          每页 {PAGE_SIZE} 条
        </p>
        <div className="flex items-center gap-2">
          <PageButton disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            <Icon name="chevron-right" className="h-3.5 w-3.5 rotate-180" />
            上一页
          </PageButton>
          <PageButton disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>
            下一页
            <Icon name="chevron-right" className="h-3.5 w-3.5" />
          </PageButton>
        </div>
      </div>
    </div>
  )
}
