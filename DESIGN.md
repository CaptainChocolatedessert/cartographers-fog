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
first-class SDK item types, and any installed extension can read them regardless of which
extension created them. There is prior art: desain's visibility extension already consumes
walls from Dynamic Fog *and* Smoke & Spectre without forking either.

**Where those items actually live — verified in a room, 2026-07-25.** Dynamic Fog keeps the
shared, networked representation as `LINE` and `PATH` items on the `FOG` layer, and each client
materialises its own **local** `WALL` and `LIGHT` items from them. Watching an item census
while drawing makes it unambiguous: every new networked `LINE` produced exactly one new local
`WALL`, and the lights are local too.

So walls must be read from **`OBR.scene.local`**, not `OBR.scene.items`. Querying the scene
alone returns nothing, silently, in a room where the fog is plainly working. Two consequences
follow:

- `OBR.scene.items.onChange` never fires for them. Anything reacting to wall changes must also
  subscribe to `OBR.scene.local.onChange` — and since this extension's own output is local
  too, that subscription feeds back on itself unless redraws are gated on whether the relevant
  inputs actually changed.
- **Dynamic Fog has to be running on every client**, not just the GM's, since a client with no
  local walls cannot compute visibility at all. In practice this costs nothing: extensions are
  added to the *room* and Owlbear loads them for everyone, so the GM adding both covers the
  whole table. Verified with a GM and a player client side by side — the player's machine
  materialised the same walls and lights. A client already connected when an extension is
  added does need to reload the room before it appears.

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

It is also where Dynamic Fog's `Wall` and `Light` items live — see "Where those items actually
live" above. `OBR.scene.local.getItems()` returns local items created by *any* extension on
this client, not just your own, which is what makes reading them possible at all.

---

## Architecture

### 1. Visibility must be computed on the CPU

Owlbear computes fog on the GPU and does not expose "what can this token see" back to
extensions. Visibility polygons must be built from `Wall` items in JS. This is required for
persistence at all, not just for masking.

Prior art exists — desain's visibility extension does exactly this, consuming walls from
Dynamic Fog / Smoke & Spectre.

This was recorded as the project's central technical risk: the reference implementation is
Owlbear's closed-source renderer, so the CPU polygons are matching something nobody can read,
and `falloff` is a gradient with no polygon equivalent.

**Largely retired — verified in a room, 2026-07-25.** Drawn as an overlay on top of the live
fog, the computed polygons track the actual visibility boundary, update correctly as a token
moves, and — the useful part — with a fading light the polygon matches the **outer** extent of
the fade. So `Light.attenuationRadius` is the outer edge of the falloff, not its midpoint or
its bright core, and no cutoff has to be invented.

Keep the debug overlay working. This is tuning that will need rechecking whenever the sweep
changes, not a question answered once and for all.

### 2. Trace edges once, not per frame

At map import / scene setup:

1. Draw the map image to an offscreen canvas
2. Run edge detection (Sobel)
3. Trace contours (marching squares → simplification)
4. Perturb control points with position-seeded noise for the hand-drawn wobble
5. Emit `Path` items, initially hidden

Runtime persistence then becomes visibility toggling, not geometry generation.

#### Centerline, not contour (decided 2026-07-27)

**The goal is a hand-drawn duplicate of the map, so the trace has to find the stroke the
cartographer drew, not the outline of it.** Boundary tracing — Sobel or luminance — traces the
*silhouette* of ink, and a drawn line's silhouette is a loop: two lines wherever there was one.
That is inherent to contouring, not a tuning failure, and no threshold fixes it.

So the pipeline binarises the ink and thins it to a one-pixel skeleton, then walks the skeleton
into strokes. Measured on the harness's synthetic parchment map, at the same settings:
centerline returns 15 strokes / 58 points / 255 segments where contouring returns 8 contours /
91 points / **493** segments — near enough double the geometry for the same map, which is the
duplication made visible.

Contour mode stays, for two reasons: it is the right answer for *filled regions*, which have no
spine worth drawing, and having both behind one switch is what lets a map be judged rather than
argued about.

**Region-based vectorization** — quantise colours, then trace the boundaries between regions —
is the third option, deferred. It suits painted maps with no linework to find, where
skeletonisation has nothing to work with. Revisit if centerline disappoints on a map that is
more painting than drawing.

**Neural line extraction** (sketch simplification, ControlNet-style lineart models) is worth
trying as a *pre-processor* that strips paper texture before binarisation, but **not inside the
extension**: tens of MB of weights against an iframe whose storage is partitioned, or a
third-party service in the path of a feature that has to work at the table, and someone's
licensed map art leaving the machine. Run it offline, once per map, and feed the cleaned raster
to the harness.

#### Prior art: the author's own `VTT_Maps`

Skeleton post-processing is adapted from `VTT_Maps` (private, MIT, so GPLv3-compatible), which
solved it against exactly these maps. Four rules come from there, each because the obvious
version is wrong:

- Prune a dead-end branch **only when it terminates at a junction** — a short chain ending in
  free space is a real short stroke.
- **Pruning must iterate**; removing one stub can expose the next.
- **Weld junction clusters.** Thinning leaves junction pixels one or two apart, and the chains
  between them survive every other cleanup: stub pruning refuses them because both ends are
  junctions, collinear merging refuses them because they are not degree-2.
- **Hough transforms are a dead end**, with the measurement attached: hand-drawn strokes wander
  ±5–15px, each locally straight run votes for a different bin, and the output is dozens of
  disjoint fragments.

Also from there, and adopted: **express tuning constants in grid squares, not pixels**, so they
survive a change of map resolution. The harness does that conversion; the pipeline stays in
pixel space.

What that project did *not* solve is the half that matters here: its `cvDetect` is stubbed, and
its walls come from a hand-painted PSD layer thresholded on alpha. Getting ink out of a textured
map was never faced there, which is why the binarisation stage is this project's own work.

Two divergences: it emits **segment pairs** because `.uvtt` walls are pairs, where this emits
**polylines**, because a stroke drawn as one line has to wobble as one line in step 6. And
`mergeCollinearSegments` becomes a topological join — where exactly two chain ends meet, they
are one stroke — rather than a geometric one.

#### As built (2026-07-27) — `src/trace/*`

Steps 1–3 are implemented and unit-tested; step 4 (wobble) is deliberately left to build
order step 6, so this stage's output can be compared against the map without the noise that
will later be the point. Step 5 (emitting `Path` items) is step 5 of the build order, which
also places the geometry in the scene.

The pipeline is `pixels → luminance → blur → contours at a level → simplify → drop specks →
chop`, all in **image pixel space** and all free of the SDK and the DOM, so it is testable
headlessly like `geometry/` and `visibility/`. `debug/traceHarness.ts` + `trace.html` drive it
over a real image with live controls; that page is not a build input and is never published.

Seven things worth not re-deriving:

- **A global threshold cannot separate ink from parchment.** The line is darker than its
  surroundings *locally*, but across a map the paper's own range overlaps the ink's — so the
  line's palest pixel is lighter than the paper's darkest, and no single cutoff catches all of
  one without flooding the other. Sauvola's local threshold, `T = mean·(1 + k·(σ/R − 1))`, is
  the standard answer from document binarisation, and the deviation term is what makes an
  evenly textured patch produce no ink at all. Computed over summed-area tables so the window
  radius is free.
- **`inkFraction` is reported for the same reason `fieldMax` is.** A threshold that reads the
  paper as ink does not fail visibly — it returns a thicket of short chains, which looks like a
  busy map rather than an error.
- **Thinning erodes stroke ends by about half the stroke's width**, and a diagonal band two
  pixels across is consumed entirely (a one-pixel diagonal survives, because its ends have a
  single neighbour and are protected). Consequence for tuning: do not trace at a resolution
  where linework is hairline. The harness warns below ~24px per grid square.

