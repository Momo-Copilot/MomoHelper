/**
 * 三件核心功能用到的共享类型。
 * 墨墨 API 字段保持服务端原样（snake_case），页面 DTO 用 camelCase。
 */

/* ============================= 墨墨 API 域 ============================= */

/** 今日作答结果 */
export type StudyResponse = 'FORGET' | 'VAGUE' | 'FAMILIAR'

/** 单词级标签：实测为字符串数组，多数为空数组 */
export type StudyRecordTag = 'STICKING' | 'WELL_FAMILIAR'

/** 墨墨响应统一包裹层 */
export interface MaimemoEnvelopeError
{
  code: string
  msg: string
  info: string
}

export interface MaimemoEnvelope<T>
{
  errors: MaimemoEnvelopeError[]
  data: T
  success: boolean
}

/** 今日进度（单点快照）。study_time 为毫秒。 */
export interface MaimemoStudyProgress
{
  finished: number
  total: number
  study_time: number
}

/** 今日单词条目 */
export interface MaimemoStudyTodayItem
{
  voc_id: string
  voc_spelling: string
  order: number
  first_response?: StudyResponse
  is_new: boolean
  is_finished: boolean
}

/** 单词级学习记录。日期字段按 UTC+8 日期边界存储。 */
export interface MaimemoStudyRecord
{
  voc_id: string
  voc_spelling: string
  add_date?: string
  first_study_date?: string
  last_study_date?: string
  next_study_date?: string
  last_response?: StudyResponse
  /** 学习次数（每日最多计入 1 次） */
  study_count: number
  tags: StudyRecordTag[]
}

/** 云词本（目前仅用于校验 Token，列表条目可能不含 content） */
export interface MaimemoNotepad
{
  id: string
  title: string
  content: string
  tags?: string[]
}

/* ============================= 页面 DTO ============================= */

/** 今日词表明细行（今日页面词表卡用） */
export interface TodayWordRowDto
{
  vocId: string
  spelling: string
  order: number
  isNew: boolean
  isFinished: boolean
  firstResponse?: StudyResponse
}

/** 今日看板 */
export interface DashboardTodayDto
{
  total: number
  finished: number
  remaining: number
  studyTimeMs: number
  /** total = 0 时返回 null，不出现除零 */
  completionRate: number | null
  /**
   * 今日四分项。null = 这一项拿不到（不是 0）：
   * 学习接口不可用时降级到本地快照，而快照不存逐词明细，无法回算这四个数。
   * UI 必须区分「0 个」和「不知道」，否则会把接口故障显示成「今天没学」。
   */
  newWords: number | null
  reviewWords: number | null
  unfinishedWords: number | null
  forgottenWords: number | null
  dataReliable: boolean
  capturedAt: string
  /** 今日词表明细（dataReliable = false 时为空——快照不存词表） */
  todayWords: TodayWordRowDto[]
}

/** 需要关注的单词条目（看板 / 遗忘词列表共用） */
export interface FocusWordDto
{
  vocId: string
  spelling: string
  isNew: boolean
  firstResponse?: StudyResponse
  lastResponse?: StudyResponse
  studyCount?: number
  tags: StudyRecordTag[]
}

/** 学习趋势单日数据点（来自 localStorage 每日快照） */
export interface DashboardTrendPointDto
{
  /** 北京时区日期，YYYY-MM-DD */
  date: string
  finished: number
  total: number
  studyTimeMs: number
  isReliable: boolean
}

/** 学习趋势序列 */
export interface DashboardHistoryDto
{
  days: DashboardTrendPointDto[]
}

/* ============================= 词库 ============================= */

/** 词库词表行：query_study_records 全字段的 camelCase 版 */
export interface LibraryRecordRowDto
{
  vocId: string
  spelling: string
  /** 学习次数（每日最多计 1 次） */
  studyCount: number
  lastResponse?: StudyResponse
  tags: StudyRecordTag[]
  addDate?: string
  firstStudyDate?: string
  lastStudyDate?: string
  nextStudyDate?: string
}

/** 通用计数桶（掌握度分桶 / 标签分布 / 作答分布共用） */
export interface LibraryBucketDto
{
  key: string
  label: string
  count: number
  /** 占总数比例，total = 0 时为 0 */
  ratio: number
}

/** 词库月度聚合行 */
export interface LibraryMonthRowDto
{
  /** YYYY-MM */
  month: string
  /** 当月加入词数（add_date） */
  added: number
  /** 当月首次学习词数（first_study_date） */
  firstStudied: number
  /** 首学 / 加入；当加入为 0 时 null */
  retention: number | null
  /** 截至该月累计加入词数 */
  cumulative: number
}

