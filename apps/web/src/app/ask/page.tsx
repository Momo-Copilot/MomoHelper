'use client'

import Link from 'next/link'

import { useEffect, useRef, useState } from 'react'

import { AiAuthError } from '@momo/ai'
import { Icon } from '@/components/icons'
import { Markdown } from '@/components/markdown'
import { ErrorNote, PageHeader, Tile } from '@/components/kit'
import { askStream } from '@/lib/ai'
import {
  addAskRecord,
  clearAskHistory,
  listAskHistory,
  removeAskRecord,
  type AskRecord
} from '@/lib/ask-history'
import { getAiThinkingMode } from '@/lib/settings'

/**
 * AI 问词：浏览器直连 DeepSeek 流式接口。
 * 回答自动注入该词的真实学习数据（学习次数 / 顽固标记）；
 * 未绑定墨墨时也能提问，只是缺少学习上下文。
 * 思考模式在设置页统一配置；未配置时引导跳转。
 */
/** 历史条目的时间显示：今天只显示时分，其他日期显示月日 */
function formatAskTime(iso: string): string
{
  const date = new Date(iso)

  if (Number.isNaN(date.getTime()))
  {
    return ''
  }

  const today = new Date()

  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  return date.toLocaleString('zh-CN', {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit'
  })
}

