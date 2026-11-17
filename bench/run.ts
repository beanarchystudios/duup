/**
 * The renderer benchmark: opens the real canvas page on a generated canvas
 * (tests/benchCanvas.ts) in Chromium and measures what a person feels.
 *
 *   bun run bench                      every size, on the machine's GPU
 *   bun run bench -- S M --gpu=swiftshader --label=v1
 *
 * For each size it records how long the canvas takes to open, then pans and
 * pinch-zooms with real wheel events (CDP), at the fit-everything overview
 * and at a working zoom on one row of screens, collecting every animation
 * frame's interval in the page. Results print as a table and are written to
 * bench/results/<label>.json; `--compare=<label>` prints the change against
 * an earlier run, and `--budgets` fails the run past bench/budgets.json.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core'
import { preview } from 'vite'
import { findBrowserPath } from '../server/screenshot.ts'
import { BENCH_SIZES, type BenchSizeName } from '../tests/benchCanvas.ts'

interface FrameStats {
  frames: number
  p50: number
  p95: number
  p99: number
  max: number
  /** share of intervals over 16.7ms * 1.5, i.e. visibly dropped frames */
  janky: number
}

interface SizeResult {
  size: BenchSizeName
  frames: number
  objects: number
  /** seed → the first painted frame after it */
  openMs: number
  /** seed → no frame over 50ms for a second (iframes loaded, rasters filled) */
  settleMs: number
  iframes: number
  heapMb: number
  renderer: string
  overviewPan: FrameStats
  overviewZoom: FrameStats
  workPan: FrameStats
  workZoom: FrameStats
}

const args = process.argv.slice(2)
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const sizes = args.filter((a) => !a.startsWith('--')) as BenchSizeName[]
const runSizes: BenchSizeName[] = sizes.length ? sizes : ['S', 'M', 'L']
const label = flag('label') ?? 'latest'
const gpu = flag('gpu') ?? 'hardware'
const renderer = flag('renderer') ?? 'auto'
const SETTLE_LIMIT_MS = Number(flag('settle-limit') ?? 90_000)

const VIEW = { width: 1600, height: 1000 }

function gpuArgs(): string[] {
  const common = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', `--window-size=${VIEW.width},${VIEW.height}`]
  if (gpu === 'swiftshader') return [...common, '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader']
  return [...common, '--use-angle=vulkan']
}

async function build(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'doop-bench-'))
  await promisify(execFile)(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '--config', 'tests/fixtures.vite.config.ts', '--outDir', dir],
    { env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 64 * 1024 * 1024 },
  )
  return dir
}

/** The canvas page with no backend: as tests/canvasPageFixture.ts stubs it. */
async function stubBackend(page: Page): Promise<void> {
  /* tsx keeps function names with a `__name` helper, which the functions
     serialized into the page call */
  await page.evaluateOnNewDocument('globalThis.__name = (f) => f')
  await page.evaluateOnNewDocument((choice: string) => {
    Object.defineProperty(window, 'WebSocket', {
      value: class {
        readyState = 0
        static OPEN = 1
        close() {}
      },
    })
    /* this runs in every document, the frames' sandboxed iframes too */
    if (window.top !== window) return
    if (choice !== 'auto') localStorage.setItem('doop:renderer', choice)
  }, renderer)
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return void request.continue()
    const body =
      url.pathname === '/api/auth/get-session'
        ? { user: { id: 'u', name: 'Bench', email: 'bench@test.dev' }, session: { id: 's', userId: 'u' } }
        : url.pathname === '/api/canvases/c/fonts'
          ? []
          : {}
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

function stats(intervals: number[]): FrameStats {
  const sorted = [...intervals].sort((a, b) => a - b)
  const at = (q: number) =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) * 10) / 10
  return {
    frames: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    janky: Math.round((sorted.filter((v) => v > 25).length / Math.max(1, sorted.length)) * 1000) / 10,
  }
}

/** Start collecting animation-frame intervals in the page. */
async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __framesOn: boolean }
    w.__frames = []
    w.__framesOn = true
    let last = performance.now()
    requestAnimationFrame(function tick(now) {
      w.__frames.push(now - last)
      last = now
      if (w.__framesOn) requestAnimationFrame(tick)
    })
  })
}

