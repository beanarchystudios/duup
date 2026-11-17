import { drawDocument, SharedResources } from '../documentRaster'

/**
 * Where frame documents are drawn into bitmaps: the raster frame
 * (rasterFrame.ts), a sandboxed iframe running on another thread, so a
 * screen's layout and paint never drop a frame of the editor's own. Here,
 * on the editor's thread, only when the raster frame cannot be had (it did
 * not load) or cannot draw a document (a resource its opaque origin may not
 * fetch); the queue holds those for a resting view.
 */

export interface RasterRequest {
  type: 'doop:raster'
  id: number
  html: string
  width: number
  height: number
  scale: number
  background?: string
}

export type RasterReply =
  | { type: 'doop:raster-done'; id: number; bitmap: ImageBitmap }
  | { type: 'doop:raster-done'; id: number; error: string }

export interface DrawRequest {
  html: string
  width: number
  height: number
  scale: number
  background?: string
}

/** how long the raster frame has to say it is ready */
const BOOT_MS = 5_000

export class RasterHost {
  private frame: HTMLIFrameElement | null = null
  private readonly ready: Promise<boolean>
  private readonly waiting = new Map<number, (reply: RasterReply) => void>()
  private nextId = 1
  private readonly local = new SharedResources()
  private readonly onMessage = (ev: MessageEvent) => {
    if (!this.frame || ev.source !== this.frame.contentWindow) return
    const reply = ev.data as RasterReply | { type: 'doop:raster-ready' } | null
    if (reply?.type !== 'doop:raster-done') return
    const done = this.waiting.get(reply.id)
    if (!done) {
      if ('bitmap' in reply) reply.bitmap.close()
      return
    }
    this.waiting.delete(reply.id)
    done(reply)
  }

  constructor(src = '/raster-frame.html') {
    window.addEventListener('message', this.onMessage)
    this.ready = new Promise((resolve) => {
      if (typeof document === 'undefined') return resolve(false)
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('aria-hidden', 'true')
      frame.tabIndex = -1
      frame.title = 'raster'
      frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
      const timer = window.setTimeout(() => finish(false), BOOT_MS)
      const onReady = (ev: MessageEvent) => {
        if (ev.source === frame.contentWindow && (ev.data as { type?: string } | null)?.type === 'doop:raster-ready')
          finish(true)
      }
      const finish = (ok: boolean) => {
        window.clearTimeout(timer)
        window.removeEventListener('message', onReady)
        if (!ok) frame.remove()
        resolve(ok)
      }
      window.addEventListener('message', onReady)
      frame.src = src
      document.body.append(frame)
      this.frame = frame
    })
  }

  /** whether drawing runs off the editor's thread */
  async offThread(): Promise<boolean> {
    return this.ready
  }

  /** The document drawn in the raster frame; null when it has none or the
   *  document cannot be drawn there. */
  async drawRemote(req: DrawRequest): Promise<ImageBitmap | null> {
    if (!(await this.ready)) return null
    const reply = await this.ask(req)
    return 'bitmap' in reply ? reply.bitmap : null
  }

  /** The document drawn here, on the editor's thread. */
  drawLocal(req: DrawRequest, signal: AbortSignal): Promise<ImageBitmap> {
    return drawDocument(req.html, { ...req, signal, resources: this.local })
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage)
    this.frame?.remove()
    this.frame = null
    for (const done of this.waiting.values()) done({ type: 'doop:raster-done', id: 0, error: 'disposed' })
    this.waiting.clear()
  }

  private ask(req: DrawRequest): Promise<RasterReply> {
    const id = this.nextId++
    const message: RasterRequest = { type: 'doop:raster', id, ...req }
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.frame?.contentWindow?.postMessage(message, '*')
    })
  }
}
