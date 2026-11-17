# Plan: renderer v2 (scene compositor)

Goal: the canvas stays smooth (pan and zoom at the display's refresh rate, p95 frame time under
16.7 ms) on canvases with tens of thousands of frames and standalone shapes, a million objects in
total, with thousands of shadows and blurs. That is the bar pen.dev and Figma set. Frame HTML stays
the source of truth: agents and people keep writing real HTML, and what a frame shows stays exactly
what a browser renders.

Each task names its test or benchmark first. Tests live in `tests/` and run with `bun run test`;
benchmarks live in `bench/` (new) and run with `bun run bench`.

## Where the time goes today

- `FrameStack` (`src/components/Stage.tsx`) mounts every frame on the page as a live `FrameView`
  iframe (`sandbox="allow-scripts"`, `srcDoc={FRAME_BOOTSTRAP}` plus the runtime in
  `src/lib/frameRuntime.ts`). Nothing is culled: 2,000 frames mean 2,000 documents, 2,000 runtimes,
  2,000 message listeners and 2,000 compositor layers, whether or not they are on screen.
- Standalone elements are frames (`data-doop-canvas-element` on the body,
  `src/lib/drawing.ts`), so every drawn rectangle, path, text or pasted image is a whole iframe. An
  imported SVG with 5,000 paths becomes one frame, but 5,000 drawn shapes become 5,000 iframes.
- At rest, pan is a CSS transform on `.world`, which is cheap. Zoom-settle bumps `layoutZoom`, and
  every mounted iframe re-lays out and re-rasterizes at the new density. That cost scales with the
  whole page, not the viewport.
- Every frame write (local, a peer, an agent stream) goes through the zustand `frames` array, and
  `FrameStack` re-maps the whole page. `FrameView` is `memo`'d, but each one holds about 30 store
  subscriptions.
- The room `init` (`server/index.ts`) sends every frame's `html`, so opening a big canvas downloads
  and parses every document before anything paints.
- Layers, marquee selection, snapping and hit-testing walk `frames` linearly.

No amount of tuning makes that architecture reach a million objects, because its unit of cost is
a browser document. The rewrite changes the unit to a texture.

## Architecture

```
            ┌───────────────────────── SceneStore (no React) ──────────────────────────┐
 room / REST│ nodes: Map<id, SceneNode>   index: packed R-tree (flatbush)   dirty set │
            └────────┬──────────────────────────────┬───────────────────────────┬───────┘
                     │ visible ids at LOD          │ raster jobs              │ selection, hover
             ┌───────▼────────┐          ┌──────────▼─────────┐     ┌──────────▼──────────┐
             │ GPU compositor │◀─tiles───│ Raster service      │     │ Live layer (DOM)    │
             │ one <canvas>,  │          │ HTML → bitmap + hit │     │ ≤ 8 real iframes,   │
             │ WebGPU, WebGL2 │          │ map, LOD mip chain  │     │ promoted on demand  │
             │ fallback       │          │                     │     │                     │
             └────────────────┘          └─────────────────────┘     └─────────────────────┘
```

1. **SceneStore** holds every node on the page as plain data outside React: id, box, rotation, z,
   kind (`frame`, `primitive`), content hash and a raster state. A flatbush R-tree, rebuilt per
   page and patched on moves, answers "what is in this rect" in O(log n + k). React reads only
   what chrome needs (the selection, the hovered id) through narrow selectors.
2. **GPU compositor**: one `<canvas>` under the chrome draws each visible node as a textured quad
   (rotation in the vertex shader) from a tile atlas, in z order, plus the paper, dot grid and pixel
   grid. Pan and zoom only change one uniform, so the cost is draw calls for what is visible,
   whatever the page holds. Instancing batches quads per atlas page. WebGPU draws wherever
   `navigator.gpu` hands out an adapter (Chromium, the CEF app, Safari 26). Everything else (WebKitGTK,
   a blocklisted GPU, a lost device) falls back to WebGL2 with the same instance layout and shaders
   ported to GLSL, behind one `GpuRenderer` interface, so the compositor never knows which one it has.
