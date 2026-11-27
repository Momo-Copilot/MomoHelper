/**
 * 词库 · 复习间隔视图。
 *
 * 核心问题：这个词到底「稳」了没有？
 *
 * 掌握度视图只看「学过多少次」，但次数多不等于记住了——每次都在「刚背完 →
 * 又忘」的词，学习次数照样会涨。复习间隔（next_study_date − last_study_date）
 * 才是墨墨对「记牢程度」的直接判断：间隔越长，系统认为越不需要再提醒你。
 *
 * 因此这里的主指标是「间隔停滞」：背了很多次、间隔却一直上不去的词。
 * 它们比 STICKING 标签更隐蔽——标签只标近期答错的，而停滞词可能最近一次
 * 恰好答对了，从其他任何页面都看不出问题。
 */

import type { IntervalAnalysisDto, IntervalBucketDto, StalledWordDto } from '@momo/types'
import Link from 'next/link'

import { Tile } from '@/components/kit'

function Metric({
  label,
  value,
  unit,
  hint
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
})
{
  return (
    <div className="rounded-md bg-[var(--color-bg-subtle)] px-4 py-3">
      <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">{label}</p>
      <p className="mt-1 whitespace-nowrap font-[family-name:var(--font-mono)] text-[length:var(--text-xl)] font-semibold leading-none tabular">
        {value}
        {unit && (
          <span className="ml-1 text-[length:var(--text-xs)] font-normal text-[var(--color-text-subtle)]">
            {unit}
          </span>
        )}
      </p>
      {hint && (
        <p className="mt-1.5 text-[length:var(--text-xs)] leading-snug text-[var(--color-text-subtle)]">
          {hint}
        </p>
      )}
    </div>
  )
}

/** 单条间隔分布：条形 + 右端两个辅助数字（词数、学习次数中位数） */
function IntervalRow({ bucket, max }: { bucket: IntervalBucketDto; max: number })
{
  const ratio = max > 0 ? bucket.count / max : 0

  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-[86px] shrink-0 font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-muted)]">
        {bucket.label}
      </span>
      <div className="h-5 min-w-0 flex-1 overflow-hidden rounded-sm bg-[var(--color-bg-subtle)]">
        <div
          className="h-full rounded-sm bg-[var(--color-accent)]/70"
          style={{ width: `${Math.max(ratio * 100, bucket.count > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] tabular">
        {bucket.count.toLocaleString('zh-CN')}
      </span>
      <span className="w-16 shrink-0 text-right font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)] tabular">
        {bucket.count > 0 ? `${bucket.medianStudyCount} 次` : '—'}
      </span>
    </div>
  )
}

const RESPONSE_TEXT: Record<string, string> = {
  FAMILIAR: '认识',
  VAGUE: '模糊',
  FORGET: '忘记'
}

function StalledRow({ word }: { word: StalledWordDto })
{
  return (
    <Link
      href={`/library?word=${encodeURIComponent(word.spelling)}`}
      className="flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-bg-subtle)]"
    >
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-sm)]">{word.spelling}</span>
      <span className="shrink-0 font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)] tabular">
        背 {word.studyCount} 次
      </span>
      <span className="w-16 shrink-0 text-right font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-forget)] tabular">
        间隔 {word.intervalDays} 天
      </span>
      <span className="w-12 shrink-0 text-right text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
        {word.lastResponse ? (RESPONSE_TEXT[word.lastResponse] ?? word.lastResponse) : '—'}
      </span>
    </Link>
  )
}

export function LibraryIntervalView({ data }: { data: IntervalAnalysisDto })
{
  const max = Math.max(...data.buckets.map((bucket) => bucket.count), 1)
  const stalledCount = data.stalled.length

  return (
    <div className="space-y-4">
      <Tile hover={false}>
        <h2 className="text-[length:var(--text-md)] font-semibold">复习间隔</h2>
        <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-muted)]">
          间隔 = 下次复习日 − 上次学习日，是墨墨对这个词「记牢程度」的判断。
          间隔越长，说明系统越相信你不用再频繁复习。
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric
            label="可计算间隔"
            value={data.measurable.toLocaleString('zh-CN')}
            unit="词"
            hint="缺上次或下次学习日的词无法参与"
          />
          <Metric
            label="间隔中位数"
            value={data.medianInterval === null ? '—' : Math.round(data.medianInterval)}
            unit="天"
          />
          <Metric label="间隔停滞" value={stalledCount.toLocaleString('zh-CN')} unit="词" hint="详见下方" />
          <Metric
            label="停滞判定"
            value={`≥${data.stalledThreshold.minStudyCount}`}
            unit={`次且≤${data.stalledThreshold.maxIntervalDays}天`}
            hint="这是本站口径，不是墨墨官方标准"
          />
        </div>

        <div className="mt-5">
          <div className="flex items-center gap-3 pb-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
            <span className="w-[86px] shrink-0">间隔</span>
            <span className="flex-1" />
            <span className="w-14 shrink-0 text-right">词数</span>
            <span className="w-16 shrink-0 text-right">次数中位</span>
          </div>
          {data.buckets.map((bucket) => (
            <IntervalRow key={bucket.key} bucket={bucket} max={max} />
          ))}
        </div>
      </Tile>

      <Tile hover={false}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[length:var(--text-md)] font-semibold">间隔停滞的词</h2>
          <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
            {stalledCount > 0 ? `共 ${stalledCount} 个` : '无'}
          </span>
        </div>
        <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-muted)]">
          背了 {data.stalledThreshold.minStudyCount} 次以上，间隔仍不超过{' '}
          {data.stalledThreshold.maxIntervalDays} 天——说明每次都在「刚背完又忘」的循环里，
          而不是真的记住了。这批词通常不会出现在「遗忘词」页面，因为最近一次可能恰好答对了。
        </p>

        {stalledCount === 0 ? (
          <p className="mt-4 rounded-md bg-[var(--color-bg-subtle)] px-4 py-6 text-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
            没有符合这一口径的词。要么词库还小，要么间隔都在正常拉长。
          </p>
        ) : (
          <div className="mt-3 max-h-[420px] overflow-y-auto overscroll-contain">
            <div className="flex items-center gap-3 px-2 pb-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              <span className="flex-1">单词</span>
              <span className="shrink-0">学习次数</span>
              <span className="w-16 shrink-0 text-right">当前间隔</span>
              <span className="w-12 shrink-0 text-right">上次</span>
            </div>
            {data.stalled.slice(0, 200).map((word) => (
              <StalledRow key={word.vocId} word={word} />
            ))}
            {stalledCount > 200 && (
              <p className="px-2 pt-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                只显示学习次数最多的 200 个，共 {stalledCount} 个。
              </p>
            )}
          </div>
        )}
      </Tile>
    </div>
  )
}