- **Two fields, not one.** `sobelMagnitude` is the specified Sobel. `luminanceField` is also
  directly contourable and is better on the common map (dark linework on a lighter floor):
  the contour lands exactly on the visible edge of a stroke, where Sobel contours the gradient
  *ridge* and so returns a line down each flank of every painted stroke. Sobel earns its place
  by being polarity-agnostic — it finds pale walls on a dark floor, which luminance at a fixed
  level does not. Which one looks right is a human judgment; the pipeline takes it as an
  option.
- **The useful level depends on the field, and is not guessable.** Luminance spans 0..1, but a
  blurred Sobel magnitude on a real map peaks around **0.3** — so the natural-looking level of
  0.5 returns *nothing at all*, which is indistinguishable from a broken pipeline. `TraceStats`
  therefore reports `fieldMax` and `fieldMean`. This was found by the harness returning zero
  contours and no way to tell why; it is the same lesson as the storage probe, that a
  diagnostic which cannot separate its failure modes invents findings.
- **No invert control.** Contouring a field and contouring its inverse produce the *same*
  curves — inversion only maps level `L` to `1 - L` — so a polarity switch would duplicate the
  level, and at 0.5 would do nothing whatsoever.
- **Marching squares keys crossings by grid edge, not by coordinate.** The textbook version
  emits loose points per cell and joins them by float equality, which fails intermittently and
  shatters one contour into fragments that read as a tracing artifact rather than a bug. An
  integer edge key makes stitching exact. Ambiguous saddles are resolved by the corner average,
  which keeps a diagonal doorway connected instead of pinching it shut.

**Cost, measured in the harness at 1024×768** (synthetic parchment map): centerline 206ms —
field 82ms, binarise + thin 103ms, skeleton walk 19ms, the rest negligible — for 255 segments
and 538 path commands, inside one item. Contour mode is 72ms for the same map but twice the
geometry. Thinning is the expensive stage and it is iterative, so cost grows with ink, not just
with pixels. This runs once per map, not per frame.

### 3. Pre-segment the contours

Chop traced contours into short segments — a few grid units each — at generation time.

Masking then reduces to a **per-segment boolean** (test segment midpoint against current
visibility polygons) rather than a per-frame polygon boolean operation.

Segment length is the primary tuning knob: shorter segments give a crisper mask boundary at
the cost of item count.

**As built:** a segment is a short *polyline*, not a straight two-point piece, and cuts fall
wherever the arc-length budget runs out rather than at vertices. Cutting only at vertices
would leave a simplified wall as one enormous segment; forcing pieces straight would discard
the vertices simplification just judged worth keeping. Each segment carries its midpoint,
precomputed, because that is what the runtime mask tests. `trace/strokeChunks.ts` batches
segments to the 8192-command item cap by *command* count, since a segment's cost varies with
how much simplification kept — unlike a region run's fixed five.

### 4. Region math

```
discovered        = union of all past visibility polygons
currently_visible = union of current visibility polygons
sketch_region     = discovered − currently_visible
```

Only segments whose midpoint falls in `sketch_region` are shown. This is what keeps scribbles
off areas the player can already see directly.

### Both terms use the full radius

`attenuationRadius` is the outer edge of a light's falloff (see §1), and **both `discovered` and
`currently_visible` use all of it**.

An earlier draft had `discovered` use a fraction, on the theory that the dim outer fringe should
not count as explored. That was wrong, for two reasons:

- **Walls, not distance, gate what was seen.** The visibility polygon is bounded by geometry, so
  a generous radius cannot leak through a wall. All it adds is the far end of a corridor the
  party could actually see down — which they did see. The "unintentional reveal" risk lives in
  the renderer's mask precision, not here.
- **The errors are wildly asymmetric.** Under-reporting leaves a permanent hole in the map, a
  black patch in the middle of explored ground that clears only if someone deliberately walks
  over there. Over-reporting produces a sketch of something glimpsed from a distance, which
  nobody notices or objects to. The earlier draft optimised against the harmless error.

If dimly-seen ground should eventually *look* different, that belongs in rendering, not
tracking — fade the sketch by how well it was observed rather than withholding it. Doing that
properly would mean recording an observation quality per cell rather than a boolean, which
scene metadata now has ample room for (see "Storage limits"). Not needed for v1.

Worth keeping in the back pocket: occlusion is radial, so visibility at radius `r < R` is
exactly visibility at `R` with each vertex clamped to `r` — the nearest hit along a ray is
`min(wall, R)`, and clamping gives `min(wall, R, r) = min(wall, r)`. One sweep therefore yields
any smaller radius for free, should a use for one appear.

### Rendering modes for `sketch_region` — open, deferred to step 5

**The constraint that governs all of this: `sketch_region` sits under the fog.** Owlbear's fog
occludes the map in exactly the area we want to draw into, and this extension does not control
the fog. So anything shown there must be drawn on a layer *above* it, and **nothing can be made
to "show through"** — any terrain a player sees in a remembered area has to be redrawn by us.

**Drawing above the fog works, and is not an open risk — settled in step 3.** The region wash
is a local `Path` on layer `CONTROL`, and it rendered *over* the fog in a real room, on the GM's
client and a player's. That is the same mechanism the sketch strokes will use — local `Path`
items, same layer — so mode 1 needs no new capability. The prior art agrees: the **Outliner**
extension places sketched marks above the fog, which is corroboration that the SDK intends this
rather than that we found a loophole.

**There is more than one layer above the fog.** `Layer` is declared in the SDK as:

```
MAP | GRID | DRAWING | PROP | MOUNT | CHARACTER | ATTACHMENT | NOTE | TEXT | RULER
| FOG | POINTER | POST_PROCESS | CONTROL | POPOVER
```

Four sit after `FOG`, and **Outliner offers `POINTER`, not `CONTROL`** (user, 2026-07-27) —
which is a choice about which layer suits sketched marks, not evidence about what is above the
fog. `CONTROL` demonstrably is; we render there already.

Treat the declaration order as a *hint* at render order, not a contract: the type is a string
union and nothing documents its ordering. It is consistent with the one thing we measured —
`CONTROL` draws over `FOG` — and if it holds generally then `CONTROL` also draws over `POINTER`,
so our strokes would sit above Outliner's rather than below them.

So the open question is narrower than "does this work", and worth one room test when step 5 has
something to look at:

- **Semantics.** `CONTROL` reads as the layer for tool chrome, so persistent scene content there
  may be competing with other extensions' UI for the top of the stack. `POINTER` is what a
  peer extension chose for exactly this job.
- **Z-order in practice**, against Outliner and Dynamic Fog both installed.

Neither blocks step 5, and the layer is a one-line change if the test says move.

**Where that line is, as of step 6:** `SKETCH_LAYER` in `src/sketch/strokes.ts`. Three modules
declare a layer of their own — the sketch, the wash (`WASH_LAYER`) and the debug overlay
(`OVERLAY_LAYER`) — all currently `CONTROL`, but only the sketch is installed, so it is the only
one that decides what a player sees. An earlier revision of this section named `wash.ts` as the
one place to change, which was true when the wash was the only thing drawing and is not any more.

That divides the options by what they can actually put on screen, not by implementation taste.
They are not mutually exclusive; a build could ship more than one as a user-selectable style.

### Placing the sketch — as built (2026-07-28), `src/sketch/*`

Build order step 5: trace the scene's map, mask the result against the discovered region, draw
what remains. Rendering mode 1 (drawn marks), in flat red — the hand-drawn treatment is step 6,
and a debug colour is deliberate, since a stroke that could be mistaken for map art is a stroke
whose misplacement nobody notices.

Verified in a room 2026-07-28: 347 strokes, 577 segments, traced in 335ms, drawn over the fog
and masked by the region.

#### Which map gets traced, and why it is a choice

A scene can hold several MAP-layer images, and one may be a GM's overlay — secret doors, the
real layout behind an illusion. Every client traces locally and draws its own strokes (§5), so
a player client tracing that overlay puts GM-only linework on a player's screen. That is a
spoiled session, not a cosmetic bug.

**Nothing in the SDK lets this be detected.** `Item` carries a plain `visible: boolean` and no
role dimension, so no field marks an image as GM-only, and whether a player client's `getItems`
even returns one is untested. So the GM nominates the map — right-click, "Sketch from this map"
— and the nomination lives in **scene metadata**, so every client traces the same one.

