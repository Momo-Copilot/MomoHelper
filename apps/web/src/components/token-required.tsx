'use client'

/**
 * 「还没绑定墨墨 Token」的统一提示。
 *
 * 之前每个页面各写一套：有的渲染成居中的大卡片，有的是一条红色 ErrorNote，
 * 文案和按钮也不一样。现在统一成一个组件，所有需要 Token 的页面共用。
 *
 * 两个出口：「去设置」走正常配置流程，「看看演示」加载打包好的样本数据
 * （不需要 Token、不写真实存储，退出后一切还原）。
 */

import Link from 'next/link'
import { useState } from 'react'

import { Icon } from '@/components/icons'
import { Tile } from '@/components/kit'
import { startDemo } from '@/lib/demo'

export function TokenRequired({ description }: { description?: string })
{
  const [loading, setLoading] = useState(false)

  return (
    <Tile hover={false} className="mt-16 text-center">
      <Icon name="alert" className="mx-auto h-8 w-8 text-[var(--color-vague)]" />
      <h1 className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
        需要先配置墨墨 Token
      </h1>
      <p className="mx-auto mt-1 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
        {description ?? '尚未绑定墨墨 Token，绑定后即可使用本页；也可以先看演示。'}
      </p>
      <div className="mt-5 flex justify-center gap-3">
        <Link
          href="/settings"
          className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white hover:bg-[var(--color-accent-hover)]"
        >
          <Icon name="sliders" className="mr-2 h-4 w-4" />
          去设置
        </Link>
        <button
          type="button"
          disabled={loading}
          onClick={async () =>
          {
            setLoading(true)

            try
            {
              await startDemo()
            }
            catch
            {
              setLoading(false)
            }
          }}
          className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] hover:bg-[var(--color-bg-subtle)] disabled:opacity-60"
        >
          {loading ? '加载演示数据…' : '看看演示'}
        </button>
      </div>
    </Tile>
  )
}
