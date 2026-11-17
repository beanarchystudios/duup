import type { SceneItem } from './scene'
import type { IndexBox } from './sceneIndex'

/**
 * Which frames get a FrameView (their DOM chrome: name, hover ring, drag and
 * resize, pins) and which of those get a live iframe (their real document,
 * for picking, editing and anything a bitmap cannot show).
 *
 * A live iframe is a whole browser document; a page of thousands of them is
 * what made big canvases crawl. So only a few are live at once: the frames
 * being worked on first (selected, streamed into, a menu open on them),
 * then the one under the pointer, then the ones the view is zoomed in on,
 * then frames that cannot be drawn into a bitmap at all. Everything else is
 * drawn by the compositor. A page small enough to afford it keeps every
 * frame live, exactly as before the compositor existed.
 */

/** live iframes at once, past the frames being worked on */
export const LIVE_MAX = 8
/** FrameViews at once, past the frames that must have one */
export const MOUNT_MAX = 120
/** a page with no more frames than this keeps all of them live */
export const ALL_LIVE_BELOW = 24
/** a frame covering this share of the stage is what the view is on */
const FOCUS_SHARE = 0.1
/** a frame narrower than this on screen gets no FrameView of its own */
const MOUNT_MIN_PX = 28
/** a frame that cannot be drawn is shown live from this size on screen */
const FAILED_MIN_PX = 48

export interface PolicyInput {
  /** every frame on the page, in paint order */
  all: readonly SceneItem[]
  /** the visible frames meeting the view, in paint order */
  inView: readonly SceneItem[]
  view: IndexBox
  zoom: number
  /** frames that must be live: selected (when few), streamed into, a menu open */
  keep: ReadonlySet<string>
  /** frames that must have a FrameView but need not be live: a large selection */
  mount: ReadonlySet<string>
  hovered: string | null
  failed: ReadonlySet<string>
  /** what was live last time, least recent first: kept while there is room */
  previous: readonly string[]
  /** drawn natively by the compositor: never needs a FrameView to be seen */
  native(item: SceneItem): boolean
}

export interface Policy {
  mounted: ReadonlySet<string>
  live: ReadonlySet<string>
}

function screenArea(item: SceneItem, zoom: number): number {
  const b = item.bounds
  return (b.maxX - b.minX) * (b.maxY - b.minY) * zoom * zoom
}

function minSide(item: SceneItem, zoom: number): number {
  const b = item.bounds
  return Math.min(b.maxX - b.minX, b.maxY - b.minY) * zoom
}

export function decide(input: PolicyInput): Policy {
  const visible = input.all.filter((it) => !it.frame.hidden)
  if (visible.length <= ALL_LIVE_BELOW) {
    const ids = new Set(visible.map((it) => it.frame.id))
    for (const id of input.keep) ids.add(id)
    return { mounted: ids, live: ids }
  }
  const zoom = input.zoom
  const view = input.view
  const stageArea = (view.maxX - view.minX) * (view.maxY - view.minY) * zoom * zoom
  const inViewIds = new Set(input.inView.map((it) => it.frame.id))
  const live = new Set(input.keep)
  const room = () => live.size < input.keep.size + LIVE_MAX
  const add = (id: string) => {
    if (room()) live.add(id)
  }
  if (input.hovered && inViewIds.has(input.hovered)) add(input.hovered)
  const bySize = [...input.inView].sort((a, b) => screenArea(b, zoom) - screenArea(a, zoom))
  for (const it of bySize) {
    if (!room()) break
    if (input.native(it)) continue
    if (screenArea(it, zoom) >= stageArea * FOCUS_SHARE) add(it.frame.id)
  }
  for (const it of bySize) {
    if (!room()) break
    if (input.failed.has(it.frame.id) && minSide(it, zoom) >= FAILED_MIN_PX) add(it.frame.id)
  }
  /* what was live and is still in view stays, the most recent first, so a
     small pan does not reload the frames just looked at */
  for (let i = input.previous.length - 1; i >= 0 && room(); i--) {
    const id = input.previous[i]!
    if (inViewIds.has(id)) add(id)
  }
  const mounted = new Set([...live, ...input.mount])
  let budget = MOUNT_MAX
  for (const it of bySize) {
    if (budget <= 0) break
    if (mounted.has(it.frame.id)) continue
    if (input.native(it) || minSide(it, zoom) < MOUNT_MIN_PX) continue
    mounted.add(it.frame.id)
    budget--
  }
  return { mounted, live }
}

/** The same set with the same members, or `next` when it changed: keeps a
 *  React dependency stable when the decision did not move. */
export function sameSet(prev: ReadonlySet<string>, next: ReadonlySet<string>): ReadonlySet<string> {
  if (prev.size !== next.size) return next
  for (const id of next) if (!prev.has(id)) return next
  return prev
}