3. **Raster service** turns a frame's HTML into bitmaps at a mip chain (1/8, 1/4, 1/2, 1, 2, 4 of
   design px), keyed by `(frameId, contentHash, scale)`, and returns a **hit map** with each
   element's `data-doop-id` (stamped at raster), positional path and box. The compositor uses
   the hit map for hover outlines and click selection without a live document. Sources, best first:
   - **HTML-in-Canvas** (`<canvas layoutsubtree>` + `drawElementImage`, the WICG API Paper ships
     behind its "HTML-in-canvas powered images, videos, and exports"): enabled by flag in the CEF
     macOS app (Chromium 154) and wherever the browser exposes it.
   - **Live snapshot**: a pool of offscreen raster iframes (2-4) loads the frame, waits for fonts
     and images, and runs the existing `exportSnapshot` → `inlineDocument` → SVG → bitmap path
     (`src/lib/frameRaster.ts`, already pixel-tested in `frameRasterBrowser.test.ts`).
   - **Server render**: the `/i/<id>.png?scale=` Chromium render (`server/screenshot.ts`), for
     frames the client cannot draw (tainted canvases, nested documents).
   - Rasters are cached in memory (GPU LRU capped at 512 MB of texture, configurable), in
     IndexedDB by content hash, and on the server in the thumbnail bucket. A second viewer and a
     reload paint from cache without rasterizing at all.
4. **Live layer**: at most `LIVE_MAX` (8) real `FrameView` iframes, positioned over their quads.
   A frame is **promoted** when it is being edited, path-edited, text-edited, prototyped, streamed
   into by an agent, holding a picked element, or animated and on screen (see risks). It is
   **demoted** after `DEMOTE_MS` idle once a fresh raster of its current hash is ready, so the
   swap never shows a stale frame. All existing editing (`frameBridge.ts`, style gestures, resize,
   rotate, path editor, find bar) keeps working unchanged against a live frame, which is the
   reason the rewrite is feasible: the editor does not have to be rebuilt.
5. **Native primitives**: a standalone element whose markup is a doop drawing
   (`data-doop-drawing` rect, ellipse, path, text, image, group) is parsed once into a primitive
   descriptor and drawn by the compositor directly: SDF rounded rects and ellipses, tessellated
   paths (cached per `d`), text through a glyph atlas (MSDF for zoom independence) and images as
   textures. It is still stored as HTML. A primitive the parser cannot express exactly falls back
   to the raster path, so fidelity never regresses. This is what turns 100,000 drawn shapes from
   100,000 iframes into one instanced draw.
6. **Effects**: drop shadows and layer blurs on primitives are shader passes (separable Gaussian
   at reduced resolution, cached per node until it changes). A background blur samples the
   composed backdrop under the node's quad (two-pass Kawase on a downsampled copy). Effects inside
   frames are part of the frame's raster and cost nothing at pan time.

### Data and wire

- **Lazy frame HTML on the wire.** The room `init` carries frame metadata, content hashes and
  raster URLs, never `html`. `html` is fetched per frame on promotion, for export or for the
  Layers tree of that frame (`GET /api/frames/:id/html`, ETag by hash). The server already loads
  HTML per canvas (`server/frameHtml.ts`). This change stops shipping it.
- **Server-side rasters.** The server keeps the latest 1x and 1/4x raster per frame hash
  (rendered after writes settle, through the existing render gate at background priority). A
  canvas opens by painting server tiles, and the client fills in sharper mips as it needs them.
- **Store shape.** `canvas.frames` (array) becomes `SceneStore` (Map + index) as the one source
  of truth. A thin compatibility selector keeps array-shaped readers working during migration.
- **Layers panel** is virtualized (only visible rows mount) and reads frame trees lazily.

## Phases

