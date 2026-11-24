'use client'

/**
 * 遗忘词云：把有遗忘信号的词按强度摊成一张图。
 *
 * 与词库页共享 ['library'] 缓存，切换零请求；强度口径见 buildWordCloud。
 * 墨墨不给逐次作答历史，所以图上是「综合遗忘强度」而非「遗忘次数」，
 * 页面底部必须把这句口径写清楚，避免数字被当成真实次数去核对。
 */

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useMemo, useState } from 'react'

import { MaimemoAuthError } from '@momo/maimemo'
import { Icon } from '@/components/icons'
import { PageHeader, Tile, TileSkeleton } from '@/components/kit'
import { WordCloud } from '@/components/word-cloud'
import { buildWordCloud } from '@/lib/analyze'
import { loadLibrary } from '@/lib/library'
import { MaimemoNotConfiguredError } from '@/lib/maimemo'

const QUERY_KEY = ['library'] as const

export default function CloudPage()
{
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => loadLibrary() })

  // 词数上限按首次进入的屏宽定：实测 900×520 画布能排下 98% 的 60 词，
  // 移动端 360×400 排 32 词，再多就开始互相挤压或者干脆排不进去
  const [limit] = useState(() =>
  {
    if (typeof window === 'undefined')
    {
      return 60
    }

    return window.innerWidth < 768 ? 32 : 60
  })

  const records = query.data?.records
  const cloud = useMemo(
    () => (records ? buildWordCloud(records, { limit }) : null),
    [records, limit]
  )
  /** 实际画进图里的词数：版面排不下的会被布局跳过，未显示数按这个算才准 */
  const [shownCount, setShownCount] = useState<number | null>(null)

  if (query.isPending)
  {
    return (
      <div>
        <PageHeader title="遗忘词云" description="正在读取学习记录…" />
        <TileSkeleton className="h-[420px]" />
      </div>
    )
  }

  if (query.isError)
  {
    const error = query.error
    const needSetup = error instanceof MaimemoNotConfiguredError || error instanceof MaimemoAuthError

    return (
      <div>
        <PageHeader title="遗忘词云" />
        <Tile hover={false} className="mt-10 text-center">
          <Icon name="alert" className="mx-auto h-8 w-8 text-[var(--color-vague)]" />
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
            {needSetup ? '需要先配置墨墨 Token' : '词云加载失败'}
          </h1>
          <p className="mx-auto mt-1 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            {error instanceof MaimemoNotConfiguredError
              ? '尚未绑定墨墨 Token，绑定后即可生成遗忘词云。'
              : error instanceof MaimemoAuthError
                ? '墨墨 Token 已失效或无效，请到设置页重新绑定。'
                : error.message}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            {needSetup ? (
              <Link
                href="/settings"
                className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white hover:bg-[var(--color-accent-hover)]"
              >
                <Icon name="sliders" className="mr-2 h-4 w-4" />
                去设置
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] hover:bg-[var(--color-bg-subtle)]"
              >
                重试
              </button>
            )}
          </div>
        </Tile>
      </div>
    )
  }

  const data = query.data
  const loaded = data.records.length
  const expected = data.total ?? loaded
  const isComplete = data.complete && loaded >= expected

  if (!cloud)
  {
    return null
  }

  return (
    <div>
      <PageHeader
        title="遗忘词云"
        description={`全库 ${cloud.total.toLocaleString('zh-CN')} 词 · 有遗忘信号 ${cloud.signalCount.toLocaleString('zh-CN')} 词`}
        actions={
          <Link
            href="/forget"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            看遗忘词明细
          </Link>
        }
      />

      {!isComplete && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-[var(--color-vague)]/30 bg-[var(--color-vague-bg)] px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-vague)]">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            只取到 {loaded.toLocaleString('zh-CN')} 条，接口总数 {expected.toLocaleString('zh-CN')}
            条。差额多为未安排复习的词（没有 next_study_date），墨墨接口暂不提供按此筛选的查询，
            词云只覆盖已进入复习计划的词。
          </span>
        </p>
      )}

      <Tile index={0} hover={false} className="col-span-12">
        {cloud.words.length === 0 ? (
          <div className="py-16 text-center">
            <Icon name="check" className="mx-auto h-8 w-8 text-[var(--color-familiar)]" />
            <p className="mt-3 text-[length:var(--text-md)] font-medium">没有词带遗忘信号</p>
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
              最近没有答错、也没有顽固词标记——这张图现在是干净的。
            </p>
          </div>
        ) : (
          <WordCloud words={cloud.words} onPlaced={setShownCount} />
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-[var(--color-border)] pt-4">
          <div className="flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
            <span>遗忘强度</span>
            <span className="flex overflow-hidden rounded-sm">
              {[0, 1, 2, 3, 4].map((tier) => (
                <span
                  key={tier}
                  aria-hidden
                  className="h-3 w-7"
                  style={{ background: `var(--cloud-${tier})` }}
                />
              ))}
            </span>
            <span>轻 → 重（字号同步变大）</span>
          </div>
          <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
            悬浮看详情 · 点击跳到词库定位
          </p>
        </div>

        <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
          强度 = 最近作答忘记 40 + 顽固词标记 30 + 复习遍数 30。墨墨不提供逐次作答历史，
          这里用综合强度代替「遗忘次数」；只统计最近答错或带 STICKING 标签的词
          {shownCount !== null &&
            cloud.signalCount > shownCount &&
            `，另有 ${(cloud.signalCount - shownCount).toLocaleString('zh-CN')} 个词未在图中显示`}
          。
        </p>
      </Tile>
    </div>
  )
}
