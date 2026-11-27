'use client'

import { useMemo, useRef, useState } from 'react'

import type { StudyResponse, TodayWordRowDto } from '@momo/types'
import { Icon } from '@/components/icons'
import { Segmented } from '@/components/kit'
import { WordCardPopover } from '@/components/word-card'

/**
 * 今日词表卡：get_today_items 全量词以芯片墙展示，
 * 支持完成状态（is_finished）双筛选。
 * 数据复用看板请求（无额外网络调用）；降级快照时无词表（空态）。
 *
 * 为什么从「一行一词」改成芯片墙：
 * 一个词只占一个词条，没有第二列第三列的信息需要对齐，逐行排版把
 * 大片区域浪费在了行距和空白列上。芯片墙一屏能看完所有词，
 * 且用底色直接编码作答状态——比原来右侧那枚小徽章显眼得多。
 *
 * 状态编码（沿用全站语义色，与 ResponseBadge 同源）：
 *   认识 = 绿底 / 模糊 = 黄底 / 忘记 = 红底 / 未作答 = 中性底 + 虚线边
 */

type FinishFilter = 'all' | 'finished' | 'unfinished'

interface ChipTone
{
  /** 底色 + 文字色 + 边框，整块芯片一套 */
  className: string
  label: string
}

/** 作答状态 → 芯片配色。与 ResponseBadge 的响应枚举一一对应 */
const CHIP_TONES: Record<StudyResponse, ChipTone> = {
  FAMILIAR: {
    className:
      'border-[var(--color-familiar)]/25 bg-[var(--color-familiar-bg)] text-[var(--color-familiar)]',
    label: '认识'
  },
  VAGUE: {
    className:
      'border-[var(--color-vague)]/25 bg-[var(--color-vague-bg)] text-[var(--color-vague)]',
    label: '模糊'
  },
  FORGET: {
    className:
      'border-[var(--color-forget)]/25 bg-[var(--color-forget-bg)] text-[var(--color-forget)]',
    label: '忘记'
  }
}

/** 未作答（含接口返回白名单外枚举）：中性底 + 虚线边，视觉上明确「还没做」 */
const PENDING_TONE: ChipTone = {
  className:
    'border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]',
  label: '未作答'
}

/**
 * 可点击单词芯片：整块芯片就是按钮，点开词卡。
 *
 * 用 button 而不是 span+onClick：键盘可达、有原生焦点环，
 * 且点击热区天然等于芯片大小（40px 高，够手指点）。
 */
function WordChip({ word }: { word: TodayWordRowDto })
{
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const tone = word.firstResponse ? CHIP_TONES[word.firstResponse] : undefined
  const effective = tone ?? PENDING_TONE

  return (
    <span className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`${word.spelling} · ${effective.label}${word.isNew ? ' · 新词' : ''} · 点击查看释义`}
        className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[var(--shadow-tile-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] ${effective.className}`}
      >
        <span className="font-[family-name:var(--font-display)] text-[length:var(--text-md)] whitespace-nowrap">
          {word.spelling}
        </span>
        {word.isNew && (
          // 底色用 color-mix 从当前文字色派生：不能用 bg-current/15，
          // Tailwind 的透明度修饰符对 currentColor 不生效，会渲染成透明
          <span className="shrink-0 rounded-sm bg-[color-mix(in_srgb,currentColor_14%,transparent)] px-1 py-0.5 text-[10px] font-semibold leading-none">
            新
          </span>
        )}
        {word.isFinished && (
          <Icon name="check" className="h-3 w-3 shrink-0 opacity-70" />
        )}
      </button>
      {open && (
        <WordCardPopover
          spelling={word.spelling}
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
        <>
          {/* 图例放在词表上方：先告诉用户颜色含义，再看色块，比看完再回头查更省力 */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
            {(['FAMILIAR', 'VAGUE', 'FORGET'] as StudyResponse[]).map((key) => (
              <span key={key} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`h-3 w-3 shrink-0 rounded-full border ${CHIP_TONES[key].className}`}
                />
                {CHIP_TONES[key].label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={`h-3 w-3 shrink-0 rounded-full border ${PENDING_TONE.className}`}
              />
              未作答
            </span>
            <span>点击任意词看释义</span>
          </div>

          <ul className="mt-3 flex flex-wrap gap-2">
            {filtered.map((word) => (
              <li key={word.vocId}>
                <WordChip word={word} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
