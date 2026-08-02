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

#### Not every light reveals — `lightType`, and the bug it caused (2026-08-02)

Found in a room by the user: three coherent room complexes nobody had entered were being cut out
of the parchment overlay, advertising that those rooms exist. The log named the cause immediately —
three `SECONDARY` lights against one `PRIMARY`.

**Dynamic Fog's light types are not decoration.** A `PRIMARY` light is a torch in a hand: it lights
an area and reveals it outright. A `SECONDARY` light is a brazier standing in a room — it lights
that room, but the party see it only where they can also *see into* the room. We were sweeping all
of them identically, so every brazier on the map behaved like a party member standing in the dark
holding a lamp.

**The consequences ran further than the overlay.** The same polygons feed the region accumulator, so
those rooms were being written into the persistent discovered region without anyone going there. And
because a fixed light never moves, its room is permanently "currently visible" — so
`discovered − currently_visible` excludes it forever, and the room could never be sketched even
after the party walked through it.

**The rule: a non-primary light contributes its lit area intersected with the party's line of
sight.** The user's framing, and the correction that matters — an earlier draft gated on whether the
*light source* was visible, which fails the ordinary case of a brazier behind a pillar in a hall you
are plainly looking into. It is the illuminated area that has to be visible, not the lamp.

**Line of sight is not the primary's lit polygon**, and that is the subtlety. Sight is not bounded by
your own lamp — you can see a lit hall from much further away than your torch reaches — so the
gating polygon has to be a sweep at map scale, bounded only by walls. That would be a second
expensive sweep per primary light, except that occlusion is radial: the nearest hit along a ray is
`min(wall, R)`, so clamping every vertex of the long sweep to a smaller `r` gives exactly the
polygon `r` would have produced. **One sweep yields both.** This document recorded that identity as
a spare part looking for a use; this is the use.

Two costs worth knowing. The sight sweep's radius defeats the distance pruning, so every ray tests
every wall in the scene — which is why it runs **only when a non-primary light is actually present**.
A scene of ordinary torches pays nothing. And a scene with several primaries produces overlapping
pieces where two of them see the same brazier, which the even-odd stencil turns back into filled
patches: mottle over ground the party can see. That is the harmless direction, and not worth a union
operation to avoid.

##### The clipper, and why it is fans rather than a general one

`geometry/starClip.ts`, pure and tested. General simple-polygon intersection means Greiner–Hormann
or a sweep line, both of which are notorious for breaking on degeneracies — vertices lying exactly
on edges, collinear overlaps — and visibility polygons are unusually rich in exactly those, because
their vertices sit on wall lines and shared ray directions. The hard cases would be the common ones.

A visibility polygon is **star-shaped about its own light**, which is what "visible from here"
means, so the triangle fan from the light to each boundary edge tiles it exactly. Intersecting two
polygons then reduces to intersecting pairs of *triangles*, and a triangle is convex — which puts
the whole computation on Sutherland–Hodgman, which is exact for a convex clip, a dozen lines, and
carries no degeneracy folklore. The result is a list of convex pieces rather than one polygon;
merging them would need the union operation being avoided, and every consumer here is content with
pieces.

**Soundness is the property, not precision** (user, 2026-08-02): "I can accept pretty low fidelity
of a polygon as long as there should be one. I can't accept punching a hole in the parchment at all
if there shouldn't be a hole, because that reveals the existence of a room." Fans give that by
construction — each triangle is inside its own polygon, and clipping to a convex region returns a
subset. Simplification preserves it too, since dropping vertices from a *convex* polygon can only
shrink it. Hence the inputs are simplified before clipping, which is also what makes the cost
bearable: the product of two vertex counts is millions of triangle pairs at the ~2,750 vertices a
raw polygon carries, and trivial at the few dozen a simplified one does. Primary polygons keep full
precision for their own contribution, since that boundary moves with the party and is looked at
directly.

One implementation note that cost a debugging round: `polygon.ts`'s `signedArea` uses the trapezoid
form, whose sign is the **opposite** of the standard shoelace. Normalising winding with it inverted
the inside test and every intersection came back empty. The clipper now derives which side is inside
from the clip polygon's own centroid, so it assumes no winding convention at all — which suits a
y-down world where "counter-clockwise" is not a safe thing to inherit.

##### Cone lights, closed at the same time

`innerAngle`/`outerAngle` were a recorded gap: every light was swept as a full circle, which
over-reports a cone — the same class of error as the `SECONDARY` bug, so it was fixed alongside.
The sweep restricts its candidate angles to the wedge and closes the polygon **through the apex**,
since a pie slice's boundary passes through its light where a full circle's must not.

`outerAngle` rather than `innerAngle`: inner is where falloff begins, so sweeping it would
under-report the dim fringe, and §4 records why under-reporting is the worse error.

**The convention is assumed, not verified** — cone centred on the light's rotation, `outerAngle` the
total width — in the same spirit as `FRONT_SIDE_SIGN`, because no cone light has been available to
test against. What makes that safe to ship is a property rather than a hope: **a cone of any facing
is a subset of the full circle**, so a wrong guess can only ever reveal less than the previous
behaviour did, never more. It cannot introduce a reveal that was not already happening. A test pins
that subset property across twelve facings.

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

~~**The reset is not confirmed**, because a confirmation needs `OBR.modal` or a context-menu
`embed`, and both want an HTML page.~~ **Superseded by the settings panel (2026-07-31)** — see
"The settings panel" below. Inside a panel the confirmation is a two-step button, so neither
`OBR.modal` nor a context-menu `embed` turned out to be needed. The three context-menu entries
still ship alongside it.

#### The settings panel — as built (2026-07-31), `panel.html` + `src/panel.ts`

The first real UI, and the home for the two controls a context menu cannot host.

**Surface.** A manifest `action`, which Owlbear renders as a button in the top left of a room and
opens as an iframe. Note the manifest field is **`popover`**, not `popover_url` — the obvious guess
by analogy with `background_url` is wrong, and a wrong manifest fails silently. `ActionApi` only
*manipulates* an action that the manifest already declared (`setIcon`, `setWidth`, badge, open and
close), which is what makes it clear the declaration has to be there. Distinct from
`ToolApi.createTool`, which builds an entry in the drawing-tool column and is what this project's
notes previously described.

**Plain TypeScript, not React** (2026-07-31, deliberately). DESIGN.md's stated stack names React and
this deviates: the panel is a handful of controls over shared metadata, the project already has a
hand-written HTML + TS page in `trace.html` that works well, and adding React means three
dependencies plus the lockfile regeneration ritual that CI has already caught once. Revisit if the
panel becomes stateful enough to want it.

##### The panel writes metadata and does nothing else

The panel is a **separate iframe** from the background page and shares no module state with it —
importing `tracker.ts` there would build a second, empty copy rather than reach the running one. So
every control writes shared metadata, and the effect arrives back through subscriptions the
background page already holds: `onSketchSettingsChange` for the map choice and the clear,
`onRegionChange` for the reset, `onAppearanceChange` for the look.

That is §5 working as designed rather than a workaround. Shared state is the interface, so a second
surface costs no new plumbing and behaves identically on the GM's client and on every player's.

**One race this exposed, now closed.** `clearDiscoveredRegion` cancels the tracker's pending region
write before clearing; a panel calling `clearRegion` directly cannot. A reset arriving while a token
was settling would therefore have been undone a moment later by the debounced write of the pre-reset
mask — and would have looked like a reset that silently failed. The tracker's `onRegionChange`
handler now cancels any pending write whenever it observes a clear, which covers both callers.

##### Appearance settings — room metadata, and one asymmetry

Colour, stroke width and wobble live in **room** metadata under a single key (`appearance.ts` /
`appearanceStore.ts`), per "Display options are GM-controlled and ride shared metadata" above. The
defaults are exactly the constants that shipped from step 6, which is load-bearing: a room whose
metadata has never been written must render as it did before the panel existed.

**The asymmetry that decides the wiring: colour and width are free, wobble is not.** Colour and
width are `PathStyle` fields on items that already exist, so changing them is a redraw. Wobble is
baked into the geometry at trace time — §6 requires the displacement to be a pure function of world
position, computed once — so changing it means tracing the map again. `invalidatesTrace` carries the
distinction, and a caller that collapses it gets one of two bugs: a full re-trace on every nudge of a
colour picker, or a wobble toggle that appears dead until the scene reloads.

##### Wobble is an amplitude, not a switch (2026-07-31)

It shipped as a boolean and lasted about an hour. Toggling it made no perceptible difference (user),
and the arithmetic says why: the amplitude judged in a room on 2026-07-28 is **0.02 of a grid square
— three world units** on a 150-unit grid, against strokes 12.5 units wide. The line moved by less
than its own width. That is the same three-unit figure that let wobble be ruled out as the cause of
the off-centre strokes earlier the same day, which should have been the clue.

