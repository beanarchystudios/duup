import { INSTANCE_BYTES, type Camera, type DrawBatch, type GpuRenderer, type GpuTexture } from './renderer'

/* The usage bits, as the WebGPU spec numbers them: the DOM typings have the
   types but not these constant namespaces */
const BUFFER = { COPY_DST: 0x8, VERTEX: 0x20, UNIFORM: 0x40 } as const
const TEXTURE = { COPY_DST: 0x2, TEXTURE_BINDING: 0x4, RENDER_ATTACHMENT: 0x10 } as const

/* The quad shader: a unit square's corner (from the vertex index) is scaled
   to the instance's box, turned about its centre, placed in the world and
   carried through the camera into clip space. */
const SHADER = /* wgsl */ `
struct Uniforms {
  view: vec2f,
  cam: vec2f,
  zoom: f32,
  pad0: f32,
  pad1: vec2f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) local: vec2f,
  @location(2) half: vec2f,
  @location(3) shape: vec4f,
  @location(4) color: vec4f,
}

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) rect: vec4f,
  @location(1) uvr: vec4f,
  @location(2) extra: vec4f,
  @location(3) color: vec4f,
  @location(4) soft: vec4f,
) -> VOut {
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));
  let local = (corner - vec2f(0.5)) * rect.zw;
  let s = sin(extra.x);
  let c = cos(extra.x);
  let turned = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  let world = rect.xy + rect.zw * 0.5 + turned;
  let screen = world * u.zoom + u.cam;
  var out: VOut;
  out.pos = vec4f(screen.x / u.view.x * 2.0 - 1.0, 1.0 - screen.y / u.view.y * 2.0, 0.0, 1.0);
  out.uv = mix(uvr.xy, uvr.zw, corner);
  out.local = local;
  out.half = rect.zw * 0.5 - vec2f(soft.y);
  /* mix, radius, shape, blur */
  out.shape = vec4f(extra.y, extra.z, extra.w, soft.x);
  out.color = color;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let texel = textureSample(tex, samp, in.uv);
  let half = max(in.half, vec2f(0.0001));
  var d: f32;
  if (in.shape.z < 0.5) {
    let r = min(in.shape.y, min(half.x, half.y));
    let q = abs(in.local) - half + vec2f(r);
    d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
  } else {
    d = (length(in.local / half) - 1.0) * min(half.x, half.y);
  }
  var coverage: f32;
  if (in.shape.w > 0.0) {
    coverage = 1.0 - smoothstep(-in.shape.w, in.shape.w, d);
  } else {
    coverage = clamp(0.5 - d * u.zoom, 0.0, 1.0);
  }
  return mix(in.color, texel * in.color.a, in.shape.x) * coverage;
}
`

interface WebGpuTexture extends GpuTexture {
  texture: GPUTexture
  bindGroup: GPUBindGroup
}

export class WebGpuRenderer implements GpuRenderer {
  readonly kind = 'webgpu' as const
  readonly maxTextureSize: number
  readonly canvas: HTMLCanvasElement
  lost = false
  private readonly context: GPUCanvasContext
  private readonly pipeline: GPURenderPipeline
  private readonly uniforms: GPUBuffer
  private readonly uniformGroup: GPUBindGroup
  private readonly sampler: GPUSampler
  private readonly blank: WebGpuTexture
  private instances: GPUBuffer | null = null
  private instanceCapacity = 0
  private width = 1
  private height = 1
  private lostCallbacks: (() => void)[] = []

