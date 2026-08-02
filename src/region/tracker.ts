/**
 * Build order step 3 — naive persistence.
 *
 * Ties the pieces together: watch visibility, accumulate what has been seen into the
 * discovered region, persist it, and draw it.
 *
 * Two loops running at deliberately different rates:
 *
 * - **Accumulation** polls `getItemBounds` and samples by *distance moved* rather than on a
 *   timer. That is what makes a drag from one room through a corridor to another discover the
 *   corridor; committing only when the token stops would record the endpoints and miss
 *   everything between them.
 * - **Persistence** is debounced and GM-only. Writes are rate limited by Owlbear, so spacing
 *   them is a correctness measure rather than mere politeness.
 *
 * Accumulation deliberately does **not** ride on the visibility watcher's change events, and this
 * is the hard-won part. Owlbear delivers no item change during a drag and `getItems` reports the
 * pre-drag position throughout — but `getItemBounds` reflects the live interaction transform,
 * moving in 2–33 unit steps while the stored position sits still. So the watcher supplies walls
 * and light configuration, which really do arrive as events, while position comes from polling
 * bounds. See CLAUDE.md, "The corridor gap", before changing this.
 *
 * Player clients accumulate nothing. They compute visibility (they must, to render) but take
 * the discovered region from metadata — independent accumulation would diverge between clients
 * and be overwritten on every sync, which reads as flicker. See DESIGN.md §5.
 */

import OBR from "@owlbear-rodeo/sdk";

import { buildSceneGrid } from "./sceneGrid";
import { clearRegion, onRegionChange, readRegion, writeRegion } from "./store";
import {
  countSet,
  createMask,
  rasterizePolygon,
  unionInto,
  type RegionMask,
} from "./regionMask";
// `renderWash` is not imported: the wash is no longer drawn, see `render`. `clearWash` stays, so
// a client that had one on screen from an earlier build loses it on the next scene change.
import { clearWash } from "./wash";
import { clearParchment, renderParchment } from "./parchmentOverlay";
import {
  onSketchSettingsChange,
  readSketchSettings,
  type SketchSettings,
} from "../sketch/sketchSettings";
import {
  prepareSketch,
  renderSketch,
  resetSketch,
  setAppearance,
  setMarginStrokeWidths,
  sketchSegmentCount,
} from "../sketch/sketch";
import {
  DEFAULT_APPEARANCE,
  differs,
  invalidatesTrace,
  type Appearance,
} from "../sketch/appearance";
import { onAppearanceChange, readAppearance } from "../sketch/appearanceStore";
import { boundingBox } from "../geometry/polygon";
import {
  latestSnapshot,
  subscribeVisibility,
  type VisibilitySnapshot,
} from "../visibility/watch";
import { computeVisibilityPolygon } from "../visibility/visibility";
import { distance, type Vector2 } from "../geometry/vector";
import { devLog } from "../devlog";
import type { CellGrid } from "./cellGrid";

/**
 * Wait this long after movement stops before writing.
 *
 * Debounced against *movement*, not against gaining cells. Those differ during a slow drag: the
 * track flushes whenever no point has been recorded for a moment, so a leisurely drag produces a
 * run of small flushes, and debouncing on those wrote metadata five times in eleven seconds.
 * Writes are rate limited by Owlbear, and each one also re-renders the wash — main-page work
 * contending with the very round trips the poll depends on. Deferring while a token is still
 * moving collapses that to a single write once it settles.
 */
const PERSIST_DEBOUNCE_MS = 800;

/**
 * How often to ask the app where the lights actually are.
 *
 * Cheap on its own — a bounds read, no geometry — which is the point. Sweeps are triggered by
 * distance rather than by this tick, so raising the rate costs round trips and not sweeps.
 *
 * Measured at 100ms this was still the binding constraint on a fast drag: steps of 187–228 units
 * against a 150-unit reach, because a brisk flick covers more ground between readings than a
 * light can see. Round trips are the floor here, so the readings for all lights are issued in
 * parallel and the interval is set near what one round trip costs.
 */
const POLL_MS = 40;

