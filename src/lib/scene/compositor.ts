import type { Frame } from '../../../shared/types'
import { useStore } from '../store'
import { Atlas, type AtlasSlot } from './atlas'
import {
  INSTANCE_FLOATS,
  I_BLUR,
  I_COLOR,
  I_MARGIN,
  I_MIX,
  I_RADIUS,
  I_ROT,
  I_SHAPE,
  I_UV,
  type DrawBatch,
  type GpuRenderer,
  type GpuTexture,
} from './gpu/renderer'
import { WebGpuRenderer } from './gpu/webgpu'
import { WebGl2Renderer } from './gpu/webgl2'
import { bestLevel, levelFor, rasterSize, thumbLevel } from './lod'
import { primitiveOf, type Primitive } from './primitives'
import { RasterQueue, rasterKey, type RasterJob, type RasterResult } from './rasters'
import { currentScene, type Scene, type SceneItem } from './scene'
import type { IndexBox } from './sceneIndex'
import { useSceneState, type RendererChoice } from './sceneState'

/**
 * The canvas renderer: one GPU-drawn <canvas> under the editor's DOM that
 * paints every frame on the page as a texture and every doop shape as a
 * native primitive, so moving the view costs the same for ten frames as for
 * ten thousand. Live iframes (FrameView) are mounted only for the frames
 * being worked on (see livePolicy.ts) and drawn over it; the compositor
 * leaves out each frame a live iframe is already showing.
 *
 * It runs outside React: it reads the store's scene and camera, keeps what
 * is resident on the GPU, asks the raster queue for what is missing (the
 * level each frame needs at the current zoom, nearest the middle of the view
 * first) and draws on animation frames when something changed.
 */

/** texture memory the atlas stays under */
const GPU_BUDGET_BYTES = 512 * 1024 * 1024
/** the camera counts as at rest after this long without a move */
const SETTLE_MS = 140
/** frames smaller than this on screen draw as a plain quad */
const TINY_PX = 3
/** placeholder for a frame whose bitmap has not arrived: the white a frame
 *  without a background sits on */
const PLACEHOLDER: [number, number, number, number] = [1, 1, 1, 1]
/** jobs handed to the queue at once, nearest first */
const MAX_WANTS = 400

interface Entry {
  key: string
  html: string
  width: number
  height: number
  background: string | undefined
  slots: Map<number, AtlasSlot>
  /** a bitmap of an older document, shown until the new one arrives */
  stale: AtlasSlot | null
  failedKey: string | null
}

interface SlotOwner {
  frameId: string
  level: number
  entry: Entry
}

/**
 * WebGPU, else WebGL2, as `choice` allows; null leaves the page to the DOM
 * renderer. `canvas()` hands out a fresh element per attempt: a canvas a
 * context type has claimed cannot take another. Under `auto` a software
 * WebGPU adapter (no GPU, or a blocklisted one) yields to WebGL2, which may
 * still be hardware, and is the last resort after it.
 */
export async function createRenderer(
  canvas: () => HTMLCanvasElement,
  choice: RendererChoice,
): Promise<GpuRenderer | null> {
  if (choice === 'dom') return null
  if (choice === 'webgl2') return WebGl2Renderer.create(canvas())
  const found = await WebGpuRenderer.adapter().catch(() => null)
  const tryWebGpu = async () => {
    if (!found) return null
    try {
      return await WebGpuRenderer.create(canvas(), found)
    } catch (error) {
      console.warn('[compositor] WebGPU unavailable', error)
      return null
    }
  }
  if (choice === 'webgpu') return tryWebGpu()
  if (found && !found.software) return (await tryWebGpu()) ?? WebGl2Renderer.create(canvas())
  const gl = WebGl2Renderer.create(canvas())
  if (gl && !gl.software) return gl
  const gpu = await tryWebGpu()
  if (gpu) {
    gl?.destroy()
    return gpu
  }
  return gl
}