async function stopFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __framesOn: boolean }
    w.__framesOn = false
    /* the first interval spans the start, not a frame */
    return w.__frames.slice(1)
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wheel events at ~120Hz for `ms`, as a trackpad sends them. */
async function wheel(
  cdp: CDPSession,
  ms: number,
  delta: (t: number) => { dx: number; dy: number; ctrl?: boolean },
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const t = (Date.now() - start) / ms
    const { dx, dy, ctrl } = delta(t)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: VIEW.width / 2,
      y: VIEW.height / 2,
      deltaX: dx,
      deltaY: dy,
      modifiers: ctrl ? 2 : 0,
    })
    await sleep(8)
  }
}

async function measure(page: Page, cdp: CDPSession, run: () => Promise<void>): Promise<FrameStats> {
  await sleep(300)
  await startFrames(page)
  await run()
  return stats(await stopFrames(page))
}

/** Wait until no animation frame has taken over 50ms for a whole second. */
async function settle(page: Page, limit: number): Promise<number> {
  return page.evaluate(
    (limit) =>
      new Promise<number>((resolve) => {
        const start = performance.now()
        let quietSince = start
        let last = start
        requestAnimationFrame(function tick(now) {
          if (now - last > 50) quietSince = now
          last = now
          if (now - quietSince > 1000 || now - start > limit) return resolve(quietSince - start)
          requestAnimationFrame(tick)
        })
      }),
    limit,
  )
}

async function runSize(browser: Browser, origin: string, size: BenchSizeName): Promise<SizeResult> {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport(VIEW)
  await stubBackend(page)
  page.setDefaultTimeout(SETTLE_LIMIT_MS + 30_000)
  await page.goto(`${origin}/tests/fixtures/canvasBench.html`)
  await page.waitForFunction(() => !!(window as unknown as { canvasBench?: unknown }).canvasBench)
  await page.waitForSelector('.stage')
  const cdp = await page.createCDPSession()
  await cdp.send('Performance.enable')

  const seeded = await page.evaluate(
    (size) =>
      new Promise<{ frames: number; objects: number; openMs: number }>((resolve) => {
        const bench = (window as unknown as { canvasBench: { seed(s: string): { frames: number; objects: number } } })
          .canvasBench
        const t0 = performance.now()
        const counts = bench.seed(size)
        requestAnimationFrame(() =>
          requestAnimationFrame((now) => resolve({ ...counts, openMs: Math.round(now - t0) })),
        )
      }),
    size,
  )
  const settleMs = Math.round(seeded.openMs + (await settle(page, SETTLE_LIMIT_MS)))

  /* the overview: Stage fitted everything when the canvas arrived */
  const overviewPan = await measure(page, cdp, () => wheel(cdp, 3000, (t) => ({ dx: t < 0.5 ? 12 : -12, dy: 4 })))
  const overviewZoom = await measure(page, cdp, () =>
    wheel(cdp, 3000, (t) => ({ dx: 0, dy: t < 0.5 ? -6 : 6, ctrl: true })),
  )

  /* a working zoom: the first row of screens at 45%, ten or so on screen */
  await page.evaluate(() => {
    const bench = (window as unknown as { canvasBench: { setViewport(v: object): void } }).canvasBench
    bench.setViewport({ x: 40, y: 80, zoom: 0.45 })
  })
  await settle(page, SETTLE_LIMIT_MS)
  const workPan = await measure(page, cdp, () => wheel(cdp, 3000, (t) => ({ dx: t < 0.5 ? 10 : -10, dy: 2 })))
  const workZoom = await measure(page, cdp, () =>
    wheel(cdp, 3000, (t) => ({ dx: 0, dy: t < 0.5 ? -5 : 5, ctrl: true })),
  )

  const metrics = (await cdp.send('Performance.getMetrics')).metrics
  const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
  const iframes = await page.evaluate(() => document.querySelectorAll('iframe[data-doop-frame]').length)
  const used = await page.evaluate(
    () => document.querySelector('[data-compositor]')?.getAttribute('data-compositor') ?? 'dom',
  )
  await context.close()
  return {
    size,
    ...seeded,
    settleMs,
    iframes,
    heapMb: Math.round(heap / 1024 / 1024),
    renderer: used,
    overviewPan,
    overviewZoom,
    workPan,
    workZoom,
  }
}

