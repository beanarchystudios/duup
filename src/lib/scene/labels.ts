import { useStore } from '../store'
import { currentScene } from './scene'
import type { IndexBox } from './sceneIndex'

/**
 * Frame names for the frames that have no FrameView (which draws its own),
 * painted on one 2D canvas over the world. Drawn when the camera rests;
 * while it moves the canvas is carried by a CSS transform from the camera it
 * was drawn at, so a pan or zoom never waits on text.
 */

/* the FrameView name's look (FrameView.tsx): 12px semibold, 6px above */
const FONT = '600 12px Allo, system-ui, sans-serif'
const GAP = 6
/** narrower than this on screen, a name would only be its ellipsis */
const MIN_WIDTH = 48

export class LabelLayer {
  private skip: ReadonlySet<string> | null = null
  private drawnAt = { x: 0, y: 0, zoom: 1 }
  private ink = '#5f5e5b'
  private raf = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stage: HTMLElement,
  ) {}

  /** frames that draw their own name (mounted FrameViews); null: all of them do */
  setSkip(skip: ReadonlySet<string> | null): void {
    this.skip = skip
    this.redraw()
  }

  /** the camera moved: carry the last drawing along until the next redraw */
  follow(): void {
    const vp = useStore.getState().viewport
    const k = vp.zoom / this.drawnAt.zoom
    this.canvas.style.transform = `translate(${vp.x - this.drawnAt.x * k}px, ${vp.y - this.drawnAt.y * k}px) scale(${k})`
  }

  redraw(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1
    const width = this.stage.clientWidth
    const height = this.stage.clientHeight
    const w = Math.round(width * dpr)
    const h = Math.round(height * dpr)
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const vp = useStore.getState().viewport
    this.drawnAt = { x: vp.x, y: vp.y, zoom: vp.zoom }
    this.canvas.style.transformOrigin = '0 0'
    this.canvas.style.transform = ''
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const scene = currentScene()
    if (!scene || this.skip === null) return
    const ink = getComputedStyle(this.stage).getPropertyValue('--ink-soft').trim()
    if (ink) this.ink = ink
    ctx.font = FONT
    ctx.fillStyle = this.ink
    ctx.textBaseline = 'bottom'
    const view: IndexBox = {
      minX: -vp.x / vp.zoom,
      minY: -vp.y / vp.zoom,
      /* a name sits above its frame: a frame just below the top edge still shows one */
      maxX: (width - vp.x) / vp.zoom,
      maxY: (height - vp.y) / vp.zoom + 30 / vp.zoom,
    }
    for (const item of scene.query(view)) {
      const f = item.frame
      if (item.standalone || this.skip.has(f.id) || f.rotation) continue
      const sw = f.width * vp.zoom
      if (sw < MIN_WIDTH) continue
      const x = f.x * vp.zoom + vp.x
      const y = f.y * vp.zoom + vp.y - GAP
      ctx.fillText(fit(ctx, f.name, sw), x, y)
    }
  }
}

/** the name, cut with an ellipsis to `width` px */
function fit(ctx: CanvasRenderingContext2D, name: string, width: number): string {
  if (ctx.measureText(name).width <= width) return name
  let lo = 0
  let hi = name.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(name.slice(0, mid) + '…').width <= width) lo = mid
    else hi = mid - 1
  }
  return lo ? name.slice(0, lo) + '…' : ''
}