export class Compositor {
  private readonly atlas: Atlas
  private readonly queue: RasterQueue
  private readonly entries = new Map<string, Entry>()
  private readonly owners = new WeakMap<AtlasSlot, SlotOwner>()
  private scene: Scene | null = null
  private cull: IndexBox | null = null
  private data = new Float32Array(INSTANCE_FLOATS * 1024)
  private count = 0
  private batches: DrawBatch[] = []
  private pages = new Set<AtlasSlot['page']>()
  private needInstances = true
  private needWants = true
  private raf = 0
  private now = 0
  private lastMove = 0
  private settleTimer = 0
  private unsubscribers: (() => void)[] = []
  private size = { width: 1, height: 1 }
  private dpr = 1
  private showing: ReadonlySet<string> = new Set()
  private disposed = false
  /** frame times of the compositor's own work, for the benchmark */
  readonly stats = { draws: 0, builds: 0, buildMs: 0 }

  constructor(
    readonly renderer: GpuRenderer,
    private readonly stage: HTMLElement,
  ) {
    this.atlas = new Atlas(renderer, {
      pageSize: Math.min(4096, renderer.maxTextureSize),
      budgetBytes: GPU_BUDGET_BYTES,
      onEvict: (slot) => this.evicted(slot),
    })
    this.queue = new RasterQueue({
      onResult: (job, result) => this.landed(job, result),
      busy: () => performance.now() - this.lastMove < SETTLE_MS || useStore.getState().panMode,
    })
    renderer.onLost(() => {
      if (this.disposed) return
      this.atlas.dispose()
      this.entries.clear()
      useSceneState.getState().setRenderer('dom')
    })
  }

  start(): void {
    const ro = new ResizeObserver(() => this.measure())
    ro.observe(this.stage)
    this.unsubscribers.push(() => ro.disconnect())
    this.measure()
    this.unsubscribers.push(
      useStore.subscribe((s, prev) => {
        if (s.viewport !== prev.viewport) this.moved()
        if (s.canvas !== prev.canvas || s.activePageId !== prev.activePageId) this.invalidate()
      }),
      useSceneState.subscribe((s, prev) => {
        if (s.showing !== prev.showing) {
          this.showing = s.showing
          this.needInstances = true
          this.schedule()
        }
      }),
    )
    this.showing = useSceneState.getState().showing
    this.invalidate()
  }

  dispose(): void {
    this.disposed = true
    for (const off of this.unsubscribers) off()
    cancelAnimationFrame(this.raf)
    window.clearTimeout(this.settleTimer)
    this.queue.dispose()
    this.atlas.dispose()
    this.renderer.destroy()
  }

  /** what the benchmark and tests read */
  debug() {
    return {
      kind: this.renderer.kind,
      instances: this.count,
      batches: this.batches.length,
      pages: this.atlas.pageCount,
      textureMb: Math.round(this.atlas.bytes / 1024 / 1024),
      pendingRasters: this.queue.pending,
      rasters: { ...this.queue.stats },
      ...this.stats,
    }
  }

  /** the raster queue has nothing left to do for the current view */
  get idle(): boolean {
    return this.queue.pending === 0
  }

  private measure(): void {
    this.size = { width: this.stage.clientWidth, height: this.stage.clientHeight }
    this.dpr = window.devicePixelRatio || 1
    this.renderer.resize(this.size.width, this.size.height, this.dpr)
    this.cull = null
    this.needWants = true
    this.schedule()
  }

  private invalidate(): void {
    this.needInstances = true
    this.needWants = true
    this.schedule()
  }

