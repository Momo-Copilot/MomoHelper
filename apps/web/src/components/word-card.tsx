'use client'

import { useEffect, useRef, useState } from 'react'

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

export function WordCardPopover({
  spelling,
  onClose
}: {
  spelling: string
  onClose: () => void
})
{
  const [card, setCard] = useState<WordCard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // 点击卡片外任意位置关闭
  useEffect(
    () =>
    {
      function onDown(event: MouseEvent): void
      {
        if (ref.current && !ref.current.contains(event.target as Node))
        {
          onClose()
        }
      }

      // mousedown 先于 click，避免触发按钮的 click 冒泡误关
      document.addEventListener('mousedown', onDown)
      return () => document.removeEventListener('mousedown', onDown)
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

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${spelling} 词条`}
      className="absolute left-0 top-full z-20 mt-2 w-[min(420px,calc(100vw-80px))] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left shadow-[var(--shadow-pop)]"
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
    </div>
  )
}
