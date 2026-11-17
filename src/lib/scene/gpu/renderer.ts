/**
 * The one interface the compositor draws through. Two backends implement
 * it: WebGPU (`webgpu.ts`) wherever the browser hands out an adapter, and
 * WebGL2 (`webgl2.ts`) everywhere else, with the same instance layout and
 * the same shader, so the compositor never knows which one it has.
 *
 * Everything is a textured quad. The scene's quads live in one instance
 * buffer in world coordinates, uploaded when the scene or what is resident
 * changes; a pan or zoom only changes the camera uniform, so moving the view
 * costs one small write and a handful of draw calls whatever the page holds.
 */

/** floats per instance; see the offsets below */
export const INSTANCE_FLOATS = 20
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4

/* Instance layout, in floats (five vec4s):
   0-3   x, y, width, height of the quad in world px (the unrotated box)
   4-7   u0, v0, u1, v1: the texture rect it samples, normalised
   8     rotation in radians, clockwise about the box's centre
   9     texture mix: 1 samples the texture, 0 paints the colour alone
   10    corner radius in world px (a rect), clamped to the box
   11    shape: 0 a (rounded) rectangle, 1 an ellipse filling the box
   12-15 r, g, b, a: the colour (premultiplied) for an untextured quad; the
         texture's opacity in `a` for a textured one
   16    blur in world px: 0 draws the shape crisp (antialiased to a screen
         pixel), above it the edge fades over that distance, a soft shadow
   17    the quad's extra margin past the shape on every side, world px, so
         a blurred edge has room to fade (the box in 0-3 includes it)
   18-19 unused */
export const I_X = 0
export const I_UV = 4
export const I_ROT = 8
export const I_MIX = 9
export const I_RADIUS = 10
export const I_SHAPE = 11
export const I_COLOR = 12
export const I_BLUR = 16
export const I_MARGIN = 17

export interface GpuTexture {
  readonly width: number
  readonly height: number
}

export interface Camera {
  /** where world (0, 0) lands on the canvas, in CSS px */
  x: number
  y: number
  /** CSS px per world px */
  zoom: number
}

/** A run of consecutive instances sampling one texture (null: colour only). */
export interface DrawBatch {
  texture: GpuTexture | null
  first: number
  count: number
}

export type RendererKind = 'webgpu' | 'webgl2'

export interface GpuRenderer {
  readonly kind: RendererKind
  /** the element it draws into */
  readonly canvas: HTMLCanvasElement
  /** drawn by the CPU (SwiftShader, llvmpipe, WARP): slower than a GPU */
  readonly software: boolean
  /** the largest texture side this device allows */
  readonly maxTextureSize: number
  /** the drawing buffer follows the canvas's CSS size at this pixel ratio */
  resize(cssWidth: number, cssHeight: number, dpr: number): void
  createTexture(width: number, height: number): GpuTexture
  /** copy a bitmap into a texture at (x, y), in texels */
  upload(texture: GpuTexture, x: number, y: number, bitmap: ImageBitmap): void
  destroyTexture(texture: GpuTexture): void
  /** the whole scene's quads, `count` of them in `data` */
  setInstances(data: Float32Array, count: number): void
  draw(camera: Camera, batches: readonly DrawBatch[]): void
  /** the device was lost (GPU reset, driver update): every texture is gone */
  readonly lost: boolean
  onLost(callback: () => void): void
  destroy(): void
}