/**
 * Record a light's position once it has moved this fraction of its own attenuation radius.
 *
 * Gaplessness is a property of the *distance* between consecutive samples, never of the time
 * between them: two samples overlap when they are closer together than the polygon is wide.
 */
const SAMPLE_FRACTION = 0.5;

/**
 * Once a light has been still this long, sweep the track it just laid down.
 *
 * Recording and sweeping are deliberately separated. Sweeping inline made sampling density a
 * function of sweep cost: a 100ms poll with 46–97ms sweeps and a re-entry guard produced real
 * samples 0.2–1.3s apart, and measured steps of 124, 98 and 95 units against a 90-unit polygon —
 * gaps, in precisely the case this whole mechanism exists to cover. Recording a position is one
 * cheap bounds read, so the track stays dense no matter how slow the geometry is, and the cost is
 * paid once the token is released. The discovered region therefore lags a drag by this much,
 * which is invisible in use and buys a track with no holes in it.
 */
const FLUSH_IDLE_MS = 250;

/**
 * Sweep the track early once it reaches this many points, rather than waiting for a release.
 *
 * Without a cap, a long drag across a big map would bank hundreds of samples and then stall on
 * them all at once. At the observed ~50ms per sweep this bounds a flush to a few seconds, and a
 * drag long enough to hit it gets its earlier stretch drawn while it is still going.
 */
const MAX_BUFFERED_SAMPLES = 48;

let grid: CellGrid | undefined;
let discovered: RegionMask | undefined;
let sceneDpi = 150;
let isGm = false;

/** Where each light was when it last contributed, so sampling can be distance-based. */
const lastSampled = new Map<string, Vector2>();

/** The most recent visible polygons, so a metadata-driven redraw subtracts the same area. */
let visiblePolygons: Vector2[][] = [];

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeVisibility: (() => void) | undefined;
let unsubscribeRegion: (() => void) | undefined;
let unsubscribeMapChoice: (() => void) | undefined;
let unsubscribeAppearance: (() => void) | undefined;
let rendering = false;

/** The look this client is currently drawing with — see the subscription in `initialiseForScene`. */
let appearance: Appearance = DEFAULT_APPEARANCE;

/** A redraw was requested while one was in flight, and must run once this one finishes. */
let renderAgain = false;

/**
 * The sketch settings this client last acted on, so a metadata change that leaves them alone
 * does not trigger a re-trace. `onSketchSettingsChange` rides `scene.onMetadataChange`, which
 * also fires for every region write this client makes — several a minute during play, against a
 * trace costing a few hundred milliseconds.
 */
let sketchSettings: SketchSettings | undefined;

/**
 * Guards the bounds reads against re-entry, so a slow round trip cannot queue ticks behind each
 * other. Cheap enough that this should rarely trip — unlike the sweeping it replaced.
 */
let polling = false;

/** Guards the sweep pass, which is long-running and yields partway through. */
let flushing = false;

/**
 * Whether the region has grown since it was last written. Kept separate from the timer so that
 * deferring a write during movement cannot lose one: the flag survives any number of
 * reschedules, and a failed write leaves it set so the next settle tries again.
 */
let regionDirty = false;

/** A recorded position, carrying when it was taken so sampling cadence can be measured. */
interface TrackPoint {
  at: Vector2;
  time: number;
}

/**
 * Positions recorded during a movement, per light, awaiting a sweep. Decimated by distance as
 * they arrive, so the length is bounded by ground covered rather than by how long a drag took.
 */
const trajectory = new Map<string, TrackPoint[]>();

/** When each light last laid down a point, so stillness can be detected. */
const lastRecordedAt = new Map<string, number>();

export async function installRegionTracker(): Promise<() => void> {
  isGm = (await OBR.player.getRole()) === "GM";

  await initialiseForScene();

  const unsubscribeReady = OBR.scene.onReadyChange((ready) => {
    if (ready) void initialiseForScene();
    else void teardownScene();
  });

  return () => {
    unsubscribeReady();
    void teardownScene();
  };
}

/**
 * Grids are per-scene: a different map means different bounds, and cells recorded against the
 * old grid address different ground. So everything is rebuilt when the scene changes.
 */
