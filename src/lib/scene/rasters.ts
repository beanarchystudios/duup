import { RasterHost } from './rasterHost'
import { LEVELS } from './lod'

/**
 * Turning frame documents into bitmaps, for the compositor.
 *
 * A raster is named by its content: the frame's HTML and size (`rasterKey`)
 * and a level of detail. The same document at the same level is the same
 * bitmap for every viewer, every reload and every frame that holds it, so
 * finished rasters are kept in IndexedDB (encoded as WebP) and a canvas
 * opened again paints from disk instead of drawing its frames anew.
 *
 * Drawing a document is a whole layout and paint, so it happens in the
 * raster frame (rasterHost.ts), off the editor's thread. A document the
 * raster frame cannot draw is drawn here instead, and that waits until the
 * person stops moving the view (`busy`), when a long task would drop the
 * frames they are looking at. The compositor names what it wants with
 * `want`, nearest the middle of the screen first, and replaces the list as
 * the view settles: work for frames scrolled away is dropped unstarted.
 */

export interface RasterJob {
  frameId: string
  key: string
  level: number
  html: string
  width: number
  height: number
  /** painted on white, as the canvas shows a frame; a shape is see-through */
  background?: string
  /** lower first */
  priority: number
}

export type RasterResult = { ok: true; bitmap: ImageBitmap; fromCache: boolean } | { ok: false; error: unknown }

/** cyrb53: a fast 53-bit string hash, plenty for a content key */
export function hashString(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** bumped when the way a document is drawn changes, so old bitmaps are not reused */
const RASTER_VERSION = 1

export function rasterKey(html: string, width: number, height: number, background?: string): string {
  return `${RASTER_VERSION}:${hashString(html)}:${width}x${height}:${background ?? 'none'}`
}

const jobId = (key: string, level: number) => `${key}@${level}`

/* ---------------- the disk cache ---------------- */

const DB_NAME = 'doop-rasters'
const STORE = 'rasters'
/** entries kept on disk; past it the least recently written go */
const DISK_LIMIT = 6000

interface DiskEntry {
  id: string
  blob: Blob
  at: number
}

class DiskCache {
  private db: Promise<IDBDatabase | null> | null = null
  private writes = 0

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'id' })
          store.createIndex('at', 'at')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return this.db
  }

  async get(id: string): Promise<Blob | null> {
    const db = await this.open()
    if (!db) return null
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE).objectStore(STORE).get(id)
        req.onsuccess = () => resolve((req.result as DiskEntry | undefined)?.blob ?? null)
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }

  async put(id: string, blob: Blob): Promise<void> {
    const db = await this.open()
    if (!db) return
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ id, blob, at: Date.now() } satisfies DiskEntry)
      if (++this.writes % 200 === 0) this.trim(db)
    } catch {
      /* a full disk or a private window: the cache is a convenience */
    }
  }

  /** drop the oldest entries past the limit */
  private trim(db: IDBDatabase): void {
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
      const count = store.count()
      count.onsuccess = () => {
        let extra = count.result - DISK_LIMIT
        if (extra <= 0) return
        const cursor = store.index('at').openCursor()
        cursor.onsuccess = () => {
          const c = cursor.result
          if (!c || extra-- <= 0) return
          c.delete()
          c.continue()
        }
      }
    } catch {
      /* best effort */
    }
  }
}

/* ---------------- the queue ---------------- */

export interface RasterQueueOptions {
  /** a finished raster, a cache hit or a failure */
  onResult(job: RasterJob, result: RasterResult): void
  /** while true, no new drawing starts (cache reads still do) */
  busy(): boolean
  /** jobs drawing at once; documents mostly wait on fetches and decode */
  concurrency?: number
  /** keep finished rasters on disk */
  persist?: boolean
}

export class RasterQueue {
  private wanted = new Map<string, RasterJob>()
  private running = new Set<string>()
  private readonly disk: DiskCache | null
  private readonly host = new RasterHost()
  private timer = 0
  private disposed = false
  /** how many drew and how long they took, for the benchmark */
  readonly stats = { drawn: 0, drawnHere: 0, cached: 0, failed: 0, drawMs: 0 }

  constructor(private readonly options: RasterQueueOptions) {
    this.disk = options.persist === false || typeof indexedDB === 'undefined' ? null : new DiskCache()
  }

  /** The jobs the compositor needs now, replacing the last list: anything
   *  not in it that has not started is dropped. */
  want(jobs: Iterable<RasterJob>): void {
    const next = new Map<string, RasterJob>()
    for (const job of jobs) {
      const id = jobId(job.key, job.level)
      if (this.running.has(id)) continue
      const had = next.get(id)
      if (!had || job.priority < had.priority) next.set(id, job)
    }
    this.wanted = next
    this.pump()
  }

  /** Something may be able to start: the view settled, or a job ended. */
  pump(): void {
    if (this.disposed || this.timer) return
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.startJobs()
    }, 0)
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.timer)
    this.wanted.clear()
    this.host.dispose()
  }

  get pending(): number {
    return this.wanted.size + this.running.size
  }

  private startJobs(): void {
    const limit = this.options.concurrency ?? 3
    while (this.running.size < limit && this.wanted.size) {
      let best: [string, RasterJob] | null = null
      for (const entry of this.wanted) if (!best || entry[1].priority < best[1].priority) best = entry
      if (!best) return
      const [id, job] = best
      this.wanted.delete(id)
      this.running.add(id)
      void this.run(id, job)
    }
  }

  private async run(id: string, job: RasterJob): Promise<void> {
    try {
      const cached = await this.fromDisk(id)
      if (cached) {
        this.stats.cached++
        this.deliver(job, { ok: true, bitmap: cached, fromCache: true })
        return
      }
      const started = performance.now()
      const req = {
        html: job.html,
        width: job.width,
        height: job.height,
        scale: LEVELS[job.level] ?? 1,
        background: job.background,
      }
      let bitmap = await this.host.drawRemote(req)
      if (!bitmap) {
        /* drawn on this thread: it waits for the view to rest */
        await this.whenIdle()
        if (this.disposed) return
        bitmap = await this.host.drawLocal(req, AbortSignal.timeout(20_000))
        this.stats.drawnHere++
      }
      this.stats.drawn++
      this.stats.drawMs += performance.now() - started
      if (this.disk) void this.store(id, bitmap)
      this.deliver(job, { ok: true, bitmap, fromCache: false })
    } catch (error) {
      this.stats.failed++
      this.deliver(job, { ok: false, error })
    } finally {
      this.running.delete(id)
      this.pump()
    }
  }

  private deliver(job: RasterJob, result: RasterResult): void {
    if (this.disposed) {
      if (result.ok) result.bitmap.close()
      return
    }
    this.options.onResult(job, result)
  }

  private async fromDisk(id: string): Promise<ImageBitmap | null> {
    if (!this.disk) return null
    const blob = await this.disk.get(id)
    if (!blob) return null
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
    } catch {
      return null
    }
  }

  /** the bitmap as WebP on disk; encoded off the main thread */
  private async store(id: string, bitmap: ImageBitmap): Promise<void> {
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
      await this.disk?.put(id, blob)
    } catch {
      /* the cache is a convenience */
    }
  }

  private whenIdle(): Promise<void> {
    if (!this.options.busy()) return Promise.resolve()
    return new Promise((resolve) => {
      const check = () => (this.disposed || !this.options.busy() ? resolve() : window.setTimeout(check, 50))
      window.setTimeout(check, 50)
    })
  }
}
