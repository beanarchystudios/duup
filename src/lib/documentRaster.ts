/**
 * A frame document as one self-contained SVG, and that SVG drawn into a
 * bitmap: every image, stylesheet and font inlined as a data: URL (an SVG
 * drawn as an image loads nothing from the network), scripts and handlers
 * stripped. Used by the export (frameRaster.ts) and by the canvas renderer,
 * which runs it in a raster frame of its own, off the editor's main thread
 * (src/lib/scene/rasterFrame.ts), so this module imports nothing of the
 * editor.
 */

export const RESOURCE_FETCH_MS = 15_000

/** A box inside the frame, in frame pixels. */
export interface ClipRect {
  x: number
  y: number
  width: number
  height: number
}

export interface InlineOptions {
  width: number
  height: number
  signal: AbortSignal
  /** fetched resources to share with other documents (the canvas renderer
   *  inlines the same fonts and images into every frame it draws); a fresh
   *  cache per document when unset */
  resources?: SharedResources
  /** the part of the document the SVG shows, by its viewBox; all of it when unset */
  clip?: ClipRect
  /** painted under the document; transparent when unset */
  background?: string
  /** the SVG is a file someone opens as a page (a browser tab, Quick
   *  Look), not an image drawn here: there the viewer's window is the
   *  viewport, so viewport units and media queries are settled against the
   *  frame first (`FrameViewport`) */
  standalone?: boolean
}

/* a number glued to a viewport unit, not inside a word or a base64 run */
const VIEWPORT_UNIT = /(?<![\w+/=.-])(-?\d*\.?\d+)(s|l|d)?(vh|vw|vmin|vmax)(?![\w+/=])/gi

/** `100vh` as the frame's px, `50vw` as half its width, and so on. */
export function pinViewportUnits(css: string, size: { width: number; height: number }): string {
  return css.replace(VIEWPORT_UNIT, (_whole, amount: string, _kind: string | undefined, unit: string) => {
    const lower = unit.toLowerCase()
    const side =
      lower === 'vh'
        ? size.height
        : lower === 'vw'
          ? size.width
          : lower === 'vmin'
            ? Math.min(size.width, size.height)
            : Math.max(size.width, size.height)
    return `${Math.round(Number(amount) * side * 100) / 10_000}px`
  })
}

/* CSSRule.MEDIA_RULE: the rules come from another window, so `instanceof`
   cannot tell them apart */
const MEDIA_RULE = 4

/** The frame's own viewport, for CSS that will be laid out somewhere else:
 *  viewport units become the frame's px, and `@media` rules are kept or
 *  dropped by what a window of the frame's size matches. A hidden iframe of
 *  that size answers the queries, so every feature (width, orientation,
 *  aspect ratio, the person's colour scheme) is judged as the canvas does. */
class FrameViewport {
  private frame: HTMLIFrameElement | null = null
  constructor(private readonly size: { width: number; height: number }) {}

  /** before url()s are inlined, so no data: URL is ever rewritten */
  units(css: string): string {
    return pinViewportUnits(css, this.size)
  }

  matches(query: string): boolean {
    return !query.trim() || this.window().matchMedia(query).matches
  }

  /** `css` with each top-level `@media` rule unwrapped when the frame
   *  matches it and dropped when not; the rest is the CSSOM's own text. */
  media(css: string): string {
    if (!/@media/i.test(css)) return css
    const doc = this.window().document
    const style = doc.createElement('style')
    style.textContent = css
    doc.head.append(style)
    try {
      const rules = style.sheet?.cssRules
      return rules ? this.serialize(rules) : css
    } finally {
      style.remove()
    }
  }

  dispose(): void {
    this.frame?.remove()
    this.frame = null
  }

  private serialize(rules: CSSRuleList): string {
    return Array.from(rules, (rule) => {
      if (rule.type !== MEDIA_RULE) return rule.cssText
      const media = rule as CSSMediaRule
      return this.matches(media.media.mediaText) ? this.serialize(media.cssRules) : ''
    }).join('\n')
  }

