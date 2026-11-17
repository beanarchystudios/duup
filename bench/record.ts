/**
 * A video of the canvas under load: opens a benchmark canvas (tests/benchCanvas.ts)
 * in Chromium, drives one scripted pan / zoom sequence with real wheel events
 * and records what the screen showed, with an FPS meter drawn in the page.
 *
 *   bun run bench:record -- M --out=/tmp/new.mp4 --label="v2"
 *   bun run bench:record -- M --root=../doop-main --out=/tmp/old.mp4 --label="v1"
 *
 * `--root` builds another checkout (it needs tests/benchCanvas.ts and
 * tests/fixtures/canvasBench.html), so the same script records old and new.
 * Frames come from the compositor (CDP screencast): a page that froze sends
 * none, and the video holds the last one, the way the person saw it.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import puppeteer, { type CDPSession } from 'puppeteer-core'
import { preview } from 'vite'
import { findBrowserPath } from '../server/screenshot.ts'

const args = process.argv.slice(2)
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const size = args.find((a) => !a.startsWith('--')) ?? 'M'
const root = path.resolve(flag('root') ?? '.')
const out = path.resolve(flag('out') ?? 'bench/record.mp4')
const label = flag('label') ?? path.basename(root)
const VIEW = { width: 1600, height: 1000 }
const run = promisify(execFile)

/* the meter and the caption, drawn by the page itself on every animation frame */
const OVERLAY = (caption: string) => `
(() => {
  if (window.top !== window) return
  const start = () => {
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483647;' +
      'font:600 22px/1.25 ui-monospace,Menlo,monospace;color:#fff;background:rgba(10,10,14,.82);' +
      'padding:10px 16px;border-radius:12px;pointer-events:none;text-align:center;min-width:380px'
    document.body.append(box)
    const times = []
    let last = performance.now()
    let shown = 0
    const tick = (now) => {
      times.push(now - last)
      last = now
      let sum = 0, worst = 0, n = 0
      for (let i = times.length - 1; i >= 0 && sum < 1000; i--) { sum += times[i]; worst = Math.max(worst, times[i]); n++ }
      if (times.length > 400) times.splice(0, times.length - 400)
      const fps = sum ? Math.round((n * 1000) / sum) : 0
      if (now - shown > 100) {
        shown = now
        const color = fps >= 55 ? '#4ade80' : fps >= 30 ? '#facc15' : '#f87171'
        box.innerHTML = '<div style="font-size:15px;opacity:.75">' + ${JSON.stringify(caption)} + '</div>' +
          '<span style="color:' + color + '">' + fps + ' fps</span>' +
          '<span style="opacity:.75;font-size:16px"> · worst frame ' + Math.round(worst) + 'ms</span>' +
          '<div id="__phase" style="font-size:14px;opacity:.75">' + (window.__phase || '') + '</div>'
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  if (document.body) start()
  else addEventListener('DOMContentLoaded', start)
})()`

async function wheel(cdp: CDPSession, ms: number, delta: (t: number) => { dx: number; dy: number; ctrl?: boolean }) {
  const begin = Date.now()
  while (Date.now() - begin < ms) {
    const t = (Date.now() - begin) / ms
    const { dx, dy, ctrl } = delta(t)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: VIEW.width / 2,
      y: VIEW.height / 2,
      deltaX: dx,
      deltaY: dy,
      modifiers: ctrl ? 2 : 0,
    })
    await new Promise((r) => setTimeout(r, 8))
  }
}

