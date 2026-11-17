import { api } from '../api'
import { visibleGuides } from '../guides'
import { recordUpdate, recordUpdates, trackSave } from '../history'
import { snapFrame } from '../snap'
import { canEditOpenCanvas, useStore } from '../store'
import { currentScene, type SceneItem } from './scene'

/**
 * A press on a frame the compositor draws with no FrameView over it: the
 * stage hit-tests the scene, selects the frame (which mounts it, live, for
 * the next press) and drags the selection, as FrameView's own move does:
 * snapping to the frames around it and the guides, ⇧ adding to the
 * selection, Escape putting everything back, one undo step on release.
 */

/** the topmost frame under a world point that the stage handles itself */
export function unmountedFrameAt(x: number, y: number, mounted: ReadonlySet<string> | null): SceneItem | null {
  if (!mounted) return null
  /* a locked frame is canvas to the stage, as FrameView lets its presses through */
  return currentScene()?.topmostAt(x, y, (it) => !mounted.has(it.frame.id) && !it.frame.locked) ?? null
}

/** frames near a box, for snapping: the page can hold far too many to scan */
function neighbours(box: { x: number; y: number; width: number; height: number }, zoom: number, skip: Set<string>) {
  const reach = 400 / zoom
  return (
    currentScene()
      ?.query({
        minX: box.x - reach,
        minY: box.y - reach,
        maxX: box.x + box.width + reach,
        maxY: box.y + box.height + reach,
      })
      .filter((it) => !skip.has(it.frame.id))
      .map((it) => it.frame) ?? []
  )
}

export function startSceneDrag(e: PointerEvent | React.PointerEvent, item: SceneItem): void {
  const s = useStore.getState()
  const frame = item.frame
  if (frame.locked) return
  if (e.shiftKey) {
    s.toggleSelect(frame.id)
    if (!useStore.getState().selectedIds.includes(frame.id)) return
  } else if (!s.selectedIds.includes(frame.id)) {
    s.select(frame.id)
  }
  if (!canEditOpenCanvas(useStore.getState())) return
  const ids = new Set(useStore.getState().selectedIds)
  const scene = currentScene()
  const group = [...ids]
    .map((id) => scene?.byId.get(id)?.frame)
    .filter((f): f is NonNullable<typeof f> => !!f && !f.locked)
    .map((f) => ({ id: f.id, orig: { x: f.x, y: f.y, width: f.width, height: f.height } }))
  const start = { x: e.clientX, y: e.clientY }
  const orig = { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
  let moved = false
  let done = false

  function onMove(ev: PointerEvent) {
    if (ev.pointerId !== e.pointerId) return
    if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) moved = true
    if (!moved) return
    const zoom = useStore.getState().viewport.zoom
    const raw = {
      ...orig,
      x: Math.round(orig.x + (ev.clientX - start.x) / zoom),
      y: Math.round(orig.y + (ev.clientY - start.y) / zoom),
    }
    const snapped = ev.altKey
      ? { ...raw, guides: [] }
      : snapFrame('move', raw, neighbours(raw, zoom, ids), zoom, visibleGuides())
    useStore.getState().setSnapGuides(snapped.guides)
    const dx = snapped.x - orig.x
    const dy = snapped.y - orig.y
    for (const g of group) useStore.getState().patchFrameLocal(g.id, { x: g.orig.x + dx, y: g.orig.y + dy })
  }
  function finish(save: boolean) {
    if (done) return
    done = true
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    useStore.getState().setSnapGuides([])
    const live = currentScene()
    const updates: { frameId: string; before: typeof orig; after: typeof orig }[] = []
    for (const g of group) {
      const f = live?.byId.get(g.id)?.frame
      if (!f) continue
      if (!save) {
        useStore.getState().patchFrameLocal(g.id, g.orig)
        continue
      }
      const after = { x: f.x, y: f.y, width: f.width, height: f.height }
      if (after.x === g.orig.x && after.y === g.orig.y) continue
      trackSave(api.updateFrame(f.id, after).catch(console.error))
      updates.push({ frameId: f.id, before: g.orig, after })
    }
    const [only, ...more] = updates
    if (only && !more.length) recordUpdate(only.frameId, only.before, only.after)
    else if (more.length) recordUpdates(updates)
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === e.pointerId) finish(true)
  }
  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === e.pointerId) finish(false)
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') finish(false)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
}
