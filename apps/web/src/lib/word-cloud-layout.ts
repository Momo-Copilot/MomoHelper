/**
 * 词云布局（纯函数、零依赖，可脱离浏览器单测）。
 *
 * 贪心螺旋：词按传入顺序（调用方已按强度降序）从画布中心向外螺旋试探，
 * 与已放置词的外框不重叠就落下。估宽用字符数乘经验系数，够做碰撞避免；
 * 全程无随机数，同一批词每次布局结果一致，刷新不会跳。
 *
 * 朝向：落在中心的首词（通常也是最大的词）恒水平——旋转会让人读不出来；
 * 其余约四分之一的长词竖排，竖向填不满的横向缝隙，版面更饱满。
 * 竖排只是候选，摆不下就回退水平，绝不因旋转而丢词。
 */

/** 英文字宽经验系数：平均 0.56 个字号宽/字符 */
const CHAR_WIDTH_RATIO = 0.56

/** 词与词之间的最小空隙（px） */
const GUTTER = 3

/** 单行最多占画布宽度的比例，超过就降字号，避免长词横穿整屏 */
const MAX_WIDTH_RATIO = 0.82

/** 最小字号：再小就不可读，干脆不画 */
const MIN_FONT = 12

/** 每个词每个朝向最多试探的螺旋步数（越大越密，也越慢） */
const MAX_STEPS = 1600

/** 螺旋参数：角度步长越小候选点越密，半径步长决定铺开速度 */
const ANGLE_STEP = 0.16
const RADIUS_STEP = 0.42

/** 竖排词的取样间隔：每 5 个词里挑 1 个竖排 */
const VERTICAL_EVERY = 5

/** 太短的词竖排像一根竖线，没意义 */
const VERTICAL_MIN_LENGTH = 5

/** 大字竖排最抢眼，会让版面看起来倒向一边；只让中小号词竖排 */
const VERTICAL_MAX_FONT = 28

export interface PlacedWordBase
{
  /** 外框中心坐标 */
  x: number
  y: number
  /** 估算外框宽高（px，已按旋转后计算：竖排时宽高互换） */
  w: number
  h: number
  /** 实际使用字号（已按 scale 缩放、按宽度降档） */
  font: number
  /** 旋转角度：0 = 水平，-90 = 竖排（自下而上阅读） */
  rotate: number
}

function estimateWidth(text: string, font: number): number
{
  return Math.ceil(text.length * font * CHAR_WIDTH_RATIO) + 10
}

/**
 * 从画布中心向外螺旋找一个不与已放置词重叠、也不越界的位置。
 * w/h 是旋转后的外框尺寸，调用方负责按朝向换算。
 */
function findSpot(
  placed: PlacedWordBase[],
  w: number,
  h: number,
  width: number,
  height: number
): { x: number; y: number } | null
{
  const cx = width / 2
  const cy = height / 2

  for (let step = 0; step < MAX_STEPS; step++)
  {
    // 角度匀速推进、半径线性增大；纵向压扁成椭圆，横版画布更饱满
    const angle = step * ANGLE_STEP
    const radius = 4 + step * RADIUS_STEP
    const x = cx + Math.cos(angle) * radius
    const y = cy + Math.sin(angle) * radius * 0.55

    if (x - w / 2 < 0 || x + w / 2 > width || y - h / 2 < 0 || y + h / 2 > height)
    {
      continue
    }

    const clash = placed.some(
      (other) =>
        Math.abs(x - other.x) < (w + other.w) / 2 + GUTTER &&
        Math.abs(y - other.y) < (h + other.h) / 2 + GUTTER
    )

    if (!clash)
    {
      return { x, y }
    }
  }

  return null
}

/**
 * 螺旋贪心布局。
 *
 * scale 给窄屏用：画布变窄时按比例缩字号，否则一个 62px 的词能占掉半屏。
 * 放不下的词直接跳过（不塞进重叠区），返回值只含真正画得出来的词。
 */
export function layoutWords<T extends { spelling: string; size: number }>(
  source: T[],
  width: number,
  height: number,
  scale = 1
): (T & PlacedWordBase)[]
{
  const placed: (T & PlacedWordBase)[] = []
  const maxWidth = width * MAX_WIDTH_RATIO

  for (let index = 0; index < source.length; index++)
  {
    const word = source[index]

    if (!word)
    {
      continue
    }

    let font = Math.max(MIN_FONT, Math.round(word.size * scale))

    // 超宽词降字号重试（0.85 递减，直到塞得下或触底）
    while (estimateWidth(word.spelling, font) > maxWidth && font > MIN_FONT)
    {
      font = Math.round(font * 0.85)
    }

    const textW = estimateWidth(word.spelling, font)
    const textH = Math.ceil(font * 1.12)

    if (textW > maxWidth || textH > height * 0.92)
    {
      continue
    }

    // 中心词恒水平：第一个落位的词就在画布正中，旋转会让最显眼的词最难读
    const isCenter = placed.length === 0
    const wantsVertical =
      !isCenter &&
      index % VERTICAL_EVERY === 2 &&
      word.spelling.length >= VERTICAL_MIN_LENGTH &&
      font <= VERTICAL_MAX_FONT &&
      // 竖排后占的高度就是词的宽度，超过画布高度则根本放不下，别白试
      textW <= height * 0.92

    const rotations = wantsVertical ? [-90, 0] : [0]

    for (const rotate of rotations)
    {
      const vertical = rotate !== 0
      const w = vertical ? textH : textW
      const h = vertical ? textW : textH
      const spot = findSpot(placed, w, h, width, height)

      if (spot)
      {
        placed.push({ ...word, x: spot.x, y: spot.y, w, h, font, rotate })
        break
      }
    }
  }

  return placed
}
