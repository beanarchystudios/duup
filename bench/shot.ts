/**
 * A look at the renderer: opens a benchmark canvas, waits for it to fill,
 * saves a screenshot and prints the compositor's counters.
 *   bun run bench:shot -- M --zoom=0.2 --out=/tmp/m.png
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import puppeteer from 'puppeteer-core'
import { preview } from 'vite'
import { findBrowserPath } from '../server/screenshot.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const size = args.find((a) => !a.startsWith('--')) ?? 'S'
const out = flag('out') ?? 'bench/shot.png'
const wait = Number(flag('wait') ?? 6000)
const zoom = flag('zoom')
const renderer = flag('renderer') ?? 'auto'
const gpu = flag('gpu') ?? 'hardware'

const dir = mkdtempSync(path.join(tmpdir(), 'doop-shot-'))
await promisify(execFile)(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'build',
    '--config',
    'tests/fixtures.vite.config.ts',
    '--outDir',
    dir,
    /* a profile names functions */
    ...(args.includes('--profile') ? ['--minify', 'false'] : []),
  ],
  { env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 64 * 1024 * 1024 },
)
const server = await preview({
  configFile: false,
  logLevel: 'error',
  appType: 'mpa',
  build: { outDir: dir },
  preview: { port: 0, cors: true },
})
const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '')
const browser = await puppeteer.launch({
  executablePath: findBrowserPath()!,
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    ...(gpu === 'swiftshader'
      ? ['--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader']
      : ['--use-angle=vulkan']),
  ],
})
try {
  const page = await browser.newPage()
  page.on('console', (m) => console.log('[page]', m.type(), m.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e))
  await page.setViewport({ width: 1600, height: 1000 })
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
        ? { user: { id: 'u', name: 'Bench', email: 'b@t.dev' }, session: { id: 's', userId: 'u' } }
        : url.pathname === '/api/canvases/c/fonts'
          ? []
          : {}
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(`${origin}/tests/fixtures/canvasBench.html`)
  await page.waitForFunction(() => !!(window as unknown as { canvasBench?: unknown }).canvasBench)
  const counts = await page.evaluate(
    (s) => (window as unknown as { canvasBench: { seed(s: string): object } }).canvasBench.seed(s),
    size,
  )
  console.log('seeded', counts)
  if (zoom) {
    await new Promise((r) => setTimeout(r, 500))
    await page.evaluate(
      (z) =>
        (window as unknown as { canvasBench: { setViewport(v: object): void } }).canvasBench.setViewport({
          x: 40,
          y: 80,
          zoom: Number(z),
        }),
      zoom,
    )
  }
  await new Promise((r) => setTimeout(r, wait))
  if (args.includes('--profile')) {
    /* a CPU profile of a pan: where the main thread's time goes */
    const cdp = await page.createCDPSession()
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
    const until = Date.now() + 2500
    while (Date.now() < until) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 12, deltaY: 4 })
      await new Promise((r) => setTimeout(r, 8))
    }
    const { profile } = await cdp.send('Profiler.stop')
    const self = new Map<string, number>()
    const total = profile.samples?.length ?? 1
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const counts = new Map<number, number>()
    for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const [id, n] of counts) {
      const node = byId.get(id)!
      const name = `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber}`
      self.set(name, (self.get(name) ?? 0) + n)
    }
    for (const [name, n] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30))
      console.log(`${((n / total) * 100).toFixed(1)}%  ${name}`)
  }
  if (args.includes('--watch')) {
    /* what changes in the scene state while the view pans */
    await page.evaluate(() => {
      const w = window as unknown as {
        __doopScene: { subscribe(f: (s: object, p: object) => void): void }
        __log: string[]
      }
      w.__log = []
      w.__doopScene.subscribe((s, p) => {
        const changed = Object.keys(s).filter(
          (k) => (s as Record<string, unknown>)[k] !== (p as Record<string, unknown>)[k],
        )
        w.__log.push(`${Math.round(performance.now())} ${changed.join(',')}`)
      })
    })
    const cdp = await page.createCDPSession()
    const until = Date.now() + 2500
    while (Date.now() < until) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 12, deltaY: 4 })
      await new Promise((r) => setTimeout(r, 8))
    }
    console.log(await page.evaluate(() => (window as unknown as { __log: string[] }).__log.join('\n')))
  }
  if (args.includes('--trace')) {
    /* a timeline of a pan: which kinds of main-thread work take the time */
    await page.tracing.start({
      categories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.stack',
        'disabled-by-default-devtools.timeline.invalidationTracking',
      ],
    })
    const cdp = await page.createCDPSession()
    const until = Date.now() + 2500
    while (Date.now() < until) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 500, deltaX: 12, deltaY: 4 })
      await new Promise((r) => setTimeout(r, 8))
    }
    const buf = await page.tracing.stop()
    const events = (
      JSON.parse(new TextDecoder().decode(buf!)) as {
        traceEvents: {
          name: string
          ph: string
          dur?: number
          pid: number
          tid: number
          args?: { data?: { frame?: string } }
        }[]
      }
    ).traceEvents
    /* the renderer main thread: the one running the most FunctionCalls */
    const calls = new Map<string, number>()
    for (const e of events)
      if (e.name === 'FunctionCall') calls.set(`${e.pid}:${e.tid}`, (calls.get(`${e.pid}:${e.tid}`) ?? 0) + 1)
    const main = [...calls].sort((a, b) => b[1] - a[1])[0]?.[0]
    const totals = new Map<string, { ms: number; n: number; max: number }>()
    for (const e of events) {
      if (`${e.pid}:${e.tid}` !== main || e.ph !== 'X' || !e.dur) continue
      const t = totals.get(e.name) ?? { ms: 0, n: 0, max: 0 }
      t.ms += e.dur / 1000
      t.n++
      t.max = Math.max(t.max, e.dur / 1000)
      totals.set(e.name, t)
    }
    for (const e of events) {
      if (`${e.pid}:${e.tid}` === main && e.name === 'UpdateLayoutTree' && (e.dur ?? 0) > 30_000)
        console.log('  big style recalc', Math.round(e.dur! / 1000), 'ms', JSON.stringify(e.args ?? {}).slice(0, 1500))
    }
    const kinds = new Map<string, number>()
    for (const e of events) {
      if (`${e.pid}:${e.tid}` !== main || !/Invalidat|ScheduleStyle|StyleRecalcInvalidation/.test(e.name)) continue
      const d = (e.args as { data?: Record<string, unknown> } | undefined)?.data ?? {}
      const key = `${e.name} ${String(d.reason ?? '')} ${String(d.nodeName ?? '')} ${String(d.invalidationList ? JSON.stringify(d.invalidationList).slice(0, 120) : '')}`
      kinds.set(key, (kinds.get(key) ?? 0) + 1)
    }
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('  inval', n, k)
    console.log('DOM elements', await page.evaluate(() => document.getElementsByTagName('*').length))
    for (const [name, t] of [...totals].sort((a, b) => b[1].ms - a[1].ms).slice(0, 18))
      console.log(
        `${t.ms.toFixed(0).padStart(6)}ms  n=${String(t.n).padStart(5)}  max=${t.max.toFixed(0).padStart(5)}ms  ${name}`,
      )
  }
  if (args.includes('--debug-raster')) {
    console.log(
      'raster frame',
      await page.evaluate(async () => {
        const frame = document.querySelector('iframe[title="raster"]') as HTMLIFrameElement | null
        if (!frame) return 'no frame'
        const reply = await new Promise((resolve) => {
          const on = (ev: MessageEvent) => {
            if (ev.source !== frame.contentWindow) return
            window.removeEventListener('message', on)
            resolve(JSON.stringify(ev.data, (k, v) => (v instanceof ImageBitmap ? `bitmap ${v.width}x${v.height}` : v)))
          }
          window.addEventListener('message', on)
          frame.contentWindow!.postMessage(
            {
              type: 'doop:raster',
              id: 999999,
              html: '<body style="background:red">hi</body>',
              width: 100,
              height: 50,
              scale: 1,
            },
            '*',
          )
          setTimeout(() => resolve('no reply'), 5000)
        })
        return { src: frame.src, reply }
      }),
    )
  }
  console.log(
    'ui font',
    await page.evaluate(async () => {
      await document.fonts.ready
      return { family: getComputedStyle(document.body).fontFamily, allo: document.fonts.check('500 12.5px Allo') }
    }),
  )
  console.log('compositor', await page.evaluate(() => window.__doopCompositor?.debug() ?? null))
  console.log('iframes', await page.evaluate(() => document.querySelectorAll('iframe[data-doop-frame]').length))
  await page.screenshot({ path: out })
  console.log('saved', out)
} finally {
  await browser.close()
  await server.close()
  if (args.includes('--profile')) console.log('build kept at', dir)
  else rmSync(dir, { recursive: true, force: true })
}