export default function AskPage()
{
  const [question, setQuestion] = useState('')
  const [spelling, setSpelling] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** null = 设置页还没配置过思考模式 */
  const [thinking, setThinking] = useState<'on' | 'off' | null>(null)
  const [history, setHistory] = useState<AskRecord[]>([])
  /** 展开中的历史条目 id */
  const [expanded, setExpanded] = useState<string | null>(null)

  const answerRef = useRef('')
  const abortRef = useRef<AbortController | null>(null)

  // 卸载时中断进行中的流
  useEffect(
    () => () =>
    {
      abortRef.current?.abort()
    },
    []
  )

  // 挂载后读取设置（localStorage 仅浏览器可用）；发起请求前会重读一次
  useEffect(
    () =>
    {
      setThinking(getAiThinkingMode())
      setHistory(listAskHistory())
    },
    []
  )

  function stop(): void
  {
    abortRef.current?.abort()
  }

  /** 把历史里的问题填回输入框，让用户可以直接改一改再问 */
  function reask(item: AskRecord): void
  {
    setQuestion(item.question)
    setSpelling(item.spelling)
    setExpanded(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function clearAll(): void
  {
    if (!window.confirm(`清空 ${history.length} 条问词历史？此操作不可恢复。`))
    {
      return
    }

    setHistory(clearAskHistory())
    setExpanded(null)
    // 当前回答本来也存进了历史，一起清掉，避免「历史空了但答案还挂在上面」
    answerRef.current = ''
    setAnswer('')
  }

  async function submit(): Promise<void>
  {
    const text = question.trim()

    if (!text || busy)
    {
      return
    }

    // 每次发起前重读设置：用户可能在别的标签页刚改过
    const mode = getAiThinkingMode()

    if (!mode)
    {
      setError('请先到「设置 → AI 思考模式」选择开或关，再发起提问')
      setThinking(null)
      return
    }

    setBusy(true)
    setError(null)
    answerRef.current = ''
    setAnswer('')

    const controller = new AbortController()
    abortRef.current = controller

    try
    {
      await askStream(
        text,
        spelling.trim() || undefined,
        mode === 'on',
        (delta) =>
        {
          answerRef.current += delta
          setAnswer(answerRef.current)
        },
        controller.signal
      )
    }
    catch (err)
    {
      // 用户主动停止不算错误
      if (err instanceof DOMException && err.name === 'AbortError')
      {
        // 忽略
      }
      else if (err instanceof AiAuthError)
      {
        // Key 失效：给可执行的下一步，而不是把 HTTP 401 甩给用户
        setError('DeepSeek Key 已失效或无效，请到「设置」页重新填写')
      }
      else
      {
        setError(err instanceof Error ? err.message : '请求失败，请稍后重试')
      }
    }
    finally
    {
      if (abortRef.current === controller)
      {
        abortRef.current = null
      }

      setBusy(false)

      // 有内容就落历史：正常结束、用户主动停止、中途失败但已吐出部分答案，
      // 都值得留下——问过一次的问题不该因为没答完就被丢掉
      const finalAnswer = answerRef.current.trim()

      if (finalAnswer)
      {
        const next = addAskRecord({
          question: text,
          spelling: spelling.trim(),
          answer: finalAnswer,
          thinking: mode === 'on' ? 'on' : 'off',
          at: new Date().toISOString()
        })

        setHistory(next)
        // 历史里那条保持折叠：答案仍留在上方的回答卡里，展开会变成同屏两份
        setExpanded(null)
      }
    }
  }

  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader
        title="问词"
        description="回答结合你的真实学习数据；涉及词根、词源的说明属于推测"
      />

      <Tile index={0} hover={false} className="md:sticky md:top-0 md:z-20">
        <form
          onSubmit={(event) =>
          {
            event.preventDefault()
            void submit()
          }}
        >
          <label htmlFor="spelling" className="block text-[length:var(--text-sm)]">
            涉及单词（可选）
          </label>
          <input
            id="spelling"
            value={spelling}
            maxLength={64}
            onChange={(event) => setSpelling(event.target.value)}
            placeholder="例如：affect"
            className="mt-2 h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 font-[family-name:var(--font-mono)] text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
          />

          <label htmlFor="question" className="mt-4 block text-[length:var(--text-sm)]">
            你的问题
          </label>
          <textarea
            id="question"
            required
            rows={3}
            maxLength={500}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="例如：affect 和 effect 怎么区分？"
            className="mt-2 w-full resize-none rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] px-3 py-2.5 text-[length:var(--text-sm)] transition-colors focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-none"
          />
          <p className="mt-1 text-right font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
            {question.length} / 500
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || !question.trim()}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-[var(--color-accent)] px-6 text-[length:var(--text-sm)] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              <Icon name="message" className="h-4 w-4" />
              {busy ? '回答中…' : '发送'}
            </button>
            {busy && (
              <button
                type="button"
                onClick={stop}
                className="inline-flex h-10 items-center rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
              >
                停止
              </button>
            )}
          </div>
        </form>
      </Tile>

      {error && (
        <div className="mt-4">
          <ErrorNote message={error} />
        </div>
      )}

      {answer && (
        <Tile index={1} hover={false} className="mt-4">
          <div className="flex items-start gap-3.5">
            <span
              aria-hidden
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
            >
              <Icon name="zap" className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <Markdown text={answer} />
              {busy && (
                <span
                  aria-hidden
                  className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-[var(--color-accent)] align-middle"
                />
              )}
            </div>
          </div>
          {!busy && (
            <p className="mt-3 border-t border-[var(--color-border)] pt-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              本次问答已存入下方历史，可直接开始下一个问题。
            </p>
          )}
        </Tile>
      )}

      {/* 历史：独立滚动区——页面整体滚动时，这块自己滚，输入框不跟着跑 */}
      <Tile index={2} hover={false} className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-baseline gap-2 text-[length:var(--text-sm)]">
            历史记录
            {history.length > 0 && (
              <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                {history.length} 条
              </span>
            )}
          </p>
          {history.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)] underline-offset-4 transition-colors hover:text-[var(--color-forget)] hover:underline"
            >
              清空
            </button>
          )}
        </div>

        <div className="mt-3 max-h-[52vh] space-y-2 overflow-y-auto overscroll-contain pr-1">
          {history.length === 0 ? (
            <p className="py-10 text-center text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
              还没有提问记录。问过的单词与回答会保存在这里，只存本机。
            </p>
          ) : (
            history.map((item) =>
            {
              const open = expanded === item.id

              return (
                <div
                  key={item.id}
                  className="rounded-md border border-[var(--color-border)]"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : item.id)}
                    className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-[length:var(--text-sm)] leading-snug">
                        {item.question}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                        {item.spelling && (
                          <span className="font-[family-name:var(--font-mono)]">{item.spelling}</span>
                        )}
                        <span>{item.thinking === 'on' ? '深度思考' : '快速回答'}</span>
                        <span>{formatAskTime(item.at)}</span>
                      </p>
                    </div>
                    <Icon
                      name="chevron-right"
                      className={`mt-1 h-4 w-4 shrink-0 text-[var(--color-text-subtle)] transition-transform ${
                        open ? 'rotate-90' : ''
                      }`}
                    />
                  </button>

                  {open && (
                    <div className="border-t border-[var(--color-border)] px-3 py-3">
                      <Markdown text={item.answer} />
                      <div className="mt-3 flex items-center gap-4 text-[length:var(--text-xs)]">
                        <button
                          type="button"
                          onClick={() => reask(item)}
                          className="text-[var(--color-accent)] underline-offset-4 hover:underline"
                        >
                          重新提问
                        </button>
                        <button
                          type="button"
                          onClick={() => setHistory(removeAskRecord(item.id))}
                          className="text-[var(--color-text-subtle)] transition-colors hover:text-[var(--color-forget)]"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </Tile>
    </div>
  )
}
