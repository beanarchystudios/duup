/**
 * Doop's own shapes drawn natively. A standalone rectangle or ellipse (the
 * Rectangle and Ellipse tools' output, `data-doop-drawing` filling a
 * `data-doop-canvas-element` body) is still stored as HTML, but the
 * compositor draws it straight from this description: a rounded rect or an
 * ellipse in one colour, with an optional drop shadow, at any zoom, with no
 * document, iframe or bitmap behind it. Anything the description cannot say
 * exactly (a gradient, a border, text, a class, a CSS variable) is null here,
 * and the shape is drawn from a raster of its document instead, so nothing
 * is ever drawn wrong, only drawn the slower way.
 *
 * Read with string matching rather than a DOM parser: a page can hold tens of
 * thousands of shapes, and each description is cached by its HTML string.
 */

export interface PrimitiveShadow {
  dx: number
  dy: number
  blur: number
  spread: number
  /** premultiplied rgba, 0-1 */
  color: [number, number, number, number]
}

export interface Primitive {
  /** 0 a rectangle (with `radius`), 1 an ellipse filling the box */
  shape: 0 | 1
  radius: number
  /** premultiplied rgba, 0-1, the element's opacity applied */
  color: [number, number, number, number]
  shadow: PrimitiveShadow | null
}

const SHAPES = new Set(['rectangle', 'circle', 'rect', 'ellipse'])

const memo = new Map<string, Primitive | null>()

/** The native description of a standalone shape's document, or null when it
 *  must be drawn from its document. */
export function primitiveOf(html: string): Primitive | null {
  let known = memo.get(html)
  if (known === undefined) {
    known = parse(html)
    if (memo.size > 200_000) memo.clear()
    memo.set(html, known)
  }
  return known
}

const BODY = /<body\b([^>]*)>([\s\S]*?)(?:<\/body>|$)/i
const ONE_ELEMENT = /^<(div|p)\b([^>]*)>\s*<\/\1>$/i

