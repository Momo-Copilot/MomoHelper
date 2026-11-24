/**
 * 作答标记徽章：认识绿 / 模糊黄 / 忘记红（浅底 + 深字）。
 *
 * 今日页和词库表共用同一份。这两处原本各自定义过一次映射，很快就跑偏了
 * ——词库那边一度只剩文字颜色、没有底色，同一个「忘记」在两个页面长得不一样。
 * 合成一个组件后，样式只可能有一处来源。
 */

import type { StudyResponse } from '@momo/types'

const RESPONSE_BADGE: Record<StudyResponse, { label: string; className: string }> = {
  FORGET: {
    label: '忘记',
    className: 'bg-[var(--color-forget-bg)] text-[var(--color-forget)]'
  },
  VAGUE: {
    label: '模糊',
    className: 'bg-[var(--color-vague-bg)] text-[var(--color-vague)]'
  },
  FAMILIAR: {
    label: '认识',
    className: 'bg-[var(--color-familiar-bg)] text-[var(--color-familiar)]'
  }
}

/**
 * @param value 接口返回的 last_response / first_response。
 *   实测出现过白名单外的未知枚举值，所以这里按 Record 查不到就当未作答，
 *   不让脏数据把页面渲染崩掉。
 */
export function ResponseBadge({ value }: { value?: StudyResponse | string | null })
{
  const meta = value ? RESPONSE_BADGE[value as StudyResponse] : undefined

  if (!meta)
  {
    return <span className="text-[var(--color-text-subtle)]">—</span>
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[length:var(--text-xs)] font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  )
}