**A switch between two states nobody can distinguish is not a control**, and the answer is a range
rather than a better default: zero is off, and the ceiling is a quarter of a grid square (the user's
choice). The stored field is therefore a magnitude, `wobbleSquares`, with the old boolean migrated —
`false` to zero, `true` to the shipped amplitude — so a room that had deliberately turned wobble off
does not silently turn it back on.

Two things about the top of that range, worth knowing before treating it as a bug:

- **At 0.25 the pen strays 37.5 world units, more than the ~30-unit width of the wall linework**, so
  strokes visibly leave their walls — a larger displacement than the placement drift diagnosed and
  fixed the same day. It is a different *kind* of error, which is why the ceiling is acceptable: the
  placement bug was a systematic slide in one direction that grew down the map, where this is a
  smooth field varying with position, so it reads as a hand rather than as misalignment.
- **The wavelength is 0.35 squares**, so amplitudes approaching that stop reading as a wobble and
  start rearranging the drawing. ~~If the settings that look good turn out to live up there, the
  next thing to expose is the wavelength.~~ **Exposed the same day** — see below.

The default is deliberately unchanged. If a value in the new range proves better by eye, that is a
change to `DEFAULT_APPEARANCE`, and it changes what every existing table sees on its next reload.

##### The period, and why the subdivision step had to follow it

Amplitude is how far the line moves, period is how often — short is a tremor, long is a slow bow,
and together they are most of what separates "shaky" from "drawn by hand". Range 0.1 to 1.5 grid
squares, default the shipped 0.35.

**Exposing it forced a constant to become derived, and that is the interesting part.** `wobble.ts`
is two octaves: a slow bow at the wavelength and a finer tremor at a *third* of it. The subdivision
step — how finely a straight run is cut up before being bent — was a fixed 0.06 squares. At the
default wavelength the fine octave is 0.117 squares, so the step gives **two samples per fine
cycle: exactly the sampling limit, already.** Holding it fixed while the period shortened would have
undersampled the tremor, and an undersampled smooth field does not look like a smaller wobble — it
looks like white noise, which is precisely the artifact `valueNoise`'s interpolation exists to
prevent.

So the step is now a fraction of the wavelength, written as `0.06 / 0.35` rather than a rounded
figure, so the default reproduces the validated step exactly and the change is invisible at the
setting that was judged in a room. A test pins that.

**The cost is point count**, which is what the 8192-command item budget is spent on. Points scale
inversely with the step, so at the 0.1-square floor the sketch carries ~3.5× the points it does at
the default, and at 1.5 squares about a fifth. Measured against ~19k points and a handful of items,
the floor is affordable; that is what sets it, not the aesthetics.

One trap worth noting: a wavelength of zero makes `fbm` return zero and silently disables the
wobble *however high the amplitude* — a control appearing dead because a different control is at its
floor. The minimum is well above zero, and a test pins the consequence rather than only the bound.

Three smaller things, each a real defect caught before it shipped:

- **Continuous controls must debounce their writes.** A colour picker and a slider fire `input` on
  every pixel of travel, and writes are rate-limited (`RateLimitHit`, see "Storage limits"). The
  panel coalesces to one write per pause, the same reasoning as the region's debounce — avoiding an
  enforced limiter, not politeness.
- **Echoes must not fight the user's thumb.** `onAppearanceChange` also fires for the panel's own
  writes, so adopting one mid-drag yanks the slider back. Updates from the store are ignored while a
  write is queued.
- **Stroke width is stored as a fraction but reasoned about as `1/N`,** and a larger `N` is a
  *finer* line — so using the denominator as the slider's value makes dragging right thin the
  stroke. The slider carries a thickness rank and the panel flips between the two scales.

##### Mark whole map explored

The inverse of the reset, and it exists for **judging the sketch rather than for play**. A trace can
only be assessed where the party has walked, so tuning the look otherwise means exploring a map
first, and anywhere never walked is never seen — which is a poor way to evaluate the one thing this
project is actually about.

Implemented as `fillMask` plus an ordinary `writeRegion`, so it travels the same path as a region
the GM walked: every client's tracker unions it in through `onRegionChange`. It is cheap to store
for the reason "Storage limits" gives — encoded size scales with the region's *perimeter*, and a
solid rectangle is the best case there is.

Two things it is not. It does not reveal Owlbear's fog, which this extension does not control (see
"Rendering modes"), so the map itself stays hidden and only the sketch appears. And it does not show
sketch where the party can *currently* see, because `sketch_region = discovered − currently_visible`
still applies — on a scene with a token carrying a light, the area around it stays bare by design.

The grid spans the MAP-layer images' bounds, so "the whole map" means the map's own extent. That is
also the limit of what the region can ever record, which is worth remembering: anything outside the
map image is never discovered, walked or not.

##### Pencil texture — multiple faint passes (2026-08-01)

A second route to "hand-drawn", alongside the wobble: draw each stroke several times, faintly, along
slightly different paths. They cross and diverge, darkening where they coincide and fraying where
they do not, which is what reads as graphite rather than ink.

**Why not vary width or opacity along a stroke, which was the obvious idea.** `PathStyle` is per
*item* — one `strokeWidth`, one `strokeOpacity` for a whole `Path` however many subpaths it holds,
and there is no per-command styling. Varying either along a stroke therefore means cutting it into
pieces and bucketing them by style, which quantises a continuous quantity; the user's judgment was
that the eye would find the steps at every bucket boundary, and that is almost certainly right.
Passes sidestep it: each pass is uniform, so it is expressible, and the variation comes from where
the passes fall relative to one another rather than from any one of them changing.

The other two options considered are recorded in case they are wanted:

- **A nib** — width as a function of stroke direction — needs the geometry to carry the width, i.e.
  emitting a filled *outline* rather than a stroked centerline. That is the only honest way to do it
  and it is a bigger job. `fillRule: "nonzero"` would absorb the self-intersections that offsetting
  a polyline produces on tight curves.
- **An SkSL `Effect`** is a poor fit. It shades a rectangular region, not a stroke, so texturing only
  our linework would mean sampling the rendered scene from `POST_PROCESS` — the approach already
  rejected under "Rejected alternatives" for coupling to how the fog happens to look.

**Three parameters, all in the panel:** passes (1–4, one is off), pass opacity, and scatter (0 is
off). Defaults are one opaque pass with no scatter, so the shipped look is unchanged until a slider
moves.

Four things worth not re-deriving:

- **A pass reuses `wobbleSegments`, and shares the wobble's wavelength and step.** Not laziness —
  it inherits three properties that are awkward to get right: shared points stay shared (the vector
  field argument in "The hand-drawn pass" applies unchanged, and a `chop.ts` cut would otherwise
  open a gap in every pass), the texture is static rather than crawling (§6), and the noise stays
  correctly sampled. That last one is the trap: a *finer* scatter period would need its own finer
  subdivision step or it would alias into white noise, which is the exact artifact `valueNoise`'s
  interpolation exists to prevent.
- **Masking runs once, on the base segments, and every pass is selected by index.** Masking each
  pass on its own midpoint would let them wink in and out independently at the region boundary, so
  the texture would shimmer as tokens moved — precisely where the eye already is. Hence
  `SketchSelection.indices`.
- **Passes are built at trace time, not render time.** A pass is a displacement of the whole
  polyline, the same cost as the wobble; doing it per redraw would pay it several times a second
  during a drag.
- **Opacity compounds, and the panel says so.** Three passes at 50% read as 87.5%, not 50%, so
  raising the pass count darkens the sketch unless the per-pass opacity comes down. Without showing
  the stacked figure the two controls look like they are fighting each other. `effectiveOpacity`
  exists for that readout alone.

Cost is linear in passes: four passes is four times the path commands and four times the items,
against ~19k points and a handful of items today. That is what sets the ceiling at four — beyond
three or four, additional passes fall on ground already covered.

##### Judged in a room (2026-08-01): the ranges are right, the effect is not

The user tried it against a real map. The controls behave and the ranges are appropriate — "it can
get something pretty good" — but **the overlapping strokes themselves do not look good**, and the
verdict was "might be better than nothing". Likely to stay off.

Worth understanding why, because it is structural rather than a tuning failure. **Real graphite
varies *within* a stroke** — the tooth of the paper takes ink unevenly along a single mark. Multiple
offset copies vary *between* strokes instead, which reads as gestural underdrawing: the look of a
sketch still being worked out, not of a finished line drawn in pencil. That is a legitimate
aesthetic and quite wrong for a map meant to look like a careful record.

So this joins the dash and the wash: built, judged, kept, and left off by default. Nothing needs
removing — `pencilPasses: 1` is the default, so the shipped look is unaffected and the controls are
there for anyone who wants that style.

**It also sharpens the case for the SDF renderer below.** The thing multi-pass cannot do is exactly
the thing a shader can: vary the ink *along and across a single stroke*. If within-stroke texture is
what actually reads as pencil, that is the only route to it that this SDK allows.