async function initialiseForScene(): Promise<void> {
  await teardownScene();

  if (!(await OBR.scene.isReady())) return;

  const sceneGrid = await buildSceneGrid();
  if (!sceneGrid) return;

  grid = sceneGrid;
  // Kept because the parchment overlay sizes its mottle and its simplification tolerance in grid
  // squares, and `render` has no other route to the scene's dpi. Read once per scene rather than
  // per redraw: it cannot change without the scene changing, and redraws run several a second.
  sceneDpi = (await OBR.scene.grid.getDpi()) || 150;
  discovered = (await readRegion(sceneGrid)) ?? createMask(sceneGrid);
  lastSampled.clear();
  visiblePolygons = [];

  devLog(
    "info",
    `region: tracking as ${isGm ? "GM (writer)" : "player (reader)"}, ` +
      `starting from ${countSet(discovered)} discovered cells`,
  );

  unsubscribeRegion = onRegionChange(sceneGrid, (incoming) => {
    if (!discovered || !grid) return;

    // The stored region went away — either cleared deliberately, or recorded against a grid this
    // scene no longer uses. Drop the local copy to match. Unioning cannot express a removal, so
    // without this a client would keep showing ground the scene no longer claims, and the GM
    // would write its stale copy straight back on the next move.
    if (!incoming) {
      // Any pending write belongs to the region just cleared. Without cancelling it, a clear
      // arriving while a token is settling would be undone a moment later by a debounced write of
      // the pre-clear mask — and the clear would appear to have silently failed. `clearDiscoveredRegion`
      // cancels its own timer, but a clear can now also arrive from the settings panel, which runs
      // in its own iframe and shares none of this module's state.
      if (persistTimer !== undefined) clearTimeout(persistTimer);
      persistTimer = undefined;
      regionDirty = false;

      discovered = createMask(grid);
      lastSampled.clear();
      trajectory.clear();
      lastRecordedAt.clear();
      void render();
      return;
    }

    // Union rather than replace. It is idempotent, so the GM seeing its own write echo back
    // costs nothing, and a player adopts the authoritative region without losing anything.
    if (unionInto(discovered, incoming) > 0) void render();
  });

  unsubscribeVisibility = subscribeVisibility(handleSnapshot);

  // Re-trace when the GM nominates a different map or toggles the sketch, on every client.
  // Gated on the settings actually changing: this subscription shares `scene.onMetadataChange`
  // with the region writes, which land several times a minute during play.
  sketchSettings = await readSketchSettings();
  setMarginStrokeWidths(sketchSettings.marginStrokeWidths);
  unsubscribeMapChoice = onSketchSettingsChange((settings) => {
    const retrace =
      settings.mapId !== sketchSettings?.mapId ||
      settings.enabled !== sketchSettings?.enabled;
    const marginChanged =
      settings.marginStrokeWidths !== sketchSettings?.marginStrokeWidths;
    if (!retrace && !marginChanged) return;

    sketchSettings = settings;
    if (retrace) {
      // A re-trace re-derives the margin anyway, so there is nothing to apply separately.
      void buildSketch();
      return;
    }
    // The same split the appearance subscription makes, for the same reason: the margin multiplies
    // numbers the trace already produced, so applying it is a redraw. Re-tracing on every nudge of
    // the slider would cost a few hundred milliseconds a time and make the control unusable.
    setMarginStrokeWidths(settings.marginStrokeWidths);
    void render();
  });

  // Appearance is shared through *room* metadata, so this runs on every client — the panel is
  // GM-only, but applying what the GM chose is everyone's job.
  //
  // The branch is the point. Colour and width are PathStyle on items that already exist, so they
  // need a redraw; wobble is baked into the geometry at trace time and needs the map tracing
  // again. Collapsing the two either burns a few hundred milliseconds every time a colour slider
  // moves, or leaves a wobble toggle doing nothing until the scene reloads.
  appearance = await readAppearance();
  setAppearance(appearance);
  unsubscribeAppearance = onAppearanceChange((next) => {
    if (!differs(appearance, next)) return;
    const retrace = invalidatesTrace(appearance, next);
    appearance = next;
    setAppearance(next);
    if (retrace) void buildSketch();
    else void render();
  });

  // Not awaited. Tracing is a few hundred milliseconds of synchronous work and the wash should
  // appear immediately; the strokes join it when the trace lands.
  void buildSketch();

  // Players read the region rather than accumulating it, so only the GM pays for polling.
  if (isGm) {
    pollTimer = setInterval(() => {
      void pollMotion();
    }, POLL_MS);
  }
}

