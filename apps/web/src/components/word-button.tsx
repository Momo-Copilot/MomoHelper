'use client'

/**
 * 可点击的单词：点一下弹出词条卡（释义 / AI 补充 / 例句）。
 *
 * 抽成公共组件是为了样式统一——词表、间隔停滞表、今日词表都用同一套下划线
 * 点线的视觉，用户在哪一页看到都知道「这个词能点」。
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { WordCardPopover } from './word-card'

/** 默认样式：词表里的大号单词 */
const DEFAULT_CLASS =
  'font-[family-name:var(--font-display)] text-[length:var(--text-md)] underline decoration-[var(--color-border-strong)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]'

export function WordButton({
  spelling,
  className = DEFAULT_CLASS,
  render
}: {
  spelling: string
  /** 覆盖默认样式（表格里用更小的字号） */
  className?: string
  /** 自定义单词渲染（模糊搜索用它把差异字母标红）；不传则显示原拼写 */
  render?: (word: string) => ReactNode
})
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
        className={className}
      >
        {render ? render(spelling) : spelling}
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
