# Design — Cartographer's Fog

Architecture, constraints, and the reasoning behind them. See [README.md](README.md) for what
the project is and how to run it.

---

## Starting point

Cartographer's Fog is a **standalone companion extension that runs alongside
`owlbear-rodeo/dynamic-fog`** — not a fork of it, and not a replacement for it. Dynamic Fog
stays installed and keeps doing what it does well: placing walls and lights and driving
Owlbear's line-of-sight rendering. This extension reads that output and adds the persistence
sketch on top.

This works because Dynamic Fog does not invent a private data format. `Wall` and `Light` are
first-class SDK item types living in ordinary scene items, and any installed extension can read
all scene items regardless of which extension created them. There is prior art: desain's
visibility extension already consumes walls from Dynamic Fog *and* Smoke & Spectre without
forking either.

The architecture below is read-only on Dynamic Fog's data. Visibility is computed from `Wall`
items, the discovered region is stored in scene metadata under this extension's own namespace,
and sketch strokes are emitted as local per-client items. Nothing here writes anything Dynamic
Fog owns.

This project is GPLv3. As a companion sharing no code it is not a derivative work, so that is a
choice rather than an inherited obligation.

### Why not fork Dynamic Fog

A fork is not a patch on someone's installed Dynamic Fog — it is a *replacement* they install
instead, which forces existing users to switch tools and leaves this project with permanent
merge maintenance. It also buys no access that is actually needed: Owlbear computes fog on the
GPU and never exposes visibility to extensions, so a fork would still have to compute
visibility on the CPU exactly as described below.

Worth knowing: the fog semantics live in the closed-source Owlbear app renderer, not in
`dynamic-fog`, which is largely placement UI over native item types. Reading its source answers
fewer questions than it appears to.

### Why not build on Smoke & Spectre

Smoke & Spectre is the popular community extension that already has persistence. It is not a
viable base: closed source, shipped only as a minified production bundle, no public repo, and
no license granting modification rights. Reverse-engineering it would also mean re-doing the
work on every upstream update.

It does bound the scope of this project, though. **Persistence alone is not the differentiator
— Smoke & Spectre already ships it, along with trailing fog.** What does not exist anywhere is
the hand-drawn cartographer's aesthetic. If a feature does not serve the sketch, S&S has
already solved it for anyone who wants it.

This also fixes an interop boundary: reading native `Wall`/`Light` items means working with
Dynamic Fog and `uvtt-importer`, and *not* with Smoke & Spectre, whose custom obstruction items
are invisible to this extension. That is an accepted limitation, not a gap to close.

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

**This is the project's central technical risk.** The reference implementation — Owlbear's own
renderer — is closed source, so our CPU polygons are matching something nobody can read. `Light`
carries `falloff`, a gradient with no polygon equivalent, so "visible" requires choosing a
cutoff. Any mismatch shows up as sketch strokes bleeding into areas the player can plainly see,
which is exactly the artifact the whole design is built to avoid. Budget real time for visual
comparison against the GPU fog, and treat it as tuning rather than a correctness bug to be
solved once. A fork would not have avoided this.

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

**Single writer.** Give one client — the GM's — sole write authority over the discovered
region. Union is commutative and idempotent, which makes multi-writer merging look safe, but it
isn't: two clients doing read-modify-write against shared metadata can interleave such that one
overwrites bits the other just added. Single-writer sidesteps the problem entirely and costs
nothing here.

Scene metadata is reportedly capped at **16KB** (verify against the SDK docs at implementation
time). This bounds the encoding question below — for scale, a 100×100 cell bitmask is about
1.25KB raw, before any compression.

### 6. Squiggle noise must be static

Seed the wobble from a hash of world position, **never** from the `time` uniform. Animated
squiggle makes the map appear to breathe and is genuinely nauseating to look at for a
multi-hour session.

### 7. Fade, don't pop

Hard on/off toggling at the mask boundary flickers distractingly as tokens move. Apply a
short opacity fade on segments entering and leaving `sketch_region` so it reads as ink
appearing and receding.

---

## Map pixel access (CORS) — resolved: clean

Edge detection needs raw pixels via `getImageData()`. The extension runs in an iframe on its
own origin; map images are served from Owlbear's asset storage on a different origin. A
cross-origin image can be *displayed* freely, but drawing it to a canvas and reading it back
taints the canvas and throws `SecurityError` unless the server sends
`Access-Control-Allow-Origin`.

**Owlbear's CDN sends it.** Assets are served from `images.owlbear.rodeo` (BunnyCDN) with
`Access-Control-Allow-Origin: *`, verified against both a platform asset and a user-uploaded
item asset, and returned **unconditionally** — the header is present even on requests carrying
no `Origin` at all.

Two consequences beyond the bare pass:

- `*` rather than a reflected origin means there is no allowlist to get onto. An extension
  hosted on any origin can read these pixels.
- Because the header is unconditional, the cache-tainting failure mode does not apply. That bug
  requires a cached response *lacking* the header to be reused by a later CORS load; here every
  cached response carries it.

**So: read map pixels directly from scene assets, and build the architecture as specified.**

### Reproducing the header check

No code required. Collect asset URLs from a live room's console via
`performance.getEntriesByType('resource')`, then request one with an explicit origin:

```sh
curl -sS -o /dev/null -D - -H "Origin: https://<extension-origin>" "<asset-url>"
```

This reads the server's answer directly instead of inferring it from browser behaviour, and it
tests the exact origin the extension will run on — which matters, because a reflected-origin
policy would let the Owlbear app itself read pixels while refusing an extension.

### The probe — keep it as a startup assertion