Two refinements came out of the first room test, and the order matters:

- **The layer alone does not mean "map".** The test scene held the map plus a character token
  called "Monk" that had ended up on the MAP layer, and refusing to trace until that was
  disambiguated is the safety rule firing on a case it was never meant to catch. Candidates are
  now ranked by world-space area, and anything under a quarter of the largest is discarded.
  This is **not** the rejected largest-wins heuristic: it only ever *removes* images, so it
  cannot cause a GM-only image to be traced that would not have been anyway, and two comparable
  images still produce a refusal.
- **A locked map cannot be selected, so it has no context menu.** Scene maps are usually locked,
  which made the nomination unreachable exactly when it was needed. The refusal message now says
  so. A proper picker belongs with the settings UI whenever that exists.

Where no choice has been made and one candidate survives, it is traced. Otherwise nothing is
traced and the candidates are logged with their sizes and lock state. **Never guess.**

#### The GM's controls, pending a settings UI

Three context-menu entries ship, all GM-only, all in lieu of the panel this project keeps
deferring: **Sketch from this map**, **Clear sketch**, and **Reset explored area**.

The reset is the one worth explaining. It began dev-gated, on the reasoning that wiping a scene's
exploration with one click is right for testing and wrong for a table. That was backwards: the
discovered region is persistent and only ever grows, so gating the reset meant a GM who explored
a scene had **no way back at all**. Starting a session fresh on ground the party has already
walked is ordinary, and nothing else can undo it.

**Clearing the sketch is one-way, and deliberately not a toggle.** Nothing is lost by it: the
linework is derived from the map, so nominating a map redraws it. Reversible-toggle machinery
would be ceremony around an action that is already free to undo, and it would need to answer a
question a context menu cannot — a menu filter matches the *item* right-clicked, so it has no way
to read scene metadata and label itself by current state.

What is stored is the **suppression**, not a deletion, and storing it is the necessary part:
without it the next scene load would re-derive the sketch and undo the clearing. An explicit
`false` is required rather than merely forgetting the nomination, because on the common one-map
scene an absent choice falls back to "trace the only map there is" — so clearing the nomination
alone would resurrect the sketch immediately. It is checked *before* tracing rather than before
rendering, since spending a few hundred milliseconds producing linework nobody will see is the
wrong shape of gone.

The recovery path runs through the map's own context menu, so the notification names it. That
matters more than usual: a locked map cannot be right-clicked, so a GM who clears the sketch on a
scene with a locked map must unlock it to get the sketch back.

**The reset is not confirmed**, because a confirmation needs `OBR.modal` or a context-menu
`embed`, and both want an HTML page. `ContextMenuItem.embed` is the cheaper of the two — it
renders inside the menu itself — and is the natural first step if a confirmation is wanted before
the full settings panel exists.

#### Trace resolution — a cap, not a target

The raster is `min(sourceWidth, 1024)`, which is the trace harness's default and therefore the
configuration that was judged by eye. Two findings sit behind that, both worth not re-deriving.

**Density targeting was tried and rejected.** The harness's seven tuning constants split two
ways: three scale with pixels per grid square, four are raw pixels and so mean nothing except
against the raster they were tuned on. That argues for choosing the width to hold *density*
constant, making all seven portable at once. It is sound in principle and wrong in practice —
the test scene's map spans **5.4 grid squares** (816 world units at dpi 150), so a 32 px/square
target picks a **174-pixel** raster and thinning erases every line. The harness's own
24 px/square warning was calibrated on maps where a grid square is a small slice of the image;
on a map a few squares across, the same rule discards nearly all the resolution. Width is a
property of the image, never of how many squares it happens to span.

**The harness's grid-square settings were never calibrated.** Its three grid-denominated lengths
convert through a "source pixels per grid square" field that was left at its **default of 70**,
never measured. So the validated configuration is pixel constants against a 1024-capped raster,
with no relation to the scene's grid at all — `VTT_Maps`' portability rule was nominally applied
but is not actually in force. The extension reproduces that arithmetic verbatim, placeholder and
all, because deriving lengths from a map's *true* density is a different configuration rather
than a more faithful one: on the test scene it would have tripled every length (150 px/square
against the nominal 70). Both figures are logged, so the gap is visible rather than assumed.

Recalibrating properly means measuring a real map and re-judging in the harness. That is
outstanding work, not a tidy-up.

#### Masking

`discovered` is a cell lookup, O(1), already quantised because that is how it is stored.
`currently_visible` is tested against the polygons **at full precision**, not against a
pre-subtracted mask: quantising it would stair-step the inner boundary to the cell size, and
that is the boundary that moves with the party and gets looked at directly. The region wash can
afford cells because it is a region marker; linework cannot. The two therefore disagree by up to
half a cell at the boundary, by design.

Polygon bounding boxes are hoisted out of the loop, for the reason "Masking cost" records below.

#### Cell resolution — grid-derived sizing fails on a small map

`SUBDIVISIONS` alone ties cell size to the scene grid, which breaks down on a map spanning few
grid squares. Measured on the test scene: 37.5-unit cells, a 22x29 grid for the whole map, and
two things wrong at once — cells **larger than the traced segments they gate** (37.5 against
~24.5 units), inverting §3's assumption that the mask is finer than the geometry it masks; and
cells comparable to a light's own diameter (90 units), so a token's whole field of view
quantised to a couple of cells and exploration recorded as blocks rather than a path.

`MIN_CELLS_PER_AXIS = 200` fixes it, bounded below by one map pixel — a cell finer than a pixel
records detail the source does not have. The test scene goes to 200x259 cells of 4.08 units:
six times finer than a segment, twenty times finer than a light, four times coarser than a
pixel. `MAX_CELLS` rose from 256² to 512² to stop the floor fighting the ceiling on anything
more elongated than about 1.6:1; storage was measured to have two orders of magnitude of
headroom, so it was never the binding constraint.

Changing cell size invalidates stored regions — `sameGrid` rejects them and the scene starts
unexplored, logged rather than silent.

#### Known tuning limits, judged on a real map (2026-07-28)

Recorded because they are properties of the settings at a given resolution, not defects:

- **Bold text collapses to a single stroke running along the words.** Blur plus Sauvola merges
  adjacent letters into one blob and thinning returns its spine. This is skeletonisation working
  as designed — see "Centerline, not contour" on filled regions having no spine worth drawing.
- **Small text and fine pen strokes disappear.** `minContourLength` is 14px here, substantial on
  an 816px-wide map, and thinning erodes anything 1–2px across entirely. At 150 px per grid
  square — ordinary battlemap resolution — body text is ~10px tall with hairline strokes, below
  both thresholds.

Levers when this is revisited, in likely order of payoff: `minContourLength`, `blurSigma`,
`sauvolaRadius`. Tune in the harness, which takes an asset URL directly; the extension logs the
map's URL for exactly that.

#### Open: strokes sit at one edge of a wall, not down its middle (2026-07-31)

Observed by the user on "Lair Of The Lamb": sketch strokes follow the wall linework but sit at
one side of it rather than centred — and **not consistently the same side**, which is the
detail that matters for diagnosis.