  private window(): Window {
    if (!this.frame) {
      const frame = document.createElement('iframe')
      frame.setAttribute('aria-hidden', 'true')
      frame.tabIndex = -1
      frame.style.cssText = `position:fixed;left:-100000px;top:0;border:0;visibility:hidden;width:${this.size.width}px;height:${this.size.height}px`
      document.body.append(frame)
      /* laid out now, so its media queries see its size */
      void frame.offsetWidth
      this.frame = frame
    }
    const win = this.frame.contentWindow
    if (!win) throw new Error('no viewport to match media against')
    return win
  }
}

/* what would run once the SVG is opened as a page: inline handlers, and
   links or forms into script */
const SCRIPT_URL = /^\s*(javascript|vbscript):/i
const URL_ATTRS = ['href', 'xlink:href', 'src', 'action', 'formaction'] as const

function stripExecutable(doc: Document): void {
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name)
    }
    for (const name of URL_ATTRS) {
      if (SCRIPT_URL.test(el.getAttribute(name) ?? '')) el.removeAttribute(name)
    }
  }
}

/** One SVG, sized to the frame, holding the document with every external
 *  resource inlined. Exported for tests. */
export async function inlineDocument(html: string, opts: InlineOptions): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = new URL(doc.querySelector('base[href]')?.getAttribute('href') ?? '', document.baseURI).href
  const viewport = opts.standalone ? new FrameViewport(opts) : null
  try {
    const resources =
      opts.resources && !viewport ? opts.resources.forSignal(opts.signal) : new ResourceCache(opts.signal, viewport)
    return await inlineInto(doc, base, resources, viewport, opts)
  } finally {
    viewport?.dispose()
  }
}

async function inlineInto(
  doc: Document,
  base: string,
  resources: ResourceCache,
  viewport: FrameViewport | null,
  opts: InlineOptions,
): Promise<string> {
  const units = (css: string) => viewport?.units(css) ?? css
  const settleMedia = (css: string) => viewport?.media(css) ?? css

  /* nothing embeds inside an SVG image: a nested document would be a hole
     in the picture, so a frame holding one is for the server's browser */
  if (doc.querySelector('iframe, object, embed')) throw new Error('the frame embeds a document')
  /* nothing runs inside one either: scripts, and the <base> that has done its job */
  for (const el of doc.querySelectorAll('script, base, link:not([rel~="stylesheet"])')) el.remove()
  stripExecutable(doc)

  const work: Promise<void>[] = []
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    work.push(
      (async () => {
        const href = new URL(link.getAttribute('href') ?? '', base).href
        const css = await resources.text(href)
        const style = doc.createElement('style')
        const media = link.getAttribute('media')
        if (media) style.setAttribute('media', media)
        style.textContent = settleMedia(await inlineCssUrls(units(css), href, resources))
        link.replaceWith(style)
      })(),
    )
  }
  for (const style of doc.querySelectorAll('style')) {
    work.push(
      (async () => {
        style.textContent = settleMedia(await inlineCssUrls(units(style.textContent ?? ''), base, resources))
      })(),
    )
  }
  for (const el of doc.querySelectorAll('[style]')) {
    const inline = units(el.getAttribute('style') ?? '')
    el.setAttribute('style', inline)
    if (!/url\(/i.test(inline)) continue
    work.push(
      (async () => {
        el.setAttribute('style', await inlineCssUrls(inline, base, resources))
      })(),
    )
  }
  for (const img of doc.querySelectorAll('img, input[type="image"], video[poster]')) {
    /* one source per image: the browser picked from srcset by the frame's
       own viewport, which is the width the SVG gets too, so src is right */
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    img.removeAttribute('loading')
    const attr = img.tagName === 'VIDEO' ? 'poster' : 'src'
    work.push(inlineAttr(img, attr, base, resources))
  }
  for (const source of doc.querySelectorAll('picture > source')) source.remove()
  for (const image of doc.querySelectorAll('image')) {
    work.push(inlineAttr(image, image.hasAttribute('href') ? 'href' : 'xlink:href', base, resources))
  }
  await Promise.all(work)
  /* a sheet for one media applies or not, judged by the frame's viewport */
  if (viewport) {
    for (const style of doc.querySelectorAll('style[media]')) {
      if (viewport.matches(style.getAttribute('media') ?? '')) style.removeAttribute('media')
      else style.remove()
    }
  }

  /* the XML serializer gives an HTML document's root its xhtml namespace */
  const body = new XMLSerializer().serializeToString(doc.documentElement)
  const { width, height, clip } = opts
  const box = clip ? ` viewBox="${clip.x} ${clip.y} ${clip.width} ${clip.height}"` : ''
  const ground = opts.background ? `<rect width="${width}" height="${height}" fill="${opts.background}"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${clip?.width ?? width}" height="${clip?.height ?? height}"${box}>` +
    `${ground}<foreignObject width="${width}" height="${height}">${body}</foreignObject></svg>`
  )
}