##### What the map picker fixes

Listing every MAP-layer image with its size, lock state and visibility, and letting the GM pick, is
what closes the hole recorded above: **a context menu needs an item selected, and a scene map is
normally locked**, so the nomination was unreachable in exactly the scene that needed it. A panel
needs no selection.

`listMapImages` is deliberately *not* `resolveSketchMap`. The resolver refuses when a scene is
ambiguous, because guessing risks tracing a GM overlay onto a player's screen; the panel shows
everything and lets a human choose, which is safe precisely because a human is reading the names.
The area filter's verdict is carried as a label ("too small to be a map?") rather than as a rule —
it is a heuristic, and the GM is not.

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

#### Strokes drift off the wall down the map — diagnosed and fixed (2026-07-31)

Observed by the user on "Lair Of The Lamb": sketch strokes follow the wall linework but sit
toward one side of it rather than centred. **The trace was never at fault.** The cause was the
placement transform applying the width's scale to both axes, and the fix is per-axis scaling plus
a half-pixel centring correction, both in `sketch/placement.ts`.

The diagnosis is worth keeping in full, because nearly every step of the first attempt was wrong
in an instructive way.

##### What it turned out to be

The map's world bounds are **not a uniform scaling of its pixels**: 3.1137 world units per source
pixel across against 3.1041 down, a 0.275% discrepancy — the signature of a map nudged slightly
out of proportion to line its art up with the scene grid. `createPlacement` derived one scale from
the width and applied it to both axes, so that discrepancy became a y error growing from zero at
the map's top edge to **+21.7 world units** at the bottom, against wall linework about 30 units
wide. Strokes left the walls they were traced from, low, and worse the further down the map.

A second, smaller error compounded it: traced coordinates name pixel *centres* while `bounds.min`
is the raster's outer *corner*, so every stroke also sat half a pixel — 5 world units — up and
left. Both trace modes share that convention (the skeleton walk emits pixel indices; marching
squares samples at pixel centres and keys crossings to the same lattice), so the `+0.5` is
unconditional.

The two partly cancelled near the top of the map and reinforced each other lower down, which is
why the artifact read as "off centre" rather than "sliding".

##### Why the guard did not catch it

`MAX_ASPECT_MISMATCH` was set at 1% to absorb rounding in the raster height, and it did. But its
*consequence* under a single scale is a displacement, and nobody converted: **1% of 791 raster
rows is 7.9 pixels, or 79 world units** — more than two wall widths. A tolerance stated as a ratio
was silently licensing a drift measured in world units.

Per-axis scaling makes the mismatch harmless for an unrotated image, and also absorbs the raster
height's rounding exactly (791 rows standing in for 791.27), which a width-derived scale cannot.
So the guard is now purely a rotation detector, and is documented as one.

##### Two candidates that were recorded here and were both wrong

This section previously blamed the binariser, on the strength of the sides varying per wall.
Measured in the harness against the real map, both are dead:

- **"Sauvola hollows out a wide uniform band."** It predicts two skeleton lines per wall; measured,
  106 of 113 horizontal wall crossings yield exactly **one**. A hollowed band would also pull the
  mask's centroid off the ink, and that offset measures −0.05 px. The premise was wrong too: this
  map's walls are ~3 px in the traced raster, against a Sauvola window of 25 px, so there was never
  a wide uniform interior to hollow.
- **"The map's ink is genuinely asymmetric."** Same measurement, both axes, essentially zero.

**The trace is correct in raster space.** The skeleton sits on the wall's dark core with a *median
offset of exactly zero*, and traced points land 0.41 px from the skeleton on average, 1.61 px at
worst. What remains is a consistent −0.25 px thinning bias — the even-width artifact, where a band
with no true centre row keeps one of the two middle ones. That is ~2.5 world units and is left
alone.

##### The lessons, which are the reusable part

- **The harness cannot see this class of bug, and that is structural.** It works entirely in pixel
  space and has no world mapping, so a placement error is invisible in it *by construction*. The
  artifact was diagnosed only once the harness and the room were compared and found to disagree in
  *direction* — the harness showed strokes high, Owlbear showed them low. Where those two disagree,
  the fault is in the stage the harness does not run. (`traceHarness.ts` had the same half-pixel
  convention error in its own drawing, now fixed, so it agreed with the bug and would have
  disagreed with the fix.)
- **"Not consistently the same side" was a misreading, and it sent the diagnosis to the wrong
  file.** The offset was in fact strongly directional; it looked random because it *grows down the
  map* and because x and y misbehave differently — x is exact by construction, so vertical walls
  showed only the constant half-pixel while horizontal walls showed the growing drift. The user's
  own correction ("on a horizontal wall it seems to always be low") is what reopened it.
- **A wall's width is not `strokeWidthPx`.** The reasoning that dismissed the half-pixel as too
  small measured it against a 42.5-unit band, but that figure is the *mask* width, and the mask
  over-extends the visible dark core by roughly 0.8 px per side. The wall a human sees is ~3.0 px
  ≈ 30 world units. Dismissing a small error requires the right denominator, and this one was
  inflated by a third.
- **The diagnostic that settled it is now permanent.** `mapImage.ts` logs the placement geometry
  and the implied y drift at the map's bottom edge on every trace, unconditionally — not gated on
  a threshold, because a diagnostic that only fires when something is known to be wrong cannot
  distinguish "fine" from "never ran".

##### What to check if it recurs

Read the `sketch: placement origin …` line. `units/px x` and `y` should be near-identical, and
`y drift at the map's bottom edge` should be near zero. A large value means the map is out of
proportion in a way the per-axis scale should have absorbed, which would point at the bounds
rather than the placement — most likely rotation, which is still unhandled.

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

##### The multiplier is a per-scene setting (2026-08-02)

`MARGIN_STROKE_WIDTHS` is now a default rather than a constant: the Setup tab carries a slider from
0 to 3, defaulting to the judged 1.5. **Per scene, not per room**, because the right value is a
property of the map — how heavy its linework is relative to what the estimator reports, and how much
space its rooms have around them. A room-wide value would be wrong for every scene but the one it
was tuned on.

**This is the pragmatic answer to both cautions above**, neither of which a better constant could
fix. The estimator and the multiplier are entangled, so a GM can compensate for a map where the
measurement misbehaves without anyone touching the estimator; and on a tight map the margin can be
wound down — or off — in exchange for patchier wall linework, which is the right trade when the
alternative is showing a room across a thin wall. It does not *solve* either problem. The
occlusion-gating remedy above is still the real fix for the spoiler case, and this does not remove
the reason to build it.

**The stored value is the multiplier, not a distance**, so the per-map adaptation survives: the same
setting yields a wider margin on a map drawn with a heavier pen, which is the whole reason the
margin is measured from ink rather than from the grid.

Three things worth not re-deriving:

- **Zero has to short-circuit.** A zero multiplier makes the ink term zero, and the fallback below
  it reads a zero ink term as "the ink could not be measured" and answers with a grid-derived
  margin. Without an explicit early return, the off end of the control quietly produces a margin on
  every scene whose grid is set — and it would read as the control doing nothing. A test pins it.
- **The fallback scales with the setting too**, expressed as a ratio against the default so that at
  the default it is exactly the 0.1 grid squares that shipped. Otherwise the control appears dead on
  precisely the traces where the ink was unmeasurable.
- **It is a redraw, not a re-trace, and that took a small change to earn.** The margin used to be
  computed at trace time with only the result kept. The trace record now holds the *inputs* — the
  measured ink width, the dpi and the map extent, all properties of the map — and the multiplier is
  applied at render time. Baking the two together would have cost a few hundred milliseconds of
  re-tracing on every nudge of the slider. The tracker routes a margin change to a redraw and a map
  or enabled change to a re-trace, the same split the appearance subscription makes.

The validator lives in `wallMargin.ts` rather than beside the other scene settings, for two reasons:
it belongs next to the bounds it clamps against, and the scene-settings module imports the SDK,
which would make the rule untestable headlessly — the layering constraint this project keeps
rediscovering.

**Erasing the scene's data clears it; clearing the sketch does not.** Removing the sketch is a
judgment about whether to draw at all, and discarding a GM's tuning as a side effect of a button
about something else would be a small, annoying surprise.

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
the filled-region inflation described above, since this map's walls are solid.

