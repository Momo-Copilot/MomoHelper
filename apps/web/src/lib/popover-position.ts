/**
 * 弹层定位（纯函数，可脱离浏览器单测）。
 *
 * 坐标是 fixed 体系（相对视口）：弹层用 portal 挂到 body，所以不受任何
 * 祖先 overflow 容器裁剪。策略是默认贴锚点下方，下方空间不够就向上翻，
 * 水平夹在视口内，高度上限跟着可用空间走（内容超长时弹层内部滚动）。
 */

/** 弹层与锚点、视口边缘的间距 */
export const POPOVER_GAP = 8

/** 弹层最大宽度，窄屏按视口收缩 */
export const POPOVER_MAX_WIDTH = 420

/** 下方可用高度低于这个值就优先向上翻 */
const MIN_BELOW = 240

/** 弹层最小可用高度：再小就没法读，宁可向上翻 */
const MIN_HEIGHT = 160

export interface PopoverBox
{
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
}

export interface AnchorRect
{
  left: number
  top: number
  bottom: number
}

export function computePopoverBox(
  rect: AnchorRect,
  viewport: { width: number; height: number }
): PopoverBox
{
  const vw = viewport.width
  const vh = viewport.height
  const width = Math.min(POPOVER_MAX_WIDTH, Math.max(0, vw - POPOVER_GAP * 2))
  const left = Math.min(Math.max(POPOVER_GAP, rect.left), Math.max(POPOVER_GAP, vw - width - POPOVER_GAP))

  // 上下各留 GAP，避免贴着视口边缘
  const below = vh - rect.bottom - POPOVER_GAP * 2
  const above = rect.top - POPOVER_GAP * 2
  const openUp = below < MIN_BELOW && above > below

  return openUp
    ? {
        left,
        bottom: vh - rect.top + POPOVER_GAP,
        width,
        maxHeight: Math.max(MIN_HEIGHT, above)
      }
    : {
        left,
        top: rect.bottom + POPOVER_GAP,
        width,
        maxHeight: Math.max(MIN_HEIGHT, below)
      }
}