The check above used asset URLs observed in the page, not the exact string `image.url` returns
through the SDK. Same host and CDN across two asset classes, so the risk is low, but an
assertion is cheap and a `SecurityError` surfacing deep inside a trace pipeline is not. Run
this inside the extension iframe, in a real room with a map loaded:

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

- **CLEAN** → expected. Proceed.
- **BLOCKED at load** → the CDN changed policy, or this asset class differs from the two
  tested. Fall back (below).
- **TAINTED** → shouldn't occur with `crossOrigin` set; indicates something unusual.

### CDN image transforms

Asset URLs accept transform query parameters — `?width=1024`, `?crop=x,y,w,h`,
`?class=background`. Likely useful: fetch a downscaled map for edge detection rather than
tracing at full resolution. Cheaper, and the downscale suppresses JPEG artifacts and floor
texture that would otherwise generate spurious edges. Since the output is vectors, resolution
is only a coordinate scale factor.

Undocumented and unofficial, so test it rather than depend on it, and keep a full-resolution
path working.

### Why direct asset access is preferred over tracing at import

Not for fidelity — the output is vectors, so resolution differences are only a coordinate
transform, and the `Image` item supplies every term needed (`image.width/height`, `grid.dpi`,
`grid.offset`, `position`, `scale`, `rotation`). Tracing an original file is if anything
*higher* fidelity than tracing a compressed re-encode. Watch only for crop/pad introducing a
hidden offset.

The real reason is coverage. **Gating the feature on UVTT import excludes most maps.** Most
Owlbear users never touch UVTT — they drag in a JPG and draw fog by hand, or use a starter
set. An extension that only works on freshly-imported UVTT files is useless to them.

### Fallback if pixel access ever breaks

Not needed for v1, and no longer on the critical path — recorded because CDN policy is outside
this project's control, and because self-hosted or externally-linked map images may not share
the asset CDN's headers.

The shader route does **not** rescue the vector plan. Canvas tainting blocks GPU readback too,
so you cannot trace through a `POST_PROCESS` effect. (Shaders are CORS-free only because they
never extract data — fine for a purely visual effect, useless for generating `Path` items.)

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
| Fork Dynamic Fog | Replaces rather than extends it; permanent merge cost; buys no access we need |
| Walls as the sketch geometry source | See below |
| Per-frame geometric path clipping | Too expensive; pre-segmentation gets the same result cheaply |
| Sync item updates on token move | Hammers the network; use metadata + local items |
| `time`-driven squiggle | Visually nauseating |
| POST_PROCESS self-masking shader | See below |

**On walls as geometry:** walls are already vector data, so deriving the sketch from them would
need no pixel access, no edge detection, and no contour tracing — and wall outlines plus
hatching is a recognisably cartographic look. It was rejected because walls are an incomplete
and unreliable description of a map: not every feature that should be sketched gets a wall, and
walls are routinely drawn approximately or in the wrong place, since their only job is blocking
light. The sketch would inherit every one of those errors. **The map image is the source of
truth for sketch geometry.**

**On the shader route:** a `POST_PROCESS` effect could sample the `scene` uniform and draw
sketch strokes only where luminance falls below a threshold, using the fog's own darkness as
a self-mask — no LOS geometry needed at all. It's elegant and cheap, and it's a reasonable
*prototype* path. It was rejected as the real implementation because it couples the effect to
how fog happens to *look*, so custom fog backgrounds or a naturally dark map break it. Worth
keeping in the back pocket for a quick visual spike.

---

## Open questions

- ~~**CORS.**~~ Resolved — clean. See the dedicated section above.
- **Discovered-region encoding.** Grid bitmask? Quadtree? Polygon union? Needs to be compact
  enough to live comfortably in scene metadata and cheap to test points against. The 16KB
  metadata cap tilts this toward a grid bitmask, which is also the cheapest to point-test;
  polygon union is the most accurate and the most likely to blow the budget.
- **Performance budget.** How many `Path` items can a scene hold before OBR degrades? This
  bounds the segment-length knob. Note that item count and segment count are separable: a
  single `Path` holds many `MOVE`-separated subpaths, so the visible segment set could be
  rebuilt into a handful of `Path` items rather than toggling thousands. The wrinkle is that
  fade is per-item via `PathStyle` opacity, so batching requires grouping segments into fade
  cohorts. Measure before committing to either shape.
- **Visibility fidelity vs. the GPU fog.** How close can CPU polygons get, and what `falloff`
  cutoff reads best? See §1 — this is tuning, and it is the risk most likely to sink the look.
- **Sepia palette and stroke weight.** Purely aesthetic, but worth an early visual spike —
  the whole feature lives or dies on whether it looks good.

---

## Build order

0. ~~Run the CORS probe.~~ **Done — clean.** Steps 4+ target scene assets directly.
1. Scaffold a fresh Vite + React + TS extension against `@owlbear-rodeo/sdk`, building and
   loading in a real room. Add the dev log shim and its Node receiver at the same time, plus
   the CORS startup assertion reporting through it. Two things to get right here:
   `vite.config.ts` needs `base: "/cartographers-fog/"` because project Pages serve from a
   subpath, and Pages has to move from branch-deploy to a GitHub Actions workflow once the
   branch holds source rather than built output.
2. CPU visibility polygons from `Wall` items — vitest against fixture walls, then verify
   against the GPU fog visually
3. Naive persistence: discovered region tracked, plain revealed areas, no sketch
4. Offline edge-trace → `Path` generation, run manually on one test map
5. Wire the two together with per-segment masking
6. Wobble, sepia, dash, fade — the pass that makes it look hand-drawn
