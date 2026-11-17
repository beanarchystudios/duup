import type { Frame } from '../shared/types'

/**
 * Canvases for the renderer benchmark (`bench/run.ts`) and the scale tests:
 * deterministic, so every run measures the same scene. A screen is an app
 * screen of the density an agent designs (a chat client with a sidebar of
 * threads, messages with code blocks, a diff panel, a frosted composer),
 * built from a few hundred to a few thousand elements with box shadows and
 * backdrop blurs. Shapes are standalone drawings (`data-doop-canvas-element`),
 * as the Rectangle and Ellipse tools make them.
 */

export interface BenchSize {
  /** desktop and phone screens, laid out in rows of variants */
  screens: number
  /** standalone rectangles and ellipses scattered between the rows */
  shapes: number
  /** messages per desktop screen, which sets how many elements a screen has */
  messages: number
}

export const BENCH_SIZES = {
  S: { screens: 40, shapes: 200, messages: 12 },
  M: { screens: 400, shapes: 2_000, messages: 18 },
  L: { screens: 1_000, shapes: 10_000, messages: 24 },
  XL: { screens: 2_000, shapes: 50_000, messages: 30 },
} as const satisfies Record<string, BenchSize>

export type BenchSizeName = keyof typeof BENCH_SIZES

/** mulberry32: small, fast and the same everywhere */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'agent thread render frame canvas compose stream diff review merge commit branch worktree session token model prompt reply design layer vector shadow blur pixel'.split(
    ' ',
  )

function words(rnd: () => number, count: number): string {
  let out = ''
  for (let i = 0; i < count; i++) out += (i ? ' ' : '') + WORDS[Math.floor(rnd() * WORDS.length)]
  return out
}

const PALETTES = [
  { bg: '#0b0b0f', panel: '#141419', ink: '#e9e9ee', soft: '#8b8b96', accent: '#7c5cff', line: '#24242c' },
  { bg: '#fafafa', panel: '#ffffff', ink: '#111111', soft: '#6b6b70', accent: '#0177d3', line: '#e6e6e6' },
  { bg: '#0f1115', panel: '#171a21', ink: '#f2f4f8', soft: '#9099a8', accent: '#22c55e', line: '#262b35' },
]

function styles(p: (typeof PALETTES)[number]): string {
  return `<style>
:root{--bg:${p.bg};--panel:${p.panel};--ink:${p.ink};--soft:${p.soft};--accent:${p.accent};--line:${p.line}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:13px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink);display:flex;overflow:hidden}
.side{width:280px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:12px;gap:4px}
.proj{font-weight:600;color:var(--soft);font-size:11px;text-transform:uppercase;margin:12px 4px 4px}
.thread{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}
.thread.on{background:color-mix(in srgb,var(--accent) 18%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 40%,transparent)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent)}
.main{flex:1;display:flex;flex-direction:column;position:relative}
.bar{height:48px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--line)}
.chip{padding:3px 8px;border-radius:999px;background:var(--panel);box-shadow:0 1px 2px rgba(0,0,0,.2),0 0 0 1px var(--line);font-size:11px}
.msgs{flex:1;overflow:hidden;padding:20px 40px;display:flex;flex-direction:column;gap:14px}
.msg{display:flex;gap:10px;max-width:760px}
.msg.me{align-self:flex-end;flex-direction:row-reverse}
.av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#ff7ab6);flex:none}
.bubble{background:var(--panel);border-radius:12px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.18),0 0 0 1px var(--line)}
pre{margin:8px 0 0;padding:10px;border-radius:8px;background:#0d0d12;color:#d6d6e0;font:12px/1.5 ui-monospace,monospace;overflow:hidden}
.k{color:#c792ea}.s{color:#c3e88d}.n{color:#f78c6c}.c{color:#676e95}
.diff{position:absolute;right:16px;top:64px;width:360px;background:color-mix(in srgb,var(--panel) 70%,transparent);backdrop-filter:blur(18px);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.35),0 0 0 1px var(--line);padding:12px}
.row{display:flex;gap:8px;font:11px/1.6 ui-monospace,monospace}.add{background:rgba(34,197,94,.14)}.del{background:rgba(239,68,68,.14)}
.composer{margin:0 40px 20px;border-radius:16px;padding:12px;background:color-mix(in srgb,var(--panel) 75%,transparent);backdrop-filter:blur(24px) saturate(1.4);box-shadow:0 12px 40px rgba(0,0,0,.25),0 0 0 1px var(--line);display:flex;gap:8px;align-items:center}
.btn{padding:6px 12px;border-radius:8px;background:var(--accent);color:#fff;box-shadow:0 2px 8px color-mix(in srgb,var(--accent) 50%,transparent)}
</style>`
}

function code(rnd: () => number): string {
  let lines = ''
  const n = 3 + Math.floor(rnd() * 6)
  for (let i = 0; i < n; i++) {
    lines +=
      `<span class="k">const</span> ${WORDS[i % WORDS.length]} = <span class="n">${Math.floor(rnd() * 999)}</span>` +
      ` <span class="c">// ${words(rnd, 3)}</span>\n<span class="s">"${words(rnd, 2)}"</span>\n`
  }
  return `<pre>${lines}</pre>`
}

