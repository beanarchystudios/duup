import type { Frame } from '../../../shared/types'
import { rotatedBounds } from '../../../shared/frameRotation'
import { canvasPages, pageFrames } from '../../../shared/pages'
import { isCanvasElement } from '../drawing'
import { useStore } from '../store'
import { SceneIndex, type IndexBox } from './sceneIndex'

/**
 * The active page as the renderer sees it: its frames in paint order (back
 * to front, as the store keeps them), each with the box it covers on the
 * canvas, and a spatial index over those boxes. Derived from the store and
 * cached on the canvas object and page it came from, so every reader in one
 * store state shares one scene.
 */
export interface SceneItem {
  frame: Frame
  /** its place in the paint order */
  rank: number
  /** the canvas box it covers, its rotation included */
  bounds: IndexBox
  /** a standalone shape (no frame chrome, transparent) */
  standalone: boolean
}

export interface Scene {
  pageId: string
  items: SceneItem[]
  byId: Map<string, SceneItem>
  /** built on first use: a drag patches the page every pointer move */
  readonly index: SceneIndex
  /** the visible items meeting a world rect, in paint order */
  query(box: IndexBox): SceneItem[]
  /** the topmost visible item under a world point, if any */
  topmostAt(x: number, y: number, accept?: (item: SceneItem) => boolean): SceneItem | null
}

/* a frame's html only changes with a new string, so a standalone check per
   string is enough; WeakMap would need an object key */
const standaloneMemo = new Map<string, boolean>()
function standaloneOf(html: string): boolean {
  let known = standaloneMemo.get(html)
  if (known === undefined) {
    known = isCanvasElement(html)
    if (standaloneMemo.size > 100_000) standaloneMemo.clear()
    standaloneMemo.set(html, known)
  }
  return known
}

function boundsOf(frame: Frame): IndexBox {
  const b = frame.rotation ? rotatedBounds(frame, frame.rotation) : frame
  return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height }
}

/** The scene of a page's frames, in the paint order they are given in. */
export function buildScene(pageId: string, frames: readonly Frame[]): Scene {
  const items: SceneItem[] = frames.map((frame, rank) => ({
    frame,
    rank,
    bounds: boundsOf(frame),
    standalone: standaloneOf(frame.html),
  }))
  const byId = new Map(items.map((it) => [it.frame.id, it]))
  let index: SceneIndex | null = null
  const scene: Scene = {
    pageId,
    items,
    byId,
    get index() {
      index ??= new SceneIndex(items.map((it) => it.bounds))
      return index
    },
    query(box) {
      return scene.index
        .search(box)
        .map((i) => items[i]!)
        .filter((it) => !it.frame.hidden)
    },
    topmostAt(x, y, accept) {
      const hits = scene.index.at(x, y)
      for (let k = hits.length - 1; k >= 0; k--) {
        const it = items[hits[k]!]!
        if (it.frame.hidden) continue
        /* the bounds of a turned frame are wider than the frame */
        if (it.frame.rotation && !insideTurned(it.frame, x, y)) continue
        if (!accept || accept(it)) return it
      }
      return null
    },
  }
  return scene
}

function insideTurned(frame: Frame, x: number, y: number): boolean {
  const rad = (-(frame.rotation ?? 0) * Math.PI) / 180
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  const dx = x - cx
  const dy = y - cy
  const ux = dx * Math.cos(rad) - dy * Math.sin(rad)
  const uy = dx * Math.sin(rad) + dy * Math.cos(rad)
  return Math.abs(ux) <= frame.width / 2 && Math.abs(uy) <= frame.height / 2
}

let cached: { canvas: object; pageId: string; scene: Scene } | null = null

/** The active page's scene in the current store state. */
export function currentScene(): Scene | null {
  const { canvas, activePageId } = useStore.getState()
  if (!canvas) return null
  const pageId = activePageId ?? canvasPages(canvas)[0]!.id
  if (cached && cached.canvas === canvas && cached.pageId === pageId) return cached.scene
  const scene = buildScene(pageId, pageFrames(canvas, pageId))
  cached = { canvas, pageId, scene }
  return scene
}