Each phase ships behind `doop:renderer=v2` (a per-browser setting, then a server default) and
leaves v1 working until phase 7. Each phase has a measurable exit gate from the benchmark.

### Phase 0: benchmark and budgets (first, before any rewrite)

1. **Canvas generator.** `bench/generate.ts` seeds canvases straight into the store: `S` (100
   frames), `M` (2,000 frames), `L` (20,000 frames plus 50,000 standalone shapes), `XL` (1,000,000
   objects as 5,000 frames × 150 elements + 250,000 shapes), each with 2,000 shadows and 500
   backdrop blurs.
2. **Harness.** `bench/canvas.bench.ts` drives the real `CanvasPage` in Chromium (reusing
   `tests/browser.ts` and `tests/canvasPageFixture.ts`) through scripted gestures: 10 s pan, pinch
   zoom from 8% to 400%, page switch, open-to-first-paint, open-to-interactive and select-all.
   It records frame times from `requestAnimationFrame` plus the CDP Performance timeline, JS heap,
   GPU memory and process count.
3. **Baseline report.** Run on v1 and commit `bench/baseline.json`. Expect `M` to already miss
   the bar and `L`/`XL` not to open.
4. **Budgets.** `bench/budgets.json`: pan and zoom p95 ≤ 16.7 ms, p99 ≤ 33 ms on `L`; open-to-
   first-paint ≤ 1.5 s on `L` warm, ≤ 4 s cold; heap ≤ 1.5 GB on `XL`. A CI job (`perf`, nightly
   and on demand) fails a PR over budget once v2 is default.

### Phase 1: SceneStore and culling (still DOM, but quick wins)

1. `tests/sceneStore.test.ts`: insert, move, delete and z-change keep the R-tree query equal to a
   brute-force scan over random boxes, rotated boxes included.
2. Mount `FrameView` only for frames intersecting the viewport plus one screen of margin. Off-screen
   frames render their cached `/i/` thumbnail as an `<img>` (`FramePreview`). Accept the reload
   cost on remount, since "moving an iframe reloads it" now applies only at the viewport edge.
3. Move marquee, snapping, `topmost under a point`, ⌘A and Tab order onto the index.
4. Lazy `html` in the room `init` and the per-frame HTML route.
5. **Exit:** `M` meets the pan budget; `L` opens.

### Phase 2: raster service and tile cache

1. `tests/rasterService.test.ts`: the content hash changes with HTML, size or token or font
   changes (the injected `<style data-doop-tokens>` and `data-doop-fonts` blocks count) and with
   nothing else. The cache keys and LRU evict by bytes.
2. `tests/rasterServiceBrowser.test.ts`: for a fixture set (text, gradients, shadows, web fonts,
   SVG, images, a component instance), the raster matches the live iframe within a 0.5% pixel
   diff at 1x and 2x. The hit map's boxes match `doop:inspect` for every `data-doop-id`.
3. The raster pool, the HTML-in-Canvas source behind a capability check, and the server fallback.
4. Server-side rasters after settled writes, plus the IndexedDB cache.
5. **Exit:** off-screen frames are pixels rather than documents, and zoom-settle no longer
   relayouts any frame that is not live.

### Phase 3: GPU compositor

1. `tests/compositorBrowser.test.ts`: a page drawn by the compositor matches the v1 page (static
   frames) within the phase 2 tolerance at 25%, 100% and 400%, rotated frames and page backgrounds
   included.
2. One WebGL2 canvas, atlas packing, instanced quads, mip selection by `zoom × devicePixelRatio`,
   and a blurry-then-sharp handoff when a mip arrives (never blank).
3. The paper, dot grid, pixel grid and rulers' content moved onto the compositor. Chrome
   (selection rings, grips, labels, cursors, pins) stays DOM in screen space, as `FrameLabelLayer`
   already is.
4. **Exit:** `L` meets the pan and zoom budget.

### Phase 4: live layer (promotion and demotion)