async function main() {
  const executablePath = findBrowserPath()
  if (!executablePath) throw new Error('No Chrome/Chromium found. Set CHROME_PATH.')
  const dir = mkdtempSync(path.join(tmpdir(), 'doop-record-'))
  const frames = mkdtempSync(path.join(tmpdir(), 'doop-frames-'))
  console.log(`building ${root}…`)
  await run(
    process.execPath,
    [
      path.join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      'tests/fixtures.vite.config.ts',
      '--outDir',
      dir,
    ],
    { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 64 * 1024 * 1024 },
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
    executablePath,
    headless: true,
    protocolTimeout: 900_000,
    args: [
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--use-angle=vulkan',
      `--window-size=${VIEW.width},${VIEW.height}`,
    ],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport(VIEW)
    page.setDefaultTimeout(900_000)
    await page.evaluateOnNewDocument('globalThis.__name = (f) => f')
    await page.evaluateOnNewDocument(OVERLAY(`${label} · ${size}`))
    await page.evaluateOnNewDocument(() => {
      if (window.top !== window) return
      Object.defineProperty(window, 'WebSocket', {
        value: class {
          readyState = 0
          static OPEN = 1
          close() {}
        },
      })
    })
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
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[data-slot="getting-started"], .getting-started')?.remove(),
    )

    const cdp = await page.createCDPSession()
    const shots: { file: string; at: number }[] = []
    cdp.on('Page.screencastFrame', (frame) => {
      const file = path.join(frames, `${String(shots.length).padStart(6, '0')}.jpg`)
      writeFileSync(file, Buffer.from(frame.data, 'base64'))
      shots.push({ file, at: frame.metadata.timestamp ?? Date.now() / 1000 })
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: VIEW.width,
      maxHeight: VIEW.height,
    })
    const phase = (text: string) =>
      page.evaluate((t) => ((window as unknown as { __phase: string }).__phase = t), text).catch(() => {})
    const startedAt = Date.now() / 1000

    await phase('opening the canvas…')
    await new Promise((r) => setTimeout(r, 600))
    const opened = Date.now()
    /* seeding runs the open: on the old renderer every frame becomes an iframe */
    const counts = await page.evaluate(
      (s) => (window as unknown as { canvasBench: { seed(s: string): object } }).canvasBench.seed(s),
      size,
    )
    console.log('seeded', counts)
    await phase(`opened ${JSON.stringify(counts).replace(/[{}"]/g, '').replace(/,/g, ' · ')}`)
    await new Promise((r) => setTimeout(r, 2500))
    await phase('pan')
    await wheel(cdp, 3500, (t) => ({ dx: t < 0.5 ? 14 : -14, dy: t < 0.5 ? 6 : -6 }))
    await phase('zoom in')
    await wheel(cdp, 3000, () => ({ dx: 0, dy: -7, ctrl: true }))
    await phase('pan, zoomed in')
    await wheel(cdp, 2500, (t) => ({ dx: t < 0.5 ? 18 : -18, dy: 3 }))
    await phase('zoom out')
    await wheel(cdp, 3000, () => ({ dx: 0, dy: 7, ctrl: true }))
    await phase('pan')
    await wheel(cdp, 2500, (t) => ({ dx: t < 0.5 ? -14 : 14, dy: 0 }))
    await phase('done')
    await new Promise((r) => setTimeout(r, 800))
    await cdp.send('Page.stopScreencast')
    console.log(`recorded ${shots.length} frames over ${((Date.now() - opened) / 1000).toFixed(1)}s`)

    /* each frame shows until the next one: a frozen page holds its picture */
    const endAt = Date.now() / 1000
    const list = shots
      .map((s, i) => {
        const next = shots[i + 1]?.at ?? endAt
        return `file '${s.file}'\nduration ${Math.max(0.001, next - Math.max(s.at, startedAt)).toFixed(4)}`
      })
      .join('\n')
    const listFile = path.join(frames, 'list.txt')
    writeFileSync(listFile, `${list}\nfile '${shots[shots.length - 1]!.file}'\n`)
    mkdirSync(path.dirname(out), { recursive: true })
    await run('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-vf',
      'fps=30,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      out,
    ])
    console.log('saved', out)
  } finally {
    await browser.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(frames, { recursive: true, force: true })
  }
}

await main()
