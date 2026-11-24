'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { POPOVER_GAP, computePopoverBox, type PopoverBox } from '@/lib/popover-position'
import type { WordCard } from '@/lib/word-card'

/**
 * 词卡弹层：点击单词出现，点击其他任意位置关闭。
 * 双区块：「我的自建」（释义/助记/例句，皆空时提示暂无数据）+「AI 生成」。
 */

function SectionTag({ text, accent }: { text: string; accent?: boolean })
{
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[var(--text-xs)] font-medium ${
        accent
          ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]'
          : 'bg-[var(--color-bg-subtle)] text-[var(--color-text-subtle)]'
      }`}
    >
      {text}
    </span>
  )
}

/** 我的自建区块：释义 / 助记 / 例句，三类皆空显示「暂无数据」 */
function MineSectionView({ card }: { card: WordCard })
{
  const { mine } = card

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[var(--text-xs)] font-medium text-[var(--color-text-muted)]">
          我的自建
        </p>
        <SectionTag text={mine.empty ? '暂无数据' : '来自墨墨'} accent={!mine.empty} />
      </div>

      {mine.empty ? (
        <p className="mt-2 rounded-md bg-[var(--color-bg-subtle)] px-3 py-2.5 text-[var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
          你还没有为这个词创建自建内容（释义 / 助记 / 例句）。可在墨墨 App 中添加，官方词库释义不在开放接口范围内。
        </p>
      ) : (
        <div className="mt-2 space-y-2.5">
          {mine.definitions.length > 0 && (
            <ul className="space-y-1">
              {mine.definitions.map((definition, i) => (
                <li key={i} className="text-[var(--text-sm)] leading-relaxed">
                  {definition}
                </li>
              ))}
            </ul>
          )}

          {mine.notes.map((note, i) => (
            <p key={`note-${i}`} className="text-[var(--text-sm)] leading-relaxed">
              <span className="mr-1.5 rounded-sm bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[var(--text-xs)] text-[var(--color-text-muted)]">
                {note.type}
              </span>
              {note.text}
            </p>
          ))}

          {mine.phrases.map((phrase, i) => (
            <p
              key={`phrase-${i}`}
              className="rounded-md bg-[var(--color-bg-subtle)] px-3 py-2 text-[var(--text-sm)] leading-relaxed"
            >
              {phrase.text}
              <span className="mt-1 block text-[var(--text-xs)] text-[var(--color-text-subtle)]">
                {phrase.translation}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** AI 生成区块：音标 / 释义 / 例句 */
function AiSectionView({ card }: { card: WordCard })
{
  if (!card.ai || card.ai.definitions.length === 0)
  {
    return null
  }

  const { ai } = card

  return (
    <div className="border-t border-[var(--color-border)] pt-3">
      <div className="flex items-center justify-between">
        <p className="text-[var(--text-xs)] font-medium text-[var(--color-text-muted)]">
          AI 补充
        </p>
        <SectionTag text="AI 生成" />
      </div>

      <ul className="mt-2 space-y-1">
        {ai.definitions.map((definition, i) => (
          <li key={i} className="text-[var(--text-sm)] leading-relaxed">
            {definition}
          </li>
        ))}
      </ul>

      {ai.example && (
        <p className="mt-2.5 rounded-md bg-[var(--color-bg-subtle)] px-3 py-2 text-[var(--text-sm)] leading-relaxed">
          {ai.example}
          {ai.exampleTranslation && (
            <span className="mt-1 block text-[var(--text-xs)] text-[var(--color-text-subtle)]">
              {ai.exampleTranslation}
            </span>
          )}
        </p>
      )}
    </div>
  )
}

/** 读当前锚点位置算弹层坐标（定位算法本身在 lib/popover-position，可单测） */
function measure(anchor: HTMLElement): PopoverBox
{
  return computePopoverBox(anchor.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight
  })
}

export function WordCardPopover({
  spelling,
  anchor,
  onClose
}: {
  spelling: string
  /** 触发按钮：定位基准，且点它不当作「点外部」 */
  anchor?: HTMLElement | null
  onClose: () => void
})
{
  const [card, setCard] = useState<WordCard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // 挂载时就有 anchor（组件由点击触发），首帧即可算好位置，不会闪一下再跳
  const [box, setBox] = useState<PopoverBox | null>(() => (anchor ? measure(anchor) : null))

  // 跟随锚点：页面滚动、表格横向滚动、窗口缩放都重新定位
  useEffect(
    () =>
    {
      if (!anchor)
      {
        return
      }

      let frame = 0

      const place = () =>
      {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => setBox(measure(anchor)))
      }

      place()
      // capture：表格自身的横向滚动不冒泡到 window，必须捕获阶段监听
      window.addEventListener('scroll', place, { passive: true, capture: true })
      window.addEventListener('resize', place)

      return () =>
      {
        cancelAnimationFrame(frame)
        window.removeEventListener('scroll', place, { capture: true })
        window.removeEventListener('resize', place)
      }
    },
    [anchor]
  )

  // 点击卡片外任意位置关闭；点锚点交给按钮自己 toggle，否则会「关了又开」
  useEffect(
    () =>
    {
      function onDown(event: MouseEvent): void
      {
        const target = event.target as Node

        if (ref.current?.contains(target) || anchor?.contains(target))
        {
          return
        }

        onClose()
      }

      // mousedown 先于 click，避免触发按钮的 click 冒泡误关
      document.addEventListener('mousedown', onDown)
      return () => document.removeEventListener('mousedown', onDown)
    },
    [onClose, anchor]
  )

  // Esc 关闭（键盘操作时的基本预期）
  useEffect(
    () =>
    {
      function onKey(event: KeyboardEvent): void
      {
        if (event.key === 'Escape')
        {
          onClose()
        }
      }

      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    },
    [onClose]
  )

  // 按需取词卡（组件挂载才请求；含 24h localStorage 缓存）
  useEffect(
    () =>
    {
      let cancelled = false

      import('@/lib/word-card')
        .then(({ getWordCard }) => getWordCard(spelling))
        .then((data) =>
        {
          if (!cancelled) setCard(data)
        })
        .catch((err) =>
        {
          if (!cancelled)
          {
            setError(err instanceof Error ? err.message : '获取词条失败，请稍后重试')
          }
        })

      return () =>
      {
        cancelled = true
      }
    },
    [spelling]
  )

  // 只在浏览器渲染：portal 需要 document（组件本身由点击触发，SSR 不会挂载）
  if (typeof document === 'undefined')
  {
    return null
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`${spelling} 词条`}
      className="fixed z-50 overflow-y-auto overscroll-contain rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left shadow-[var(--shadow-pop)]"
      style={box ?? { left: POPOVER_GAP, right: POPOVER_GAP, top: 96, maxHeight: 320 }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-[family-name:var(--font-display)] text-[var(--text-md)] font-semibold">
          {spelling}
        </span>
        {card?.ai?.phonetic && (
          <span className="font-[family-name:var(--font-mono)] text-[var(--text-xs)] text-[var(--color-text-subtle)]">
            {card.ai.phonetic}
          </span>
        )}
      </div>

      {error ? (
        <p className="mt-2 text-[var(--text-sm)] text-[var(--color-forget)]">{error}</p>
      ) : !card ? (
        <div>
          <div className="mt-3 h-4 w-3/4 animate-pulse rounded-sm bg-[var(--color-bg-subtle)]" />
          <div className="mt-2 h-4 w-2/3 animate-pulse rounded-sm bg-[var(--color-bg-subtle)]" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded-sm bg-[var(--color-bg-subtle)]" />
        </div>
      ) : (
        <div className="mt-2 space-y-3">
          <MineSectionView card={card} />
          <AiSectionView card={card} />
        </div>
      )}
    </div>,
    document.body
  )
}