1. `tests/livePromotionBrowser.test.ts`: clicking a frame element selects it from the hit map in
   one frame, and double-clicking into text promotes the frame and enters text editing at the same
   caret. An agent stream promotes, and demotion waits for the new hash's raster. `LIVE_MAX` is
   never exceeded, with the oldest idle frame evicted first.
2. Existing browser suites (`elementResizeBrowser`, `frameRotateBrowser`, `drawing*Browser`,
   `pageCanvasBrowser`, `prototypeBrowser`, ...) run under v2 unchanged and pass.
3. **Exit:** every editing suite passes on v2.

### Phase 5: native primitives and effects

1. `tests/primitiveParse.test.ts`: every shape `src/lib/drawing.ts` and `src/lib/svgImport.ts`
   produce parses to a primitive. Anything unknown (a class, a filter the shader lacks, foreign
   markup) returns `null` and uses the raster path.
2. `tests/primitiveRenderBrowser.test.ts`: primitives drawn by the compositor match their live
   iframe within tolerance, strokes past the box (`frameBleed`) included.
3. Shadow, layer blur and background blur passes, with per-node effect caches.
4. Standalone primitives stop creating iframes. They are promoted only for the path editor or text
   editing.
5. **Exit:** `XL` meets the pan budget and the heap budget.

### Phase 6: the rest of the editor at scale

1. Virtualized Layers panel, lazy frame trees.
2. Undo history, clipboard and duplicate of 10,000 selected nodes in under 100 ms
   (`tests/bulkEditsPerf.test.ts`).
3. Remote edits: tile invalidation debounced per frame, with at most `N` rasters per second per
   viewer so a busy agent never starves the pan.
4. Exports keep using the live or server path. Nothing in exports depends on the compositor.

### Phase 7: default and delete v1

1. v2 becomes the default after two weeks with no regression reports, and v1 is removed: the
   `FrameStack` path, every-frame mounting and `layoutZoom` relayout.
2. Update `.context/TECHSTACK.md` §4 (Canvas Drawing) to describe the compositor, and add a spec
   `specs/renderer-v2.md` for the raster-and-promote contract.

## Risks and how the plan handles them

- **Fidelity.** A raster can differ from the live document (fonts not loaded yet, lazy images,
  `vh` units). The raster waits for `document.fonts.ready` and image decode, rasterizes in a
  viewport of the frame's size, and the phase 2 pixel-diff suite is the gate. Promotion always
  shows the real thing while editing.
- **Animated and scripted frames** (CSS animations, video, canvas, timers) cannot be one
  bitmap. The runtime reports `animated` (running animations, `<video>`, rAF use) with the hit
  map. Such a frame is live while on screen and inside `LIVE_MAX` (nearest the centre first), and
  otherwise shows its poster raster.
- **WebKit shells** (Windows and Linux desktop) lack HTML-in-Canvas. They use the live-snapshot
  and server sources. That is slower to fill, never slower to pan.
- **GPU memory.** The texture LRU is bytes-capped, mips are chosen by on-screen size, and far
  zoom uses only 1/8 mips. `webglcontextlost` rebuilds from the CPU-side cache.
- **Raster cost on huge opens.** Server tiles mean the first paint never waits on the client, and
  a frame nobody has looked at since a write is rasterized once on the server, then cached.
- **Accessibility and find.** Text in a rastered frame is not in the DOM. The find bar
  (`findText.ts`) and any screen-reader path read the stored HTML, not the page. That is already
  true of find.
- **Scope creep toward a CSS engine.** The plan never lays out HTML itself. Only doop's own drawing
  primitives are native, and everything else is the browser's pixels. This is the line that keeps
  the rewrite tractable.

## Open questions

- Does the CEF build ship HTML-in-Canvas unflagged by the time phase 2 starts? If not, enable it
  with a command-line switch in `desktop/src-tauri-chromium`.
- Is `LIVE_MAX = 8` right? Phase 4 sweeps it against the benchmark.
- Should server tiles go to the CDN path that serves `/a/` assets, so they are immutable by hash?