function parse(html: string): Primitive | null {
  const body = BODY.exec(html)
  if (!body) return null
  const bodyAttrs = body[1] ?? ''
  if (!/\bdata-doop-canvas-element=/i.test(bodyAttrs)) return null
  /* the body may only place the shape: a background or class of its own is not ours to read */
  if (/\bclass=/i.test(bodyAttrs)) return null
  const bodyStyle = attr(bodyAttrs, 'style')
  if (bodyStyle && /background|border|shadow|opacity|filter|transform/i.test(bodyStyle)) return null
  /* nothing in the head that could style the shape */
  if (/<(style|link|script)\b/i.test(html)) return null
  const element = ONE_ELEMENT.exec((body[2] ?? '').trim())
  if (!element) return null
  const attrs = element[2] ?? ''
  const kind = attr(attrs, 'data-doop-drawing')
  if (!kind || !SHAPES.has(kind)) return null
  if (/\bclass=/i.test(attrs)) return null
  const style = declarations(attr(attrs, 'style') ?? '')
  if (!style) return null
  return describe(style)
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  if (!m) return null
  return decode(m[2] ?? m[3] ?? '')
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** the declarations of a style attribute, or null when any is beyond us */
function declarations(css: string): Map<string, string> | null {
  if (/url\(|var\(|calc\(|!important|\/\*/i.test(css)) return null
  const out = new Map<string, string>()
  for (const part of css.split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) {
      if (part.trim()) return null
      continue
    }
    out.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim())
  }
  return out
}

/* what a shape filling its body may carry; anything else sends it to a raster */
const PLACEMENT: Record<string, (v: string) => boolean> = {
  position: (v) => v === 'absolute',
  left: zeroish,
  top: zeroish,
  width: (v) => v === '100%',
  height: (v) => v === '100%',
  margin: zeroish,
  'box-sizing': () => true,
}

function zeroish(v: string): boolean {
  return /^0(px)?$/.test(v)
}

function describe(style: Map<string, string>): Primitive | null {
  let fill: [number, number, number, number] | null = null
  let radius = 0
  let ellipse = false
  let opacity = 1
  let shadow: PrimitiveShadow | null = null
  for (const [name, value] of style) {
    if (name in PLACEMENT) {
      if (!PLACEMENT[name]!(value)) return null
      continue
    }
    switch (name) {
      case 'background':
      case 'background-color':
        fill = color(value)
        if (!fill) return null
        break
      case 'border-radius': {
        if (value === '50%') ellipse = true
        else {
          const px = /^(\d*\.?\d+)px$/.exec(value)
          if (!px && !zeroish(value)) return null
          radius = px ? Number(px[1]) : 0
        }
        break
      }
      case 'opacity': {
        const n = Number(value)
        if (!Number.isFinite(n)) return null
        opacity = Math.min(1, Math.max(0, n))
        break
      }
      case 'box-shadow':
        if (value === 'none') break
        shadow = boxShadow(value)
        if (!shadow) return null
        break
      default:
        return null
    }
  }
  if (!fill) return null
  const [r, g, b, a] = fill
  const alpha = a * opacity
  if (shadow) shadow.color = shadow.color.map((c) => c * opacity) as PrimitiveShadow['color']
  return { shape: ellipse ? 1 : 0, radius, color: [r * alpha, g * alpha, b * alpha, alpha], shadow }
}

/** one outer shadow: `x y [blur [spread]] color` in px, the colour last or first */
function boxShadow(value: string): PrimitiveShadow | null {
  /* a comma outside a colour function starts a second shadow */
  if (value.replace(/\([^)]*\)/g, '').includes(',')) return null
  if (/\binset\b/i.test(value)) return null
  const colorMatch = /(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}\b|\b[a-z]+\b)/i.exec(value)
  if (!colorMatch) return null
  const c = color(colorMatch[1]!)
  if (!c) return null
  const lengths = value.replace(colorMatch[1]!, '').trim().split(/\s+/).filter(Boolean)
  if (lengths.length < 2 || lengths.length > 4) return null
  const px = lengths.map((l) => (zeroish(l) ? 0 : /^-?\d*\.?\d+px$/.test(l) ? parseFloat(l) : NaN))
  if (px.some((n) => !Number.isFinite(n))) return null
  const [r, g, b, a] = c
  return { dx: px[0]!, dy: px[1]!, blur: Math.max(0, px[2] ?? 0), spread: px[3] ?? 0, color: [r * a, g * a, b * a, a] }
}

/* the browser's own colour parser, through a 2D context's fillStyle */
let probe: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined
const colors = new Map<string, [number, number, number, number] | null>()

/** A CSS colour as straight (not premultiplied) rgba 0-1, or null. */
export function color(value: string): [number, number, number, number] | null {
  const known = colors.get(value)
  if (known !== undefined) return known
  const parsed = parseColor(value)
  if (colors.size > 10_000) colors.clear()
  colors.set(value, parsed)
  return parsed
}

function parseColor(value: string): [number, number, number, number] | null {
  if (/var\(|currentcolor|inherit|initial|unset|gradient/i.test(value)) return null
  if (probe === undefined) {
    probe =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1).getContext('2d')
        : (document.createElement('canvas').getContext('2d') ?? null)
  }
  if (!probe) return null
  /* a value the parser refuses leaves fillStyle as it was: two sentinels tell */
  probe.fillStyle = '#000000'
  probe.fillStyle = value
  const first = String(probe.fillStyle)
  probe.fillStyle = '#ffffff'
  probe.fillStyle = value
  const second = String(probe.fillStyle)
  if (first !== second) return null
  const hex = /^#([0-9a-f]{6})$/i.exec(first)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
  }
  const rgba = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(first)
  if (rgba) return [Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255, Number(rgba[4] ?? 1)]
  return null
}