*Refined 2026-07-31, while diagnosing the placement bug below.* Filled regions are not the whole
story: the mask itself runs **~0.8 px wider per side than the visible dark core**, measured at
4.6 px against 3.0 px on this map. So `strokeWidthPx` describes the *mask*, and the wall a human
sees is nearer **30 world units than 42.5**. That does not change the conclusion — if anything it
strengthens it, since the inflation now has two independent sources — but it does mean the true
denominator is smaller than this section assumed, so any error being weighed against "a 42-unit
band" is a third larger in proportion than it looks. That mistake is what kept the half-pixel
placement error dismissed for a session. The margin lands
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

  - ~~**Canvas composite → `Image` item.**~~ **Dead as of 2026-08-01** — `data:` URLs do not
    render, and the only remaining delivery mechanism is asset upload, which is far too heavy for
    per-move updates. See "Raster rendering is not available". The rest of this section is kept
    because the reasoning about masking granularity still applies to any future raster idea, but
    nothing in it is currently buildable.
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

### Raster rendering is not available — measured 2026-08-01

Prompted by the wish for a pencil texture and variable stroke width, which vectors are genuinely
bad at: could the sketch be a raster with an alpha channel, computed once and then revealed and
hidden live? Two probes were written to answer it (`debug/dataUrlProbe.ts`, `debug/blendProbe.ts`).
The answer is no, and the reasons are worth keeping because they close several designs at once.

**`data:` URLs do not render.** Reproduced across three runs:

```
32px  (0.3KB)   added OK   -> draws Owlbear's broken-image placeholder
64px  (21.6KB)  REJECTED   -> refused by the scene outright
```

Two separate failures, and the second is the fatal one. There is a hard length ceiling somewhere
between 0.3KB and 21.6KB — and *even the payload that was accepted does not load*. A 1.37MB
attempt behaved differently again: `addItems` neither resolved nor rejected, it simply never
returned, so a payload that large appears to break the message bus before validation runs.

**Consequence: the only way to get pixels into the scene is `buildImageUpload`**, which pushes into
the room's asset storage. That is networked, slow, and leaves the GM's asset library full of our
debris — acceptable once per map, impossible for anything that updates as tokens move. So:

- The **canvas-composite** variant of rendering mode 2 is dead.
- The **tiles-plus-edge-masking hybrid** is dead with it, since its straddling ring needs exactly
  this mechanism.
- A **raster sketch** is dead for the same reason.

The CDN-cropped tile variant survives on its own terms, since it uses `?crop=` on URLs the CDN
already serves — but it was independently rejected for revealing whole tiles of map the party never
saw, so nothing changes.

**`Image` has no styling either**, which is worth stating alongside: checked against the SDK types,
an `Image` carries only the base `Item` fields — `visible`, `position`, `scale`, `zIndex`. No
opacity, no tint, no blend mode, no clipping. So even if pixels *could* be delivered, revealing them
gradually would have no primitive to build on.

### Shaders CAN texture the sketch — via an invisible stencil (2026-08-01)

The most consequential result of the session, and it took nine cells to reach because the first four
were read as closing a door that is in fact open.

Nine `Path` cells on `CONTROL`, each over a cyan patch on `POINTER` so "cut away" could be told from
"painted black" at a glance:

```
A  filled rect, no effect                        solid            paths render
B  filled rect + STANDALONE SRC_OVER stripes     light stripes    the shader runs
C  filled rect + STANDALONE DST_IN               BLACK gaps       blend did not reach the rect
D  filled rect + ATTACHMENT DST_IN               BLACK gaps       nor did attaching help
E  stroked line + ATTACHMENT SRC_OVER            NOTHING          clipped away entirely
F  stroked line + STANDALONE SRC_OVER            whole cell       unattached effects are unclipped
G  filled quad  + ATTACHMENT SRC_OVER            inside the quad  clipped to the parent's fill
H  INVISIBLE quad + ATTACHMENT SRC_OVER          inside the quad  clip needs no visible fill
I  filled quad  + ATTACHMENT DST_IN              BLACK bands      erosion still unavailable
```

**Two rules come out of this:**

1. **An attached `Effect` is clipped to its parent's fill region**, and only its fill — E draws
   nothing because a stroked centerline has no fill to clip to, while F, the same line unattached,
   paints its whole rectangle.
2. **The clip does not require the fill to be visible.** H's parent has `fillOpacity: 0` and the
   effect still draws inside it, with its own alpha respected — white where the shader is opaque,
   *transparent* where it is not.

**So the parent can be a stencil rather than a drawing.** Emit each stroke as a closed, invisible
outline whose only job is to bound where ink may go, attach a procedural SkSL effect, and let the
shader paint the entire visible mark. Everything the raster idea was wanted for follows: grain,
mottling, soft ends, and width that varies continuously along a stroke — at any zoom, still vector,
no raster, no `data:` URL.

**Erosion turns out to be unnecessary rather than merely unavailable.** `DST_IN` fails in C, D and I
alike, but a shader that controls its own alpha inside the clip does not need to subtract from
anything: where it wants nothing, it returns nothing, and H shows that reads as transparent.

**`fillOpacity: 0`, not `visible: false`.** Attachment behaviours include `VISIBLE`, so hiding the
parent outright would very likely take the effect with it. An invisible *fill* on a visible item is
the distinction that makes this work, and it is easy to "tidy up" into a bug.

Two things this still does not give. The shader cannot sample a texture — `Uniform.value` admits
only `number | Vector2 | Vector3 | Matrix`, so every pattern must be computed, which rules out
scanned graphite or an authored brush but leaves noise, fBm and hatching. And the *silhouette* is
the stencil's, so the outline geometry has to be right; the shader shades within it but cannot
extend past it.

#### Better still: the shader can draw the stroke itself (cell J, 2026-08-01)

The stencil above is superseded almost immediately, by a question from the user that exposed a
mistake in it: **a clipped shader cannot soften the stencil's edge, because it has no idea where
that edge is.** The clip is applied by the compositor after the shader runs, and no uniform carries
the parent's geometry. So a stencil gives a hard silhouette and the outline has to be exactly right.

The inversion works far better. Pass the stroke's *geometry* to the shader as uniforms and let it
draw the mark, with no parent at all — `STANDALONE` effects respect their own alpha (bars B and F),
so it paints where it wants and returns nothing elsewhere. And now it *can* soften its edges,
because it knows where they are.

**Cell J proved all four unknowns at once**, with four points passed as uniforms and a signed
distance field over three segments:

- **Custom uniforms work** — seven of them, `Vector2` and `float`.
- **Constant-bound `for` loops compile.**
- **An SDF gives genuinely soft edges and continuous taper** along a single mark.
- **It rasterises at display resolution.** Zoomed hard in, the soft edge stays smooth and never
  resolves into pixels (user, 2026-08-01). Nothing is stored as a bitmap: the shader is a *rule*
  re-evaluated per screen pixel at the current zoom, exactly as a `Path` is re-rasterised. This is
  the fact the whole approach rests on, so it was checked rather than assumed.
- **World mapping is stable under pan and zoom**, with no swimming and no crawling texture. Done by
  normalising `coord` against the built-in `size` and interpolating across a world rect passed in,
  so it holds however those are scaled — `model`/`modelView` were not needed. This was the decisive
  one: §6 rejects time-seeded wobble for making the map appear to breathe, and a view-seeded texture
  would be worse.

So the sketch could become a few dozen `Effect` items carrying segment endpoints, with soft edges,
taper and grain for free, no `Path` items, no stencil, and no nib geometry.

#### Build plan: a `shader` renderer alongside the existing one

Written 2026-08-01 to be executed later, so it assumes no memory of the conversation that produced
it. **The governing principle is that the existing renderer is untouched**: new files, a setting to
choose between them, and each clears the other's items when switching. Nothing here is a
replacement until it has been judged better in a room.

##### How it draws, in one paragraph

Today we hand Owlbear a shape and it decides the pixels. An `Effect` inverts that: we hand it a
world-space rectangle and a per-pixel program, and pass the stroke geometry in as numeric uniforms.
For each pixel the program converts its position to world coordinates, measures the distance to the
nearest line piece, and turns that distance into ink — solid near the centreline, fading over a
narrow band, transparent beyond. Everything wanted follows from that last step being ours: soft
edges, width varying along a stroke, and grain *within* a single mark, which is the one thing the
multi-pass pencil could not do. One effect carries a *batch* of pieces and takes the minimum
distance across them, so strokes inside a batch merge seamlessly.

##### Decisions already made, and why

- **Fixed batch size, with unused slots padded.** The program declares N slots; which geometry
  occupies a slot is a uniform. To hide a stroke, park its slot far outside the batch's bounds so
  its distance never wins the minimum. **This is what keeps the SkSL source constant.** The
  alternative — generating source containing only the visible pieces — would recompile a shader
  every time a token moves, which is almost certainly fatal. Park the sentinel about ten times the
  batch span outside its bounds: guaranteed to lose, and it keeps the squared terms in the distance
  maths far from the edge of float range.
- **Individually-named uniforms with an unrolled loop**, generated as a string. Whether the SDK
  supports uniform *arrays* is untested, and `Uniform.value` admits only a single number, vector or
  matrix. Generating `p0a, p0b, … p63a, p63b` and unrolling sidesteps the question entirely, and a
  fixed batch size means one source compiled once.
