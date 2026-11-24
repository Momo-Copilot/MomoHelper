'use client'

import Link from 'next/link'

import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import type { ForgetDiagnosis } from '@momo/ai'
import type { FocusWordDto } from '@momo/types'
import { Icon } from '@/components/icons'
import { EmptyTile, ErrorNote, PageHeader, Segmented, Tile, TileSkeleton } from '@/components/kit'
import { WordCardPopover } from '@/components/word-card'
import { diagnoseWord } from '@/lib/ai'
import {
  getDiagnoseHistory,
  saveDiagnosis,
  type DiagnoseRecord
} from '@/lib/diagnose-history'
import { getStickingWords, getTodayForgotten } from '@/lib/maimemo'
import { getAiThinkingMode, type AiThinkingMode } from '@/lib/settings'
import { FORGET_REASON_LABELS as REASON_LABELS } from '@/lib/forget-reason'

type Tab = 'today' | 'sticking'

const EMPTY_COPY: Record<Tab, { title: string; description: string }> = {
  today: {
    title: '今天还没有遗忘的单词',
    description: '复习时点过「忘记」的词会立即出现在这里并支持 AI 诊断，无需等本轮复习完成。'
  },
  sticking: {
    title: '还没有顽固词',
    description: '顽固词来自墨墨官方标记（多次遗忘的词），继续学习后会出现在这里。'
  }
}

function formatTime(iso: string): string
{
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai'
  })
}