function table(results: SizeResult[], previous?: SizeResult[]): string {
  const rows = [
    [
      'size',
      'frames',
      'objects',
      'renderer',
      'open',
      'settle',
      'iframes',
      'heap',
      'ovPan p95',
      'ovZoom p95',
      'wkPan p95',
      'wkZoom p95',
      'janky%',
    ],
  ]
  for (const r of results) {
    const before = previous?.find((p) => p.size === r.size)
    const cell = (now: number, then?: number, unit = '') =>
      then === undefined ? `${now}${unit}` : `${now}${unit} (${then})`
    rows.push([
      r.size,
      String(r.frames),
      r.objects.toLocaleString('en'),
      r.renderer,
      cell(r.openMs, before?.openMs, 'ms'),
      cell(r.settleMs, before?.settleMs, 'ms'),
      cell(r.iframes, before?.iframes),
      cell(r.heapMb, before?.heapMb, 'MB'),
      cell(r.overviewPan.p95, before?.overviewPan.p95),
      cell(r.overviewZoom.p95, before?.overviewZoom.p95),
      cell(r.workPan.p95, before?.workPan.p95),
      cell(r.workZoom.p95, before?.workZoom.p95),
      String(Math.max(r.overviewPan.janky, r.overviewZoom.janky, r.workPan.janky, r.workZoom.janky)),
    ])
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ')).join('\n')
}

interface Budget {
  size: BenchSizeName
  framePctl95: number
  settleMs: number
  heapMb: number
}

function overBudget(results: SizeResult[]): string[] {
  const budgets = JSON.parse(readFileSync('bench/budgets.json', 'utf8')) as Budget[]
  const failures: string[] = []
  for (const b of budgets) {
    const r = results.find((x) => x.size === b.size)
    if (!r) continue
    for (const [name, s] of Object.entries({
      overviewPan: r.overviewPan,
      overviewZoom: r.overviewZoom,
      workPan: r.workPan,
      workZoom: r.workZoom,
    })) {
      if (s.p95 > b.framePctl95) failures.push(`${b.size} ${name} p95 ${s.p95}ms > ${b.framePctl95}ms`)
    }
    if (r.settleMs > b.settleMs) failures.push(`${b.size} settle ${r.settleMs}ms > ${b.settleMs}ms`)
    if (r.heapMb > b.heapMb) failures.push(`${b.size} heap ${r.heapMb}MB > ${b.heapMb}MB`)
  }
  return failures
}

async function main() {
  for (const s of runSizes) if (!(s in BENCH_SIZES)) throw new Error(`unknown size ${s}`)
  const executablePath = findBrowserPath()
  if (!executablePath) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.')
  console.log(`building fixtures…`)
  const dir = await build()
  const server = await preview({
    configFile: false,
    logLevel: 'error',
    appType: 'mpa',
    build: { outDir: dir },
    preview: { port: 0, cors: true },
  })
  const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '')
  const browser = await puppeteer.launch({ executablePath, headless: true, args: gpuArgs(), protocolTimeout: 600_000 })
  const results: SizeResult[] = []
  try {
    for (const size of runSizes) {
      console.log(`measuring ${size}…`)
      results.push(await runSize(browser, origin, size))
    }
  } finally {
    await browser.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  const compareTo = flag('compare')
  const previousPath = compareTo ? `bench/results/${compareTo}.json` : null
  const previous =
    previousPath && existsSync(previousPath)
      ? (JSON.parse(readFileSync(previousPath, 'utf8')) as SizeResult[])
      : undefined
  console.log(`\n${table(results, previous)}\n`)
  mkdirSync('bench/results', { recursive: true })
  writeFileSync(`bench/results/${label}.json`, JSON.stringify(results, null, 2) + '\n')
  if (args.includes('--budgets')) {
    const failures = overBudget(results)
    for (const f of failures) console.error(`over budget: ${f}`)
    if (failures.length) process.exit(1)
  }
}

await main()