async function inlineAttr(el: Element, attr: string, base: string, resources: ResourceCache): Promise<void> {
  const raw = el.getAttribute(attr)
  if (!raw || isInlineUrl(raw)) return
  el.setAttribute(attr, await inlineUrl(raw, base, resources))
}

/** The data: URL for `ref`, keeping its fragment: `sprite.svg#icon` and
 *  `#svgView(...)` pick what an SVG shows. */
async function inlineUrl(
  ref: string,
  base: string,
  resources: ResourceCache,
  chain?: ReadonlySet<string>,
): Promise<string> {
  const url = new URL(ref, base)
  const fragment = url.hash
  url.hash = ''
  return (await resources.dataUrl(url.href, chain)) + fragment
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
/* `@import "x.css"` is `@import url("x.css")` without the function */
const CSS_IMPORT_STRING = /@import\s+(['"])([^'"]+)\1/gi

/** Every `url(...)` in `css` that points off the document becomes a data:
 *  URL; a stylesheet it imports is inlined the same way, recursively.
 *  `chain` is the stylesheets being inlined on the way here: one that
 *  imports itself again, however indirectly, is left empty at that point. */
async function inlineCssUrls(
  css: string,
  base: string,
  resources: ResourceCache,
  chain: ReadonlySet<string> = new Set(),
): Promise<string> {
  resources.signal.throwIfAborted()
  css = css.replace(CSS_IMPORT_STRING, '@import url("$2")')
  const refs = [...css.matchAll(CSS_URL)].map((m) => m[2]?.trim() ?? '').filter((ref) => ref && !isInlineUrl(ref))
  if (refs.length === 0) return css
  const replacements = new Map<string, string>()
  await Promise.all(
    [...new Set(refs)].map(async (ref) => {
      replacements.set(ref, await inlineUrl(ref, base, resources, chain))
    }),
  )
  return css.replace(CSS_URL, (whole, _quote: string, ref: string) => {
    const replacement = replacements.get(ref.trim())
    return replacement ? `url("${replacement}")` : whole
  })
}

/** data: carries its own bytes, `#id` points inside the document. A blob:
 *  URL is left to the fetch, which fails for another document's object
 *  URL and so hands the export to the server. */
function isInlineUrl(ref: string): boolean {
  return /^(data:|#|about:)/i.test(ref)
}

/** Fetches, one per URL, as the bytes of everything inlined. A failed
 *  fetch rejects the whole render: a blank where an image belongs is not an
 *  export, and the server's renderer can still load it. */
class ResourceCache {
  private readonly pending: Map<string, Promise<Blob>>
  /** data: URLs already made, by URL: a font is base64-encoded once */
  private readonly encoded: Map<string, Promise<string>> | null
  constructor(
    readonly signal: AbortSignal,
    /** settles each imported stylesheet as `inlineDocument` does the page's */
    private readonly viewport: FrameViewport | null = null,
    shared?: { pending: Map<string, Promise<Blob>>; encoded: Map<string, Promise<string>> },
  ) {
    this.pending = shared?.pending ?? new Map()
    this.encoded = shared?.encoded ?? null
  }

  private blob(url: string): Promise<Blob> {
    let pending = this.pending.get(url)
    if (!pending) {
      /* a shared fetch outlives the document that started it: its own
         signal must not cancel it for the others */
      const signal = this.encoded ? AbortSignal.timeout(RESOURCE_FETCH_MS) : this.signal
      pending = fetch(url, { signal, credentials: 'same-origin' }).then((res) => {
        if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
        return res.blob()
      })
      this.pending.set(url, pending)
      /* a failure is not kept: the next document asks again */
      if (this.encoded) pending.catch(() => this.pending.delete(url))
    }
    return pending
  }

  async text(url: string): Promise<string> {
    return (await this.blob(url)).text()
  }

  async dataUrl(url: string, chain: ReadonlySet<string> = new Set()): Promise<string> {
    if (this.encoded && chain.size === 0) {
      let done = this.encoded.get(url)
      if (!done) {
        done = this.encode(url, chain)
        this.encoded.set(url, done)
        done.catch(() => this.encoded?.delete(url))
      }
      return done
    }
    return this.encode(url, chain)
  }

  private async encode(url: string, chain: ReadonlySet<string>): Promise<string> {
    const blob = await this.blob(url)
    if (blob.type.startsWith('text/css')) {
      /* a stylesheet imported by another: its own url()s resolve against
         it, and an import cycle ends where it started */
      if (chain.has(url)) return 'data:text/css,'
      const own = this.viewport ? this.viewport.units(await blob.text()) : await blob.text()
      const inlined = await inlineCssUrls(own, url, this, new Set(chain).add(url))
      const css = this.viewport ? this.viewport.media(inlined) : inlined
      return toDataUrl(new Blob([css], { type: 'text/css' }))
    }
    return toDataUrl(blob)
  }
}

/**
 * Resources fetched for one document and kept for the next: the canvas
 * renderer draws every frame of a page, and its frames load the same fonts
 * and images. Bounded by entries; the oldest go first.
 */
export class SharedResources {
  private readonly pending = new Map<string, Promise<Blob>>()
  private readonly encoded = new Map<string, Promise<string>>()
  constructor(private readonly limit = 400) {}

  /** @internal a cache view for one document's render */
  forSignal(signal: AbortSignal): ResourceCache {
    for (const map of [this.pending, this.encoded] as Map<string, unknown>[]) {
      while (map.size > this.limit) map.delete(map.keys().next().value as string)
    }
    return new ResourceCache(signal, null, { pending: this.pending, encoded: this.encoded })
  }
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('could not read resource'))
    reader.readAsDataURL(blob)
  })
}

export function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const abort = () => reject(signal?.reason ?? new Error('render aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      signal?.removeEventListener('abort', abort)
      resolve(image)
    }
    image.onerror = () => {
      signal?.removeEventListener('abort', abort)
      reject(new Error('the document could not be drawn'))
    }
    image.src = url
  })
}

/** A frame document drawn into a bitmap of `width` × `height` design px at
 *  `scale` texels per px, for the canvas renderer: the same inlined SVG the
 *  export draws, painted on `background` (transparent when unset), with no
 *  encode. Scripts never run, so what one adds is missing. */
export async function drawDocument(
  html: string,
  opts: {
    width: number
    height: number
    scale: number
    background?: string
    signal: AbortSignal
    resources?: SharedResources
  },
): Promise<ImageBitmap> {
  const svg = await inlineDocument(html, {
    width: opts.width,
    height: opts.height,
    signal: opts.signal,
    resources: opts.resources,
  })
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, opts.signal)
  const w = Math.max(1, Math.round(opts.width * opts.scale))
  const h = Math.max(1, Math.round(opts.height * opts.scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  if (opts.background) {
    ctx.fillStyle = opts.background
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(image, 0, 0, w, h)
  return canvas.transferToImageBitmap()
}
