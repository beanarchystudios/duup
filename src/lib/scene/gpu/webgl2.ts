import { INSTANCE_BYTES, type Camera, type DrawBatch, type GpuRenderer, type GpuTexture } from './renderer'

/* The WebGPU shader (webgpu.ts) in GLSL ES 3.0: the same quad, the same
   instance layout. WebGL2 has no first-instance offset on its draws, so each
   batch re-points the instance attributes at its own run instead. */
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 uView;
uniform vec2 uCam;
uniform float uZoom;
layout(location = 0) in vec4 aRect;
layout(location = 1) in vec4 aUv;
layout(location = 2) in vec4 aExtra;
layout(location = 3) in vec4 aColor;
layout(location = 4) in vec4 aSoft;
out vec2 vUv;
out vec2 vLocal;
out vec2 vHalf;
out vec4 vShape;
out vec4 vColor;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 local = (corner - 0.5) * aRect.zw;
  float s = sin(aExtra.x);
  float c = cos(aExtra.x);
  vec2 turned = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = aRect.xy + aRect.zw * 0.5 + turned;
  vec2 screen = world * uZoom + uCam;
  gl_Position = vec4(screen.x / uView.x * 2.0 - 1.0, 1.0 - screen.y / uView.y * 2.0, 0.0, 1.0);
  vUv = mix(aUv.xy, aUv.zw, corner);
  vLocal = local;
  vHalf = aRect.zw * 0.5 - vec2(aSoft.y);
  vShape = vec4(aExtra.y, aExtra.z, aExtra.w, aSoft.x);
  vColor = aColor;
}`

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uZoom;
in vec2 vUv;
in vec2 vLocal;
in vec2 vHalf;
in vec4 vShape;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec4 texel = texture(uTex, vUv);
  vec2 half_ = max(vHalf, vec2(0.0001));
  float d;
  if (vShape.z < 0.5) {
    float r = min(vShape.y, min(half_.x, half_.y));
    vec2 q = abs(vLocal) - half_ + vec2(r);
    d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
  } else {
    d = (length(vLocal / half_) - 1.0) * min(half_.x, half_.y);
  }
  float coverage = vShape.w > 0.0 ? 1.0 - smoothstep(-vShape.w, vShape.w, d) : clamp(0.5 - d * uZoom, 0.0, 1.0);
  outColor = mix(vColor, texel * vColor.a, vShape.x) * coverage;
}`

interface WebGlTexture extends GpuTexture {
  texture: WebGLTexture
}

export class WebGl2Renderer implements GpuRenderer {
  readonly kind = 'webgl2' as const
  readonly maxTextureSize: number
  readonly software: boolean
  lost = false
  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly buffer: WebGLBuffer
  private readonly blank: WebGlTexture
  private readonly loc: {
    view: WebGLUniformLocation | null
    cam: WebGLUniformLocation | null
    zoom: WebGLUniformLocation | null
  }
  private capacity = 0
  private width = 1
  private height = 1
  private lostCallbacks: (() => void)[] = []

  static create(canvas: HTMLCanvasElement): WebGl2Renderer | null {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false })
    if (!gl) return null
    try {
      return new WebGl2Renderer(canvas, gl)
    } catch (error) {
      console.warn('[compositor] WebGL2 setup failed', error)
      return null
    }
  }

  private constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
  ) {
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const name = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    this.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)
    this.program = link(gl, VERTEX, FRAGMENT)
    this.loc = {
      view: gl.getUniformLocation(this.program, 'uView'),
      cam: gl.getUniformLocation(this.program, 'uCam'),
      zoom: gl.getUniformLocation(this.program, 'uZoom'),
    }
    this.vao = gl.createVertexArray()!
    this.buffer = gl.createBuffer()!
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    for (let location = 0; location < 5; location++) {
      gl.enableVertexAttribArray(location)
      gl.vertexAttribDivisor(location, 1)
    }
    this.point(0)
    gl.bindVertexArray(null)
    this.blank = this.createTexture(1, 1) as WebGlTexture
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
      for (const cb of this.lostCallbacks) cb()
    })
  }

  /** the instance attributes, starting at instance `first` */
  private point(first: number): void {
    const gl = this.gl
    for (let location = 0; location < 5; location++) {
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, INSTANCE_BYTES, first * INSTANCE_BYTES + location * 16)
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement
    const w = Math.max(1, Math.round(cssWidth * dpr))
    const h = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    this.width = Math.max(1, cssWidth)
    this.height = Math.max(1, cssHeight)
  }

  createTexture(width: number, height: number): GpuTexture {
    const gl = this.gl
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (width === 1 && height === 1) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    }
    const handle: WebGlTexture = { width, height, texture }
    return handle
  }

  upload(texture: GpuTexture, x: number, y: number, bitmap: ImageBitmap): void {
    if (this.lost) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, (texture as WebGlTexture).texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
  }

  destroyTexture(texture: GpuTexture): void {
    this.gl.deleteTexture((texture as WebGlTexture).texture)
  }

  setInstances(data: Float32Array, count: number): void {
    if (this.lost) return
    const gl = this.gl
    const bytes = count * INSTANCE_BYTES
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    if (bytes > this.capacity) {
      this.capacity = Math.max(bytes, Math.ceil(this.capacity * 1.5), INSTANCE_BYTES * 1024)
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW)
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * (INSTANCE_BYTES / 4))
  }

  draw(camera: Camera, batches: readonly DrawBatch[]): void {
    if (this.lost) return
    const gl = this.gl
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!batches.length) return
    gl.useProgram(this.program)
    gl.uniform2f(this.loc.view, this.width, this.height)
    gl.uniform2f(this.loc.cam, camera.x, camera.y)
    gl.uniform1f(this.loc.zoom, camera.zoom)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.activeTexture(gl.TEXTURE0)
    for (const batch of batches) {
      if (!batch.count) continue
      gl.bindTexture(gl.TEXTURE_2D, ((batch.texture as WebGlTexture | null) ?? this.blank).texture)
      this.point(batch.first)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count)
    }
    gl.bindVertexArray(null)
  }

  onLost(callback: () => void): void {
    this.lostCallbacks.push(callback)
  }

  destroy(): void {
    this.lostCallbacks = []
    const gl = this.gl
    gl.deleteBuffer(this.buffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader')
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link')
  return program
}