- **Empty slots still cost.** Every pixel runs the whole loop regardless of occupancy, so a batch
  holding four pieces costs what a full one does. Keep batches reasonably full, and do not choose a
  batch size far above typical occupancy.
- **Masking is unchanged.** `mask.ts` still decides visibility per segment, midpoint plus wall
  margin, against `discovered` minus `currently_visible`. Only what is *built* from the result
  changes: uniform sets instead of path commands.
- **v1 consumes the same wobbled geometry as the current renderer**, so the two are comparable and
  the plan stays decoupled from the unproven domain-warping idea below.

##### Phase 0 — measure, before building anything

The batch size decides everything downstream, and it is unknown. Re-install a probe in the style of
`debug/blendProbe.ts` (retired but kept) and answer, in order:

1. **Max uniforms per effect.** Ladder 16, 32, 64, 128, 256 named `float2`s. Find where it refuses
   or hangs — and distinguish those two, as `dataUrlProbe.ts` had to.
2. **Per-pixel cost** at the largest workable batch, over a rectangle around ten grid squares
   across. Pan while watching for frame-rate loss.
3. **Batch seam.** Two adjacent batches with a stroke crossing the boundary. Strokes in different
   effects composite as separate items, so two soft edges may darken where they meet. Is it visible?

**Then compute the item count** at current geometry: ~19k points after wobble subdivision means
~17k line pieces, so at 64 per batch that is **~270 effects, against ~3 `Path` items today**.

**Decision point.** If that count looks heavy, promote domain warping into v1 rather than deferring
it — see below; it changes the figure by more than tenfold. If the workable batch size is under
about 32, stop and reconsider the whole approach.

Record the numbers in this document either way. Already answered, and not worth re-testing: the
shader rasterises at display resolution and stays smooth at any zoom, and world mapping is stable
under pan and zoom.

##### Phase 0 — MEASURED 2026-08-01, and no ceiling was found

Run by `debug/uniformProbe.ts` (kept, not installed) on the Lair Of The Lamb map. All three
questions answered, and the stop condition is nowhere near.

**1. Max uniforms per effect: not reached.** Every rung of 16/32/64/128/256 was accepted, and the
top rung — **256 slots, 517 uniforms** — drew a complete, regular lattice of 256 separate ticks.
Nothing was rejected and nothing hung. The plan's "stop if the workable batch is under 32" does not
bite by an order of magnitude.

The lattice is what makes this a real answer rather than a hopeful one. The first run drew each rung
as a *serpentine* and every rung above 16 came back as a solid brown slab, because the rows were
packed closer than a stroke is wide. **A slab proves the shader compiled and says nothing about
whether the individual slots are right** — a shader mangling slots above 64 would paint the same
slab. Redrawn as separate ticks, the 256 cell showed 13 full rows of 19 plus a **partial row of 9**,
which is exactly the predicted layout. Every slot distinct and in its place.

Same shape of mistake as the earlier probe cells whose parent filled the effect's whole rect: a
diagnostic that saturates cannot report what it was built to report.

**2. Per-pixel cost: no frame-rate loss** panning and zooming over one 64-slot effect spanning ten
grid squares (user, 2026-08-01). **This measures one effect, not the whole sketch** — the full
render is 100+ effects and that cost is not established until phase 2 draws it.

