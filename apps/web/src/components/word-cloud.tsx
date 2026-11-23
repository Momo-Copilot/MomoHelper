'use client'

/**
 * 遗忘词云：把词按遗忘强度摊成一张可点的图。
 *
 * 布局是自己写的贪心螺旋（不引第三方库）：词按强度降序，从画布中心
 * 向外螺旋试探位置，与已放置词的外框不重叠就落下。估算字宽用字符数
 * 乘经验系数，够做碰撞避免；固定排序 + 无随机数，同一批词每次布局一致。
 *
 * 颜色和字号都来自 WordCloudWordDto 的同一分值（tier / size），
 * 所以「又大又深」的词就是最该复习的词。
 */

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { StudyResponse, WordCloudWordDto } from '@momo/types'
import { layoutWords, type PlacedWordBase } from '@/lib/word-cloud-layout'

/** 已落位的词：带外框中心与估算尺寸 */
type PlacedWord = WordCloudWordDto & PlacedWordBase

const RESPONSE_LABEL: Record<StudyResponse, string> = {
  FORGET: '忘记',
  VAGUE: '模糊',
  FAMILIAR: '认识'
}

export function WordCloud({
  words,
  onPlaced
}: {
  words: WordCloudWordDto[]
  /** 布局后回报实际画出来的词数（部分词会因版面排不下被跳过） */
  onPlaced?: (count: number) => void
})
{
  const router = useRouter()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 900, h: 520 })
  const [hovered, setHovered] = useState<PlacedWord | null>(null)

  // 按真实像素宽度布局（不用 viewBox 整体缩放），小屏字号才不至于变成蚂蚁
  useEffect(
    () =>
    {
      const el = wrapRef.current

      if (!el)
      {
        return
      }

      const apply = () =>
      {
        const w = el.clientWidth

        if (w > 0)
        {
          setBox({ w, h: w < 640 ? 400 : 520 })
        }
      }

      apply()

      const observer = new ResizeObserver(apply)
      observer.observe(el)

      return () => observer.disconnect()
    },
    []
  )

  const scale = Math.min(1, Math.max(0.7, box.w / 900))
  const placed = useMemo(() => layoutWords(words, box.w, box.h, scale), [words, box, scale])

  useEffect(
    () =>
    {
      onPlaced?.(placed.length)
    },
    [placed.length, onPlaced]
  )

  return (
    <div ref={wrapRef} className="relative">
      {placed.length === 0 ? (
        <p className="flex h-40 items-center justify-center text-[var(--text-sm)] text-[var(--color-text-subtle)]">
          没有能排进图里的词。
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${box.w} ${box.h}`}
          className="w-full select-none"
          role="img"
          aria-label="遗忘词云，字号与颜色表示遗忘强度"
          onMouseLeave={() => setHovered(null)}
        >
          {placed.map((word) =>
          {
            const dimmed = hovered !== null && hovered.vocId !== word.vocId

            return (
              <text
                key={word.vocId}
                x={word.x}
                y={word.y}
                fontSize={word.font}
                fontWeight={500}
                textAnchor="middle"
                dominantBaseline="middle"
                // 颜色必须走 style：presentation attribute 里的 var() 在部分
                // WebKit 版本不解析，会整片渲染成默认黑；再带一个 fallback，
                // 变量万一没进样式表也不会退化成无色
                style={{ fill: `var(--cloud-${word.tier}, #ad4622)` }}
                transform={word.rotate === 0 ? undefined : `rotate(${word.rotate} ${word.x} ${word.y})`}
                opacity={dimmed ? 0.4 : 1}
                className="cursor-pointer transition-opacity duration-150"
                onMouseEnter={() => setHovered(word)}
                onClick={() =>
                {
                  router.push(`/library?word=${encodeURIComponent(word.spelling)}`)
                }}
              >
                <title>{`${word.spelling} · 学习 ${word.studyCount} 次`}</title>
                {word.spelling}
              </text>
            )
          })}
        </svg>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-[240px] -translate-x-1/2 -translate-y-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 shadow-[var(--shadow-pop)]"
          style={{
            left: `${(hovered.x / box.w) * 100}%`,
            top: `${(hovered.y / box.h) * 100}%`,
            marginTop: -10
          }}
        >
          <p className="font-[family-name:var(--font-display)] text-[var(--text-md)] font-medium">
            {hovered.spelling}
          </p>
          <p className="mt-0.5 text-[var(--text-xs)] text-[var(--color-text-muted)]">
            学习 {hovered.studyCount} 次
            {hovered.lastResponse ? ` · 最近${RESPONSE_LABEL[hovered.lastResponse]}` : ''}
            {hovered.sticking ? ' · 顽固词' : ''}
          </p>
          <p className="text-[var(--text-xs)] text-[var(--color-text-subtle)]">
            {hovered.lastStudyDate ? `最近学习 ${hovered.lastStudyDate}` : '还没有学习记录'}
          </p>
        </div>
      )}
    </div>
  )
}
