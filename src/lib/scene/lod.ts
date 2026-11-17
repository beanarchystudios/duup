/**
 * Levels of detail for frame rasters: a frame is drawn into a bitmap at one
 * of a fixed ladder of scales, a power of two from 1/64 to 4 design px per
 * texel, and the compositor shows the level nearest above the scale the
 * camera puts it on screen at, so a bitmap is never stretched past 1x and is
 * at worst halved. A frame's bitmap is capped by the largest side a texture
 * can have and by a pixel budget, so a very tall page tops out where the cap
 * holds and is shown live (a real iframe) once zoomed past it.
 */

export const LEVELS = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4] as const
export type Level = number

/** the longest side any raster gets, whatever the device allows */
export const MAX_RASTER_SIDE = 4096
/** 16 MP: a 4096² bitmap is 64 MB of texture */
export const MAX_RASTER_PIXELS = 16 * 1024 * 1024

/** The smallest level whose texels are at least as dense as `screenScale`
 *  (camera zoom × device pixel ratio), within the frame's caps. */
export function levelFor(
  screenScale: number,
  size: { width: number; height: number },
  maxSide = MAX_RASTER_SIDE,
): number {
  const cap = levelCap(size, maxSide)
  let index = 0
  while (index < LEVELS.length - 1 && LEVELS[index]! < screenScale) index++
  return Math.min(index, cap)
}

/** The highest level a frame of this size may be drawn at. */
export function levelCap(size: { width: number; height: number }, maxSide = MAX_RASTER_SIDE): number {
  const side = Math.max(1, size.width, size.height)
  const area = Math.max(1, size.width * size.height)
  let index = LEVELS.length - 1
  while (index > 0 && (side * LEVELS[index]! > maxSide || area * LEVELS[index]! ** 2 > MAX_RASTER_PIXELS)) index--
  return index
}

/** The bitmap size of a frame at a level, never below one texel. */
export function rasterSize(size: { width: number; height: number }, level: number): { width: number; height: number } {
  const scale = LEVELS[level] ?? 1
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

/** Of the levels a frame has, the one to show for `want`: the nearest above
 *  it (sharp, drawn smaller), else the nearest below (soft until the right
 *  one arrives). Null when it has none. */
export function bestLevel(have: Iterable<number>, want: number): number | null {
  let above: number | null = null
  let below: number | null = null
  for (const level of have) {
    if (level >= want) above = above === null ? level : Math.min(above, level)
    else below = below === null ? level : Math.max(below, level)
  }
  return above ?? below
}

/** The level every frame keeps for the far-out view: about 128 texels on its
 *  longest side, so a zoom-out to the whole canvas never shows a blank. */
export function thumbLevel(size: { width: number; height: number }): number {
  const side = Math.max(1, size.width, size.height)
  let index = 0
  while (index < LEVELS.length - 1 && side * LEVELS[index + 1]! <= 128) index++
  return index
}