  /** A software adapter (SwiftShader, WARP) or none: `auto` then prefers a
   *  WebGL2 context, which may still reach the real GPU. */
  static async adapter(): Promise<{ adapter: GPUAdapter; software: boolean } | null> {
    const gpu = navigator.gpu
    if (!gpu) return null
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
    if (!adapter) return null
    const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean }
    const software =
      !!info.isFallbackAdapter || /swiftshader|warp|llvmpipe/i.test(`${info.architecture} ${info.description}`)
    return { adapter, software }
  }

  static async create(
    canvas: HTMLCanvasElement,
    found?: { adapter: GPUAdapter; software: boolean },
  ): Promise<WebGpuRenderer | null> {
    const pick = found ?? (await WebGpuRenderer.adapter())
    if (!pick) return null
    const adapter = pick.adapter
    const device = await adapter
      .requestDevice({ requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D } })
      .catch(() => null)
    if (!device) return null
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!context) {
      device.destroy()
      return null
    }
    return new WebGpuRenderer(device, context, canvas, pick.software)
  }

  private constructor(
    private readonly device: GPUDevice,
    context: GPUCanvasContext,
    canvas: HTMLCanvasElement,
    readonly software: boolean,
  ) {
    this.context = context
    this.canvas = canvas
    this.maxTextureSize = device.limits.maxTextureDimension2D
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'premultiplied' })
    const module = device.createShaderModule({ code: SHADER })
    const f32x4 = (location: number, offset: number): GPUVertexAttribute => ({
      shaderLocation: location,
      offset,
      format: 'float32x4',
    })
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: INSTANCE_BYTES,
            stepMode: 'instance',
            attributes: [f32x4(0, 0), f32x4(1, 16), f32x4(2, 32), f32x4(3, 48), f32x4(4, 64)],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    })
    this.uniforms = device.createBuffer({ size: 32, usage: BUFFER.UNIFORM | BUFFER.COPY_DST })
    this.uniformGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }],
    })
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.blank = this.createTexture(1, 1) as WebGpuTexture
    void device.lost.then((info) => {
      this.lost = true
      /* our own destroy() is not a loss */
      if (info.reason === 'destroyed') return
      for (const cb of this.lostCallbacks) cb()
    })
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const canvas = this.context.canvas as HTMLCanvasElement
    const w = Math.max(1, Math.round(cssWidth * dpr))
    const h = Math.max(1, Math.round(cssHeight * dpr))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    this.width = Math.max(1, cssWidth)
    this.height = Math.max(1, cssHeight)
  }

  createTexture(width: number, height: number): GpuTexture {
    const texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      /* copyExternalImageToTexture needs RENDER_ATTACHMENT on its target */
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
    })
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
      ],
    })
    const handle: WebGpuTexture = { width, height, texture, bindGroup }
    return handle
  }

  upload(texture: GpuTexture, x: number, y: number, bitmap: ImageBitmap): void {
    if (this.lost) return
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: (texture as WebGpuTexture).texture, origin: { x, y }, premultipliedAlpha: true },
      [bitmap.width, bitmap.height],
    )
  }

  destroyTexture(texture: GpuTexture): void {
    ;(texture as WebGpuTexture).texture.destroy()
  }

  setInstances(data: Float32Array, count: number): void {
    if (this.lost) return
    const bytes = count * INSTANCE_BYTES
    if (bytes === 0) return
    if (!this.instances || this.instanceCapacity < bytes) {
      this.instances?.destroy()
      /* grow by half again, so a page that keeps growing reallocates rarely */
      this.instanceCapacity = Math.max(bytes, Math.ceil(this.instanceCapacity * 1.5), INSTANCE_BYTES * 1024)
      this.instances = this.device.createBuffer({
        size: this.instanceCapacity,
        usage: BUFFER.VERTEX | BUFFER.COPY_DST,
      })
    }
    this.device.queue.writeBuffer(this.instances, 0, data.buffer, data.byteOffset, bytes)
  }

  draw(camera: Camera, batches: readonly DrawBatch[]): void {
    if (this.lost) return
    this.device.queue.writeBuffer(
      this.uniforms,
      0,
      new Float32Array([this.width, this.height, camera.x, camera.y, camera.zoom, 0, 0, 0]),
    )
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    if (this.instances && batches.length) {
      pass.setPipeline(this.pipeline)
      pass.setBindGroup(0, this.uniformGroup)
      pass.setVertexBuffer(0, this.instances)
      for (const batch of batches) {
        if (!batch.count) continue
        pass.setBindGroup(1, ((batch.texture as WebGpuTexture | null) ?? this.blank).bindGroup)
        pass.draw(4, batch.count, 0, batch.first)
      }
    }
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  onLost(callback: () => void): void {
    this.lostCallbacks.push(callback)
  }

  destroy(): void {
    this.lostCallbacks = []
    this.instances?.destroy()
    this.uniforms.destroy()
    this.context.unconfigure()
    this.device.destroy()
  }
}