  private moved(): void {
    this.lastMove = performance.now()
    this.schedule()
    window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => {
      this.needWants = true
      /* the right level for the new zoom may already be resident */
      this.needInstances = true
      useSceneState.getState().bumpSettled()
      this.schedule()
      this.queue.pump()
    }, SETTLE_MS)
  }

  private schedule(): void {
    if (this.disposed || this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.tick()
    })
  }

  /** the world rect the stage shows */
  private view(): IndexBox {
    const vp = useStore.getState().viewport
    return {
      minX: -vp.x / vp.zoom,
      minY: -vp.y / vp.zoom,
      maxX: (this.size.width - vp.x) / vp.zoom,
      maxY: (this.size.height - vp.y) / vp.zoom,
    }
  }

  private tick(): void {
    if (this.renderer.lost) return
    this.now++
    const scene = currentScene()
    if (scene !== this.scene) {
      this.reconcile(scene)
      this.scene = scene
      this.needInstances = true
      this.needWants = true
    }
    const view = this.view()
    if (!this.cull || !contains(this.cull, view)) this.needInstances = true
    if (this.needInstances) this.build(view)
    for (const page of this.pages) page.lastUsed = this.now
    const vp = useStore.getState().viewport
    this.renderer.draw({ x: vp.x, y: vp.y, zoom: vp.zoom }, this.batches)
    this.stats.draws++
    if (this.needWants && performance.now() - this.lastMove >= SETTLE_MS) {
      this.needWants = false
      this.want(view)
    }
  }

  /** forget frames the page no longer holds, and their bitmaps */
  private reconcile(scene: Scene | null): void {
    for (const [id, entry] of this.entries) {
      if (scene?.byId.has(id)) continue
      this.dropEntry(entry)
      this.entries.delete(id)
      useSceneState.getState().setFailed(id, false)
    }
  }

  private dropEntry(entry: Entry): void {
    for (const slot of entry.slots.values()) this.atlas.release(slot)
    entry.slots.clear()
    if (entry.stale) this.atlas.release(entry.stale)
    entry.stale = null
  }

  /** the frame's entry, its key brought up to its current document */
  private entryFor(item: SceneItem): Entry {
    const f = item.frame
    let entry = this.entries.get(f.id)
    const background = item.standalone ? undefined : '#ffffff'
    if (entry && entry.html === f.html && entry.width === f.width && entry.height === f.height) return entry
    const key = rasterKey(f.html, f.width, f.height, background)
    if (!entry) {
      entry = {
        key,
        html: f.html,
        width: f.width,
        height: f.height,
        background,
        slots: new Map(),
        stale: null,
        failedKey: null,
      }
      this.entries.set(f.id, entry)
      return entry
    }
    entry.html = f.html
    entry.width = f.width
    entry.height = f.height
    entry.background = background
    if (entry.key === key) return entry
    /* a new document: the best bitmap of the old one stays up until the
       new one lands, so an edit never blanks the frame */
    const keep = bestLevel(entry.slots.keys(), levelFor(this.screenScale(), f))
    const kept = keep === null ? null : (entry.slots.get(keep) ?? null)
    for (const slot of entry.slots.values()) if (slot !== kept) this.atlas.release(slot)
    entry.slots.clear()
    if (kept) {
      if (entry.stale) this.atlas.release(entry.stale)
      entry.stale = kept
    }
    entry.key = key
    if (entry.failedKey) {
      entry.failedKey = null
      useSceneState.getState().setFailed(f.id, false)
    }
    return entry
  }

  private screenScale(): number {
    return useStore.getState().viewport.zoom * this.dpr
  }

  /** The instances of every visible thing in a region one screen wider than
   *  the view on each side, so a pan rebuilds only once it leaves it. */
  private build(view: IndexBox): void {
    const started = performance.now()
    this.needInstances = false
    const w = view.maxX - view.minX
    const h = view.maxY - view.minY
    const cull = { minX: view.minX - w, minY: view.minY - h, maxX: view.maxX + w, maxY: view.maxY + h }
    this.cull = cull
    this.count = 0
    this.batches = []
    this.pages = new Set()
    const scene = this.scene
    if (!scene) return
    const zoom = useStore.getState().viewport.zoom
    const scale = zoom * this.dpr
    for (const item of scene.query(cull)) {
      const f = item.frame
      if (this.showing.has(f.id)) continue
      const tiny = Math.max(f.width, f.height) * zoom < TINY_PX
      if (item.standalone) {
        const prim = primitiveOf(f.html)
        if (prim) {
          this.primitive(f, prim, tiny)
          continue
        }
      }
      const entry = this.entryFor(item)
      if (tiny) {
        if (!item.standalone) this.quad(f, null, PLACEHOLDER)
        continue
      }
      const level = bestLevel(entry.slots.keys(), levelFor(scale, f))
      const slot = level === null ? entry.stale : (entry.slots.get(level) ?? null)
      if (slot && !slot.dead) {
        this.quad(f, slot, null)
        this.pages.add(slot.page)
      } else if (!item.standalone) {
        this.quad(f, null, PLACEHOLDER)
      }
    }
    this.renderer.setInstances(this.data, this.count)
    this.stats.builds++
    this.stats.buildMs += performance.now() - started
  }

  private grow(): Float32Array {
    if ((this.count + 1) * INSTANCE_FLOATS > this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    return this.data
  }

  /** one instance, joining the last batch when it samples the same texture */
  private push(texture: GpuTexture | null): number {
    const at = this.count * INSTANCE_FLOATS
    this.grow().fill(0, at, at + INSTANCE_FLOATS)
    const last = this.batches[this.batches.length - 1]
    if (last && last.texture === texture) last.count++
    else this.batches.push({ texture, first: this.count, count: 1 })
    this.count++
    return at
  }

  private quad(f: Frame, slot: AtlasSlot | null, color: [number, number, number, number] | null): void {
    const at = this.push(slot ? slot.page.texture : null)
    const d = this.data
    d[at] = f.x
    d[at + 1] = f.y
    d[at + 2] = f.width
    d[at + 3] = f.height
    if (slot) {
      d.set(slot.uv, at + I_UV)
      d[at + I_MIX] = 1
      d[at + I_COLOR + 3] = 1
    } else if (color) {
      d.set(color, at + I_COLOR)
    }
    d[at + I_ROT] = ((f.rotation ?? 0) * Math.PI) / 180
  }

  private primitive(f: Frame, prim: Primitive, tiny: boolean): void {
    const rot = ((f.rotation ?? 0) * Math.PI) / 180
    if (prim.shadow && !tiny) {
      const s = prim.shadow
      /* the quad reaches past the shadow's shape by its blur, room to fade */
      const margin = s.blur
      const at = this.push(null)
      const d = this.data
      d[at] = f.x + s.dx - s.spread - margin
      d[at + 1] = f.y + s.dy - s.spread - margin
      d[at + 2] = f.width + 2 * (s.spread + margin)
      d[at + 3] = f.height + 2 * (s.spread + margin)
      d[at + I_ROT] = rot
      d[at + I_RADIUS] = prim.radius + s.spread
      d[at + I_SHAPE] = prim.shape
      d.set(s.color, at + I_COLOR)
      /* a CSS blur radius spreads the edge over about its own length */
      d[at + I_BLUR] = Math.max(0.5, s.blur / 2)
      d[at + I_MARGIN] = margin
    }
    const at = this.push(null)
    const d = this.data
    d[at] = f.x
    d[at + 1] = f.y
    d[at + 2] = f.width
    d[at + 3] = f.height
    d[at + I_ROT] = rot
    d[at + I_RADIUS] = prim.radius
    d[at + I_SHAPE] = prim.shape
    d.set(prim.color, at + I_COLOR)
  }

  /** ask the queue for the levels the view needs, nearest the middle first */
  private want(view: IndexBox): void {
    const scene = this.scene
    if (!scene) return this.queue.want([])
    const w = view.maxX - view.minX
    const h = view.maxY - view.minY
    /* half a screen of lead around the view, so a short pan finds them drawn */
    const region = {
      minX: view.minX - w / 2,
      minY: view.minY - h / 2,
      maxX: view.maxX + w / 2,
      maxY: view.maxY + h / 2,
    }
    const cx = (view.minX + view.maxX) / 2
    const cy = (view.minY + view.maxY) / 2
    const zoom = useStore.getState().viewport.zoom
    const scale = zoom * this.dpr
    const jobs: RasterJob[] = []
    for (const item of scene.query(region)) {
      const f = item.frame
      if (Math.max(f.width, f.height) * zoom < TINY_PX) continue
      if (item.standalone && primitiveOf(f.html)) continue
      const entry = this.entryFor(item)
      if (entry.failedKey === entry.key) continue
      const level = levelFor(scale, f)
      if (entry.slots.has(level)) continue
      const inView = f.x < view.maxX && f.x + f.width > view.minX && f.y < view.maxY && f.y + f.height > view.minY
      const dx = f.x + f.width / 2 - cx
      const dy = f.y + f.height / 2 - cy
      jobs.push({
        frameId: f.id,
        key: entry.key,
        level,
        html: f.html,
        width: f.width,
        height: f.height,
        background: entry.background,
        /* in view before the lead, then by distance, so the middle fills
           first; a frame shown live last, for the moment it stops being */
        priority: (this.showing.has(f.id) ? 1e13 : 0) + (inView ? 0 : 1e12) + dx * dx + dy * dy,
      })
    }
    jobs.sort((a, b) => a.priority - b.priority)
    this.queue.want(jobs.slice(0, MAX_WANTS))
  }

  private landed(job: RasterJob, result: RasterResult): void {
    const entry = this.entries.get(job.frameId)
    if (!entry || entry.key !== job.key) {
      if (result.ok) result.bitmap.close()
      return
    }
    if (!result.ok) {
      entry.failedKey = job.key
      useSceneState.getState().setFailed(job.frameId, true)
      return
    }
    this.place(job.frameId, entry, job.level, result.bitmap)
    /* a sharp level also makes the far-out thumbnail, cheaply, from itself */
    const thumb = thumbLevel(entry)
    if (job.level > thumb && !entry.slots.has(thumb)) {
      const size = rasterSize(entry, thumb)
      void createImageBitmap(result.bitmap, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'high',
        premultiplyAlpha: 'premultiply',
      })
        .then((small) => {
          if (this.entries.get(job.frameId) === entry && entry.key === job.key && !entry.slots.has(thumb)) {
            this.place(job.frameId, entry, thumb, small)
          }
          small.close()
        })
        .catch(() => {})
        .finally(() => result.bitmap.close())
    } else {
      result.bitmap.close()
    }
  }

  private place(frameId: string, entry: Entry, level: number, bitmap: ImageBitmap): void {
    if (this.disposed || this.renderer.lost) return
    const old = entry.slots.get(level)
    if (old) this.atlas.release(old)
    const slot = this.atlas.allocate(bitmap.width, bitmap.height, this.now)
    this.renderer.upload(slot.page.texture, slot.x, slot.y, bitmap)
    entry.slots.set(level, slot)
    this.owners.set(slot, { frameId, level, entry })
    if (entry.stale) {
      this.atlas.release(entry.stale)
      entry.stale = null
    }
    this.needInstances = true
    this.schedule()
  }

  /** a page was cleared for room: the entries holding its slots forget them */
  private evicted(slot: AtlasSlot): void {
    const owner = this.owners.get(slot)
    if (!owner) return
    if (owner.entry.slots.get(owner.level) === slot) owner.entry.slots.delete(owner.level)
    if (owner.entry.stale === slot) owner.entry.stale = null
    this.needInstances = true
    this.needWants = true
    this.schedule()
  }
}

function contains(outer: IndexBox, inner: IndexBox): boolean {
  return outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY
}
