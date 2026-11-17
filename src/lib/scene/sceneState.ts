import { create } from 'zustand'
import type { RendererKind } from './gpu/renderer'

/**
 * What the renderer and the editor tell each other, kept apart from the
 * main store so its churn (a hover, a raster landing) never re-runs the
 * selectors of every component that reads the canvas.
 */
export type RendererChoice = 'auto' | RendererKind | 'dom'

export interface SceneState {
  /** what draws the frames: a GPU backend, or every frame as a live iframe
   *  (`dom`: the v1 renderer, chosen or fallen back to). `pending` while
   *  the GPU is being asked. */
  renderer: RendererKind | 'dom' | 'pending'
  /** frames whose live iframe shows their current document: the compositor
   *  leaves them to it */
  showing: ReadonlySet<string>
  /** frames whose document cannot be drawn into a bitmap here (a nested
   *  document, an image without CORS): shown live when there is room */
  failed: ReadonlySet<string>
  /** the frame under the pointer, after a short dwell: shown live, so its
   *  element outlines are there by the time it is clicked */
  hovered: string | null
  /** bumped when the camera comes to rest, so mount decisions follow it */
  settled: number
  setRenderer(renderer: SceneState['renderer']): void
  setShowing(frameId: string, on: boolean): void
  setFailed(frameId: string, on: boolean): void
  setHovered(frameId: string | null): void
  bumpSettled(): void
}

function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> | null {
  if (set.has(id) === on) return null
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

export const useSceneState = create<SceneState>((set) => ({
  renderer: 'pending',
  showing: new Set(),
  failed: new Set(),
  hovered: null,
  settled: 0,
  setRenderer: (renderer) => set({ renderer }),
  setShowing: (frameId, on) =>
    set((s) => {
      const showing = toggled(s.showing, frameId, on)
      return showing ? { showing } : {}
    }),
  setFailed: (frameId, on) =>
    set((s) => {
      const failed = toggled(s.failed, frameId, on)
      return failed ? { failed } : {}
    }),
  setHovered: (hovered) => set((s) => (s.hovered === hovered ? {} : { hovered })),
  bumpSettled: () => set((s) => ({ settled: s.settled + 1 })),
}))

const CHOICE_KEY = 'doop:renderer'

/** This browser's pick (Settings, or the benchmark): `auto` unless set. */
export function rendererChoice(): RendererChoice {
  try {
    const value = localStorage.getItem(CHOICE_KEY)
    if (value === 'webgpu' || value === 'webgl2' || value === 'dom' || value === 'auto') return value
  } catch {
    /* storage refused: the default */
  }
  return 'auto'
}

export function setRendererChoice(choice: RendererChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(CHOICE_KEY)
    else localStorage.setItem(CHOICE_KEY, choice)
  } catch {
    /* per browser, best effort */
  }
}
