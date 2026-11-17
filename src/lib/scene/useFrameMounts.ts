import { useMemo, useRef } from 'react'
import { useStore } from '../store'
import { decide, sameSet, ALL_LIVE_BELOW, type Policy } from './livePolicy'
import { primitiveOf } from './primitives'
import { currentScene, type SceneItem } from './scene'
import { useSceneState } from './sceneState'
import type { IndexBox } from './sceneIndex'

/** a selection this large is mounted but not made live frame by frame */
const LIVE_SELECTION_MAX = 4

function native(item: SceneItem): boolean {
  return item.standalone && primitiveOf(item.frame.html) !== null
}

function stageSize(): { width: number; height: number } {
  const stage = document.querySelector<HTMLElement>('.stage')
  return { width: stage?.clientWidth ?? window.innerWidth, height: stage?.clientHeight ?? window.innerHeight }
}

/**
 * The FrameViews the stage mounts and which of them are live, decided by
 * `livePolicy` from what is being worked on and where the camera rests.
 * Re-decided when the camera settles (not on every pan step), when the work
 * changes (a selection, a stream) and when the pointer dwells on a frame.
 * With no GPU renderer every frame is mounted live, the v1 behaviour.
 */
export function useFrameMounts(frameCount: number): Policy | null {
  const renderer = useSceneState((s) => s.renderer)
  const settled = useSceneState((s) => s.settled)
  const hovered = useSceneState((s) => s.hovered)
  const failed = useSceneState((s) => s.failed)
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const selectedIds = useStore((s) => s.selectedIds)
  const ctxFrame = useStore((s) => s.ctxMenu?.frameId ?? null)
  const streams = useStore((s) => s.streams)
  const pickedFrame = useStore((s) => s.selectedElement?.frameId ?? null)
  const layerHoverFrame = useStore((s) => s.hoveredLayer?.frameId ?? null)
  const previous = useRef<string[]>([])
  const last = useRef<Policy | null>(null)

  return useMemo(() => {
    /* null: mount every frame live */
    if (renderer === 'dom') return null
    if (renderer === 'pending' && frameCount <= ALL_LIVE_BELOW) return null
    const scene = currentScene()
    if (!scene) return null
    if (renderer === 'pending') return { mounted: new Set<string>(), live: new Set<string>() }
    const vp = useStore.getState().viewport
    const size = stageSize()
    const view: IndexBox = {
      minX: -vp.x / vp.zoom,
      minY: -vp.y / vp.zoom,
      maxX: (size.width - vp.x) / vp.zoom,
      maxY: (size.height - vp.y) / vp.zoom,
    }
    const keep = new Set<string>()
    const mount = new Set<string>()
    for (const id of selectedIds) (selectedIds.length <= LIVE_SELECTION_MAX ? keep : mount).add(id)
    for (const id of [ctxFrame, pickedFrame, layerHoverFrame, ...Object.keys(streams)]) if (id) keep.add(id)
    const next = decide({
      all: scene.items,
      inView: scene.query(view),
      view,
      zoom: vp.zoom,
      keep,
      mount,
      hovered,
      failed,
      previous: previous.current,
      native,
    })
    /* recency: the newly live go to the end */
    previous.current = [
      ...previous.current.filter((id) => next.live.has(id)),
      ...[...next.live].filter((id) => !previous.current.includes(id)),
    ]
    const stable: Policy = last.current
      ? { mounted: sameSet(last.current.mounted, next.mounted), live: sameSet(last.current.live, next.live) }
      : next
    if (last.current && stable.mounted === last.current.mounted && stable.live === last.current.live)
      return last.current
    last.current = stable
    return stable
    /* canvas and the page are read through currentScene(); they are what the
       memo depends on, with the camera's resting point (`settled`) */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    renderer,
    settled,
    hovered,
    failed,
    canvas,
    activePageId,
    selectedIds,
    ctxFrame,
    streams,
    pickedFrame,
    layerHoverFrame,
    frameCount,
  ])
}
