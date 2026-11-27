'use client'

/**
 * 局部错误边界。
 *
 * 用途很具体：某个图表的渲染出错时，只让那一块显示错误，而不是整页白屏。
 * 2026-11-27 出现过「点某个按钮整页崩掉」的情况——React 的默认行为是
 * 未捕获的渲染异常会卸载整棵树，用户什么都看不到，也无从反馈。
 */

import { Component, type ReactNode } from 'react'

interface Props
{
  children: ReactNode
  /** 自定义兜底内容；不传则用默认的一行提示 */
  fallback?: ReactNode
  /** 出错时的额外回调（打日志用） */
  onError?: (error: Error) => void
}

interface State
{
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State>
{
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State
  {
    return { error }
  }

  componentDidCatch(error: Error): void
  {
    this.props.onError?.(error)
    console.error('[momo] 渲染出错：', error)
  }

  render(): ReactNode
  {
    if (this.state.error)
    {
      return (
        this.props.fallback ?? (
          <div className="rounded-md border border-[var(--color-forget)]/25 bg-[var(--color-forget-bg)] px-4 py-3 text-[length:var(--text-sm)] text-[var(--color-forget)]">
            这一块渲染失败：{this.state.error.message}。其他内容不受影响。
          </div>
        )
      )
    }

    return this.props.children
  }
}