/** 词库聚合结果（只存聚合、不存原始记录时用；当前页面直接用原始记录现算） */
export interface LibraryStatsDto
{
  total: number
  /** 平均学习次数，保留一位小数 */
  avgStudyCount: number
  /** 只学过 1 次的词数 */
  singleStudyCount: number
  /** 带 STICKING 标签的词数 */
  stickingCount: number
  countBuckets: LibraryBucketDto[]
  tagBuckets: LibraryBucketDto[]
  responseBuckets: LibraryBucketDto[]
  months: LibraryMonthRowDto[]
}

/** 全量拉取结果元信息 */
export interface LibrarySnapshotDto
{
  records: LibraryRecordRowDto[]
  /** 接口 as_count 返回的总词数；拿不到时为 null */
  total: number | null
  /** 是否翻页取全（false 说明被分页边界或安全阀截断） */
  complete: boolean
  /** ISO 时间戳 */
  fetchedAt: string
}

/* ============================= 复习间隔 ============================= */

/**
 * 复习间隔分桶。
 *
 * 间隔 = next_study_date − last_study_date，即墨墨给这个词排的复习周期。
 * 它是 SRS 的核心输出：间隔越长，说明系统判定这个词记得越稳。
 */
export interface IntervalBucketDto
{
  key: string
  label: string
  min: number
  max: number
  count: number
  /** 该桶内学习次数的中位数（看清「背了多少次才到这个间隔」） */
  medianStudyCount: number
  /** 最近一次作答为「熟知 + 认识」的占比；无作答样本为 null */
  rememberedRate: number | null
  /** 每个词距今天数中位数，用于提示桶内是否大量已过期 */
  medianDaysSinceStudy: number | null
}

/** 间隔停滞词：背了很多次，间隔却一直上不去 */
export interface StalledWordDto
{
  vocId: string
  spelling: string
  studyCount: number
  intervalDays: number
  /** 距上次学习天数 */
  daysSinceStudy: number | null
  lastResponse: string | null
  tags: string[]
}

/** 复习间隔分析结果 */
export interface IntervalAnalysisDto
{
  /** 可计算间隔的词数（last 与 next 都存在且间隔非负） */
  measurable: number
  buckets: IntervalBucketDto[]
  /** 全库间隔中位数（天） */
  medianInterval: number | null
  /** 间隔停滞词（背 ≥5 次且间隔 ≤7 天），按学习次数降序 */
  stalled: StalledWordDto[]
  /** 停滞词的判定阈值，页面上要写明，避免用户以为这是官方口径 */
  stalledThreshold: { minStudyCount: number; maxIntervalDays: number }
}

/* ============================= 学情快照 ============================= */

/** 学情快照日粒度行 */
export interface ReportDailyRowDto
{
  /** 北京时间 YYYY-MM-DD */
  date: string
  /** 当天开始学习的词数（first_study_date 缺失时按 add_date 计） */
  count: number
}

/** 学情风险摘要（报告页风险区与看板入口卡共用） */
export interface ReportRiskDto
{
  /** 沉睡词数：距上次学习 >= 30 天的已学词 */
  sleepingCount: number
  /** 沉睡分桶（已学词数作分母）：7–13 / 14–29 / 30–59 / 60+ 天未碰 */
  sleepingBuckets: LibraryBucketDto[]
  /** 未学新词区间（连续 >= 3 天没有新词首次学习），按时间升序；复习不算 */
  gaps: { start: string; end: string; days: number }[]
  /** 最长连续未学新词天数；无则为 0 */
  maxGapDays: number
  /** 未来复习峰值日（并列取最早一天）；无未来安排为 null */
  reviewPeak: { date: string; count: number } | null
  /** 未来 7 / 14 / 30 天内（含今天到期）待复习词数 */
  reviewUpcoming: { within7: number; within14: number; within30: number }
  /** 已开始学习但未安排复习的词数（next_study_date 缺失） */
  unscheduledCount: number
}

/** 学情快照聚合（/report 页用；画像基础数字复用 LibraryStatsDto） */
export interface ReportSnapshotDto
{
  /** 数据充分度档位：few = 跨度 < 7 天，some = 7~29 天，rich = >= 30 天 */
  tier: 'few' | 'some' | 'rich'
  /** 首学数据跨度（最早开始日到今天的天数）；无日期数据为 0 */
  spanDays: number
  /** 最早 / 最晚开始学习日（YYYY-MM-DD）；无日期数据为 null */
  firstDay: string | null
  latestDay: string | null
  /** 日粒度新学曲线（最早开始日 → 今天，含 0 值天与全部历史） */
  dailyNew: ReportDailyRowDto[]
  /**
   * 每日「涉猎词数」：首学 + 最后学习去重，用于热力图。
   *
   * 与 dailyNew 的区别：dailyNew 只数「第一次学某个词」的日子，只复习旧词的
   * 一天会是 0；这里把 last_study_date 也算进来，能反映「那天确实碰过单词」。
   * 注意它仍是下界——一个词只在最后一次学习那天记一笔。
   */
  dailyTouched: ReportDailyRowDto[]
  risk: ReportRiskDto
}