Two things this is *not*. The wobble is far too small: 3 world units of displacement against a
wall band of roughly 42. And it is not the placement transform, which would shift every stroke
the same way rather than picking a different side per wall. (A half-pixel question does exist
there — whether traced coordinates denote pixel centres or corners, worth 5 world units at this
map's scale — but it is uniform in direction and cannot explain side-to-side variation.)

That leaves the binarisation, and the likely explanation is that **what the threshold calls ink
is not the wall band a human sees**. Two candidates, distinguishable by looking:

- **Sauvola hollows out a wide uniform band.** It is a *document* binariser, tuned for thin
  strokes: its deviation term suppresses detection where local variance is low, which is exactly
  the interior of a thick, evenly-filled wall. The band then binarises to its two edges, and the
  skeleton follows those rather than the middle. This predicts *two* strokes per wall, so if only
  one survives, pruning or welding is discarding the other — worth checking rather than assuming.
- **The map's ink genuinely is asymmetric.** Many hand-drawn maps outline a wall heavily on one
  side and lightly on the other. The centerline of the *ink* is then legitimately off the centre
  of the *band*, and the trace is behaving correctly on a map whose linework is not symmetric.
  This predicts the side varies with how the artist drew each wall — which matches the report.

**The diagnostic is cheap and visual.** Load the map's asset URL into `trace.html` and step
through the background layers: `mask` shows what was classified as ink, `skeleton` shows what was
thinned from it. A hollowed band is unmistakable in the mask preview. Do this before changing any
constant — the two causes want opposite responses. If Sauvola is hollowing the band, the lever is
`sauvolaRadius` (a window wide enough to span the band restores interior contrast) or contour
mode, which DESIGN.md already notes is the right answer for filled regions. If the ink is simply
asymmetric, nothing is wrong and the fix is a matter of taste rather than correctness.

Note the interaction with the ink-width estimator: if wide bands are binarising to their edges,
the measured "stroke width" is describing edge lines rather than walls, which changes what the
inflated 42.5-unit figure recorded above actually means.

#### Correcting the sketch by hand — a future feature (raised 2026-07-28)

The tuning limits above are the argument for this: no threshold setting will ever be right
everywhere on a map, so a trace will always leave some spurious lines and miss some real ones.
Letting the GM fix that once per map — delete a stray, redraw a wall the thinning ate — would be
worth more than any amount of further tuning, because it addresses the residue tuning cannot
reach.

**Why it is not simply "make them scene items."** Sketch strokes are currently local, locked, and
`disableHit`, and each of those earns its place:

- **`disableHit`** stops hundreds of strokes lying over the map from intercepting every click
  meant for a token. Without it the sketch is actively hostile in play.
- **Local** keeps them off the network, which is §5's whole point.
- **Delete-and-replace on every visibility change** means there is nothing durable to edit —
  an adjusted stroke would be destroyed by the next token move.

Naively promoting them to scene items breaks §5 twice over: the geometry would be networked, and
worse, *masking* would become a per-move networked write (toggling `visible` on hundreds of
items), which is precisely the traffic the architecture exists to avoid.

**The shape that works** separates authored geometry from what is drawn. The traced strokes —
with the GM's corrections applied — are the durable, shared artifact, stored once per map. What
each client renders stays exactly as it is now: a locally-derived, locally-drawn subset. Editing
then costs one write when the GM finishes editing, and nothing per move. Storage is not a barrier
— a few hundred segments encode well inside the measured metadata headroom.

**Two problems to solve before building it:**

- **Stroke identity across a re-trace.** Storing corrections as a diff ("segment 143 deleted") is
  compact but fragile: changing any trace setting renumbers everything, so the corrections would
  reattach to the wrong lines. Storing the full corrected geometry avoids that but discards the
  ability to re-trace at all. Neither is obviously right.
- **An edit mode.** Selection needs hit-testing back on, which is only tolerable while
  deliberately editing. That implies a UI toggle, and therefore the settings UI that does not
  exist yet.

**A cheaper version worth considering first: erase, don't edit.** Let the GM paint out regions
where the trace is wrong, rather than manipulate individual strokes. That handles deleting
spurious lines — probably most of the value — with none of the identity problem, since an erase
mask is the same shape of object as the discovered region and can reuse that machinery wholesale.
Redrawing strokes by hand is the expensive half, and it is separable.

### The hand-drawn pass — as built (2026-07-28), build order step 6

Judged in a room and parked as the first usable build. Sepia `#603F21`, strokes at 1/12 of a
grid square, no dash, no wash, no debug overlay.

**Wobble is a 2D vector field, not an offset along each stroke's normal.** The normal version is
the obvious one and it pulls strokes apart: `chop.ts` cuts contours into segments that share
endpoints, and while the *offset* at a shared point is common to both, the *normal* is computed
from neighbouring vertices, which differ across a cut landing on a vertex. The two copies then
move differently and every pre-cut boundary becomes a visible break. A vector field removes the
failure rather than patching it — displacement depends on position and nothing else, so shared
points always land together. Part of the offset then runs along the stroke instead of across it,
which slides a point rather than bending the line, and is invisible in practice.

Two octaves of smoothly interpolated lattice noise, keyed on world position and never on time
(§6). Applied once at trace time, so it costs nothing per render, and stable across reloads and
across clients — each of which traces independently.

**Strokes are emitted as `QUAD` curves through vertex midpoints**, not chained `LINE`s. Wobble
subdivides long runs so they can bend, and joining those points with straight edges puts a
visible corner at each one — turning a wobble into a zigzag. Command count is one per point
either way, so the 8192 budget and `strokeChunks` are untouched.

**The wash and the debug overlay are off.** Both were scaffolding for steps they outlived: the
wash showed the tracked region when nothing else could, and the overlay's cyan outlines settled
whether the CPU polygons match the GPU fog. Both now draw over the thing they were used to
build. `wash.ts` remains as rendering mode 3 and as the way to see the raw region if tracking is
ever in doubt; the overlay remains for re-checking sweep tuning, which §1 expects to recur.

#### The wall margin

Wall linework is the case where masking by a single midpoint fails, and it fails *by
construction*: a visibility polygon is bounded by the walls, so its boundary **is** the wall; a
traced stroke runs down the centerline of the wall drawn in the art; and the GM's Dynamic Fog
wall is drawn approximately along that same art. The midpoint therefore sits within a few units
of the polygon edge, where `pointInPolygon` guarantees nothing. Which side wins depends on where
the GM's line falls relative to the art, and that wanders along a wall's length — so wall
linework would appear in patches along a single wall, and walls are most of what the sketch has
to show.

Masking therefore samples three points per segment: the midpoint, and ±`margin` along the
stroke's normal. Perpendicular specifically — a stroke runs *along* a wall, so its own endpoints
are equally ambiguous and all the uncertainty lies across it.

**Applied to both terms.** Widening only `discovered` would sketch over a wall in plain sight,
which is exactly what `discovered − currently_visible` exists to prevent. Widened on both, a
wall stroke is discovered *and* visible while it is being looked at (hidden), then discovered but
not visible once the party leaves (drawn).

**The margin is measured from the map's ink, not from the grid** (user, 2026-07-28). A grid
square is the obvious unit and not a dependable one: `getDpi` returns a value even on a scene
whose grid was never set to match the map, and the margin would be silently wrong.
`TraceStats.strokeWidthPx` measures the art directly as **ink area over skeleton arc length** —
the skeleton runs down the middle of every stroke, so its length *is* the total stroke length,
and both terms are computed anyway. Arc length rather than a skeleton pixel count, because
thinning is 8-connected and a diagonal step covers √2 while counting as one pixel.

Known weakness: a **filled region** has a large area and a short spine, so it reports as one
enormously wide stroke. Hence a clamp — expressed as a share of the map's shorter side, not of
the grid, so it does not reintroduce the dependency being removed — and the grid as a fallback
only for paths with no measurement. If the estimator proves unreliable, the principled upgrade is
a distance transform, whose per-pixel half-widths have a median immune to filled regions.

**Both effects are counted and logged** (`margin +rescued/-suppressed`). All zero on a walled
scene means the margin is misconfigured, not that it was unnecessary — the same lesson as every
other diagnostic here: a measurement that cannot distinguish its outcomes will be believed
anyway.

##### Measured on a real walled map (2026-07-31)

Run on "Lair Of The Lamb", 10275x7915 world units — 68.5 grid squares, traced at a 1024 raster:

```
ink 4.2px wide (62291 px over 14699px of skeleton) = 42.5 world units,
wall margin 63.8 from ink
... sketch 166/2003 segments (margin +38/-7)
```

**The margin does real work.** About a quarter of the wall linework on screen at that moment was
drawn only because of it, and it stayed active throughout (`+2` to `+7` per redraw, `-1/-2`
suppressed). The problem it was built for is real rather than theoretical.

**But two things about *why* it works are worth knowing, and neither is comfortable.**

**1. The estimator's error and the multiplier compensate for each other.** A measured stroke
width of 42.5 world units is **0.28 of a grid square** — fat for linework, and almost certainly
the filled-region inflation described above, since this map's walls are solid. The margin lands
at 0.43 of a grid square, well under its clamp, which never bound.

So the distance-transform upgrade proposed above is **not a safe isolated improvement**. Making
the width measurement accurate would shrink it toward the true stroke width, and the margin with
it — possibly below what makes wall linework appear at all. The estimator and
`MARGIN_STROKE_WIDTHS` are entangled: change one and re-measure the counters, or wall linework
will quietly go patchy again. This is exactly the kind of thing a later session would tidy up
without realising it was load-bearing.

**2. Its safety so far is a property of the map, not of the margin** (user, 2026-07-31). That map
has generous space around its rooms, so a margin reaching 0.43 squares past the discovered edge
finds nothing to reveal. **On a tighter map it would.** A stroke belonging to an unexplored room
across a thin wall can have its perpendicular sample land in the explored room next door, and be
drawn — showing the party a room they have never entered. That is a genuine spoiler, and it is
*not* covered by §4's argument that over-reporting is harmless: that argument was about ground
glimpsed at a distance, not about the room next door.

**The remedy if it appears — occlusion-gate the samples.** Reject a margin sample when a wall
lies between it and the segment's midpoint. Wall segments are already in the visibility snapshot,
and `geometry/segment.ts` already has `rayHitDistance` for exactly this shape of test. It gets
the cases right by construction: a stroke *on* a wall has both samples start at the wall and
travel away from it, so neither is blocked and whichever side is explored still rescues it; while
a stroke inside the next room has its sample toward the explored room blocked by the wall between
them, and is correctly left undrawn.

Note this is not the wall-gated interpolation rejected under "Routes that do not work". That one
narrowed an assumption about *where a token went* without removing it. This asks a question with
a definite answer — is there a wall between these two points — and uses it to decline, never to
infer.

**1. Drawn marks — vector strokes** (the mode described in §2/§3/§6/§7). Traced outlines,
perturbed for a hand-drawn wobble, reading as ink on darkness. Shows remembered *structure*,
not terrain, which suits the aesthetic: the party's own map, not a view of the room. The only
mode needing edge detection and contour tracing, and so the only one exposed to that risk —
how tracing holds up on painted, textured or low-contrast maps is untested.

**2. Map pixels — masked copy of the map.** The only way to show real terrain in a remembered
area, and a genuinely different feature from mode 1 rather than a fallback for it: this is
classic "explored areas stay visible" persistence, optionally recolored. Two implementations,
with quite different risk:

  - **Canvas composite → `Image` item.** Mask and recolor per pixel, giving a soft boundary and
    true color transforms (desaturation, grain, paper texture). Costs an *encode* per update,
    and depends on whether Owlbear renders an `Image` whose `url` is a `data:` URL — this is
    **unverified**, and it gates the approach, since `buildImageUpload` into asset storage is
    far too heavy for per-move updates. Ten-minute test; do it before committing.
  - **CDN-cropped tiles.** Pre-slice the map into `Image` items whose URLs carry `?crop=`
    (see "CDN image transforms"), then reveal by toggling `visible` per tile. No canvas, no
    encoding, no `data:` URL question — updates are just visibility flags. Costs are item count
    and one CDN fetch per tile. **Rejected on its own**: a whole-tile toggle does not merely
    look blocky, it *shows map content the party never saw* — a secret door in the corner of a
    revealed tile is a correctness bug that silently spoils a session, not a cosmetic one.
  - **Tiles plus edge masking — preferred if mode 2 is built.** Combines the two above. Classify
    every tile against `sketch_region` as fully inside, fully outside, or straddling the
    boundary. Inside and outside tiles are handled by the cheap path (a `visible` toggle on a
    CDN-cropped `Image`); only the straddling ring is canvas-composited with a per-pixel mask.
    Correct by construction — interior tiles are safe by definition and partial tiles are masked
    exactly — and cost scales with the region's **perimeter** rather than its area.

    This is what makes mode 2 affordable at all. A single whole-map composite means re-encoding
    ~16M pixels into a multi-megabyte `data:` URL on every token move; the boundary ring is a few
    dozen small tiles instead.

    Three notes. It does **not** avoid the `data:` URL question, only shrinks the payload —
    `blob:` URLs cannot substitute, being scoped to the creating document's origin while the
    renderer is the parent page on another origin. Tile classification is nearly free if
    `discovered` is stored as a grid bitmask with tiles aligned to its cells, which is where the
    encoding question was already leaning for unrelated reasons. And **seams are a real risk**:
    adjacent tiles must align to the pixel or sub-pixel positioning leaves hairlines along every
    edge, which would look worse than the blockiness being avoided — test early with a
    deliberately visible checkerboard.

    Two refinements worth having later: the inner boundary (edge of current vision) moves on
    every token move while the outer frontier only changes when new ground is explored, so the
    two can be updated at different rates; and since `discovered` only grows, a tile that becomes
    fully interior can permanently discard its composited version and revert to the plain crop.

  Note `Image` items have **no built-in tint, opacity or blend property** — checked
  `ImageBuilder` and `GenericItemBuilder`, which expose only a bare `visible` toggle. Any real
  color transform therefore requires the canvas route.

**3. Flat region wash — vector fill.** Fill the `sketch_region` polygon with a translucent
`Path` (`fillColor`, low `fillOpacity`, `fillRule` for its holes). Nearly free, since the region
is already a polygon by the end of §4. But it shows only *where* the party has been, with no
detail of any kind — it is a region marker, not a view of anything. **Not a substitute for
modes 1 or 2, and it does not de-risk tracing**, because it does not do the same job. Its real
use is as step 3's "plain revealed areas" visualization, where showing the tracked region and
nothing else is exactly the point.

All modes read the same `sketch_region`, so none of this blocks step 3, and the choice is
better made once there is a traced map to look at — which is also when tracing quality becomes
judgeable rather than theoretical.

**Timing note (from the user, 2026-07-25):** the visible region only needs updating when a token
*finishes* moving, not continuously while dragging. That removes the original objection to the
canvas route — per-frame re-encoding — since a ~1s budget on move-end is generous for a
composite, and a cross-fade between two `Image` items covers §7's fade without per-frame raster
work.

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

**Player clients do not accumulate `discovered`.** They compute `currently_visible` locally —
they must, to render — but take `discovered` from metadata. If every client accumulated
independently they would diverge, through different sampling instants during a drag and
different throttle timing, and since only the GM's version persists, each sync would overwrite
the player's local work. That reads as flicker: cells appearing, then vanishing.

Note this is a consistency decision, not an optimisation. Players still run the visibility
sweep, which is the expensive part; skipping the rasterization on top saves little.

**Expect the player's region to lag** by accumulation plus debounce plus network. The fog
updates instantly on the GPU, so the artifact is that ground a player has just left goes
un-sketched for a beat. If that reads badly, players may accumulate **optimistically** into a
local copy and union it with the authoritative one — safe precisely because union is
commutative and idempotent, and every client derives identical polygons from identical walls
and lights, so the two converge rather than conflict.

Two edge cases this rule does not yet cover:

- **No GM connected.** Nobody accumulates and the region silently stops growing.
- **More than one GM.** If Owlbear permits several GM-role players, "the GM writes" is
  ambiguous and reintroduces the read-modify-write race. Needs a deterministic tiebreak — the
  lowest player id among GMs would do.

#### Revisit: should each client derive the sketch at all? (raised 2026-07-29)

Worth reopening eventually, and explicitly *not* urgent — the per-client architecture is running
in real sessions and working. Recorded because the reasoning that produced it has partly expired.

There is an asymmetry in the current design that is easy to miss. Two things are derived per
client, and they are treated differently: the **discovered region** is computed locally but
shared as authoritative state with a single writer, while the **sketch** is computed locally and
never shared at all. The original justification was size — a traced sketch is thousands of path
commands, against a region that is a few kilobytes. **That argument is weaker than it was.** The
storage probe found no metadata limit below 512KB per key, and a traced sketch encodes to tens of
kilobytes, so "too big to share" is no longer obviously true.

The user's observation is that storing the sketch as scene items might also bear on the two edge
cases above. Worth being careful about how far that goes: neither case is *caused* by the sketch
being local — both are about who accumulates the region — so item storage does not fix them
directly. What it does is remove one of the two independent derivations, which makes the
remaining question ("who computes, and who writes") a single problem to solve once rather than a
pattern repeated with different answers. A leader election that covers no-GM and multi-GM would
then cover everything.

What still argues for local derivation, and would have to be given up:

- **Per-player fog is nearly free** while each client renders from its own visibility. Sharing
  one authoritative sketch means one sketch for everybody.
- **Local items leave nothing behind.** Nothing to be accidentally selected, deleted, or picked
  up by the GM's undo history, and everything vanishes cleanly when the extension is removed.
- **Masking must stay local regardless.** Even with shared geometry, toggling which segments show
  is a per-move operation, and doing that over the network is exactly what §5 exists to prevent.
  So a move here splits the sketch into shared *geometry* and local *visibility* — which is the
  same shape the hand-editing feature needs (see "Correcting the sketch by hand"). The two should
  be designed together if either is built.

### Observing movement — `getItemBounds` is live, `getItems` is not

Accumulating a discovered region means knowing where the lights were *while* a token moved, not
merely where it ended up. Owlbear makes that harder than it looks, and the way through is one
asymmetry that is not documented anywhere.

**During a drag, the item store is frozen.** No change event fires on `scene.items.onChange` or
`scene.local.onChange`, and `getItems` reports the pre-drag position for the entire drag. Measured
2026-07-26: a ~9s drag of 372 units produced zero events, then one carrying the destination.

**`getItemBounds` is not.** It is the app *computing* geometry rather than reading the item
record, and it reflects the live interaction transform. Polled at 100ms during the same class of
drag it moved in steps of 2–33 units while `getItems` read `+0` throughout. Both a light's own
bounds and its parent token's bounds track live and agree.

Why the two disagree: Dynamic Fog builds each light with `.attachedTo(parent.id)` and sets its
position exactly once, at creation — its `update()` only ever reapplies radius, falloff and
angles, and never writes position (`LightActor.ts`, verified in source). The light follows its
token because the **app renderer** composes the attachment transform, against an interaction that
is only committed to the item store on release. So the fog visibly moving during a drag is *not*
evidence that any extension can observe it. Dynamic Fog cannot either; its reconciler subscribes
to the same two channels we do.

**Remote clients see it too.** A drag performed on one client produced a live bounds trail on
another, at finer granularity than on the client holding the pointer (which was busy sweeping).
So the GM can observe a *player's* drag, and single-writer (above) needs no revision to cover
player movement — the GM watches every light regardless of who owns the token.

#### Consequence: record and flush, never sweep inline

Sampling density and sweep cost must not be coupled. Sweeping inside the poll made the sampling
interval a function of geometry cost: 46–97ms sweeps behind a re-entry guard produced real samples
0.2–1.3s apart and steps of 124, 98 and 95 units against a 90-unit polygon — gaps, in exactly the
case the mechanism exists to prevent. So:

- **Poll cheaply.** One `getItemBounds` per light, no geometry. Record a point once the light has
  moved `max(cellSize, attenuationRadius / 2)`, so the track is decimated by *distance* and its
  length is bounded by ground covered rather than by how long a drag took.
- **Flush after stillness** (250ms), sweeping the whole recorded track at once, with a cap that
  flushes early on very long drags rather than banking hundreds of samples. Yield to the event
  loop between sweeps — `await Promise.resolve()` drains only the microtask queue and would leave
  the poll blocked for the whole flush.

The region therefore lags a drag by about a quarter second and then fills in complete. That trade
was chosen deliberately: a tight track with no holes beats a live one with gaps.

**Round trips are the binding constraint, not geometry.** Once sweeps were out of the loop, the
limit became message latency — `getItemBounds` queues behind the main page while it composites a
fast drag. Two things follow, both learned by measurement:

- Issue every light's reading in **parallel**. Awaiting them one at a time makes a poll cost N
  round trips, so sampling silently degrades as a scene gains lights.
- Spend no round trip on anything else. An `await OBR.scene.isReady()` per poll was a third of the
  traffic; removing it took the worst observed step on a fast drag from **480 units to 105**.

Gaplessness is a property of the distance between consecutive samples — two samples overlap only
while they are closer together than the polygon is wide. At a 40ms poll and a 45-unit light
radius, that holds up to roughly 2300 units/sec, which covers ordinary play and leaves a deliberate
fast flick marginally over. Larger light radii raise the ceiling proportionally.

#### Routes that do not work

- **Interpolating between observations.** Rejected: a token may have gone round a corner, so a
  straight line marks ground nobody crossed. A wall-gated variant (interpolate only where no wall
  crosses the line) narrows when the assumption is made without removing it — a token can loop
  inside one open room. Moot now that the real path is observable.
- **Our own drag tool.** `OBR.tool.createMode` plus `startItemInteraction` would give the true
  pointer path, but means reimplementing token dragging and only records when the GM remembers to
  use it. `getItemBounds` gets the same data for nothing.
- **Hooking the native drag.** Not possible. `InteractionApi` exposes only
  `startItemInteraction` — there is no observer for an interaction someone else started — and
  while `ToolMode`'s click handlers return a `boolean` for pass-through, every drag handler
  returns `void`.
- **Accepting the gaps as stylistically appropriate.** Considered and rejected: it is a usability
  loss, and a limitation should not be promoted to a feature.

### Storage limits — measured 2026-07-26, and the folklore was wrong

This document previously recorded scene metadata as "reportedly capped at 16KB", and that
number shaped the region encoding, the cell resolution, and the argument for storing the region
in items instead. **It is not 16KB.** Measured in a live room by a probe that writes, reads
back, and verifies:

- **Scene metadata: no limit found at 512KB on a single key**, and 4 keys × 512KB (2MB total)
  also succeeded. The probe ran out of sizes to try before the store ran out of room.
- **It persists, and it reaches players.** A 256KB payload written by the GM in Firefox was read
  back **byte-identical, tail marker intact, by a player client in Chrome** — a separate browser
  process with a separate cache, so it made a genuine server round trip. This also settles a
  larger question than storage: **scene metadata does reach player clients**, which §5's
  share-state-render-locally architecture depends on entirely and which had never been verified.
- **Per-key versus shared is still untested.** Since no single-key limit was found, N keys
  succeeding shows only that the total fits — a shared cap larger than the total is equally
  consistent. Do not repeat the mistake of concluding "per key" from this.

**Consequence: the size anxiety driving the region encoding was unfounded.** A fine-resolution
bitmask fits comfortably, and so does a polygon representation — which means storing the region
as vector shapes no longer requires putting it in scene items to escape a cap. Metadata is
roomy enough for either.

**Encoded region sizes, measured (2026-07-26).** Simulated at the maximum resolution current
settings allow (256×256 cells), stamping 64-gon visibility polygons rather than RLE-friendly
rectangles. Encoded size scales with the region's **perimeter** (run transitions ≈ 2 bytes per
run before base64), so fragmentation is the realistic worst case, not coverage:

| Scenario | Coverage | Encoded |
|---|---|---|
| Compact random-walk exploration, 3200 stamps | 11.5% | 0.5KB |
| Deliberately fragmented: 150 scattered rooms + 60 one-cell corridors | 25.1% | 3.7KB |
| Pathological checkerboard (unreachable from rasterized polygons) | 50% | ~87KB |

So realistic regions run 0.5–4KB against a measured metadata floor of 512KB per key — two
orders of magnitude of headroom even in the fragmented case, and the unreachable pathological
bound still fits six times over.

### Masking cost — measured and fixed (2026-07-26)

`sketch_region = discovered − currently_visible` runs on every render, so its cost bounds how
fine the cell grid can be. Measured on a 256×256 grid at 22% coverage, subtracting two lights:

| | 64-vertex polygons | 2755-vertex polygons |
|---|---|---|
| Original | 7.5ms | **134.9ms** |
| Bounding box hoisted | 2.8ms | 3.6ms |
| Loop inverted as well | 0.1ms | **0.7ms** |

Two defects, both mine, worth understanding because the same shapes will recur:

1. **`pointInPolygon` rebuilt its bounding box on every call.** The box exists as an early-out,
   but recomputing it costs a full pass over the vertices *before* it can reject — so a cell
   nowhere near the polygon still cost O(vertices). Real visibility polygons carry thousands of
   vertices and this runs once per cell. The signature was diagnostic: 43× more vertices cost
   18× more time, when a working early-out should have made vertex count nearly irrelevant.
   It now takes an optional precomputed bounds, and hot callers hoist it.