/** Trace the scene's map, then draw whatever of it is already remembered. */
async function buildSketch(): Promise<void> {
  if (await prepareSketch()) await render();
}

async function teardownScene(): Promise<void> {
  unsubscribeVisibility?.();
  unsubscribeVisibility = undefined;
  unsubscribeRegion?.();
  unsubscribeRegion = undefined;
  unsubscribeMapChoice?.();
  unsubscribeMapChoice = undefined;
  unsubscribeAppearance?.();
  unsubscribeAppearance = undefined;
  sketchSettings = undefined;
  // A queued redraw belongs to the scene being torn down; letting it fire would repaint from
  // state the next scene is about to replace.
  renderAgain = false;

  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  regionDirty = false;

  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
  polling = false;
  flushing = false;
  trajectory.clear();
  lastRecordedAt.clear();

  grid = undefined;
  discovered = undefined;
  lastSampled.clear();
  visiblePolygons = [];

  await clearWash().catch(() => {});
  // The overlay's holes describe where the party was in the *previous* scene. Leaving it up would
  // paint the new one through a stencil cut for somewhere else.
  await clearParchment().catch(() => {});
  // A new scene is a new map: the cached trace addresses ground this scene does not have.
  await resetSketch();
}

/**
 * The watcher drives rendering only. Accumulation is not done here because the events that reach
 * this function do not fire during a drag — see the module header.
 */
function handleSnapshot(snapshot: VisibilitySnapshot): void {
  if (!grid || !discovered) return;

  visiblePolygons = snapshot.views.map((view) => view.polygon);
  void render();
}

/**
 * Record where each light is, and flush the track once it stops moving.
 *
 * Position comes from `getItemBounds` rather than the light item, because only the former tracks
 * a drag in progress. Everything else — which lights exist, their radius, the wall segments —
 * comes from the watcher's snapshot, since those genuinely do arrive as change events and are far
 * more expensive to recompute than to reuse.
 *
 * No geometry is computed here. That is the point: this must stay cheap enough to keep pace with
 * the poll, because the spacing of these readings is what decides whether the track has gaps.
 */
async function pollMotion(): Promise<void> {
  if (!grid || !discovered || !isGm || polling) return;

  const snapshot = latestSnapshot();
  if (!snapshot || snapshot.lights.length === 0) return;

  polling = true;
  try {
    // No `isReady` check here, deliberately. It is a round trip of its own, and at 40ms it was a
    // third of this poll's message traffic — spent re-asking a question already answered by the
    // `onReadyChange` subscription that starts and stops this timer in the first place. Round
    // trips are the binding constraint on sampling density, so this one is not affordable.

    // All readings issued together. Awaiting them one light at a time made a poll cost N round
    // trips, so the sampling interval degraded with the number of lights in the scene — and the
    // interval is exactly what decides whether a fast drag leaves holes.
    const positions = await Promise.all(
      snapshot.lights.map((light) => livePosition(light.id)),
    );
    const now = performance.now();

    for (const [index, light] of snapshot.lights.entries()) {
      const at = positions[index];
      if (!at) continue;

      const buffer = trajectory.get(light.id);

      // Measure from the last point recorded during this movement, falling back to where the
      // light was last swept from. Otherwise every reading in a drag would be compared against
      // the pre-drag position and the whole track would collapse to one point.
      const from = buffer?.[buffer.length - 1]?.at ?? lastSampled.get(light.id);
      const travelled = from ? distance(from, at) : Infinity;

      // Never record finer than a cell can represent, nor finer than half the light's own reach:
      // below that the sweeps would be redundant with each other.
      const threshold = Math.max(
        grid.cellSize,
        light.attenuationRadius * SAMPLE_FRACTION,
      );
      if (travelled < threshold) continue;

      const point: TrackPoint = { at: { ...at }, time: now };
      if (buffer) buffer.push(point);
      else trajectory.set(light.id, [point]);
      lastRecordedAt.set(light.id, now);

      // Movement observed, so push any pending write further out. This is what makes the write
      // wait for the token to settle rather than firing between the small flushes a slow drag
      // produces.
      if (regionDirty) schedulePersist();
    }

    const due = [...trajectory.entries()]
      .filter(
        ([id, points]) =>
          points.length >= MAX_BUFFERED_SAMPLES ||
          now - (lastRecordedAt.get(id) ?? now) >= FLUSH_IDLE_MS,
      )
      .map(([id]) => id);

    if (due.length > 0) void flushTracks(due);
  } catch (error) {
    devLog("error", "region: motion poll failed", error);
  } finally {
    polling = false;
  }
}

