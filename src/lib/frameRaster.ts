import type { Frame } from '../../shared/types'
import { snapshotFrame } from './frameBridge'
import { inlineDocument, loadImage, RESOURCE_FETCH_MS, type ClipRect } from './documentRaster'

export { drawDocument, inlineDocument, pinViewportUnits, SharedResources, type ClipRect } from './documentRaster'

/**
 * Render a frame to an image in this browser: the document is inlined into
 * one self-contained SVG (every image, stylesheet and font as a data: URL,
 * since an SVG drawn as an image loads nothing from the network), drawn
 * onto a canvas and encoded. The engine that shows the frame paints the
 * export, so it is exactly what the person sees, with no server render.
 *
 * Anything that cannot be inlined (an image whose host sends no CORS
 * headers, a document the XML serializer cannot round-trip) rejects, and
 * the caller falls back to the server's renderer.
 */

export type RasterType = 'png' | 'jpeg'

export interface RasterOptions {
  /** output pixel density; 2 for a retina export */
  scale: number
  type: RasterType
  /** JPEG only, 0-1 */
  quality?: number
  /** the whole render, fetches included, gives up when this fires */
  signal?: AbortSignal
  /** the part of the frame to keep; the whole frame when unset. The
   *  document is still laid out and painted whole, so an element keeps
   *  every style its ancestors give it and whatever paints behind it. */
  clip?: ClipRect
}

export async function rasterizeFrame(frame: Frame, opts: RasterOptions): Promise<Blob> {
  const signal = opts.signal ?? AbortSignal.timeout(RESOURCE_FETCH_MS)
  const snapshot = await snapshotFrame(frame.id)
  /* an unmounted frame renders from its saved HTML; a mounted one whose
     pixels cannot all be read is for the server */
  if (snapshot && snapshot.html === null) throw new Error('the frame cannot be drawn here')
  const html = snapshot?.html ?? frame.html
  const svg = await inlineDocument(html, { width: frame.width, height: frame.height, signal })
  return drawSvg(svg, { width: frame.width, height: frame.height, ...opts })
}

/** The frame as an SVG file: the same self-contained document the raster
 *  draws (an HTML page inside a `foreignObject`, every resource inlined), so
 *  it opens anywhere a browser renders SVG but is not editable vector art.
 *  `clip` crops it by its viewBox; the white ground matches the PNG. */
export async function frameSvg(frame: Frame, opts: { clip?: ClipRect; signal?: AbortSignal } = {}): Promise<Blob> {
  const signal = opts.signal ?? AbortSignal.timeout(RESOURCE_FETCH_MS)
  const snapshot = await snapshotFrame(frame.id)
  if (snapshot && snapshot.html === null) throw new Error('the frame cannot be drawn here')
  const svg = await inlineDocument(snapshot?.html ?? frame.html, {
    width: frame.width,
    height: frame.height,
    signal,
    clip: opts.clip,
    background: '#fff',
    standalone: true,
  })
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
}

/** The part of the frame a rendered box covers, in whole frame pixels
 *  (rounded outward, so an edge at a fraction is kept), or null when the
 *  box lies outside the frame: what the frame clips away is not in any
 *  render of it. */
export function clipToFrame(
  rect: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): ClipRect | null {
  const left = Math.max(0, Math.floor(rect.x))
  const top = Math.max(0, Math.floor(rect.y))
  const right = Math.min(frame.width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(frame.height, Math.ceil(rect.y + rect.height))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Cut `clip` out of a rendered frame image drawn at `scale` (the server's
 *  export, say) and encode the piece. */
export async function cropRaster(
  image: Blob,
  clip: ClipRect,
  opts: Pick<RasterOptions, 'scale' | 'type' | 'quality'>,
): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(clip.width * opts.scale))
  canvas.height = Math.max(1, Math.round(clip.height * opts.scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  ctx.drawImage(bitmap, -Math.round(clip.x * opts.scale), -Math.round(clip.y * opts.scale))
  return encode(canvas, opts)
}

interface DrawOptions extends RasterOptions {
  width: number
  height: number
}

/** Draw the SVG onto a canvas at `scale` and encode it, the whole frame
 *  or the `clip` of it. The canvas is painted white first, as the server's
 *  renderer paints a frame with no background, and a JPEG has no alpha to
 *  keep. */
async function drawSvg(svg: string, opts: DrawOptions): Promise<Blob> {
  /* a data: URL, not a blob: one — Chromium taints the canvas for a
     foreignObject SVG drawn from a blob URL, and the export needs toBlob */
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, opts.signal)
  const clip = opts.clip ?? { x: 0, y: 0, width: opts.width, height: opts.height }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(clip.width * opts.scale))
  canvas.height = Math.max(1, Math.round(clip.height * opts.scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  /* the whole frame is drawn at scale, shifted so the clip lands at the origin */
  ctx.drawImage(
    image,
    -Math.round(clip.x * opts.scale),
    -Math.round(clip.y * opts.scale),
    Math.round(opts.width * opts.scale),
    Math.round(opts.height * opts.scale),
  )
  return encode(canvas, opts)
}

function encode(canvas: HTMLCanvasElement, opts: Pick<RasterOptions, 'type' | 'quality'>): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('could not encode the image'))),
        opts.type === 'jpeg' ? 'image/jpeg' : 'image/png',
        opts.type === 'jpeg' ? (opts.quality ?? 0.9) : undefined,
      )
    } catch (error) {
      /* a tainted canvas throws a SecurityError here */
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