2. **The loop scanned the whole grid.** Inverting it — copy `discovered`, then clear what the
   visible polygons cover — bounds the work by *visible area* instead of grid size, since a
   cell outside every polygon's bounding box can never be cleared and need not be visited.

**Consequence: masking no longer constrains cell resolution.** At 0.7ms for a realistic case,
and with cost now scaling with visible area rather than total cells, quadrupling linear
resolution to 1024×1024 lands around 11ms. The binding constraint on resolution is the item
command limit in the renderer (below), not storage and not masking.

The same hoisting applies to §3's per-segment masking, which will call `pointInPolygon` against
these polygons thousands of times per update.

### Items cap at exactly 8192 array entries

Writing a `Path` with too many commands is rejected outright:

```
RecordValidationError: "JSON exceeds array length limit"
```

**The limit is 8192 commands, exactly** — 8192 accepted, 8193 refused, bisected to the single
command. It is a fixed constant (2¹³), not a budget shared with the rest of the scene.

An earlier revision of this document claimed the ceiling *moved* between runs, citing 7825 and
8041. **That was wrong**, and the correction is worth recording because the failure mode is
easy to repeat: the probe caught every exception and treated it as "too big", so Owlbear's
`RateLimitHit` responses to rapid writes were misread as size rejections and drove the
bisection to false floors. Once throttling was distinguished from validation failure, the
boundary was identical across runs. **A diagnostic that cannot tell its failure modes apart
will invent findings.**

