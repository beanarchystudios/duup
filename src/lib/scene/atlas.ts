import type { GpuRenderer, GpuTexture } from './gpu/renderer'

/**
 * Frame rasters packed into a few large textures, so the compositor draws
 * a whole page in a draw call per texture rather than one per frame.
 *
 * A page is a square texture packed in shelves (rows of slots of about the
 * same height). A raster too big to share a page gets a texture of its own.
 * Space inside a page is not reused slot by slot: a page whose slots are all
 * released is cleared whole, and when the textures pass their memory budget
 * the page drawn least recently is cleared to make room. Its slots die, and
 * the compositor fetches them again (from the raster cache, or a new raster)
 * if it still needs them.
 */

/** texels of clear border around every slot, so linear filtering never
 *  samples a neighbour */
const GUTTER = 1

export interface AtlasSlot {
  readonly page: AtlasPage
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** u0, v0, u1, v1: the slot's texels, inset by half a texel */
  readonly uv: readonly [number, number, number, number]
  /** cleared with its page: the texels hold something else now */
  dead: boolean
}

interface Shelf {
  y: number
  height: number
  x: number
}

export class AtlasPage {
  readonly shelves: Shelf[] = []
  nextY = 0
  /** the draw this page last showed a slot in */
  lastUsed = 0
  live = 0
  readonly slots = new Set<AtlasSlot>()
  constructor(
    readonly texture: GpuTexture,
    readonly solo: boolean,
  ) {}
  get bytes(): number {
    return this.texture.width * this.texture.height * 4
  }
}

export interface AtlasOptions {
  /** the side of a shared page, in texels */
  pageSize: number
  /** the texture memory the atlas tries to stay under */
  budgetBytes: number
  /** a slot died with its page */
  onEvict(slot: AtlasSlot): void
}

export class Atlas {
  private readonly pages: AtlasPage[] = []

  constructor(
    private readonly renderer: GpuRenderer,
    private readonly options: AtlasOptions,
  ) {}

  get bytes(): number {
    return this.pages.reduce((sum, page) => sum + page.bytes, 0)
  }

  get pageCount(): number {
    return this.pages.length
  }

  /** A slot of `width` × `height` texels, clearing old pages for room when
   *  the budget is spent. `now` is the current draw's number. */
  allocate(width: number, height: number, now: number): AtlasSlot {
    const size = this.options.pageSize
    const w = width + 2 * GUTTER
    const h = height + 2 * GUTTER
    if (w > size / 2 || h > size / 2) return this.solo(width, height, now)
    for (let i = this.pages.length - 1; i >= 0; i--) {
      const page = this.pages[i]!
      if (page.solo) continue
      const slot = this.place(page, w, h)
      if (slot) return slot
    }
    const page = this.freePage(now) ?? this.newPage(size, size, false)
    return this.place(page, w, h)!
  }

  /** The slot's texels are no longer needed. */
  release(slot: AtlasSlot): void {
    if (slot.dead) return
    const page = slot.page
    page.slots.delete(slot)
    slot.dead = true
    if (--page.live <= 0) this.clear(page, false)
  }

  /** The slot was drawn in draw `now`: its page is in use. */
  touch(slot: AtlasSlot, now: number): void {
    slot.page.lastUsed = now
  }

  /** Every page and texture, for a lost device or a teardown. */
  dispose(): void {
    for (const page of this.pages) {
      for (const slot of page.slots) slot.dead = true
      this.renderer.destroyTexture(page.texture)
    }
    this.pages.length = 0
  }

  private solo(width: number, height: number, now: number): AtlasSlot {
    const bytes = width * height * 4
    this.makeRoom(bytes, now)
    const page = this.newPage(width, height, true)
    return this.slot(page, 0, 0, width, height)
  }

  /** The least recently drawn shared page, cleared, when the budget leaves
   *  no room for another; null while there is room. */
  private freePage(now: number): AtlasPage | null {
    const size = this.options.pageSize
    if (this.bytes + size * size * 4 <= this.options.budgetBytes) return null
    const victim = this.leastRecent(now, (p) => !p.solo)
    if (!victim) return null
    this.clear(victim, true)
    this.pages.push(...this.pages.splice(this.pages.indexOf(victim), 1))
    return victim
  }

  private makeRoom(bytes: number, now: number): void {
    while (this.bytes + bytes > this.options.budgetBytes) {
      const victim = this.leastRecent(now, () => true)
      if (!victim) return
      this.clear(victim, true)
      if (victim.solo) this.drop(victim)
    }
  }

  /** a page not drawn in the current draw, the oldest first */
  private leastRecent(now: number, ok: (page: AtlasPage) => boolean): AtlasPage | null {
    let best: AtlasPage | null = null
    for (const page of this.pages) {
      if (page.lastUsed >= now || !ok(page)) continue
      if (page.solo && page.live === 0) continue
      if (!best || page.lastUsed < best.lastUsed) best = page
    }
    return best
  }

  private newPage(width: number, height: number, solo: boolean): AtlasPage {
    const page = new AtlasPage(this.renderer.createTexture(width, height), solo)
    this.pages.push(page)
    return page
  }

  private drop(page: AtlasPage): void {
    this.renderer.destroyTexture(page.texture)
    this.pages.splice(this.pages.indexOf(page), 1)
  }

  /** every slot on the page dies; a solo page goes with its one slot */
  private clear(page: AtlasPage, evicted: boolean): void {
    for (const slot of page.slots) {
      slot.dead = true
      if (evicted) this.options.onEvict(slot)
    }
    page.slots.clear()
    page.live = 0
    page.shelves.length = 0
    page.nextY = 0
    if (page.solo && !evicted) this.drop(page)
  }

  private place(page: AtlasPage, w: number, h: number): AtlasSlot | null {
    const size = page.texture.width
    let shelf = page.shelves.find((s) => s.height >= h && s.height <= h * 1.5 && s.x + w <= size)
    if (!shelf) {
      if (page.nextY + h > page.texture.height) return null
      shelf = { y: page.nextY, height: h, x: 0 }
      page.shelves.push(shelf)
      page.nextY += h
    }
    const slot = this.slot(page, shelf.x + GUTTER, shelf.y + GUTTER, w - 2 * GUTTER, h - 2 * GUTTER)
    shelf.x += w
    return slot
  }

  private slot(page: AtlasPage, x: number, y: number, width: number, height: number): AtlasSlot {
    const tw = page.texture.width
    const th = page.texture.height
    const slot: AtlasSlot = {
      page,
      x,
      y,
      width,
      height,
      uv: [(x + 0.5) / tw, (y + 0.5) / th, (x + width - 0.5) / tw, (y + height - 0.5) / th],
      dead: false,
    }
    page.slots.add(slot)
    page.live++
    return slot
  }
}
