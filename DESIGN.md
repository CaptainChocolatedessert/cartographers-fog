# Design — Cartographer's Fog

Architecture, constraints, and the reasoning behind them. See [README.md](README.md) for what
the project is and how to run it.

---

## Starting point

Fork or build on **`owlbear-rodeo/dynamic-fog`** (React + TypeScript + Vite). It is Owlbear's
own open-source extension, explicitly published as an example of SDK usage, and it already
implements walls, doors, lights, and line-of-sight rendering. It is GPLv3, which is why this
project is too.

### Why not build on Smoke & Spectre

Smoke & Spectre is the popular community extension that already has persistence. It is not a
viable base: closed source, shipped only as a minified production bundle, no public repo, and
no license granting modification rights. Reverse-engineering it would also mean re-doing the
work on every upstream update.

### Companion extension

Map ingestion is a solved problem — use **`Eppinguin/uvtt-importer`** (also open source,
React + TS + Vite). It imports `.uvtt` / `.dd2vtt` / FoundryVTT `.json` files and is
explicitly designed to emit native OBR fog shapes for the Dynamic Fog extension. Do not
reimplement UVTT parsing.

Note: Smoke & Spectre's own UVTT import is *not* interchangeable — it produces S&S custom
obstruction items, which Dynamic Fog cannot see.

---

## SDK facts worth having on hand

### Items

`Billboard`, `Curve`, `Effect`, `Image`, `Label`, `Light`, `Line`, `Path`, `Pointer`,
`Ruler`, `Shape`, `Text`, `Wall`

### `Path` — the sketch primitive

Raw path defined by a list of drawing commands, backed by Skia's `SkPath`.

- Commands: `MOVE`, `LINE`, `QUAD`, `CONIC`, `CUBIC`, `CLOSE`
- `PathStyle`: `fillColor`, `fillOpacity`, `strokeColor`, `strokeOpacity`, `strokeWidth`,
  `strokeDash`
- `fillRule`: `"nonzero"` | `"evenodd"`

`QUAD`/`CUBIC` control points are where the hand-drawn wobble comes from. `strokeDash` is
useful for a broken, sketchy stroke.

`Curve` is a simpler freeform alternative if full Bézier control isn't needed.

### `Effect` — shaders