Two consequences, and the second is easy to miss:

- Any large emitted geometry must be **chunked across several items**. 8192 is exact, so a
  margin is only needed for the per-run variation in what we generate, not for the limit
  itself — but rejection should still be handled as an ordinary outcome rather than an
  exception.
- **This constrains rendering, not just storage.** A single visibility polygon already reaches
  ~2,755 vertices in a modest scene, and the region wash emits ~5 commands per merged run — a
  fragmented region at 256×256 produces roughly 1,800 runs, or ~9,000 commands, which already
  exceeds the limit. **The wash renderer needs chunking from the outset**, not as a later
  scaling concern.

### Writes are rate limited

Rapid writes are refused with `RateLimitHit: "Too many requests"`, distinct from validation
failure. This matters for §5's persistence design: debouncing the metadata write is not merely
network politeness, it avoids an enforced limiter that will reject us outright. Treat write
failure as an expected outcome with backoff and retry, and distinguish `RateLimitHit` from
`RecordValidationError` at every call site — retrying a size failure is futile, and giving up on
a throttle loses data.

### Editing the fog directly — possible, but writes to the GM's own content

Cutting holes in the fog over explored ground would let the real map show through natively —
no raster copy, no `data:` URLs, no tiles, no seams. It also rescues the cheap wash: a
translucent `Path` over the region only fails to reveal terrain *while the fog is intact*, so
fog-hole plus wash gives revealed-and-tinted map for almost nothing. That is a genuinely
simpler route to what the masked-map mode wants, and worth understanding before dismissing.

Mechanically it is available. `SceneFogApi` carries only global appearance — `getColor`,
`setColor`, `strokeWidth`, `filled` — but fog *geometry* is ordinary items on the `FOG` layer
(`PATH:FOG` and `LINE:FOG` in an item census), reachable through `OBR.scene.items`, and the
`Permission` enum has explicit `FOG_CREATE` / `FOG_UPDATE` / `FOG_DELETE`.

**Not recommended, on four counts:**

1. **It mutates the GM's authored content.** Fog shapes are user-drawn, networked and saved
   with the scene. Everything else in this design is additive *local* items that vanish
   cleanly when the extension is removed. Editing fog means a crash mid-update, an uninstall,
   or a runaway bug permanently alters work the GM did by hand, with no way back. This is a
   different category of risk from anything else here, and it is why the architecture is
   otherwise read-only on data this extension does not own.
2. **It is networked on most moves** — writing scene items as the party explores is exactly
   what §5 exists to avoid.
3. **Two writers.** Dynamic Fog regenerates fog and walls from its own inputs; we would be
   editing items it manages.
4. **Fog appearance is global.** `setColor` / `setFilled` apply scene-wide, so fog editing is
   binary — revealed or not. It cannot make explored ground *look* different from
   currently-visible ground, which is the whole point, hence needing an overlay regardless.

**Two tests, either of which could change this verdict:**

- **Does editing a fog shape change the derived walls?** Dynamic Fog documents that it creates
  walls from fog shapes. If that is live, punching a hole to reveal a room would generate walls
  around the hole and *block line of sight through it* — revealing an area would wall it off,
  which makes the whole approach unusable rather than merely inadvisable. Test: in a scratch
  scene, delete or reshape one `PATH:FOG` item and watch whether the local `WALL:FOG` count
  moves. Five minutes.
- **Does OBR support additive reveal-shapes we create and own?** If holes can be expressed as
  *new* fog items belonging to this extension rather than edits to the GM's, objection 1
  largely dissolves — our items delete cleanly and the GM's originals are never touched. That
  would make this attractive again, so it is worth checking before committing to the raster
  route. Note `Path.fillRule` supports `evenodd`, which creates holes *within a single path*;
  whether OBR composites separate fog items the same way is the open part.

### Display options are GM-controlled and ride shared metadata

If the rendering modes above become user-selectable, the controls belong to the GM alone — the
sketch is a shared table aesthetic, not a per-player preference. That raises the obvious
question of how a GM's choice reaches player clients that render independently, and the answer
is that it needs no new machinery: it is the same shared-state mechanism §5 already uses.

- `OBR.player.getRole()` returns `"GM" | "PLAYER"` — gate the UI on it.
- `OBR.room.setMetadata()` writes the settings; `onMetadataChange()` fires on **every** client
  automatically. No broadcast to design, no handshake.
- A client joining mid-session reads `OBR.room.getMetadata()` at startup, so there is no
  late-joiner problem either.

Settings are tens of bytes and change only when the GM moves a control, so unlike the
discovered region this costs nothing in traffic.

**Use room metadata, not scene metadata.** A GM's aesthetic preference sensibly follows them
between scenes, whereas the discovered region is necessarily per-scene. More practically, it
keeps settings out of the 16KB *scene* metadata budget that the discovered region is already
the main claimant on. Per-scene overrides can be layered on later if, say, a snow map wants a
different palette from a dungeon.

Two things not to mistake:

- **GM-only UI is not GM-only write.** The `Permission` enum governs item operations by layer
  (`FOG_CREATE`, `DRAWING_UPDATE`, …) and says nothing about metadata, so any client can call
  `room.setMetadata` whatever its role. Hiding the controls is a convention, not a boundary —
  fine for a cooperative tool, but the GM's client should read-modify-write its key rather than
  blind-overwrite.
- **Tolerate unknown values.** Every client loads the same deployed build, so skew only happens
  when a deploy lands mid-session and some clients have not reloaded. A `mode ?? DEFAULT_MODE`
  fallback turns "player sees a crash" into "player sees the default style" for free.

Worth knowing for later: `OBR.player.setMetadata` is per-player and synced, so a personal
override on top of the GM's shared style — an accessibility palette, or turning the sketch down
because it distracts — has a natural home whenever that is wanted. Not needed for v1.

### 6. Squiggle noise must be static