**3. Batch seam: none visible.** A stroke split across two abutting effects is indistinguishable from
the same stroke in one. Caution for anyone re-running it: the probe's own cyan cell outline runs
along the join and reads as a seam artefact at a glance (user's observation). It is not one.

**4. Padding works** — the mechanism the whole renderer rests on, drawn for the first time. 64 slots
with 6 occupied gives six clean marks and no stray ink. Not on the plan's list; added because a
sentinel that leaked would be catastrophic and untestable headlessly.

**Edges read as soft** (user, 2026-08-01), which is the judgment the approach exists for.

**Item count, from this map's real numbers rather than the estimate above.** 2003 segments and 9644
points after wobble means **~7.6k pieces**, not the ~17k guessed — so at 64 per batch that is about
**120 effects, not 270**. Against ~3 `Path` items today.

**So the batch size should NOT be the maximum, and this is the non-obvious part.** Bigger batches
mean fewer items but *more total shading work*: every pixel runs the whole unrolled chain, so
doubling the slot count roughly doubles both the chain length and the area each batch covers — about
4× the work per batch against half as many batches, i.e. roughly double overall. The uniform ceiling
turns out not to be the binding constraint; per-pixel cost is. **Pick the smallest batch size whose
item count is acceptable**, which is why v1 ships 64 rather than the 256 that was proven to work.
`sdf.ts` takes it as a parameter, so this is one constant to revisit once phase 2 has real numbers.

##### Batch size, measured in a room 2026-08-01 — the prediction above held

Phase 2 rendered, and the shader look was judged good (user: "Soft (shader) looks good and pan and
zoom are fine"). Then the batch size was tested against panning:

```
256 slots,  ~30 effects   UNUSABLY choppy at every reasonable zoom, still better zoomed in
 64 slots, ~120 effects   usable; choppy only with the whole map on screen, smooth zoomed in
 32 slots, ~240 effects   better again; NOT distinguishable from 64 by eye
```

**Shipping 32, and 32-vs-64 is deliberately left unresolved** (user, 2026-08-01: "that feels better
again, I'm not sure how it compares to 64 — let's make a note that this could be optimized but leave
it for now"). The by-eye comparison has bottomed out: the difference between adjacent settings is now
smaller than the judgment can resolve, so **further tuning of this constant needs a frame-time
measurement rather than another opinion.** Do not run more eye tests on it; they cannot answer.

**Per-pixel cost dominates, and the arithmetic above predicted the magnitude.** 4× the slots gave
roughly 4× the shading and made it unusable. Item count is emphatically not the thing to optimise.

**A wrong turn worth recording, because the evidence genuinely looked like it pointed the other
way.** The zoom dependence at 64 — choppy zoomed out, smooth zoomed in — was read as proof that
*per-item* overhead dominates, on the argument that per-pixel cost is zoom-invariant: zoomed out
every effect is on screen and the rectangles tile the map to about one viewport, while zoomed in a
quarter as many are on screen but each covers four times the screen area, so the shaded-pixel total
should be about equal. That reasoning is sound as far as it goes, and it inverted the conclusion to
"take the largest batch". The room demolished it in one test.

What the argument missed is that both costs are real and they are not comparable in size. A fixed
per-effect cost does exist — it is exactly why zooming in helps at a *constant* slot count — but it
is far smaller than the per-pixel term, so a zoom comparison at fixed batch size can reveal the
minor term while saying nothing about the major one. **A comparison that holds the dominant variable
constant cannot rank it against the one being varied.** Same shape as the earlier probe cells that
changed two things at once, in a subtler dress.

**The second cost term is overdraw**, and it is worth naming separately because it responds to a
different fix. An effect shades its entire rectangle, and traced linework is sparse, so most of every
box is empty pixels running the full chain for nothing. Smaller batches shrink the boxes *and* the
chain, which is why moving down helps twice over. Tightening the batching so boxes hug their
geometry attacks the same term without costing more items, and is the next lever if the slot count
bottoms out.

##### Brushes — charcoal, built and judged good 2026-08-01

The shader renderer's aesthetic layer. "Brush" in the drawing-app sense, so a nib pen and a pencil
will sit under it comfortably when they arrive. Two ship: **liner**, the clean soft-edged mark the
renderer already had, named rather than left implicit so that choosing Brushes cannot lose the
appearance already judged; and **charcoal**, which adds procedural grain.

**The governing constraint is that there are no textures.** The standard way to draw charcoal — or
any of these — is to stamp a scanned grain bitmap along the path, and `Uniform.value` admits only
numbers, vectors and matrices. Everything must be computed. That suits charcoal well, because
granularity genuinely *is* what the medium looks like rather than a texture standing in for it. It
will suit a nib pen well too, being purely geometric. It suits a wet ink brush least, since that
medium's character comes from bristle separation and pigment pooling, which are normally authored —
worth saying before that one is attempted.

**Charcoal is two noise fields, and only one of them is optional:**

1. **Displace the alpha threshold** by fBm, so the *silhouette* breaks up — the mark skips the way a
   stick does over paper.
2. **Multiply density** by a second, decorrelated field, so ink sits unevenly inside it.

Doing only (2) gives a clean-edged shape with a dirty middle, which reads as a textured sticker
rather than a drawn mark. Both fields are keyed to **world** position, never to `coord`: §6 forbids
a texture that moves with the view, and a test pins it.

**Cost: the noise runs once per pixel, *after* the unrolled distance chain, never inside it.** Inside
it would be paid `batchSize` times. Two fBm octaves rather than the usual four or five, chosen for
cost — octave count is the first lever if grain ever gets expensive. A test slices the generated
source between the distance seed and the alpha ramp and asserts no `fbm2` call appears there.

**Judged in a room and tuned by eye** (user, 2026-08-01): edge 50%, grain size 0.09 squares, grain
60%, tooth 85% — now the defaults, and pinned by a test. Note which way the tuning went: grain
coarser than first guessed, at roughly the width of the stroke itself (which ships at a twelfth of a
square) rather than far below it.

**Performance held.** Panning is fine at every zoom with the whole map discovered. The redraw after
a token moves is noticeably slower — which is the *rebuild*, not the shading, exactly the
distinction recorded under the batch size measurements, and the thing phase 5's incremental updates
would fix. Accepted as fine for now.

**Each brush stores its own settings** (`Appearance.brushes`, a record keyed by brush). Tuning
charcoal must not disturb the liner, so switching back and forth compares two tuned looks rather
than one tuned and one trampled. Colour, stroke width, wobble and period stay **shared**: wobble
necessarily, since it is baked into the traced geometry both renderers consume, and the other two by
judgment — they describe the mark whatever draws it.

The panel says **"Color", not "Ink"**, since charcoal is not ink and a label naming one medium reads
as wrong under any brush that is not that medium. The stored key remains `strokeColor`; renaming it
would lose the colour of every room that has written one.

###### Colour is shared, and there is now evidence it should not be

`strokeColor` is one value for every brush, decided when brushes were introduced on the judgment
that colour describes the mark whatever draws it. Tuning since then points the other way: the ink
brush was judged good specifically **in black** (2026-08-02), while charcoal and the liner were
judged in the shipped sepia. So comparing brushes now means re-picking the colour by hand each time,
and no brush's judged look can be stored in full.

Moving `strokeColor` into `BrushSettings` would fix it, at the cost of a migration — seed every
brush from the existing top-level value, exactly as `featherFraction` was seeded onto the liner —
and of a GM having to set the colour more than once when they *do* want it uniform. **Not done.**
Recorded so the next person deciding does not have to rediscover the evidence.

##### Brushes — ink and nib, built 2026-08-01, UNJUDGED

Both needed the same new capability, which is why they were built together: **width that varies
along a mark**. A nib's width comes from the direction of travel, an ink brush's from position along
the stroke, and once either exists the other is a different formula over the same machinery.

**The width is computed on the CPU, not in the shader** (`sketch/brushWidths.ts`, pure and tested).
Per-pixel cost is what limits this renderer and it is paid *per slot*, so anything decided here
costs a few thousand operations once at trace time instead of millions per frame. The shader's whole
share is one `mix` and one subtraction per slot — the smallest addition that expresses varying width
at all. It also puts the parts that get judged by eye somewhere a test can hold them.

**The distance function becomes a round cone**: `length(pa - ba*h) - mix(r.x, r.y, h)`, reusing the
projection parameter `h` that measuring distance already computes. This is the cheap approximation,
not the exact varying-radius field — the true one accounts for the slope of the radius change. The
error scales with how fast the radius moves along one piece, and pieces here are short (cut for
masking, then subdivided again by the wobble), so it is not visible. Exactness would cost several
operations in the hottest loop in the project.

**The alpha ramp was unified to a signed distance thresholded at zero.** Constant-width brushes now
subtract `halfWidth` once after the chain instead of comparing against it inside `smoothstep`. That
is algebraically identical — both reduce to `(d - halfWidth + e) / 2e` — so the judged liner and
charcoal are unchanged, and it lets one ramp serve both shapes.

**Grain and varying width are independent features, not four hard-coded brushes.** `brushFeatures`
is the single place that says what a brush needs, and both `sdfSource` and `buildUniforms` read it.
That matters because a disagreement between them fails *silently in both directions*: an undeclared
uniform is ignored, a declared one never supplied leaves the effect drawing nothing, and neither
throws. A test asserts the two sets are equal for every brush.

**Taper forced a pipeline change, and it is the interesting part.** `chop.ts` cuts contours into
segments so masking can work per segment, which destroys the notion of a stroke — and an ink brush
must taper at the ends of the *original contour*, not at every masking cut, or a wall reads as a row
of dashes. So the cut now records what it destroys: `SegmentProvenance` carries the contour index,
the piece's arc-length span within it, and whether the contour was closed. Every later stage rewrites
points, and each was rebuilding the segment literally and silently dropping the new field, so
`reshapeSegment` now owns that rebuild.

**Closed contours are never tapered.** A loop has no ends, so a taper would put a thin patch at
whatever arbitrary point the tracer began walking it — a defect that would *move* if the tracer
changed, which is the worst kind to debug.

Two smaller decisions worth not re-deriving:

- **The nib uses `|sin|`, not `sin`.** A nib is an edge, so a stroke and its reverse are the same
  thickness — and the tracer's walk direction is arbitrary, so a signed response would make width
  depend on which way the skeleton happened to be walked.
- **Tangents use central differences.** At a masking cut the two copies of a shared point see
  different neighbours and can differ slightly in width. That is the same shape of problem
  `wobble.ts` documents for normals but far milder: there the two copies moved to different
  *places* and visibly tore the stroke apart, here the point stays put and only its width differs,
  by a fraction of a percent on geometry the wobble has already subdivided.

**Judged: the nib is good (2026-08-01), and the ink brush is good after rework (2026-08-02)** — the
expectation above held on the first attempt, and the fix was structural rather than tuning.

Ink ships at edge 45%, entry 130%, pressure 75%, lift 25%, tail 45%. Note the judged look pairs
those with a **black** stroke colour rather than the shipped sepia — and colour is *shared* across
brushes, so that cannot be encoded as a brush default. See "Colour is shared" below.

##### The ink profile is asymmetric, and never reaches zero

The first ink brush tapered symmetrically to nothing at both ends, and the user's verdict named the
real defect: *"they all taper to zero width at the beginning and end, which makes the junctions look
odd."*

**That is structural, not cosmetic.** A traced skeleton is a **network**. `chopContours` walks it
into chains between junctions, so the great majority of contour ends are *junctions where other
contours carry on* — not free ends where a hand lifted. A profile that vanishes at both ends
therefore punches a pinch-hole at every place walls meet on the map. The symmetric taper was
modelling a lone brushstroke on blank paper, which is not what the geometry is.

The profile is now three things, and the shape of it matters:

- **Entry blob.** The stroke starts *wider* than full width and settles quickly. A brush lands
  before it travels, and this asymmetry is most of what separates it from a felt tip.
- **Pressure wander** through the middle, unchanged.
- **Lift**, thinning over the last stretch to `tailWidth` — **a fraction of full weight, never
  zero**. The stroke lightens without breaking the network.

Entry is given its *own*, shorter span (`ENTRY_SPAN_SHARE`, half the lift's) because a brush lands
faster than it leaves; sharing one span reads as a bulge with a stroke attached rather than as a
stroke that began heavy.

**`MIN_TAIL_WIDTH` lives in the validator, not just in the slider's range.** Keeping the floor in
`fromRoomMetadata` means a stale or hand-written metadata value cannot reintroduce the pinch either.

Still true, and worth keeping in view: a wet brush's character comes from bristle separation and
pigment pooling, which are normally authored as texture — and no texture can reach the shader. What
is here is a width profile, not a brush engine.

##### The parchment overlay — built and judged 2026-08-02

Mottled tone over everything the party cannot currently see, so the screen reads as a hand-drawn map
on parchment with a hole cut where they are standing. **The fog supplies the colour**; the shader
only varies it, which is why the tint is a small adjustment at low alpha rather than a parchment
colour in its own right.

**The stencil is a rectangle with holes, at full polygon precision.** A `Path` carries a `fillRule`,
so the overlay is one path: the map's extent as the outer ring, each visible polygon as an inner
ring, `evenodd`, `fillOpacity: 0`. The obvious alternative was the region's cell grid, and it would
have been wrong — its cells are tens of world units across, and §3 is explicit that the *visible*
boundary is the one that moves with the party and gets looked at directly. A clipped shader cannot
soften its own edge, so the outline's precision is the only lever there is.

**The holes are simplified, and must be.** One visibility polygon runs to ~2,750 vertices, and this
path **cannot be chunked**: split the extent into tiles and each tile would still fill wherever
another's hole overlapped it, because even-odd counts crossings across the whole path. So the
tolerance rises until the command budget is met, which always converges.

##### The holes are one unioned outline, not one ring per polygon (2026-08-02)

Punching each visible polygon as its own inner ring works only while those rings are **disjoint**,
and once lights stopped being interchangeable they no longer were. Two failures, both found in a
room, and each patch for one bought the other:

- **Overlapping holes fill back in.** Even-odd counts crossings, so a point inside the extent and
  two holes has three and is filled. A torch standing in a brazier-lit room overlaps that brazier's
  lit area, so the overlap turned back into parchment.
- **Abutting holes show their seams.** Clipping a lit area to line of sight produced a fan of small
  pieces sharing radial edges, and those rasterised as dotted lines running outward from each light.

Both are properties of the representation, not of the geometry. So `region/visibleShape.ts` unions
the visible polygons in a **bitmap** — where overlap is meaningless, since marking a cell twice is
marking it once, and there are no internal edges to show — and then traces the result back out with
the marching-squares tracer the trace pipeline already owns. One outline, no seams, no overlap. A
pillar standing in a lit room falls out for free as an inner ring, which even-odd fills correctly;
the piecewise version would have made a mess of it.

**Tracing back to vectors rather than emitting cells is what keeps it smooth.** Marching squares on
a binary mask already chamfers corners at 45° rather than stepping at 90°, and Douglas–Peucker then
cuts across what remains, so the outline is ordinary linework at any zoom rather than visible
stair-steps.

**Every stage shrinks, and that is the entire safety argument** (user, 2026-08-02: "I can't accept
punching a hole in the parchment at all if there shouldn't be a hole, because that reveals the
existence of a room"). Rasterising samples cell centres; eroding drops any cell with an unset
neighbour, pulling the boundary a full cell inside; and simplification may cut a corner outward but
by at most its tolerance, which is held below the erosion distance. **The erosion is not optional
and exists solely to pay for the simplifier** — Douglas–Peucker cutting across a concave bend moves
the boundary outward, and outward next to a wall means into the room beyond it. Smoothing a raster
without eroding first reintroduces exactly the failure being prevented.

The cost is that the visible region sits a cell inside the truth — about four world units against a
150-unit grid square on the test map, invisible next to the mottle it is cutting.

**The sketch mask still gets the polygons at full precision.** Only the overlay, which needs rings
rather than point tests, pays the quantisation — which keeps the §3 decision that the *visible*
boundary is the one that moves with the party and gets looked at directly.

**A testing lesson worth keeping, because the first version of the test could not fail.** Soundness
was checked by asserting every ring *vertex* lay inside the source polygon — and Douglas–Peucker
returns a subset of the vertices it was given, so those are inside by construction whatever the
tolerance. A deliberately over-large tolerance sailed through. The failure is the **chord between**
two kept vertices bowing outward, so the test now samples along every edge. The fixture had to
change too: an L-shape's single reflex corner is so deep that the simplifier keeps it at any sane
tolerance, so the pinning fixture is a finely scalloped gear whose shallow teeth an over-large
tolerance flattens. Same shape as every other too-tidy fixture recorded here.

###### Two SDK facts this cost three rounds to find, both about attached effects

1. **An attached `Effect` covers its parent's fill region — its own `width`, `height` and `position`
   do not confine it.** Five diagnostic bands, each sized to a fifth of the map, all painted over
   the whole map. **Corollary: attached effects cannot be tiled for performance.** One per stencil.
2. **An `ATTACHMENT` effect is handed built-ins describing its parent, and generic uniform names
   collide with them silently.** `scale` and `opacity` — two names the shader used — made it render
   solid black. No error, no warning, no blank: black. Every custom uniform is now prefixed `pm`,
   and a test pins the *prefix* rather than the two known-bad names, since the collision set is
   undocumented and the next one will be some other ordinary word. The sketch's shaders never hit
   this because they are `STANDALONE` and have no parent.

**A diagnostic lesson worth keeping, because it is the inverse of the usual one.** Round two split
the suspect shader into thirds across the map, expecting to see which ingredient failed. That could
not work: a shader that fails to compile fails *entirely*, so all three thirds went black together
and the split reported nothing. **A diagnostic must be able to produce a partial result, or it
cannot localise anything** — bisecting a compile failure needs separate programs, not one program
divided by geometry. Same shape as the probe ladder whose rungs saturated into a solid slab.

**Judged and tuned in a room**: strength 16%, blotch size 1.5 grid squares, variation 60%, over a
dark sepia tint. Blotches wanted to be **four to five times coarser** than first guessed — 1.5
squares against 0.33 — the same direction charcoal's grain went. Procedural texture keeps wanting to
be coarser than it looks like it should.

**The tint must be dark, and that was the first thing to get wrong.** This shipped with a light
cream, on the reasoning that parchment is a pale material. But the overlay *mottles* the fog rather
than replacing it, so a light tint fights the darkness instead of varying it. The right hue differs
by map (user, 2026-08-02), so the shipped `#4A3520` is a starting point rather than a judged value —
but "dark" is not the negotiable part.

**Strength is the mean alpha, not the peak, and that was a fix rather than the original design.** The
mottle began as `opacity × mix(1 - variation, 1, m)`, which made opacity the *peak*: since the noise
averages about a half, raising variation deepened the texture *and* lightened the sheet, so the two
controls fought. Centring the swing on the mean — `clamp(opacity × (1 + variation × (m - 0.5) × 2))`
— decouples them. It is not a neutral change (the spread roughly doubles for the same numbers), so
the default was re-based on the mean the judged settings actually produced.

##### Parked: making the shader renderer faster

Deliberately not pursued (user, 2026-08-01). It is usable at 32 and the look is judged good; this is
a list of what to reach for if it ever needs to be quicker, roughly in expected value order.

- **Tighten the batch bounding boxes.** The largest known waste. `batchPieces` buckets on a uniform
  world grid, so a bucket holding a few pieces scattered across its cell still gets a box spanning
  the whole cell, every pixel of which runs the full chain. Splitting a bucket by *tightness* rather
  than only by count — or subdividing any box whose ink covers little of its area — cuts shading
  without adding a single item. It also does not touch the shader, so it cannot regress the look.
- **Domain warping** (already written up below). Passing the simplified ~1.3k-point polyline instead
  of the subdivided ~7.6k-piece one is roughly a fifteenfold reduction in pieces, which shrinks both
  the item count and every bounding box. The largest single win available, and the least certain —
  it changes the geometry the shader sees, so the look has to be re-judged.
- **Phase 5, incremental updates.** Note this attacks a *different* axis and would not help panning
  at all: it removes the rebuild-everything cost when a token moves, not the per-frame shading cost.
  Worth knowing which symptom is which — choppy panning is shading, a stutter on token movement is
  the rebuild.

**Measure before choosing.** The by-eye method is exhausted at this resolution, and all three of
these are much larger changes than moving one constant.

**Domain warping stays deferred.** The decision point above says promote it if the item count looks
heavy; at ~120 effects it does not, and the plan's reason for deferring — keeping v1 comparable to
the existing renderer by eye — still holds.

##### Phase 1 — `src/sketch/sdf.ts` (pure: no SDK, no DOM, unit-tested)

- `toPieces(segments)` — flatten each `TracedSegment` polyline into point pairs.
- `batchPieces(pieces, batchSize)` — group **spatially**, since each effect shades its whole
  rectangle and a batch of scattered pieces wastes most of it. A uniform world grid keyed on each
  piece's midpoint is enough; bucket, then split any bucket over `batchSize`.
- `batchBounds(batch, halfWidth, feather)` — world bounding box **expanded by half-width plus
  feather**, or strokes clip at the batch edge.
- `buildUniforms(batch, bounds, appearance, batchSize)` — always returns exactly `batchSize` slots,
  padding with the sentinel described above.
- `sdfSource(batchSize)` — generate the SkSL once. Map `coord` to world by normalising against the
  built-in `size` and interpolating across a world rect passed as uniforms; this is what makes it
  stable under zoom, and `model`/`modelView` are not needed.

**Tests:** flattening preserves order and yields `points − 1` pieces per segment; every piece lands
in exactly one batch; no batch exceeds `batchSize`; bounds contain every piece plus the margin;
padded slots fall outside the bounds; the uniform list length is always exactly `batchSize`.

##### Phase 2 — `src/sketch/shaderStrokes.ts` (the SDK half)

Mirror `strokes.ts` deliberately: `renderShaderStrokes(segments, dpi, appearance)` and
`clearShaderStrokes()`. Same layer `CONTROL`, `locked`, `disableHit`, local items, `STANDALONE`,
`SRC_OVER`, no parent — and **its own metadata key**, so the two renderers can find and clear their
own items independently.

##### Phase 3 — the switch

- `appearance.ts`: add `renderer: "strokes" | "shader"`, defaulting to `"strokes"` — **moved to
  `"shader"` on 2026-08-01 once it had been judged; see "Phase 4" below.** Include it in
  `differs` but **not** in `invalidatesTrace` — the geometry is identical, only the drawing changes.
- `sketch.ts` `renderSketch`: dispatch on it, and **clear both renderers' items before drawing**, or
  switching leaves the old sketch on screen underneath the new one.
- `panel.html` / `panel.ts`: a two-option control under Appearance.

##### Phase 4 — judged in a room 2026-08-01. It ships, and it is now the default.

Switch both ways and confirm nothing is left behind. Then tune the feather width and grain by eye,
which is the only part that decides whether this ships.

**Outcome: it ships.** The user ran it in a real room and judged the soft-edged look good, with pan
and zoom fine (at `BATCH_SIZE = 32`; see the batch size measurements above, which were the only
difficulty). `DEFAULT_APPEARANCE.renderer` moved to `"shader"` on their decision.

**The `Path` renderer is kept rather than removed**, and not out of sentiment: it is roughly two
orders of magnitude cheaper to draw — a handful of items against a couple of hundred effects — so it
remains the answer for a scene where the shader is slow, or a client that struggles with it. The
panel presents it as the fallback rather than as the previous version.

**The default change reaches existing rooms on purpose.** `fromRoomMetadata` falls back per field, so
a room whose stored appearance predates the `renderer` key takes the new default and switches to soft
edges on its next reload. A room that prefers the old look picks Lines, and that choice persists — a
test pins that an explicit `"strokes"` survives, since otherwise moving the default would amount to
removing the option.

**Feather ships as a slider** (`featherFraction`, 0–1 of the stroke's half-width, default 1/3) rather
than the constant this plan assumed, because it is the one control the shader route adds and the
value was picked by eye on a probe rather than measured. Grain is **not** implemented — the SDF
shader draws a clean soft-edged mark and no procedural texture was added, so the "grain" this plan
anticipated remains available and unexplored.

##### Phase 5 — incremental updates (deferred, but nearly free once padding exists)

Keep the batch *set* stable across redraws and vary only which slots are parked. A token moving
changes occupancy in a few nearby batches; every other batch keeps its item untouched — no adds, no
deletes, no recompilation, just a uniform write to the handful that changed. That would be **better
than the current renderer**, which rebuilds everything on every visibility change.

##### Deferred: domain warping

The wobble is a position-based displacement, so the shader could apply it by displacing the *sample
point* before measuring distance, rather than displacing the geometry. That would let the simplified
polyline (~1.3k points) be passed instead of the subdivided one (~19k) — roughly a fifteenfold
reduction in pieces, and therefore in items. It may also yield natural width variation for free,
since warping stretches and compresses apparent distance.

The open part is whether warped distances stay well-behaved enough to shade: the distortion scales
with the warp's *gradient*, roughly amplitude over wavelength, which at the upper end of the wobble
range is substantial. Worth a probe cell before committing.

##### Known limits, so they are not rediscovered

- The shader sees **only** what is passed as numbers — no textures, no images, and nothing about the
  map, the fog, the discovered region, or any stroke outside its own batch.
- Complexity is paid **per pixel per frame**, unlike a `Path` whose cost is in geometry and paid
  once.
- It is stateless and local: no previous frames, no sampling neighbours, no global view.
- An effect cannot alter what is beneath it — cells C, D and I settled that.
- Scene items rather than the local ones used in every probe cell remain untested.

**Note the shader route was never going to reach a texture image anyway.** `Uniform.value` admits
only `number | Vector2 | Vector3 | Matrix` — there is no shader or image uniform type, so a custom
texture cannot be passed to SkSL at all. Only `POST_PROCESS`'s built-in `scene` uniform samples
anything, and that route is already rejected under "Rejected alternatives" for coupling to how the
fog happens to look. Any shader texture would have to be computed procedurally.

**Where this leaves the aesthetic:** the sketch stays vector, and the levers are the ones already
built — wobble amplitude and period, the multi-pass pencil, stroke width and colour — plus
`strokeDash`, which is implemented and currently off. A calligraphic nib remains available and is
purely geometric: emit a filled *outline* whose half-width varies with stroke direction, rather than
a stroked centerline. That needs no capability the SDK lacks.

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

If the rendering modes above become user-selectable, the controls belong to the GM **by default** —
the sketch is a shared table aesthetic, not a per-player preference. (Amended 2026-08-02: the GM can
now hand the Appearance tab to players. That does not weaken the sentence above, it relies on it —
see "Letting players change the look" below.) That raises the obvious question of how a GM's choice
reaches player clients that render independently, and the answer is that it needs no new machinery:
it is the same shared-state mechanism §5 already uses.

- `OBR.player.getRole()` returns `"GM" | "PLAYER"` — gate the UI on it.
- `OBR.room.setMetadata()` writes the settings; `onMetadataChange()` fires on **every** client
  automatically. No broadcast to design, no handshake.
- A client joining mid-session reads `OBR.room.getMetadata()` at startup, so there is no
  late-joiner problem either.

Settings are tens of bytes and change only when the GM moves a control, so unlike the
discovered region this costs nothing in traffic.

**Use room metadata, not scene metadata.** A GM's aesthetic preference sensibly follows them
between scenes, whereas the discovered region is necessarily per-scene. ~~More practically, it
keeps settings out of the 16KB *scene* metadata budget that the discovered region is already the
main claimant on.~~ **That second argument is void** — no scene metadata limit was found below
512KB per key (see "Storage limits"), so there is no budget to stay out of. The first reason is
the whole reason. Per-scene overrides can be layered on later if, say, a snow map wants a
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

#### Letting players change the look (2026-08-02)

A GM switch — off by default — that shows players the Appearance tab. Setup and Debug stay GM-only:
between them they hold the map nomination, the explored-area reset and the two erase buttons, none
of which this was meant to hand over.

**It shares the settings rather than copying them, and that is the point rather than a limitation.**
A player who moves a slider restyles the sketch for the whole table. The user asked for exactly that
— an occasional "let someone have a play with it", not a per-seat preference — so the shared-state
argument above is what makes it work, not something it has to overcome. The genuinely *personal*
version is a different feature and still unbuilt; per-player metadata remains its natural home, and
the strongest case for it is the renderer, where a player's choice would be about their own hardware
rather than the table's taste.

**Concurrent editors are accepted, not arbitrated** (user, 2026-08-02: "it's ok if it doesn't deal
with multiple concurrent changes very elegantly, as long as nothing breaks"). Two properties already
in place are what make that safe rather than merely tolerable: appearance writes are
read-modify-write over a shallow merge, so two people on *different* controls compose instead of
clobbering; and a write rejected by the rate limiter already reports itself in the panel's status
line rather than failing silently. Two people on the *same* control means last write wins, which is
the accepted inelegance. Nothing locks, and nothing needs to.

**The switch is not a permission boundary and could never be one.** Any client can write room
metadata — the `Permission` enum governs item operations and says nothing about metadata — so this
hides a tab rather than closing a door. It is the social control it appears to be. That is also why
the *flag itself* is safe to keep in the same shared record: the shallow merge means a player saving
a colour preserves it by construction rather than by a rule someone has to remember, and a test pins
that.

Three things it would have been easy to get wrong:

- **It must fail closed.** Anything that is not exactly `true` reads as off, and a room written
  before the field existed reads as off. Wrongly denying costs a GM one click; wrongly granting
  changes a table's look under a GM who never offered it. Note this is the opposite intent from the
  `renderer` default, which was moved *specifically* to reach existing rooms.
- **It changes no geometry and no pixels**, so it is deliberately absent from both `differs` and
  `invalidatesTrace`. Both are explicit field lists, so the omission is achieved by not adding it —
  which is exactly what a later hand would undo out of tidiness, hence a test and a comment at the
  point where the mistake would be made. In it, every client would rebuild the whole sketch because
  a GM toggled a permission.
- **Revocation has to reach an open panel.** The appearance subscription already fires on every
  client, so withdrawing access folds a player's controls away mid-session. Without that, "I turned
  it off and they kept changing things" is a real report. The check deliberately sits outside the
  routine that repaints the controls, because that one skips its work while a write is pending so a
  slider is not yanked mid-drag — and suppressing a *revocation* on those grounds would be precisely
  backwards, since a player mid-drag is the player whose access has just been withdrawn.

The controls are wired for every client and only their visibility varies. Installing them lazily on
the first grant would leave a player who is handed the tab mid-session looking at live-seeming
sliders that do nothing until they reopen the panel; listeners on hidden controls cost nothing, and
that bug would not be free.

**Wobble and period are left enabled for players**, knowingly. They are the only controls where
ganging up costs other people work rather than surprise: both are baked into the geometry, so
dragging either re-traces the map on *every* client. One person doing that is the cost today; three
at once means every machine at the table re-traces repeatedly. It is a stutter rather than a break,
and the alternative — a second, restricted version of the tab — is a permanent maintenance cost
against a problem that ends when people stop dragging.

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
- ~~**Does an `Image` item accept a `data:` URL?**~~ **Answered 2026-08-01: no.** See "Raster
  rendering is not available" below. This was the gate on the canvas-composite route and it is
  shut.
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
1. Scaffold a fresh Vite + ~~React +~~ TS extension against `@owlbear-rodeo/sdk`, building and
   loading in a real room. (**React was never added** — see "The settings panel", where the
   first real UI was built in plain TypeScript instead, and why.) Add the dev log shim and its Node receiver at the same time, plus
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
