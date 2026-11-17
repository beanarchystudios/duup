import { useEffect, useRef, type RefObject } from 'react'
import { Compositor, createRenderer } from '../lib/scene/compositor'
import { LabelLayer } from '../lib/scene/labels'
import { rendererChoice, useSceneState } from '../lib/scene/sceneState'
import { useStore } from '../lib/store'

declare global {
  interface Window {
    /** the running compositor, for the benchmark and the browser tests */
    __doopCompositor?: Compositor | null
    /** the renderer's state, for the benchmark and the browser tests */
    __doopScene?: typeof useSceneState
  }
}

/**
 * The GPU layer under the world: the compositor's <canvas>, which draws
 * every frame not shown live (src/lib/scene/compositor.ts). WebGPU first,
 * WebGL2 on a fresh canvas when WebGPU is missing (a canvas a WebGPU context
 * has claimed cannot become WebGL), and nothing at all when neither is
 * there: then every frame is mounted live, as before.
 */
export function CanvasCompositor({ stage }: { stage: RefObject<HTMLDivElement | null> }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    const stageEl = stage.current
    if (!el || !stageEl) return
    let compositor: Compositor | null = null
    let cancelled = false
    const choice = rendererChoice()
    const fresh = () => {
      const canvas = document.createElement('canvas')
      canvas.className = 'pointer-events-none absolute left-0 top-0 h-full w-full'
      el.append(canvas)
      return canvas
    }
    useSceneState.getState().setRenderer(choice === 'dom' ? 'dom' : 'pending')
    if (choice === 'dom') return
    void (async () => {
      const renderer = await createRenderer(fresh, choice)
      if (cancelled) {
        renderer?.destroy()
        return
      }
      /* the attempts that came to nothing leave their canvases behind */
      for (const child of [...el.children]) if (child !== renderer?.canvas) child.remove()
      if (!renderer) {
        useSceneState.getState().setRenderer('dom')
        return
      }
      compositor = new Compositor(renderer, stageEl)
      compositor.start()
      el.dataset.compositor = renderer.kind
      window.__doopCompositor = compositor
      window.__doopScene = useSceneState
      useSceneState.getState().setRenderer(renderer.kind)
    })()
    return () => {
      cancelled = true
      compositor?.dispose()
      if (window.__doopCompositor === compositor) window.__doopCompositor = null
      el.replaceChildren()
      delete el.dataset.compositor
    }
  }, [stage])
  return <div ref={host} data-compositor="" className="pointer-events-none absolute inset-0" />
}

/**
 * The names of frames with no FrameView, over the world (labels.ts). `skip`
 * is the frames that draw their own; null when every frame does.
 */
export function CanvasLabels({
  stage,
  skip,
}: {
  stage: RefObject<HTMLDivElement | null>
  skip: ReadonlySet<string> | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layer = useRef<LabelLayer | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const stageEl = stage.current
    if (!canvas || !stageEl) return
    const labels = new LabelLayer(canvas, stageEl)
    layer.current = labels
    const unsubCamera = useStore.subscribe((s, prev) => {
      if (s.viewport !== prev.viewport) labels.follow()
      if (s.canvas !== prev.canvas || s.activePageId !== prev.activePageId) labels.redraw()
    })
    const unsubSettle = useSceneState.subscribe((s, prev) => {
      if (s.settled !== prev.settled) labels.redraw()
    })
    const ro = new ResizeObserver(() => labels.redraw())
    ro.observe(stageEl)
    return () => {
      unsubCamera()
      unsubSettle()
      ro.disconnect()
      labels.dispose()
      layer.current = null
    }
  }, [stage])
  useEffect(() => {
    layer.current?.setSkip(skip)
  }, [skip])
  return <canvas ref={canvasRef} data-frame-labels="" className="pointer-events-none absolute left-0 top-0" />
}
