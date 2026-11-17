import { drawDocument, SharedResources } from '../documentRaster'
import type { RasterReply, RasterRequest } from './rasterHost'

/**
 * The raster frame's own script (raster-frame.html). The editor loads it in
 * a sandboxed iframe with an opaque origin, which Chromium runs in a process
 * of its own, and posts it frame documents; it draws each into a bitmap
 * (documentRaster.ts) and hands the bitmap back, transferred. Parsing,
 * inlining, laying out and painting a whole screen all happen here, never
 * on the thread that is moving the editor's view.
 *
 * It only answers its parent, and runs nothing it is sent: the documents'
 * scripts are stripped before they are drawn, as for an export.
 */

const resources = new SharedResources()

addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== parent) return
  const req = ev.data as Partial<RasterRequest> | null
  if (req?.type !== 'doop:raster' || typeof req.id !== 'number' || typeof req.html !== 'string') return
  const { id, html, width = 1, height = 1, scale = 1, background } = req
  drawDocument(html, { width, height, scale, background, signal: AbortSignal.timeout(20_000), resources })
    .then((bitmap) => {
      const reply: RasterReply = { type: 'doop:raster-done', id, bitmap }
      parent.postMessage(reply, '*', [bitmap])
    })
    .catch((error: unknown) => {
      const reply: RasterReply = {
        type: 'doop:raster-done',
        id,
        error: error instanceof Error ? error.message : String(error),
      }
      parent.postMessage(reply, '*')
    })
})

parent.postMessage({ type: 'doop:raster-ready' }, '*')