/**
 * Sweep every recorded position for the given lights and fold the results into the region.
 *
 * Yields between sweeps. This can run for a second or more, and the poll has to keep recording
 * throughout — a drag that resumes mid-flush must not punch a hole in its own track.
 */
async function flushTracks(lightIds: string[]): Promise<void> {
  if (flushing || !discovered) return;

  const snapshot = latestSnapshot();
  if (!snapshot) return;

  flushing = true;
  const startedAt = performance.now();
  try {
    const before = countSet(discovered);
    const notes: string[] = [];

    for (const lightId of lightIds) {
      const points = trajectory.get(lightId);
      trajectory.delete(lightId);
      lastRecordedAt.delete(lightId);
      if (!points || points.length === 0) continue;

      const light = snapshot.lights.find((candidate) => candidate.id === lightId);
      if (!light) continue;

      // **Primary only, and this is the second place the rule has to be applied.** The watcher
      // decides what is *currently* visible; this replays a light's recorded path so a drag
      // discovers the corridor it crossed rather than only its endpoints. Both write the region,
      // so a light type honoured in one and ignored in the other produces exactly the bug this
      // fixed: rooms lit by a fixture stopped being called visible, kept being called discovered,
      // and so began sketching themselves in the moment the suppression lifted (user, 2026-08-02).
      //
      // A fixture does not move, so it has no path worth replaying; what the party can see of one
      // arrives through the snapshot below.
      if (light.lightType !== "PRIMARY") continue;

      const cellsBefore = countSet(discovered);
      let longestStep = 0;
      let longestStepMs = 0;
      let previous = lastSampled.get(lightId);
      let previousTime: number | undefined;
      let lastPolygon: Vector2[] | undefined;

      for (const point of points) {
        if (previous) {
          const step = distance(previous, point.at);
          if (step > longestStep) {
            longestStep = step;
            // How long that step took to open up. This is what separates "the poll is starved"
            // from "the drag was genuinely that fast", and the two want opposite fixes.
            longestStepMs = previousTime === undefined ? 0 : point.time - previousTime;
          }
        }
        previous = point.at;
        previousTime = point.time;

        const polygon = computeVisibilityPolygon(point.at, snapshot.segments, {
          radius: light.attenuationRadius,
          // Cone honoured here too, for the same reason the type is: two sweeps that disagree
          // about a light's shape write two different regions.
          coneAngle: (light.outerAngle * Math.PI) / 180,
          facing: (light.rotation * Math.PI) / 180,
        });
        if (polygon.length >= 3) {
          rasterizePolygon(discovered, polygon);
          lastPolygon = polygon;
        }

        // Yield to the event loop, not merely to the microtask queue. `await Promise.resolve()`
        // does the latter, which never lets a `setTimeout` callback run — so the poll would stay
        // blocked for the whole flush, and a resumed drag would punch a hole in its own track.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (previous) lastSampled.set(lightId, { ...previous });

      // The longest step is the number that decides whether the track had holes in it: samples
      // overlap only while they stay closer together than the polygon is wide. Reported every
      // time, including when nothing was gained, so a silent failure cannot hide behind a
      // productive-looking log.
      const gained = countSet(discovered) - cellsBefore;
      notes.push(
        `light ${lightId.slice(0, 4)} swept ${points.length} points, ` +
          `longest step ${longestStep.toFixed(0)} over ${longestStepMs.toFixed(0)}ms ` +
          `vs reach ${(light.attenuationRadius * 2).toFixed(0)} ` +
          `-> +${gained} cells` +
          // A whole track marking nothing usually means the polygons fell outside the grid,
          // which covers only the MAP images. Say where they were rather than leaving a guess.
          (gained === 0 && lastPolygon ? ` [polygon ${describeReach(lastPolygon)}]` : ""),
      );
    }

    // What the party can see of a *fixture* — a brazier, anything the watcher admitted only where
    // line of sight reaches it — folded in from the snapshot rather than swept from a path.
    //
    // Without this, skipping non-primary lights above would swap one wrong answer for another:
    // walk through a lit hall and you would see all of it but remember only what your own torch
    // touched, leaving permanent blank patches in ground the party plainly explored. §4 is explicit
    // that under-reporting is the worse error, so the fix for over-reporting must not land there.
    //
    // These polygons are already correct — clipped to line of sight by the watcher — so they are
    // rasterised as they stand. A fixture does not move, so sampling only at flush time loses
    // nothing that lingering another moment will not recover.
    for (const view of snapshot.views) {
      if (view.light.lightType === "PRIMARY") continue;
      if (view.polygon.length >= 3) rasterizePolygon(discovered, view.polygon);
    }

    if (notes.length > 0) {
      devLog(
        "info",
        `region: ${notes.join("; ")} in ${(performance.now() - startedAt).toFixed(0)}ms`,
      );
    }

    if (countSet(discovered) > before) {
      regionDirty = true;
      schedulePersist();
      void render();
    }
  } catch (error) {
    devLog("error", "region: track flush failed", error);
  } finally {
    flushing = false;
  }
}

/**
 * Where a light is right now, including mid-drag.
 *
 * `getItemBounds` is the app computing geometry rather than a read of the item record, and only
 * it reflects an interaction in progress. Lights are local items, so the bounds must be read from
 * the local side; a light that has just been removed throws, which is ordinary rather than an
 * error worth reporting.
 */
async function livePosition(lightId: string): Promise<Vector2 | undefined> {
  try {
    const bounds = await OBR.scene.local.getItemBounds([lightId]);

    // An id that no longer exists yields a degenerate box rather than throwing, and its centre
    // comes back as NaN — observed in bursts across a scene change, where the watcher's snapshot
    // still names lights the local scene has already dropped. Recording that would put NaN into
    // the track and hand it to the rasteriser.
    if (!Number.isFinite(bounds.center.x) || !Number.isFinite(bounds.center.y)) {
      return undefined;
    }
    return bounds.center;
  } catch {
    return undefined;
  }
}

/**
 * Redraw the wash and the sketch.
 *
 * Overlapping calls coalesce rather than being dropped. Dropping is nearly harmless for the
 * wash — something moves a moment later and the next render corrects it — but the sketch is
 * drawn once when the trace finishes, and a trace landing while a render happened to be in
 * flight would leave a scene with no strokes until a token moved. That reads exactly like the
 * feature not working.
 */
async function render(): Promise<void> {
  if (!discovered) return;
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;

  try {
    // The wash (`renderWash`) is deliberately not drawn. It was step 3's stand-in for a renderer
    // that did not exist yet — a flat marker of where the party had been, useful precisely
    // because it showed the tracked region and nothing else. The sketch now draws that region
    // properly, and a translucent slab underneath only muddies it. `wash.ts` stays as DESIGN.md's
    // rendering mode 3 and as the way to see the raw region when tracking is in doubt.
    // Timed separately, and both halves reported, because this is the redraw that a token move
    // already made noticeably slower — so anything added here has to be attributable rather than
    // merely suspected. The parchment overlay is the new arrival; the sketch figure is the
    // baseline to read it against.
    const startedSketch = performance.now();
    const sketch = await renderSketch(discovered, visiblePolygons);
    const sketchMs = performance.now() - startedSketch;

    const parchment = await renderParchment(
      gridBounds(grid),
      visiblePolygons,
      appearance.parchment,
      sceneDpi,
    );

    devLog(
      "info",
      `region: ${countSet(discovered)} cells discovered` +
        (sketch === null
          ? ", no sketch traced"
          : `, sketch ${sketch.drawn}/${sketchSegmentCount()} segments ` +
            // Both halves of the wall margin. On a walled scene these are how its size gets
            // judged: all-zero means it is doing nothing, not that nothing needed doing.
            `(margin +${sketch.rescued}/-${sketch.suppressed})`) +
        ` in ${sketchMs.toFixed(0)}ms` +
        (parchment.drawn === 0
          ? "; parchment off"
          : `; parchment ${parchment.commands} commands, ` +
            `${parchment.tolerance.toFixed(1)}u tolerance, ` +
            `build ${parchment.buildMs.toFixed(0)}ms + commit ${parchment.commitMs.toFixed(0)}ms` +
            // Non-zero means the command budget forced a hole to be abandoned, which leaves
            // parchment over ground the party is looking at. Conspicuous, so never silent.
            (parchment.dropped > 0
              ? ` — ${parchment.dropped} CUT-OUT(S) DROPPED, parchment is covering lit ground`
              : "")),
    );
  } catch (error) {
    devLog("error", "region: wash render failed", error);
  } finally {
    rendering = false;
  }

  // Outside the guard, so a request that arrived mid-render is served against the current state
  // rather than the state this pass drew.
  if (renderAgain) {
    renderAgain = false;
    await render();
  }
}

/**
 * Where a polygon actually sits in world space, for diagnosing a sample that marks nothing.
 * The usual cause is the polygon falling outside the grid, which only covers the MAP images.
 */
/**
 * World bounds of the cell grid — the extent the parchment overlay covers.
 *
 * The MAP images' bounds, since that is what `buildSceneGrid` spans. Ground beyond the map is left
 * alone: there is no map out there for the overlay to be a drawing *of*, and the fog past the edge
 * is not something this extension has a claim on.
 */
function gridBounds(
  cells: CellGrid | undefined,
): { min: Vector2; max: Vector2 } | undefined {
  if (!cells) return undefined;
  return {
    min: { ...cells.origin },
    max: {
      x: cells.origin.x + cells.columns * cells.cellSize,
      y: cells.origin.y + cells.rows * cells.cellSize,
    },
  };
}

function describeReach(polygon: readonly Vector2[]): string {
  const bounds = boundingBox(polygon);
  return (
    `x ${bounds.min.x.toFixed(0)}..${bounds.max.x.toFixed(0)} ` +
    `y ${bounds.min.y.toFixed(0)}..${bounds.max.y.toFixed(0)}`
  );
}

function schedulePersist(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persist();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Forget everything discovered in this scene, in storage and in memory.
 *
 * GM only, because the GM owns the write. Clearing storage alone would not survive: the GM's
 * in-memory mask would be persisted again on the next move and every client would union the old
 * ground straight back. Players are cleared by the metadata change, handled in
 * `initialiseForScene`.
 *
 * A pending persist is cancelled rather than allowed to fire afterwards — it holds a snapshot
 * taken before the clear, and letting it land would undo this immediately.
 */
export async function clearDiscoveredRegion(): Promise<void> {
  if (!isGm) {
    devLog("warn", "region: only the GM can clear the discovered region");
    return;
  }
  if (!grid) return;

  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  regionDirty = false;

  discovered = createMask(grid);
  lastSampled.clear();
  trajectory.clear();
  lastRecordedAt.clear();

  await clearRegion();
  await render();
  devLog("info", "region: cleared");
}

async function persist(): Promise<void> {
  if (!discovered || !isGm || !regionDirty) return;

  const cells = countSet(discovered);
  const ok = await writeRegion(discovered);

  // Cleared only on success. A failed write leaves the region dirty so the next time a token
  // settles it is tried again, rather than the discovered ground being silently dropped.
  if (ok) regionDirty = false;

  devLog("info", `region: ${ok ? "persisted" : "FAILED to persist"} ${cells} cells`);
}
