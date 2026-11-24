'use client'

import { useMemo, useRef, useState } from 'react'

import type { TodayWordRowDto } from '@momo/types'
import { ResponseBadge } from '@/components/response-badge'
import { Segmented } from '@/components/kit'
import { WordCardPopover } from '@/components/word-card'

/**
 * 今日词表卡：get_today_items 全量词逐行展示，
 * 支持完成状态（is_finished）与类型（is_new）双筛选。
 * 数据复用看板请求（无额外网络调用）；降级快照时无词表（空态）。
 */

type FinishFilter = 'all' | 'finished' | 'unfinished'

/** 可点击单词：点按弹词卡（与遗忘词页一致），点其他位置自动关闭 */
function WordButton({ spelling }: { spelling: string })
{
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <span className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="点击查看词条释义"
        className="w-full truncate text-left font-[family-name:var(--font-display)] text-[length:var(--text-md)] underline decoration-[var(--color-border-strong)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]"
      >
        {spelling}
      </button>
      {open && (
        <WordCardPopover
          spelling={spelling}
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  )
}

export function TodayWordsCard({ words }: { words: TodayWordRowDto[] })
{
  const [finishFilter, setFinishFilter] = useState<FinishFilter>('all')

  const filtered = useMemo(
    () =>
      words.filter((word) =>
      {
        if (finishFilter === 'finished' && !word.isFinished)
        {
          return false
        }

        if (finishFilter === 'unfinished' && word.isFinished)
        {
          return false
        }

        return true
      }),
    [words, finishFilter]
  )

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
          今日词表
          <span className="ml-2 font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
            {filtered.length} / {words.length}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented
            ariaLabel="完成状态"
            value={finishFilter}
            options={[
              ['all', '全部'],
              ['finished', '已完成'],
              ['unfinished', '未完成']
            ]}
            onChange={(next) => setFinishFilter(next as FinishFilter)}
          />
        </div>
      </div>

      {words.length === 0 ? (
        <p className="mt-6 text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
          当前为降级快照数据，暂无今日词表明细；数据恢复可靠后自动展示。
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-6 text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
          没有符合当前筛选条件的词。
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {filtered.map((word, i) =>
          {
            return (
              <li
                key={word.vocId}
                className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-bg-subtle)]"
              >
                <span className="tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <WordButton spelling={word.spelling} />
                </span>
                {/* 三列都定宽：内容宽度随行变化（已完成/未完成、徽章/短横线）
                    会让每行的列起点漂移，看着就是「没对齐」 */}
                <span className="flex shrink-0 items-center gap-3">
                  <span
                    className={`w-8 text-[length:var(--text-xs)] ${
                      word.isNew
                        ? 'font-medium text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)]'
                    }`}
                  >
                    {word.isNew ? '新词' : '复习'}
                  </span>
                  <span
                    className={`flex w-[4.5rem] items-center gap-1.5 text-[length:var(--text-xs)] ${
                      word.isFinished
                        ? 'text-[var(--color-familiar)]'
                        : 'text-[var(--color-text-subtle)]'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        word.isFinished
                          ? 'bg-[var(--color-familiar)]'
                          : 'bg-[var(--color-border-strong)]'
                      }`}
                    />
                    {word.isFinished ? '已完成' : '未完成'}
                  </span>
                  <span className="hidden w-12 justify-center sm:inline-flex">
                    <ResponseBadge value={word.firstResponse} />
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