/* ============================= 冲刺计划 ============================= */

/**
 * 未来单日复习负荷。
 *
 * level 是窗口内相对分档（不是绝对阈值）：词库规模从每天几十到几百都有，
 * 绝对阈值会让小词库永远是最浅一档。空档单独为 0，不参与分位计算。
 */
export interface ForecastDayDto
{
  /** 北京时间 YYYY-MM-DD */
  date: string
  /** 当日待复习词数（next_study_date 落在这一天） */
  count: number
  /** 0 = 空档；1~4 由窗口内非零日的分位决定 */
  level: 0 | 1 | 2 | 3 | 4
  /** 相对今天第几天（0 = 今天），用于日历定位 */
  offset: number
}

/** 未来复习负荷（/plan 负荷日历） */
export interface ForecastDto
{
  /** 窗口内逐日，含今天与 0 值天，按日期升序 */
  days: ForecastDayDto[]
  /** 窗口内待复习总数 */
  totalInWindow: number
  /** 峰值日（并列取最早）；窗口全空为 null */
  peak: { date: string; count: number } | null
  /** 有负荷日的均值（不含空档，避免被空档摊薄） */
  busyAverage: number
  /** 空档日数（count === 0） */
  idleDays: number
  /** 复习日期已过（早于今天）的词数：积压量 */
  overdueCount: number
  /** 带下一次复习日期的词总数（含已过期），口径说明用 */
  scheduledCount: number
}

/** 冲刺推演：考试日期与词库进度的对照 */
export interface ExamPlanDto
{
  /** 考试日期 YYYY-MM-DD；未设置为 null */
  examDate: string | null
  /** 今天到考试日的天数；考试当天为 0，已过期为负数；未设置为 null */
  daysLeft: number | null
  /** 词库总词数 */
  totalWords: number
  /** 已开始学习（study_count > 0） */
  studiedWords: number
  /** 还没开始学习 */
  remainingWords: number
  /** 近 14 天日均新学词数 */
  recentPace: number
  /** 考前过完需要每天新学多少；无考试日期或已过期 null */
  dailyNeeded: number | null
  /** 缺口 = dailyNeeded − recentPace，> 0 表示当前速度不够 */
  gap: number | null
  /** 按当前速度学完剩余词需要多少天；速度为 0 为 null */
  daysToFinish: number | null
  /** 按当前速度预计全部学完的日期；无法估算 null */
  projectedFinish: string | null
  /** ahead = 能提前过完，on-track = 差 15% 以内，behind = 明显落后，unknown = 缺数据 */
  status: 'ahead' | 'on-track' | 'behind' | 'unknown'
}

/** 计划页的风险 / 建议条目 */
export interface PlanAlertDto
{
  /** 用于去重与 React key */
  kind: 'peak-near-exam' | 'peak' | 'behind' | 'overdue' | 'idle' | 'ahead'
  tone: 'risk' | 'warn' | 'info' | 'ok'
  title: string
  detail: string
}

/* ============================= 遗忘词云 ============================= */

/**
 * 词云单词。墨墨不提供逐次作答历史，「遗忘次数」拿不到，
 * 这里用综合遗忘强度分代替：颜色档位与字号都来自同一个分数。
 */
export interface WordCloudWordDto
{
  vocId: string
  spelling: string
  /** 综合遗忘强度 0–100（口径见 analyze.ts buildWordCloud 注释） */
  score: number
  /** 色阶档位 0–4，越大越深 */
  tier: number
  /** 渲染字号（px） */
  size: number
  studyCount: number
  lastResponse?: StudyResponse
  /** 最近学习日（北京时间 YYYY-MM-DD） */
  lastStudyDate?: string
  /** 是否带墨墨 STICKING 标签 */
  sticking: boolean
}

export interface WordCloudDto
{
  /** 全库词数（分母，用于说明覆盖率） */
  total: number
  /** 有遗忘信号的词数（渲染前） */
  signalCount: number
  /** 参与渲染的词：按强度降序，已按上限截断 */
  words: WordCloudWordDto[]
  /** 因上限未渲染的词数 */
  hiddenCount: number
}