Seed the wobble from a hash of world position, **never** from the `time` uniform. Animated
squiggle makes the map appear to breathe and is genuinely nauseating to look at for a
multi-hour session.

### 7. Fade, don't pop

Hard on/off toggling at the mask boundary flickers distractingly as tokens move. Apply a
short opacity fade on segments entering and leaving `sketch_region` so it reads as ink
appearing and receding.

**Deferred (2026-07-28) — a future feature, not part of the first usable build.** Judged in a
room: hard toggling reads acceptably, and the fade is the one piece of step 6 with a cost worth
weighing rather than just paying.

That cost is not the animation. Fade is per-item through `PathStyle` opacity, so entering and
leaving segments have to be tracked as separate cohorts and stepped over several frames — and
every step is a local item write across the iframe message bus, which is the *same contended
resource* `getItemBounds` polling depends on (see "Observing movement"). Round trips, not
geometry, are what bound sampling density there; removing a single `isReady` call took the worst
observed drag step from 480 units to 105. A fade firing on every token move could measurably
reopen the gaps the accumulator exists to close.

So when this is built: measure the flush log's longest-step-against-reach figure before and
after, and be ready to fall back to fading only on *entry*, or to fewer steps. The instrumentation
is already there.

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
| Trace resolution chosen from grid density | Picks a 174px raster on a map 5.4 squares across; see "Trace resolution" |
| Largest MAP image wins | A GM overlay is the same size as the map it covers; see "Which map gets traced" |
| Interpolating between movement observations | See "Routes that do not work" |

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
- **Discovered-region encoding.** Grid bitmask? Quadtree? Polygon union? ~~The 16KB metadata cap
  tilts this toward a grid bitmask.~~ **That cap does not exist** — see "Storage limits" above,
  where no metadata limit was found below 512KB per key. Size no longer decides this, so it
  comes down to what each form is good at: a bitmask is O(1) to point-test, which §3's
  per-segment masking leans on heavily, and makes tile classification trivial; polygons are
  resolution-independent, which matters if the masked-map renderer wins, since there the region
  boundary *is* the visible edge and cell quantisation shows as stair-steps. The likely
  endpoint is polygons as the stored form with a bitmask derived locally for cheap queries.
- **Performance budget.** How many `Path` items can a scene hold before OBR degrades? This
  bounds the segment-length knob. Note that item count and segment count are separable: a
  single `Path` holds many `MOVE`-separated subpaths, so the visible segment set could be
  rebuilt into a handful of `Path` items rather than toggling thousands. The wrinkle is that
  fade is per-item via `PathStyle` opacity, so batching requires grouping segments into fade
  cohorts. Measure before committing to either shape.

  **First real measurement (2026-07-25, modest hand-drawn scene):** 37 walls flatten to **994
  segments** — Dynamic Fog's walls are dense polylines averaging ~27 points, not a handful of
  long straight runs. One light took **46ms** for 2755 polygon vertices, i.e. ~2.7M
  ray/segment tests. That is acceptable for a state-change computation but scales linearly
  with lights: four light-bearing tokens would be ~180ms per move, which would be felt.

  The visibility sweep is therefore the first thing to optimise, well before item counts
  matter. Options in rough order of payoff: a spatial index over segments so each ray tests
  a fraction of them rather than all 994; the classic O(n log n) angular sweep instead of
  per-endpoint ray casting; simplifying wall polylines once at load; and lowering
  `arcSamples`. Do not optimise blind — the dev-log line reports segments, vertices and
  elapsed ms on every redraw.
- **Visibility fidelity vs. the GPU fog.** How close can CPU polygons get, and what `falloff`
  cutoff reads best? See §1 — this is tuning, and it is the risk most likely to sink the look.
- **Sepia palette and stroke weight.** Purely aesthetic, but worth an early visual spike —
  the whole feature lives or dies on whether it looks good.
- **Cell inclusion criterion — centre, or any overlap?** A cell currently counts as discovered
  when its **centre** falls inside the visibility polygon. That splits the difference between
  under- and over-counting, but the alternative — any cell *touching* visible space — is worth
  trying once there is something to look at, because it errs generously and would show sooner
  at boundaries.

  Note the mild inconsistency this leaves: `discovered` uses the **full** attenuation radius on
  the argument that under-reporting leaves conspicuous holes while over-reporting is invisible
  (see §4), yet centre-sampling then *under*-reports by up to half a cell at every boundary.
  Any-overlap would make the two consistent. Judge it visually rather than by argument — the
  difference is half a cell, and whether that shows depends entirely on the renderer.
- **Hand-correcting the sketch.** Raised by the user 2026-07-28 and deferred — see "Correcting
  the sketch by hand". The architecture does not forbid it, but it needs a stroke-identity
  decision and an edit-mode UI, and the erase-only version may capture most of the value for a
  fraction of the work.
- **Storing the sketch as shared state rather than deriving it per client.** Raised 2026-07-29,
  deliberately parked — the current design is running in sessions and working. See "Revisit:
  should each client derive the sketch at all?". Note it lands on the same split as
  hand-correcting does (shared geometry, local visibility), so if either is built they should be
  designed together.
- **Trace calibration across maps.** The shipped settings are the harness defaults, judged on
  one map and confirmed workable on a second (see "Trace resolution" for why they are pixel
  constants rather than the grid-relative ones they appear to be). Two things are outstanding
  and neither is urgent: measuring a real map's pixels-per-grid-square so the lengths can be
  made genuinely portable, and the tuning limits under "Known tuning limits" — text and fine
  pen strokes. Robustness across more maps stays deliberately deferred; a poor result on a new
  map is expected work, not a regression.
- **Rendering mode for `sketch_region`.** Drawn marks, a masked copy of the map, or both as
  user-selectable styles. See "Rendering modes for `sketch_region`" above. Not blocking — step
  3 works regardless — but worth deciding before step 5 wires masking to a specific renderer.
  Remember that the region is *under the fog*, so no mode can reveal the map by uncovering it;
  terrain has to be redrawn.
- **Does an `Image` item accept a `data:` URL?** Gates the canvas-composite route entirely, and
  is cheap to answer: build one local `Image` with a small `data:` URL and see whether it
  renders. Worth doing opportunistically, well before step 5 depends on the answer. The
  `?crop=` tile variant avoids the question but needs the CDN transform parameters to be
  reliable, which is its own untested assumption.
- **Can fog be revealed without mutating the GM's fog shapes?** Two five-minute tests, both in
  a scratch scene, and together they decide whether the fog route is viable at all — see
  "Editing the fog directly". First: does editing a fog shape change the walls Dynamic Fog
  derives from it? If yes, revealing an area would wall it off and the approach is dead.
  Second: does OBR composite *separate* fog items such that an extension-owned shape can cut a
  hole without touching the GM's originals? If yes, the fog route becomes the cheapest way to
  show real terrain and displaces most of the raster design.

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
3. Naive persistence: discovered region tracked, plain revealed areas, no sketch. The flat
   region wash (rendering mode 3) is what "plain revealed areas" means here — it needs nothing
   beyond what this step already tracks, and showing the tracked region and nothing else is
   exactly what is wanted for verifying it.
4. ~~Offline edge-trace → `Path` generation, run manually on one test map.~~ **Done
   2026-07-27** — and it is a *centerline* trace, not an edge trace; see §2. Judged on one real
   map through `trace.html`. Robustness across more maps is untested and deliberately deferred.
5. ~~Wire the two together with per-segment masking.~~ **Done 2026-07-28** — see "Placing the
   sketch". Rendering mode 1 (drawn marks), in debug red, verified in a room. The rendering-mode
   decision is settled *for this build* rather than closed: modes 2 and 3 remain available and
   nothing about step 5 forecloses them.
6. **Wobble, sepia, dash, fade — the pass that makes it look hand-drawn.** Wobble, curves,
   colour and stroke weight are **done 2026-07-28** and judged in a room; see "The hand-drawn
   pass". Dash was built, judged, and turned off. **Fade is deferred as a future feature** — see
   §7 for the reason and for what to measure when it is picked up.
