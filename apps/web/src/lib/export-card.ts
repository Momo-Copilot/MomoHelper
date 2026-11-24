/**
 * 学情卡片导出：把关键数字画成一张 1080×1440 的竖版图。
 *
 * 用 canvas 而不是 html2canvas：后者要额外装依赖、还依赖字体加载时机；
 * 这里只需要画几个数字和文字，手写绘制反而更可控、体积为零。
 *
 * 配色读 CSS 变量，跟随浅色 / 夜间主题——分享出去的图和用户看到的一致。
 */

export interface ReportCardInput
{
  /** 北京时间日期 YYYY-MM-DD */
  date: string
  /** 词库总词数 */
  totalWords: number
  /** 已开始学习 */
  studiedWords: number
  /** 累计新学（窗口内） */
  newWordsTotal: number
  /** 顽固词 */
  stickingCount: number
  /** 最长断更天数 */
  maxGapDays: number
  /** 当前连续学习天数 */
  streak: number
}

const WIDTH = 1080
const HEIGHT = 1440
const PAD = 88

function cssVar(name: string, fallback: string): string
{
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()

  return value || fallback
}

/** 按宽度折行（中文没有空格，只能逐字量） */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[]
{
  const lines: string[] = []
  let line = ''

  for (const char of text)
  {
    const next = line + char

    if (ctx.measureText(next).width > maxWidth && line.length > 0)
    {
      lines.push(line)
      line = char
    }
    else
    {
      line = next
    }
  }

  if (line)
  {
    lines.push(line)
  }

  return lines
}

function drawMetric(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  value: string,
  hint: string,
  colors: { text: string; muted: string; subtle: string; accent: string }
): void
{
  ctx.fillStyle = colors.subtle
  ctx.font = '400 26px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(label, x, y)

  ctx.fillStyle = colors.text
  ctx.font = '500 76px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(value, x, y + 88)

  if (hint)
  {
    ctx.fillStyle = colors.muted
    ctx.font = '400 24px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    ctx.fillText(hint, x, y + 132)
  }
}

export async function downloadReportCard(input: ReportCardInput): Promise<void>
{
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT

  const ctx = canvas.getContext('2d')

  if (!ctx)
  {
    throw new Error('当前浏览器不支持 canvas')
  }

  const colors = {
    surface: cssVar('--color-surface', '#ffffff'),
    bg: cssVar('--color-bg', '#f7faf9'),
    text: cssVar('--color-text', '#1f2a27'),
    muted: cssVar('--color-text-muted', '#526460'),
    subtle: cssVar('--color-text-subtle', '#7f948d'),
    accent: cssVar('--color-accent', '#28b69d'),
    border: cssVar('--color-border', '#e3ebe8')
  }

  // 底：整张卡用 surface，外面留一圈 bg 显得像卡片浮在纸上
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.fillStyle = colors.surface
  ctx.beginPath()
  ctx.roundRect(40, 40, WIDTH - 80, HEIGHT - 80, 32)
  ctx.fill()

  const left = PAD
  const contentWidth = WIDTH - PAD * 2

  // 品牌
  ctx.fillStyle = colors.accent
  ctx.beginPath()
  ctx.roundRect(left, 116, 44, 44, 10)
  ctx.fill()

  ctx.fillStyle = colors.text
  ctx.font = '500 32px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText('墨小墨', left + 60, 150)

  // 标题
  ctx.font = '500 64px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText('我的学情卡', left, 300)

  ctx.fillStyle = colors.subtle
  ctx.font = '400 26px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(input.date, left, 348)

  // 核心一句话
  const percent = input.totalWords === 0 ? 0 : Math.round((input.studiedWords / input.totalWords) * 100)
  const headline = `已学 ${input.studiedWords.toLocaleString('zh-CN')} 个词，占词库 ${percent}%`
  ctx.fillStyle = colors.text
  ctx.font = '400 34px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'

  const lines = wrapText(ctx, headline, contentWidth)

  lines.forEach((line, index) =>
  {
    ctx.fillText(line, left, 430 + index * 46)
  })

  // 分隔线
  const dividerY = 520
  ctx.strokeStyle = colors.border
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(left, dividerY)
  ctx.lineTo(WIDTH - PAD, dividerY)
  ctx.stroke()

  // 指标 2×2
  const colGap = 24
  const colWidth = (contentWidth - colGap) / 2
  const row1 = 620
  const row2 = 850

  drawMetric(ctx, left, row1, '词库总量', input.totalWords.toLocaleString('zh-CN'), '个单词', colors)
  drawMetric(
    ctx,
    left + colWidth + colGap,
    row1,
    '累计新学',
    input.newWordsTotal.toLocaleString('zh-CN'),
    '近一年',
    colors
  )
  drawMetric(
    ctx,
    left,
    row2,
    '顽固词',
    input.stickingCount.toLocaleString('zh-CN'),
    '反复忘、带 STICKING 标记',
    colors
  )
  drawMetric(
    ctx,
    left + colWidth + colGap,
    row2,
    '最长断更',
    `${input.maxGapDays} 天`,
    '连续 3 天以上零新学',
    colors
  )

  // 底部：连续天数 + 说明
  ctx.fillStyle = colors.accent
  ctx.beginPath()
  ctx.roundRect(left, 1080, contentWidth, 116, 20)
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.font = '500 38px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(`当前连续学习 ${input.streak} 天`, left + 40, 1152)

  ctx.fillStyle = colors.subtle
  ctx.font = '400 22px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'

  const notes = [
    '数据来自墨墨背单词开放接口，仅统计已同步的学习记录。',
    '绿色格越深表示当天新学越多；断更日会留成空白。'
  ]

  notes.forEach((note, index) =>
  {
    ctx.fillText(note, left, 1280 + index * 36)
  })

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))

  if (!blob)
  {
    throw new Error('图片生成失败')
  }

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `moxiao-mo-${input.date}.png`
  link.click()

  // 立刻 revoke 会让某些浏览器下载失败，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
