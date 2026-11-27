'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

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

function Brand()
{
  return (
    <div className="flex items-center gap-2.5">
      {/* 站点 logo：猫头鹰头像。object-cover 保证任意尺寸下不变形（多余部分自动裁掉） */}
      <img
        src="/logo.png"
        alt=""
        aria-hidden
        width={32}
        height={32}
        className="h-8 w-8 shrink-0 rounded-md object-cover"
      />
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
    <p className="mt-2 px-2 font-[family-name:var(--font-mono)] text-[11px] tracking-wide text-[var(--color-text-subtle)]">
      {commit ? `v${version} · ${commit}` : `v${version}`}
    </p>
  )
}

/**
 * 底部外链图标：新窗口打开，不把本站替换掉。
 *
 * 支持两种样式：内置 svg 图标，或品牌图片（墨墨猫头鹰）。
 * 品牌图是黑白的，深色模式下会糊进背景，所以图片统一加白色圆底——
 * 官方本身就是白底黑猫头鹰，两种主题下都清晰。
 */
function FooterLink({
  href,
  label,
  icon,
  imageSrc
}: {
  href: string
  label: string
  icon?: IconName
  imageSrc?: string
})
{
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-accent)]"
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          aria-hidden
          width={24}
          height={24}
          className="h-6 w-6 rounded-full bg-white object-contain"
        />
      ) : (
        <Icon name={icon ?? 'link'} className="h-4 w-4" />
      )}
    </a>
  )
}

/** 墨墨官方网页版背单词（不依赖本站是否已绑定 Token） */
const MAIMEMO_STUDY_URL = 'https://www.maimemo.com/home/web_study'
/** 本项目仓库 */
const REPO_URL = 'https://github.com/Momo-Copilot/MomoHelper'

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
        <div className="flex items-center gap-2">
          <FooterLink href={MAIMEMO_STUDY_URL} label="去墨墨网页版背单词" imageSrc="/maimemo-logo.png" />
          <FooterLink href={REPO_URL} label="GitHub 仓库" icon="github" />
        </div>
        <VersionTag />
      </div>
    </nav>
  )
}

/**
 * 移动端底部 Tab。
 *
 * 十一个页面塞进顶部横滑不可用：占 96px、右边缘没有可发现性、滑动还容易误点。
 * 改成底部 4 个高频入口 + 「更多」抽屉：
 *   今日（每天第一站）、遗忘（当天答错复盘）、攻坚（每天练）、问词（随时问）
 * 其余七个收进抽屉——它们是「备考策略层」，一周看一两次。
 */
const MOBILE_TABS = ['/', '/forget', '/drill', '/ask']

function MobileTabBar()
{
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  const tabs = ITEMS.filter((item) => MOBILE_TABS.includes(item.href))
  const rest = ITEMS.filter((item) => !MOBILE_TABS.includes(item.href))
  /** 当前页面在抽屉里时，「更多」也要高亮，否则用户找不到自己在哪 */
  const restActive = rest.some((item) => item.href === pathname)

  return (
    <>
      <nav
        aria-label="主导航"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="flex items-stretch">
          {tabs.map((item) => (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={pathname === item.href ? 'page' : undefined}
                className={`flex flex-col items-center gap-1 py-2 text-[11px] leading-none transition-colors ${
                  pathname === item.href
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)]'
                }`}
              >
                <Icon name={item.icon} className="h-5 w-5" />
                {item.label}
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-expanded={open}
              className={`flex w-full flex-col items-center gap-1 py-2 text-[11px] leading-none transition-colors ${
                restActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
              }`}
            >
              <Icon name="more-horizontal" className="h-5 w-5" />
              更多
            </button>
          </li>
        </ul>
      </nav>

      {open && (
        <div
          className="fixed inset-0 z-30 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="更多页面"
        >
          {/* 遮罩：点空白处关闭 */}
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/40"
          />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-[var(--color-border)] bg-[var(--color-surface)] pb-[calc(12px+env(safe-area-inset-bottom))]"
          >
            <div className="flex items-center justify-between px-5 pb-1 pt-3">
              <p className="text-[length:var(--text-sm)] font-medium">更多</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]"
              >
                关闭
              </button>
            </div>
            <ul className="grid grid-cols-4 gap-1 px-3 py-2">
              {rest.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={pathname === item.href ? 'page' : undefined}
                    className={`flex flex-col items-center gap-1.5 rounded-md py-3 text-[length:var(--text-xs)] transition-colors ${
                      pathname === item.href
                        ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-subtle)]'
                    }`}
                  >
                    <Icon name={item.icon} className="h-5 w-5" />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}

/** 移动端顶栏：品牌 + 主题 + 底部 Tab（导航在下方） */
export function MobileNav()
{
  return (
    <div className="md:hidden">
      <div className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <Brand />
          <div className="flex items-center gap-2">
            <FooterLink href={MAIMEMO_STUDY_URL} label="去墨墨网页版背单词" imageSrc="/maimemo-logo.png" />
            <ThemeButton />
          </div>
        </div>
      </div>
      <MobileTabBar />
    </div>
  )
}
