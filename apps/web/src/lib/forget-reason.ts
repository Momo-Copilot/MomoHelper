/**
 * 遗忘原因枚举的中文标签。
 *
 * 与 @momo/ai 的 forgetReasonSchema 一一对应；抽出来是因为遗忘页、攻坚台、
 * 熟词僻义专题都要用同一套措辞，分散定义迟早会不一致。
 */
export const FORGET_REASON_LABELS: Record<string, string> = {
  SPELLING_SIMILAR: '拼写相似',
  ABSTRACT_MEANING: '词义抽象',
  RARE_SENSE: '熟词僻义',
  CN_MEANING_CONFLICT: '中文释义混淆',
  COLLOCATION_WEAK: '搭配不熟',
  ROOT_DIVERGENCE: '词根分叉',
  LACK_CONTEXT: '缺少语境'
}

/** 未知 reason 兜底：AI 偶尔会返回枚举外的值，不要因此显示 undefined */
export function forgetReasonLabel(reason: string): string
{
  return FORGET_REASON_LABELS[reason] ?? '其他原因'
}