Written in **SkSL** (Skia's shading language, GLSL-like). `main` takes a `float2` pixel
coordinate and returns a `half4` color.

- `effectType`: `"STANDALONE"` | `"ATTACHMENT"` | `"VIEWPORT"`
- Built-in uniforms: `size`, `position`, `scale`, `rotation`, `model`, `view`, `modelView`,
  `time`
- Custom uniforms supported via `.uniforms([...])`
- **On layer `"POST_PROCESS"`**, the effect gains a `scene` uniform of type `shader`,
  allowing it to sample the currently rendered scene color

### Dynamic Fog items

- `Light`: `lightType` `PRIMARY` | `SECONDARY` | `AUXILIARY`, plus `falloff`, `sourceRadius`
- `Wall`: `doubleSided`, `blocking`
- `zIndex` is overloaded on both — it filters which walls affect which lights, and drives
  elevation layering

### Local vs. scene items

`OBR.scene.local.addItems()` adds items visible only to the local client, with no network
sync. This is central to the architecture below.

---

## Architecture

### 1. Visibility must be computed on the CPU

Owlbear computes fog on the GPU and does not expose "what can this token see" back to
extensions. Visibility polygons must be built from `Wall` items in JS. This is required for
persistence at all, not just for masking.

Prior art exists — desain's visibility extension does exactly this, consuming walls from
Dynamic Fog / Smoke & Spectre.

### 2. Trace edges once, not per frame

At map import / scene setup:

1. Draw the map image to an offscreen canvas
2. Run edge detection (Sobel)
3. Trace contours (marching squares → simplification)
4. Perturb control points with position-seeded noise for the hand-drawn wobble
5. Emit `Path` items, initially hidden

Runtime persistence then becomes visibility toggling, not geometry generation.

### 3. Pre-segment the contours

Chop traced contours into short segments — a few grid units each — at generation time.

Masking then reduces to a **per-segment boolean** (test segment midpoint against current
visibility polygons) rather than a per-frame polygon boolean operation.

Segment length is the primary tuning knob: shorter segments give a crisper mask boundary at
the cost of item count.

### 4. Region math

```
discovered        = union of all past visibility polygons
currently_visible = union of current visibility polygons
sketch_region     = discovered − currently_visible
```

Only segments whose midpoint falls in `sketch_region` are shown. This is what keeps scribbles
off areas the player can already see directly.

### 5. Sync state, not items

Do **not** push item updates over the network on every token move.

- Store the discovered region compactly in **scene metadata**
- Each client derives and renders its sketch as **local items** from that shared state

This keeps network traffic proportional to state change rather than to geometry, and gives
per-player fog nearly for free if that's wanted later.

### 6. Squiggle noise must be static

Seed the wobble from a hash of world position, **never** from the `time` uniform. Animated
squiggle makes the map appear to breathe and is genuinely nauseating to look at for a
multi-hour session.

### 7. Fade, don't pop

Hard on/off toggling at the mask boundary flickers distractingly as tokens move. Apply a
short opacity fade on segments entering and leaving `sketch_region` so it reads as ink
appearing and receding.

---

## Map pixel access (CORS) — resolve this first

Edge detection needs raw pixels via `getImageData()`. The extension runs in an iframe on its
own origin; map images are served from Owlbear's asset storage on a different origin. A
cross-origin image can be *displayed* freely, but drawing it to a canvas and reading it back
taints the canvas and throws `SecurityError` unless the server sends
`Access-Control-Allow-Origin`.

**Whether Owlbear's CDN sends it is unknown and undocumented.** Do not assume either way.
This is the first thing to test, because it decides the architecture.

### The probe

Run inside the extension iframe, in a real room with a map loaded:

```js
const [map] = await OBR.scene.items.getItems(
  (i) => i.layer === "MAP" && isImage(i)
);
const img = new Image();
img.crossOrigin = "anonymous";
img.onload = () => {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  c.getContext("2d").drawImage(img, 0, 0);
  try {
    c.getContext("2d").getImageData(0, 0, 1, 1);
    console.log("CLEAN — vector route is viable");
  } catch (e) {
    console.log("TAINTED —", e.name);
  }
};
img.onerror = () => console.log("BLOCKED at load");
img.src = map.image.url;
```

- **CLEAN** → build the architecture as specified. Read map pixels directly from the scene.
- **BLOCKED at load** → the CDN refuses CORS. Fall back (below).
- **TAINTED** → shouldn't occur with `crossOrigin` set; indicates something unusual.

### Why direct asset access is preferred over tracing at import

Not for fidelity — the output is vectors, so resolution differences are only a coordinate
transform, and the `Image` item supplies every term needed (`image.width/height`, `grid.dpi`,
`grid.offset`, `position`, `scale`, `rotation`). Tracing an original file is if anything
*higher* fidelity than tracing a compressed re-encode. Watch only for crop/pad introducing a
hidden offset.

The real reason is coverage. **Gating the feature on UVTT import excludes most maps.** Most
Owlbear users never touch UVTT — they drag in a JPG and draw fog by hand, or use a starter
set. An extension that only works on freshly-imported UVTT files is useless to them.

### Fallback if CORS is blocked

The shader route does **not** rescue the vector plan. Canvas tainting blocks GPU readback
too, so you cannot trace through a `POST_PROCESS` effect. (Shaders are CORS-free only because
they never extract data — fine for a purely visual effect, useless for generating `Path`
items.)

The graceful fallback is a **file picker in the extension UI**: the GM supplies the map image
once, it's traced locally as a same-origin blob, and the result is matched to the scene's
`Image` item by dimensions or manual selection. One manual step per map, works for any map
regardless of origin — far less coordination than a full import pipeline.

---

## Testing strategy

Most of the difficult logic is pure, and therefore testable without a browser. Write vitest
suites for these and iterate headlessly:

- Visibility polygon construction from `Wall` items
- Contour tracing and simplification
- Control-point perturbation / squiggle generation
- Segment midpoint classification against `sketch_region`
- Image-space → world-space transform math

These are pure functions over data, and this is where the bugs will actually be.

### Mock the SDK

Stub `@owlbear-rodeo/sdk` with fixture `Wall` items and synthetic token positions so the full
persistence pipeline runs headlessly. Snapshot the emitted `Path` command arrays and diff them
across changes. A good harness here is worth more than browser automation.

### Dev log shim — add this early

Closes the loop between "I clicked something and it broke in a real room" and being able to
read the stack trace outside the browser. Highest-leverage item on this list.

```js
if (import.meta.env.DEV) {
  const send = (type, args) => fetch("http://localhost:9999/log", {
    method: "POST",
    body: JSON.stringify({ type, args: args.map(String) }),
  }).catch(() => {});
  window.onerror = (...a) => send("error", a);
  window.onunhandledrejection = (e) => send("reject", [e.reason]);
  const err = console.error;
  console.error = (...a) => { send("console", a); err(...a); };
}
```

Pair with a small Node server that appends to `dev.log`.

### Limits of browser automation

Playwright can drive the iframe standalone, but `OBR.isAvailable` will be `false` and the SDK
inert. Driving real Owlbear means automating a logged-in third-party account — fragile, and
check their ToS before building infrastructure on it.

---

## Rejected alternatives

Recorded so they don't get re-litigated:

| Approach | Why rejected |
|---|---|
| Fork Smoke & Spectre | Minified, closed source, no license to modify |
| Per-frame geometric path clipping | Too expensive; pre-segmentation gets the same result cheaply |
| Sync item updates on token move | Hammers the network; use metadata + local items |
| `time`-driven squiggle | Visually nauseating |
| POST_PROCESS self-masking shader | See below |

**On the shader route:** a `POST_PROCESS` effect could sample the `scene` uniform and draw
sketch strokes only where luminance falls below a threshold, using the fog's own darkness as
a self-mask — no LOS geometry needed at all. It's elegant and cheap, and it's a reasonable
*prototype* path. It was rejected as the real implementation because it couples the effect to
how fog happens to *look*, so custom fog backgrounds or a naturally dark map break it. Worth
keeping in the back pocket for a quick visual spike.

---

## Open questions

- **CORS.** See the dedicated section above. Blocking question — resolve before step 4 of the
  build order.
- **Discovered-region encoding.** Grid bitmask? Quadtree? Polygon union? Needs to be compact
  enough to live comfortably in scene metadata and cheap to test points against.
- **Performance budget.** How many `Path` items can a scene hold before OBR degrades? This
  bounds the segment-length knob.
- **Sepia palette and stroke weight.** Purely aesthetic, but worth an early visual spike —
  the whole feature lives or dies on whether it looks good.

---

## Build order

0. **Run the CORS probe.** Five minutes, and it determines whether steps 4+ target scene
   assets or a file picker. Do this before writing anything else.
1. Get `dynamic-fog` forked, building, and loading locally; add the dev log shim and its
   Node receiver at the same time
2. CPU visibility polygons from `Wall` items — vitest against fixture walls, then verify
   against the GPU fog visually
3. Naive persistence: discovered region tracked, plain revealed areas, no sketch
4. Offline edge-trace → `Path` generation, run manually on one test map
5. Wire the two together with per-segment masking
6. Wobble, sepia, dash, fade — the pass that makes it look hand-drawn