/** 可点击单词：点按弹词卡（墨墨自建优先，AI 兜底），点其他位置自动关闭 */
function WordButton({
  spelling,
  className = ''
}: {
  spelling: string
  className?: string
})
{
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <span className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="点击查看词条释义"
        className={`underline decoration-[var(--color-border-strong)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[var(--color-accent)] ${className}`}
      >
        {spelling}
      </button>
      {open && (
        <WordCardPopover
          spelling={spelling}
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  )
}

/** 诊断结果展示（右栏面板 / 移动端展开共用）；onRediagnose 供已诊断的词重新诊断 */
function DiagnosisBody({
  record,
  onRediagnose,
  busy = false
}: {
  record: DiagnoseRecord
  onRediagnose?: () => void
  busy?: boolean
})
{
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <WordButton
          spelling={record.spelling}
          className="font-[family-name:var(--font-display)] text-[length:var(--text-lg)]"
        />
        <span className="flex items-center gap-2">
          <span className="rounded-full bg-[var(--color-vague-bg)] px-2.5 py-0.5 text-[length:var(--text-xs)] font-medium text-[var(--color-vague)]">
            {REASON_LABELS[record.data.reason] ?? record.data.reason}
          </span>
          {onRediagnose && (
            <button
              type="button"
              onClick={onRediagnose}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[length:var(--text-xs)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              <Icon
                name="refresh"
                className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`}
              />
              重新诊断
            </button>
          )}
        </span>
      </div>
      <p className="mt-2.5 text-[length:var(--text-sm)] leading-relaxed">{record.data.explanation}</p>
      <p className="mt-3 rounded-md bg-[var(--color-bg-subtle)] px-3.5 py-2.5 text-[length:var(--text-sm)]">
        <span className="text-[length:var(--text-xs)] font-medium text-[var(--color-familiar)]">
          补救建议
        </span>
        <span className="mt-0.5 block">{record.data.suggestion}</span>
      </p>
      <p className="mt-2.5 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
        {formatTime(record.at)} 诊断{record.thinking ? ' · 深度思考' : ''} · 结果由 AI 推测，仅供参考
      </p>
    </>
  )
}

/** 遗忘词分析：左栏词列表 + 右栏固定诊断面板（master-detail） */
export default function ForgetPage()
{
  const [tab, setTab] = useState<Tab>('today')
  /** 当前选中的词（跨 Tab 保持，切 Tab 不丢） */
  const [selected, setSelected] = useState<string | null>(null)
  /** null = 设置页还没配置过思考模式 */
  const [thinking, setThinking] = useState<AiThinkingMode | null>(null)
  /** 未配置思考模式就点诊断时的提示 */
  const [modeNotice, setModeNotice] = useState<string | null>(null)
  /** 挂载后从 localStorage 载入的诊断历史（spelling 小写 → 记录） */
  const [history, setHistory] = useState<Map<string, DiagnoseRecord>>(new Map())

  useEffect(
    () =>
    {
      setThinking(getAiThinkingMode())

      // 载入历史诊断（spelling 小写 → 记录），已诊断的词直接回看不再请求
      const map = new Map<string, DiagnoseRecord>()

      for (const item of getDiagnoseHistory())
      {
        map.set(item.spelling.toLowerCase(), item)
      }

      setHistory(map)
    },
    []
  )

  const query = useQuery({
    queryKey: ['forget', tab],
    queryFn: () => (tab === 'today' ? getTodayForgotten() : getStickingWords())
  })

  const diagnose = useMutation({
    mutationFn: ({ spelling, thinking }: { spelling: string; thinking: boolean }) =>
      diagnoseWord(spelling, thinking),
    onSuccess: (data, variables) =>
    {
      saveDiagnosis(variables.spelling, data, variables.thinking)
      setHistory((prev) =>
      {
        const next = new Map(prev)
        next.set(variables.spelling.toLowerCase(), {
          spelling: variables.spelling,
          at: new Date().toISOString(),
          thinking: variables.thinking,
          data
        })
        return next
      })
      setSelected(variables.spelling)
    }
  })

  const words: FocusWordDto[] = query.data?.words ?? []

  /** 右栏当前展示的记录：选中词的历史（新诊断完成后 history 即含它） */
  const currentRecord = selected ? history.get(selected.toLowerCase()) : undefined
  /** 选中词是否正在诊断中 */
  const isDiagnosingSelected =
    diagnose.isPending && diagnose.variables?.spelling === selected
  /** 选中词最近一次诊断是否失败 */
  const isFailedSelected = diagnose.isError && diagnose.variables?.spelling === selected

  /** 对指定词发起诊断（点选与重新诊断共用）；思考模式未配置时引导去设置页 */
  function requestDiagnosis(spelling: string): void
  {
    // 每次诊断前重读设置：用户可能刚在设置页改过
    const mode = getAiThinkingMode()

    if (!mode)
    {
      setThinking(null)
      setModeNotice('请先到「设置 → AI 思考模式」选择开或关，再发起诊断')
      return
    }

    setThinking(mode)
    setModeNotice(null)
    diagnose.mutate({ spelling, thinking: mode === 'on' })
  }

  function selectWord(spelling: string): void
  {
    setSelected(spelling)

    if (history.has(spelling.toLowerCase()))
    {
      return
    }

    requestDiagnosis(spelling)
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="遗忘词分析"
        description="点左侧任意词，右侧查看诊断；已诊断的词带勾标记"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              ariaLabel="范围"
              value={tab}
              options={[
                ['today', '今日遗忘'],
                ['sticking', '顽固词']
              ]}
              onChange={(next) =>
              {
                setTab(next)
              }}
            />
            <span className="flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              <Icon name="message" className="h-3.5 w-3.5" />
              思考模式：{thinking ?? '未配置'}
              <Link
                href="/settings"
                className="underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--color-accent)]"
              >
                去设置
              </Link>
            </span>
          </div>
        }
      />

      {query.isPending && <TileSkeleton />}

      {query.isError && (
        <div className="mb-4 space-y-3">
          <ErrorNote
            message={
              query.error instanceof Error ? query.error.message : '加载失败，请稍后重试'
            }
          />
          {/* 公测接口偶发不可用会在这里报错（而不是伪装成空状态）；提供重试入口 */}
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-50"
          >
            <Icon
              name="refresh"
              className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`}
            />
            重新加载
          </button>
        </div>
      )}

      {query.data && (
        <>
          {modeNotice && (
            <div className="mb-4">
              <ErrorNote message={modeNotice} />
            </div>
          )}

          {words.length === 0 ? (
            <EmptyTile title={EMPTY_COPY[tab].title} description={EMPTY_COPY[tab].description} />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              {/* 左栏：词列表（点行选中） */}
              <Tile hover={false} index={1} className="h-fit p-0! overflow-hidden">
                <ul className="divide-y divide-[var(--color-border)]">
                  {words.map((word) =>
                  {
                    const isSticking = word.tags?.includes('STICKING')
                    const record = history.get(word.spelling.toLowerCase())
                    const isSelected = selected?.toLowerCase() === word.spelling.toLowerCase()
                    const isBusy =
                      diagnose.isPending && diagnose.variables?.spelling === word.spelling

                    return (
                      <li key={word.vocId}>
                        <button
                          type="button"
                          onClick={() => selectWord(word.spelling)}
                          aria-current={isSelected ? 'true' : undefined}
                          className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left transition-colors ${
                            isSelected
                              ? 'bg-[var(--color-accent-bg)]'
                              : 'hover:bg-[var(--color-bg-subtle)]'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="font-[family-name:var(--font-display)] text-[length:var(--text-md)]">
                              {word.spelling}
                            </span>
                            {isSticking && (
                              <span className="rounded-full bg-[var(--color-forget-bg)] px-2 py-0.5 text-[length:var(--text-xs)] font-medium text-[var(--color-forget)]">
                                顽固
                              </span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-2.5">
                            <span className="tabular font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                              {typeof word.studyCount === 'number' ? `${word.studyCount} 次` : ''}
                            </span>
                            {record ? (
                              <Icon
                                name="check"
                                className="h-4 w-4 shrink-0 text-[var(--color-familiar)]"
                              />
                            ) : (
                              <span className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                                {isBusy ? '诊断中…' : '诊断 →'}
                              </span>
                            )}
                          </span>
                        </button>

                        {/* 移动端：选中词的诊断就地展开（桌面端由右栏面板承担） */}
                        {isSelected && (
                          <div className="border-t border-[var(--color-border)] px-4 py-4 lg:hidden">
                            {isBusy ? (
                              <TileSkeleton />
                            ) : isFailedSelected ? (
                              <ErrorNote
                                message={
                                  diagnose.error instanceof Error
                                    ? diagnose.error.message
                                    : '诊断失败，请稍后重试'
                                }
                              />
                            ) : record ? (
                              <DiagnosisBody
                                record={record}
                                onRediagnose={() => requestDiagnosis(word.spelling)}
                                busy={
                                  diagnose.isPending &&
                                  diagnose.variables?.spelling === word.spelling
                                }
                              />
                            ) : (
                              <p className="text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
                                准备诊断…
                              </p>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Tile>

              {/* 右栏：固定诊断面板（sticky，点词即换内容，不随列表滚动）。
                  选中词在所有状态下都可点击弹词卡（已诊断时由 DiagnosisBody 承担） */}
              <div className="sticky top-6 hidden h-fit lg:block">
                <Tile hover={false} index={2} className="min-h-[260px]">
                  {isDiagnosingSelected || isFailedSelected ? (
                    <>
                      <WordButton
                        spelling={selected ?? ''}
                        className="font-[family-name:var(--font-display)] text-[length:var(--text-lg)]"
                      />
                      {isDiagnosingSelected ? (
                        <div className="mt-3">
                          <div className="h-4 w-full animate-pulse rounded-sm bg-[var(--color-bg-subtle)]" />
                          <div className="mt-2.5 h-4 w-4/5 animate-pulse rounded-sm bg-[var(--color-bg-subtle)]" />
                          <div className="mt-2.5 h-4 w-3/5 animate-pulse rounded-sm bg-[var(--color-bg-subtle)]" />
                          <p className="mt-3 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                            诊断中{diagnose.variables?.thinking ? '（深度思考，可能较慢）' : ''}…
                          </p>
                        </div>
                      ) : (
                        <div className="mt-3">
                          <ErrorNote
                            message={
                              diagnose.error instanceof Error
                                ? diagnose.error.message
                                : '诊断失败，请稍后重试'
                            }
                          />
                          {selected && (
                            <button
                              type="button"
                              onClick={() => requestDiagnosis(selected)}
                              className="mt-3 inline-flex h-8 items-center rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
                            >
                              重试
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : currentRecord ? (
                    <DiagnosisBody
                      record={currentRecord}
                      onRediagnose={() => selected && requestDiagnosis(selected)}
                      busy={
                        diagnose.isPending && diagnose.variables?.spelling === selected
                      }
                    />
                  ) : selected ? (
                    <>
                      <WordButton
                        spelling={selected}
                        className="font-[family-name:var(--font-display)] text-[length:var(--text-lg)]"
                      />
                      <p className="mt-3 text-[length:var(--text-sm)] text-[var(--color-text-subtle)]">
                        {history.has(selected.toLowerCase())
                          ? '正在载入历史诊断…'
                          : '尚未诊断，点左侧词触发诊断；上方单词可点开词条'}
                      </p>
                    </>
                  ) : (
                    <div className="flex h-40 flex-col items-center justify-center text-center">
                      <Icon name="trending-down" className="h-7 w-7 text-[var(--color-text-subtle)]" />
                      <p className="mt-2.5 text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
                        点击左侧任意词开始诊断
                      </p>
                      <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                        已诊断过的词会直接显示历史结果，不再重复请求
                      </p>
                    </div>
                  )}
                </Tile>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
