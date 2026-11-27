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

import { Tile } from '@/components/kit'
import { ResponseBadge } from '@/components/response-badge'
import { WordButton } from '@/components/word-button'

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

        {/* 只读表格：与词库页「词表」同款样式，不带排序/搜索——这批词按学习次数
            降序已是最有意义的顺序；也不支持点开词卡，点了会跳走反而打断浏览 */}
        {stalledCount === 0 ? (
          <p className="mt-4 rounded-md bg-[var(--color-bg-subtle)] px-4 py-6 text-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
            没有符合这一口径的词。要么词库还小，要么间隔都在正常拉长。
          </p>
        ) : (
          <>
            <div className="mt-4 max-h-[520px] overflow-auto overscroll-contain rounded-md border border-[var(--color-border)]">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-[var(--color-bg-subtle)]">
                <tr className="whitespace-nowrap text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                  <th className="px-3 py-2.5 font-normal">单词</th>
                  <th className="w-24 px-3 py-2.5 text-right font-normal">学习次数</th>
                  <th className="w-24 px-3 py-2.5 text-right font-normal">当前间隔</th>
                  <th className="w-20 px-3 py-2.5 text-center font-normal">上次作答</th>
                </tr>
              </thead>
              <tbody>
                {data.stalled.slice(0, 200).map((word) => (
                  <tr key={word.vocId} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2 text-[length:var(--text-sm)]">
                      <WordButton
                        spelling={word.spelling}
                        className="text-[length:var(--text-sm)] underline decoration-[var(--color-border-strong)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[var(--color-accent)]"
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] tabular">
                      {word.studyCount}
                    </td>
                    <td className="px-3 py-2 text-right font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] tabular text-[var(--color-forget)]">
                      {word.intervalDays} 天
                    </td>
                    <td className="px-3 py-2 text-center text-[length:var(--text-xs)]">
                      <ResponseBadge value={word.lastResponse} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            {stalledCount > 200 && (
              <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                只显示学习次数最多的 200 个，共 {stalledCount} 个。
              </p>
            )}
          </>
        )}
      </Tile>
    </div>
  )
}
