'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

import { getLocalStatus } from '@/lib/settings'
import { applyTheme, currentTheme, storeTheme, type ThemeMode } from '@/lib/theme'
import { Icon, type IconName } from './icons'

/**
 * 导航顺序按使用频率：先看今天，再看未来，然后才是复盘与词库。
 *
 * 标签一律两个字：原来「遗忘词」是唯一的三个字，与其他项参差，
 * 视觉上很跳。页面标题仍是「遗忘词分析」，菜单用简写不影响理解。
 * 另外 `hint` 给悬停提示，补足简写丢掉的信息。
 */
const ITEMS: { href: string; label: string; icon: IconName; hint: string }[] = [
  { href: '/', label: '今日', icon: 'gauge', hint: '今日学习看板' },
  { href: '/plan', label: '计划', icon: 'calendar', hint: '复习计划与冲刺推演' },
  { href: '/forget', label: '遗忘', icon: 'trending-down', hint: '遗忘词分析' },
  { href: '/drill', label: '攻坚', icon: 'zap', hint: '顽固词攻坚' },
  { href: '/rare', label: '僻义', icon: 'search', hint: '熟词僻义' },
  { href: '/confusable', label: '易混', icon: 'swap', hint: '易混词对' },
  { href: '/cloud', label: '词云', icon: 'cloud', hint: '遗忘词云' },
  { href: '/ask', label: '问词', icon: 'message', hint: '向 AI 问词' },
  { href: '/report', label: '学情', icon: 'clipboard', hint: '学情报告' },
  { href: '/library', label: '词库', icon: 'book', hint: '词库明细' },
  { href: '/settings', label: '设置', icon: 'sliders', hint: '凭据与备份设置' }
]

/** 本地凭据快照：与设置页共用 getLocalStatus，保证同一 queryKey 数据形状一致 */
function useLocalStatus()
{
  const query = useQuery({
    queryKey: ['settings', 'status'],
    queryFn: getLocalStatus,
    staleTime: 0,
    retry: false
  })

  return query.data ?? null
}

function Brand()
{
  return (
    <div className="flex items-center gap-2.5">
      {/* 墨黑底白「墨」：呼应墨墨黑白猫头鹰品牌；夜间模式经 token 自动反转为白底墨字 */}
      <span
        aria-hidden
        className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-text)] font-[family-name:var(--font-display)] text-base font-bold text-[var(--color-bg)]"
      >
        墨
      </span>
      <div className="leading-tight">
        <p className="font-[family-name:var(--font-display)] text-[length:var(--text-md)] font-semibold">
          墨小墨
        </p>
        <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[0.22em] text-[var(--color-text-subtle)]">
          Copilot
        </p>
      </div>
    </div>
  )
}

function NavLink({ item, active }: { item: (typeof ITEMS)[number]; active: boolean })
{
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      title={item.hint}
      className={`group flex items-center gap-3 rounded-md px-3 py-2 text-[length:var(--text-sm)] transition-colors ${
        active
          ? 'bg-[var(--color-accent-bg)] font-semibold text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]'
      }`}
    >
      <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
      {/*
       * 文字撑满剩余宽度（flex-1）而不是跟在图标后自然流排：
       * 原来标签只占自身宽度，248px 侧栏右侧空出一大块，整列像被挤在左边。
       * 撑满后悬停底色铺到整行，右侧指示点也贴行末，视觉上是一条完整的行。
       */}
      <span className="flex-1 truncate">{item.label}</span>
      {/*
       * 右端指示点：当前页实心常亮；其余行悬停时淡淡出现，提示"点这里"。
       * 始终占位（不只是当前页渲染），否则各行文字宽度不一致会左右晃。
       */}
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
          active
            ? 'bg-[var(--color-accent)] opacity-100'
            : 'bg-[var(--color-text-subtle)] opacity-0 group-hover:opacity-40'
        }`}
      />
    </Link>
  )
}

/** 凭据状态卡：数据全部存本机浏览器，不经过任何服务器 */
function StatusCard()
{
  const status = useLocalStatus()
  const connected = status?.token?.hasToken ?? false

  return (
    <Link
      href="/settings"
      className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2.5 transition-colors hover:border-[var(--color-border-strong)]"
    >
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-info-bg)] font-[family-name:var(--font-display)] text-sm font-semibold text-[var(--color-info)]"
      >
        <Icon name="user" className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-[length:var(--text-sm)] font-medium">本机凭据</p>
        <p className="mt-1 flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              connected ? 'bg-[var(--color-familiar)]' : 'bg-[var(--color-border-strong)]'
            }`}
          />
          {connected ? '墨墨已连接' : '墨墨未配置'}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              status?.hasAiKey ? 'bg-[var(--color-familiar)]' : 'bg-[var(--color-border-strong)]'
            }`}
          />
          {status?.hasAiKey ? 'AI 已配置' : 'AI 未配置'}
        </p>
      </div>
    </Link>
  )
}

/** 主题切换：浅色 / 夜间。初始跟随系统（内联脚本已定），手动切换后记住 */
function ThemeButton()
{
  const [theme, setTheme] = useState<ThemeMode | null>(null)

  useEffect(
    () =>
    {
      setTheme(currentTheme())
    },
    []
  )

  function toggle(): void
  {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark'

    setTheme(next)
    applyTheme(next)
    storeTheme(next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="切换浅色 / 夜间模式"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="h-4 w-4" />
    </button>
  )
}

/** 版本号：package.json semver + 构建注入的 git 短 SHA（线上核对代码版本用） */
function VersionTag()
{
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev'
  const commit = process.env.NEXT_PUBLIC_COMMIT_SHA ?? ''

  return (
    <p className="px-2 font-[family-name:var(--font-mono)] text-[11px] tracking-wide text-[var(--color-text-subtle)]">
      {commit ? `v${version} · ${commit}` : `v${version}`}
    </p>
  )
}

/** 桌面侧边栏 */
export function SideNav()
{
  const pathname = usePathname()

  return (
    <nav
      aria-label="主导航"
      className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col justify-between border-r border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 md:flex"
    >
      <div>
        <div className="flex items-center justify-between px-2">
          <Brand />
          <ThemeButton />
        </div>
        <ul className="mt-8 space-y-1">
          {ITEMS.map((item) => (
            <li key={item.href}>
              <NavLink item={item} active={pathname === item.href} />
            </li>
          ))}
        </ul>
      </div>
      <div>
        <VersionTag />
        <StatusCard />
      </div>
    </nav>
  )
}

/** 移动端顶栏：品牌 + 横向滚动导航 */
export function MobileNav()
{
  const pathname = usePathname()

  return (
    <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 px-4 py-3 backdrop-blur md:hidden">
      <div className="flex items-center justify-between">
        <Brand />
        <ThemeButton />
      </div>
      <nav aria-label="主导航" className="-mx-1 mt-3 overflow-x-auto">
        <ul className="flex gap-1 px-1">
          {ITEMS.map((item) => (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={pathname === item.href ? 'page' : undefined}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[length:var(--text-sm)] ${
                  pathname === item.href
                    ? 'bg-[var(--color-accent-bg)] font-semibold text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)]'
                }`}
              >
                <Icon name={item.icon} className="h-4 w-4" />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