/** One desktop screen of the chat client, about `messages` × 25 elements. */
export function desktopScreen(seed: number, messages: number): string {
  const rnd = random(seed)
  const p = PALETTES[seed % PALETTES.length]!
  let side = ''
  for (let g = 0; g < 4; g++) {
    side += `<div class="proj">${words(rnd, 2)}</div>`
    for (let t = 0; t < 8; t++)
      side += `<div class="thread${g === 0 && t === 2 ? ' on' : ''}"><span class="dot"></span><span>${words(rnd, 3)}</span></div>`
  }
  let msgs = ''
  for (let m = 0; m < messages; m++) {
    const me = m % 3 === 0
    msgs +=
      `<div class="msg${me ? ' me' : ''}"><div class="av"></div><div class="bubble"><b>${me ? 'You' : 'Agent'}</b>` +
      `<div>${words(rnd, 8 + Math.floor(rnd() * 20))}</div>${me ? '' : code(rnd)}</div></div>`
  }
  let diff = ''
  for (let r = 0; r < 18; r++)
    diff += `<div class="row ${r % 4 === 1 ? 'add' : r % 5 === 2 ? 'del' : ''}"><span>${r + 1}</span><span>${words(rnd, 4)}</span></div>`
  return (
    `<!doctype html><html><head>${styles(p)}</head><body>` +
    `<aside class="side">${side}</aside><main class="main">` +
    `<div class="bar"><b>${words(rnd, 2)}</b><span class="chip">main</span><span class="chip">${words(rnd, 1)}</span></div>` +
    `<div class="msgs">${msgs}</div><div class="diff">${diff}</div>` +
    `<div class="composer"><span style="flex:1;color:var(--soft)">Ask anything…</span><span class="btn">Send</span></div>` +
    `</main></body></html>`
  )
}

/** The same client on a phone: no sidebar, fewer messages. */
export function phoneScreen(seed: number, messages: number): string {
  return desktopScreen(seed, Math.max(4, Math.floor(messages / 2)))
    .replace('.side{width:280px', '.side{display:none;width:280px')
    .replace('.diff{position:absolute', '.diff{display:none;position:absolute')
}

function shapeHtml(rnd: () => number, ellipse: boolean): string {
  const hue = Math.floor(rnd() * 360)
  const radius = ellipse ? '50%' : `${Math.floor(rnd() * 16)}px`
  return (
    `<body data-doop-canvas-element="true" style="margin:0"><div data-doop-drawing="${ellipse ? 'ellipse' : 'rect'}"` +
    ` style="position:absolute;left:0;top:0;width:100%;height:100%;margin:0;background:hsl(${hue} 70% 60%);` +
    `border-radius:${radius};box-shadow:0 4px 16px rgba(0,0,0,.2)"></div></body>`
  )
}

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const GAP = 120
/** variants per row, as an agent lays out explorations */
const PER_ROW = 8

/** The frames of a benchmark canvas, on canvas `c`, laid out in rows. */
export function benchFrames(size: BenchSize, canvasId = 'c'): Frame[] {
  const frames: Frame[] = []
  const rnd = random(7)
  let x = 0
  let y = 0
  let rowHeight = 0
  for (let i = 0; i < size.screens; i++) {
    const phone = i % 4 === 3
    const box = phone ? PHONE : DESKTOP
    if (i > 0 && i % PER_ROW === 0) {
      x = 0
      y += rowHeight + GAP * 3
      rowHeight = 0
    }
    frames.push({
      id: `s${i}`,
      canvasId,
      name: `${phone ? 'Phone' : 'Desktop'} ${i + 1}`,
      x,
      y,
      ...box,
      html: phone ? phoneScreen(i, size.messages) : desktopScreen(i, size.messages),
      createdAt: i,
      updatedAt: i,
      updatedBy: 'bench',
    })
    x += box.width + GAP
    rowHeight = Math.max(rowHeight, box.height)
  }
  const spanX = PER_ROW * (DESKTOP.width + GAP)
  const spanY = y + rowHeight
  for (let i = 0; i < size.shapes; i++) {
    const w = 40 + Math.floor(rnd() * 160)
    const h = 40 + Math.floor(rnd() * 160)
    frames.push({
      id: `d${i}`,
      canvasId,
      name: `Shape ${i + 1}`,
      /* to the right of the screens, so the rows stay readable */
      x: spanX + GAP + Math.floor(rnd() * Math.max(2000, Math.sqrt(size.shapes) * 260)),
      y: Math.floor(rnd() * Math.max(spanY, 2000)),
      width: w,
      height: h,
      html: shapeHtml(rnd, i % 3 === 0),
      createdAt: size.screens + i,
      updatedAt: size.screens + i,
      updatedBy: 'bench',
    })
  }
  return frames
}

/** Elements in a document, by counting its opening tags: what "objects"
 *  means for a frame (the shapes count one each, their body included). */
export function countElements(html: string): number {
  return (html.match(/<[a-z][^>]*>/gi) ?? []).length
}
