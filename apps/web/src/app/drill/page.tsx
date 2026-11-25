'use client'

/**
 * 顽固词攻坚：每天 6 个最该练的词，连续答对 3 次就毕业。
 *
 * 结果只存本机——墨墨没有回写复习结果的接口，这里练得再好也不会改变墨墨的
 * 复习安排。页面上必须把这点写清楚，否则容易误以为练完就等于记住了。
 *
 * 批次在进入页面时算一次就固定：练到一半 store 变了不该让名单重排，
 * 否则正在看的词会突然跳走。
 */

import { MaimemoAuthError, createNote, deleteNote, findNoteByBody } from '@momo/maimemo'
import { useMutation, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import type { FocusWordDto } from '@momo/types'
import { Icon } from '@/components/icons'
import { PageHeader, Tile, TileSkeleton } from '@/components/kit'
import { diagnoseWord } from '@/lib/ai'
import {
  DAILY_GOAL,
  GRADUATE_STREAK,
  clearNote,
  countOutcome,
  dayCounts,
  drillSummary,
  isGraduated,
  loadDrill,
  pickTodayWords,
  recordDiagnosis,
  recordNote,
  recordOutcome,
  saveDrill,
  streakToGo,
  type DrillOutcome,
  type DrillStore
} from '@/lib/drill'
import { forgetReasonLabel } from '@/lib/forget-reason'
import {
  getMaimemoClient,
  getStickingWords,
  getTodayForgotten,
  MaimemoNotConfiguredError
} from '@/lib/maimemo'
import { getAiThinkingMode } from '@/lib/settings'

const RESPONSE_LABEL: Record<string, string> = {
  FORGET: '最近答错',
  VAGUE: '最近模糊',
  FAMILIAR: '最近认识'
}

const OUTCOME_META: Record<DrillOutcome, { label: string; hint: string; className: string }> = {
  know: {
    label: '认识',
    hint: '记得住，再练两次就毕业',
    className:
      'border-[var(--color-familiar)]/40 bg-[var(--color-familiar-bg)] text-[var(--color-familiar)] hover:border-[var(--color-familiar)]'
  },
  vague: {
    label: '模糊',
    hint: '看着眼熟但说不清',
    className:
      'border-[var(--color-vague)]/40 bg-[var(--color-vague-bg)] text-[var(--color-vague)] hover:border-[var(--color-vague)]'
  },
  forget: {
    label: '忘记',
    hint: '完全没印象，明天还来',
    className:
      'border-[var(--color-forget)]/40 bg-[var(--color-forget-bg)] text-[var(--color-forget)] hover:border-[var(--color-forget)]'
  }
}

/**
 * 写入墨墨时的助记类型。
 *
 * spec 里 note_type 是自由字符串（无枚举约束），但示例写的是「谐音.」——
 * 带一个尾随句点。实测传自定义值（如「墨小墨」）会返回 common_internal_error，
 * 所以这里按墨墨 APP 里的标准类型「联想」先试，失败再回退带句点的写法。
 * 两种都失败就该怀疑是别的原因（配额、词 id、服务端故障），不要再猜类型。
 */
const NOTE_TYPES = ['联想', '联想.'] as const

/** 助记正文上限：spec 没写 maxLength，但服务端可能有限制，超长直接截断 */
const NOTE_MAX = 280

export default function DrillPage()
{
  const [store, setStore] = useState<DrillStore>({ words: {} })
  const [ready, setReady] = useState(false)
  const [batch, setBatch] = useState<FocusWordDto[]>([])
  const [index, setIndex] = useState(0)
  const [diagError, setDiagError] = useState<string | null>(null)
  /** idle = 未操作，confirm = 等二次确认，busy = 请求中 */
  const [writeState, setWriteState] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const [noteError, setNoteError] = useState<string | null>(null)

  // 与遗忘词页共用 queryKey，从那边切过来零请求
  const sticking = useQuery({ queryKey: ['forget', 'sticking'], queryFn: getStickingWords })
  const forgotten = useQuery({ queryKey: ['forget', 'today'], queryFn: getTodayForgotten })

  useEffect(
    () =>
    {
      setStore(loadDrill())
      setReady(true)
    },
    []
  )

  /** 候选池：顽固词 + 今日遗忘词去重 */
  const candidates = useMemo(
    () =>
    {
      const map = new Map<string, FocusWordDto>()

      for (const word of [...(sticking.data?.words ?? []), ...(forgotten.data?.words ?? [])])
      {
        if (!map.has(word.vocId))
        {
          map.set(word.vocId, word)
        }
      }

      return [...map.values()]
    },
    [sticking.data, forgotten.data]
  )

  useEffect(
    () =>
    {
      if (!ready || batch.length > 0 || candidates.length === 0)
      {
        return
      }

      setBatch(pickTodayWords(candidates, loadDrill()))
    },
    [ready, batch.length, candidates]
  )

  const current: FocusWordDto | null = batch[index] ?? null
  const currentState = current ? store.words[current.vocId] : undefined

  const diagMutation = useMutation({
    mutationFn: (word: FocusWordDto) => diagnoseWord(word.spelling, getAiThinkingMode() === 'on'),
    onSuccess: (data, word) =>
    {
      setStore((prev) =>
      {
        const next = recordDiagnosis(prev, word, {
          reason: data.reason,
          explanation: data.explanation,
          suggestion: data.suggestion,
          at: new Date().toISOString()
        })
        saveDrill(next)
        return next
      })
    },
    onError: (error) =>
    {
      setDiagError(error instanceof Error ? error.message : '诊断失败，稍后再试')
    }
  })

  function answer(outcome: DrillOutcome): void
  {
    if (!current)
    {
      return
    }

    setStore((prev) =>
    {
      const next = recordOutcome(prev, current, outcome)
      saveDrill(next)
      return next
    })

    setIndex((value) => value + 1)
    setDiagError(null)
  }

  /**
   * 写入墨墨助记——全站唯一会改动用户墨墨数据的操作，所以：
   * 只写建议这一句、走二次确认、写完记住 note id 以便随时撤回。
   */
  async function writeNote(): Promise<void>
  {
    if (!current || !currentState?.diagnosis || writeState === 'busy')
    {
      return
    }

    setWriteState('busy')
    setNoteError(null)

    const raw = `【墨小墨】${currentState.diagnosis.suggestion}`
    const body = raw.length > NOTE_MAX ? `${raw.slice(0, NOTE_MAX)}…` : raw
    const client = getMaimemoClient()

    let created: { id: string } | null = null
    let failure: unknown = null

    // 类型不被接受时墨墨返回的是 500 而不是参数错误，没法从错误码区分，
    // 只能按顺序试：APP 标准类型 → 带句点的写法。
    //
    // 但「500」也可能是「其实写进去了，只是响应没回来」。直接换类型重试会写出
    // 两条，而本地只记得住最后一条 id，第一条就撤回不了——所以每次失败先按
    // 正文核对一次，已写入就当成功；401 则直接中止（换类型也还是 401）。
    for (const noteType of NOTE_TYPES)
    {
      try
      {
        created = await createNote(client, { vocId: current.vocId, noteType, note: body })
        break
      }
      catch (error)
      {
        failure = error

        if (error instanceof MaimemoAuthError)
        {
          break
        }

        try
        {
          const existing = await findNoteByBody(client, current.vocId, body)

          if (existing)
          {
            created = existing
            break
          }
        }
        catch
        {
          // 核对失败不改变结论：带着原始错误继续下一个类型
        }
      }
    }

    if (created)
    {
      const createdId = created.id

      setStore((prev) =>
      {
        const next = recordNote(prev, current, createdId)
        saveDrill(next)
        return next
      })
    }
    else
    {
      setNoteError(
        failure instanceof Error
          ? `${failure.message}（已试过类型：${NOTE_TYPES.join(' / ')}）`
          : '写入失败'
      )
    }

    setWriteState('idle')
  }

  async function undoNote(): Promise<void>
  {
    if (!current || !currentState?.noteId || writeState === 'busy')
    {
      return
    }

    setWriteState('busy')
    setNoteError(null)

    try
    {
      await deleteNote(getMaimemoClient(), currentState.noteId)

      setStore((prev) =>
      {
        const next = clearNote(prev, current.vocId)
        saveDrill(next)
        return next
      })
    }
    catch (error)
    {
      setNoteError(error instanceof Error ? error.message : '撤回失败')
    }
    finally
    {
      setWriteState('idle')
    }
  }

  const loading = sticking.isPending || forgotten.isPending || !ready
  const failed = sticking.isError || forgotten.isError
  const summary = useMemo(() => drillSummary(store), [store])
  const today = useMemo(() => dayCounts(store), [store])

  if (loading)
  {
    return (
      <div>
        <PageHeader title="顽固词攻坚" description="正在挑今天该练的词…" />
        <div className="grid grid-cols-12 gap-4">
          <TileSkeleton className="col-span-12" />
        </div>
      </div>
    )
  }

  if (failed)
  {
    const error = sticking.error ?? forgotten.error
    const needSetup =
      error instanceof MaimemoNotConfiguredError || error instanceof MaimemoAuthError

    return (
      <div>
        <PageHeader title="顽固词攻坚" />
        <Tile hover={false} className="mt-10 text-center">
          <Icon name="alert" className="mx-auto h-8 w-8 text-[var(--color-vague)]" />
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
            {needSetup ? '需要先配置墨墨 Token' : '加载失败'}
          </h1>
          <p className="mx-auto mt-1 max-w-md text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
            {error instanceof MaimemoNotConfiguredError
              ? '尚未绑定墨墨 Token，绑定后才能取出顽固词。'
              : error instanceof MaimemoAuthError
                ? '墨墨 Token 已失效，请到设置页重新绑定。'
                : error instanceof Error
                  ? error.message
                  : '未知错误'}
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
                onClick={() =>
                {
                  void sticking.refetch()
                  void forgotten.refetch()
                }}
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

  const empty = batch.length === 0
  const finished = batch.length > 0 && index >= batch.length

  return (
    <div>
      <PageHeader
        title="顽固词攻坚"
        description={`每天 ${DAILY_GOAL} 个 · 连续答对 ${GRADUATE_STREAK} 次毕业 · 记录只存本机`}
        actions={
          <Link
            href="/forget"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-4 text-[length:var(--text-sm)] transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            看全部顽固词
          </Link>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <Tile index={0} hover={false} className="col-span-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <p className="text-[length:var(--text-sm)] text-[var(--color-text-muted)]">今日进度</p>
              <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-md)] tabular">
                {Math.min(index, batch.length)} / {batch.length || DAILY_GOAL}
              </p>
            </div>
            <div className="flex items-center gap-4 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
              <span>已攻下 {summary.graduated}</span>
              <span>在练 {summary.practicing}</span>
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
              style={{ width: `${batch.length === 0 ? 0 : (Math.min(index, batch.length) / batch.length) * 100}%` }}
            />
          </div>
        </Tile>

        {/* 主导区：当前词 / 空态 / 结算 */}
        <Tile index={1} hover={false} className="col-span-12">
          {empty && (
            <div className="py-10 text-center">
              <Icon name="check" className="mx-auto h-8 w-8 text-[var(--color-familiar)]" />
              <p className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
                没有需要攻坚的词
              </p>
              <p className="mx-auto mt-2 max-w-sm text-[length:var(--text-sm)] text-[var(--color-text-muted)]">
                顽固词是按墨墨打的 STICKING 标签算的。等你攒下更多复习记录，这里会有东西练。
              </p>
            </div>
          )}

          {finished && (
            <div className="py-8 text-center">
              <Icon name="check" className="mx-auto h-8 w-8 text-[var(--color-familiar)]" />
              <p className="mt-3 font-[family-name:var(--font-display)] text-[length:var(--text-lg)]">
                今天这 {batch.length} 个练完了
              </p>
              <div className="mt-4 flex justify-center gap-6 text-[length:var(--text-sm)]">
                <span className="text-[var(--color-familiar)]">认识 {today.know}</span>
                <span className="text-[var(--color-vague)]">模糊 {today.vague}</span>
                <span className="text-[var(--color-forget)]">忘记 {today.forget}</span>
              </div>
              <p className="mx-auto mt-4 max-w-md text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
                连续 {GRADUATE_STREAK} 次答「认识」才会从攻坚台消失。这些记录只存在本机，
                不会改变墨墨那边的复习安排——真正的巩固还是靠墨墨的计划。
              </p>
              <div className="mt-5 flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                  {
                    setIndex(0)
                    setBatch(pickTodayWords(candidates, store))
                  }}
                  className="inline-flex h-9 items-center rounded-md border border-[var(--color-border-strong)] px-5 text-[length:var(--text-sm)] hover:bg-[var(--color-bg-subtle)]"
                >
                  再来一轮
                </button>
                <Link
                  href="/forget"
                  className="inline-flex h-9 items-center rounded-md bg-[var(--color-accent)] px-5 text-[length:var(--text-sm)] font-medium text-white hover:bg-[var(--color-accent-hover)]"
                >
                  看遗忘词
                </Link>
              </div>
            </div>
          )}

          {current && !finished && (
            <div>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="break-words font-[family-name:var(--font-display)] text-[length:var(--text-3xl)] leading-tight">
                    {current.spelling}
                  </p>
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                    {typeof current.studyCount === 'number' && (
                      <span>学习 {current.studyCount} 次</span>
                    )}
                    {current.lastResponse && (
                      <span
                        className={
                          current.lastResponse === 'FORGET'
                            ? 'text-[var(--color-forget)]'
                            : current.lastResponse === 'VAGUE'
                              ? 'text-[var(--color-vague)]'
                              : 'text-[var(--color-familiar)]'
                        }
                      >
                        {RESPONSE_LABEL[current.lastResponse] ?? ''}
                      </span>
                    )}
                    {current.tags.includes('STICKING') && (
                      <span className="rounded-sm bg-[var(--color-forget-bg)] px-1.5 py-0.5 text-[var(--color-forget)]">
                        顽固词
                      </span>
                    )}
                    {countOutcome(currentState, 'forget') > 0 && (
                      <span>在攻坚台忘过 {countOutcome(currentState, 'forget')} 次</span>
                    )}
                  </p>
                </div>
                <p className="shrink-0 text-right text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                  还差 {streakToGo(currentState)} 次
                  <br />
                  连续认识
                </p>
              </div>

              {/* AI 诊断：点了才生成，结果按词缓存，不重复烧 token */}
              <div className="mt-5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
                {currentState?.diagnosis ? (
                  <div>
                    <p className="flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                      <span className="rounded-sm bg-[var(--color-surface)] px-1.5 py-0.5 text-[var(--color-text-muted)]">
                        {forgetReasonLabel(currentState.diagnosis.reason)}
                      </span>
                      为什么老忘
                    </p>
                    <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed">
                      {currentState.diagnosis.explanation}
                    </p>
                    <p className="mt-1.5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-muted)]">
                      建议：{currentState.diagnosis.suggestion}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                      想不出为什么记不住？让 AI 结合学习记录分析一下
                    </p>
                    <button
                      type="button"
                      onClick={() => diagMutation.mutate(current)}
                      disabled={diagMutation.isPending}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[length:var(--text-xs)] transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
                    >
                      <Icon name="zap" className="h-3.5 w-3.5" />
                      {diagMutation.isPending ? '分析中…' : '分析原因'}
                    </button>
                  </div>
                )}
                {currentState?.diagnosis && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2">
                    {currentState.noteId ? (
                      <>
                        <span className="flex items-center gap-1 text-[length:var(--text-xs)] text-[var(--color-familiar)]">
                          <Icon name="check" className="h-3.5 w-3.5" />
                          已写入墨墨助记
                        </span>
                        <button
                          type="button"
                          onClick={() => void undoNote()}
                          disabled={writeState === 'busy'}
                          className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)] underline underline-offset-2 hover:text-[var(--color-text)] disabled:opacity-50"
                        >
                          撤回
                        </button>
                      </>
                    ) : writeState === 'confirm' ? (
                      <>
                        <span className="text-[length:var(--text-xs)] text-[var(--color-text-muted)]">
                          写进墨墨的助记，手机 APP 同步可见，之后能撤回
                        </span>
                        <button
                          type="button"
                          onClick={() => void writeNote()}
                          className="rounded-sm bg-[var(--color-accent)] px-2 py-1 text-[length:var(--text-xs)] font-medium text-white"
                        >
                          确认写入
                        </button>
                        <button
                          type="button"
                          onClick={() => setWriteState('idle')}
                          className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)] hover:text-[var(--color-text)]"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setWriteState('confirm')}
                        className="text-[length:var(--text-xs)] text-[var(--color-accent)] underline underline-offset-2 hover:text-[var(--color-accent-hover)]"
                      >
                        写入墨墨助记
                      </button>
                    )}
                    {writeState === 'busy' && (
                      <span className="text-[length:var(--text-xs)] text-[var(--color-text-subtle)]">
                        处理中…
                      </span>
                    )}
                  </div>
                )}
                {noteError && (
                  <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-forget)]">{noteError}</p>
                )}
                {diagError && (
                  <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-forget)]">{diagError}</p>
                )}
              </div>

              {/* 自测：三个按钮就是全部交互，别加弹窗 */}
              <div className="mt-5 grid grid-cols-3 gap-2">
                {(['forget', 'vague', 'know'] as DrillOutcome[]).map((outcome) => (
                  <button
                    key={outcome}
                    type="button"
                    onClick={() => answer(outcome)}
                    className={`flex flex-col items-center gap-0.5 rounded-md border px-2 py-3 transition-colors ${OUTCOME_META[outcome].className}`}
                  >
                    <span className="text-[length:var(--text-sm)] font-medium">
                      {OUTCOME_META[outcome].label}
                    </span>
                    <span className="text-[11px] opacity-75">{OUTCOME_META[outcome].hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </Tile>

        <p className="col-span-12 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-subtle)]">
          名单来源：墨墨打了 STICKING 标签的顽固词 + 今天点过「忘记」的词。排序按「今天还没练」
          → 遗忘次数 → 最近表现 → 学习次数。连续 {GRADUATE_STREAK} 次答「认识」自动毕业，
          中间答错会重新计数。
        </p>
      </div>
    </div>
  )
}
