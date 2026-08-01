/**
 * Build order step 5 — the traced map, masked by the discovered region, drawn into the fog.
 *
 * Two rates, and keeping them apart is the whole design:
 *
 * - **Tracing** happens once per scene. It is a few hundred milliseconds of synchronous work
 *   (DESIGN.md §2 measured 206ms at 1024×768, and cost grows with ink because thinning
 *   iterates), so it must never sit on the path of a token move.
 * - **Masking and drawing** happen on every visibility change. Both are cheap by construction:
 *   a cell lookup and a bounded polygon test per segment, then a delete-and-replace of a
 *   handful of items.
 *
 * The cached trace is keyed by map id *and* url, so replacing a scene's map art re-traces while
 * a token moving does not.
 */

import OBR from "@owlbear-rodeo/sdk";

import { DEFAULT_APPEARANCE, type Appearance } from "./appearance";
import { readAppearance } from "./appearanceStore";
import { loadMapRaster, resolveSketchMap } from "./mapImage";
import { selectSketchSegments } from "./mask";
import { readSketchSettings } from "./sketchSettings";
import { marginSource, wallMargin } from "./wallMargin";
import { clearStrokes, renderStrokes } from "./strokes";
import { clearShaderStrokes, renderShaderStrokes } from "./shaderStrokes";
import { pencilPasses } from "./pencil";
import { toWorldSegments } from "./placement";
import { traceOptionsFor, wobbleOptionsFor } from "./traceSettings";
import { wobbleSegments } from "./wobble";
import { traceImage } from "../trace/pipeline";
import { devLog } from "../devlog";
import type { RegionMask } from "../region/regionMask";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

interface TracedMap {
  readonly mapId: string;
  readonly url: string;
  /**
   * Already in world space, so rendering never repeats the transform.
   *
   * **The masking geometry**, and the only geometry masked. The pencil passes below are drawn from
   * the decisions made about these.
   */
  readonly segments: readonly TracedSegment[];
  /**
   * What is actually drawn: one entry per pencil pass, each index-aligned with `segments`.
   *
   * Built here rather than at render time because a pass is a displacement of the whole polyline —
   * the same cost as the wobble, and static for the same reason, so paying it per redraw would be
   * paying it several times a second during a drag. With the texture off this is `[segments]` and
   * costs nothing.
   */
  readonly passes: readonly (readonly TracedSegment[])[];
  readonly dpi: number;
  /** How far either side of a stroke counts as the same place — see `wallMargin.ts`. */
  readonly margin: number;
}

let traced: TracedMap | null = null;

/**
 * The GM's shared look, cached so a redraw does not cost a metadata round trip — redraws run on
 * every visibility change, which is several a second while a token moves.
 *
 * Seeded with the defaults rather than left unset, so a render arriving before the first read
 * draws the shipped look instead of nothing. `setAppearance` keeps it current; the tracker owns
 * deciding whether a change needs a re-trace or only a redraw (`invalidatesTrace`).
 */
let appearance: Appearance = DEFAULT_APPEARANCE;

/** Adopt a new look. Callers must re-render; whether they must also re-trace is their decision. */
export function setAppearance(next: Appearance): void {
  appearance = next;
}

/**
 * Guards against two traces overlapping. The scene becoming ready and a map choice arriving can
 * land together, and tracing twice would burn a second of main-thread time to reach the same
 * answer.
 */
let tracing = false;

/**
 * Trace the scene's map, replacing any previous result.
 *
 * @returns whether there is now something to draw. A `false` here is normal — an ambiguous
 * scene, a scene with no map — and the reason has already been logged by `resolveSketchMap`.
 */
export async function prepareSketch(): Promise<boolean> {
  if (tracing) return traced !== null;
  tracing = true;

  try {
    // Checked before anything expensive. Switched off means no trace at all, not a trace held
    // back from rendering — the point of the toggle is a scene whose map traces badly, and a
    // few hundred milliseconds spent producing linework nobody will see is the wrong shape of
    // "off".
    const { enabled } = await readSketchSettings();
    if (!enabled) {
      devLog("info", "sketch: switched off for this scene");
      await resetSketch();
      return false;
    }

    const map = await resolveSketchMap();
    if (!map) {
      traced = null;
      await clearBothRenderers();
      return false;
    }

    const raster = await loadMapRaster(map);
    if (!raster) {
      traced = null;
      await clearBothRenderers();
      return false;
    }

    const options = traceOptionsFor(raster.pixelsPerGrid);
    const result = traceImage(raster.pixels, options);
    const dpi = await OBR.scene.grid.getDpi();

    // Read here rather than trusting the cached copy: a trace may be the first thing this client
    // does, before any metadata change has been observed.
    appearance = await readAppearance();

    // Wobbled once, here, rather than per render. The displacement is a pure function of world
    // position (DESIGN.md §6 — never of time), so it is the same on every redraw and there is
    // nothing to recompute when a token moves.
    //
    // Being baked in here is exactly why toggling wobble has to come back through this function
    // rather than through `renderSketch` — see `appearance.ts`, `invalidatesTrace`.
    const startedWobble = performance.now();
    const wobble = wobbleOptionsFor(
      dpi,
      appearance.wobbleSquares,
      appearance.wobbleWavelengthSquares,
    );
    const segments = wobbleSegments(
      toWorldSegments(result.segments, raster.placement),
      wobble,
    );

    // The pencil passes share the wobble's wavelength and step deliberately — see `pencil.ts`.
    // A finer scatter period would need a finer subdivision or it would alias into white noise.
    const passes = pencilPasses(segments, {
      passes: appearance.pencilPasses,
      scatter: dpi * appearance.pencilScatterSquares,
      wavelength: wobble.wavelength,
      step: wobble.step,
      seed: wobble.seed,
    });
    const wobbleMs = performance.now() - startedWobble;

    // Measured from the map's own ink rather than the grid, because `getDpi` still returns a
    // value on a scene whose grid never matched the map.
    //
    // The x scale alone: an ink width has no direction, so under a per-axis placement there is no
    // one factor to convert it by. The axes agree to a fraction of a percent on anything but a
    // visibly stretched map, and this estimator's own inflation is an order of magnitude larger.
    const unitsPerPixel = raster.placement.unitsPerPixel.x;
    const strokeWidthWorld = result.stats.strokeWidthPx * unitsPerPixel;
    const marginInputs = {
      strokeWidthWorld,
      dpi,
      mapExtent:
        Math.min(raster.pixels.width, raster.pixels.height) * unitsPerPixel,
    };
    const margin = wallMargin(marginInputs);

    traced = { mapId: raster.mapId, url: raster.url, segments, passes, dpi, margin };

    devLog(
      "info",
      `sketch: ink ${result.stats.strokeWidthPx.toFixed(1)}px wide ` +
        `(${result.stats.inkPixels} px over ${result.stats.skeletonLength.toFixed(0)}px of ` +
        `skeleton) = ${strokeWidthWorld.toFixed(1)} world units, ` +
        `wall margin ${margin.toFixed(1)} from ${marginSource(marginInputs)}`,
    );

    // `inkFraction` and `fieldMax` are reported for the reason DESIGN.md §2 gives: both failure
    // modes look like nothing rather than like an error. A threshold reading paper as ink
    // returns a thicket of short strokes, and a level above the field's maximum returns none.
    devLog(
      "info",
      `sketch: traced ${result.stats.keptContours} strokes -> ${result.stats.segments} segments ` +
        `in ${result.stats.totalMs.toFixed(0)}ms, wobbled in ${wobbleMs.toFixed(0)}ms ` +
        `(${countPoints(segments)} points) ` +
        `(ink ${(result.stats.inkFraction * 100).toFixed(1)}%, ` +
        `field max ${result.stats.fieldMax.toFixed(2)})` +
        (result.stats.inkFraction > 0.3
          ? " — over 30% ink, the threshold is letting background through"
          : ""),
    );

    return true;
  } catch (error) {
    devLog("error", "sketch: trace failed", error);
    traced = null;
    return false;
  } finally {
    tracing = false;
  }
}

export interface SketchRender {
  readonly drawn: number;
  /** Drawn only because of the wall margin — zero on a walled scene means it is misconfigured. */
  readonly rescued: number;
  /** Hidden only because of it. Both halves reported, so neither can fail silently. */
  readonly suppressed: number;
}

/**
 * Draw the segments that fall in `sketch_region`.
 *
 * Safe to call before a trace exists — it simply draws nothing, which is what should happen
 * while the trace is still running on a freshly-opened scene.
 *
 * @returns how many segments were drawn, or `null` if there is no trace yet.
 */
export async function renderSketch(
  discovered: RegionMask,
  visible: readonly (readonly Vector2[])[],
): Promise<SketchRender | null> {
  if (!traced) return null;

  const selection = selectSketchSegments(
    traced.segments,
    discovered,
    visible,
    traced.margin,
  );

  // One masking decision, applied to every pass by index. Masking each pass on its own midpoint
  // would let them wink in and out separately at the region boundary — the texture would shimmer
  // wherever a token moved, which is exactly where the eye already is.
  const drawn =
    traced.passes.length === 1
      ? [selection.segments]
      : traced.passes.map((pass) => selection.indices.map((i) => pass[i]!));

  // Dispatch, and clear the *other* renderer's items on the way through. Each renderer clears only
  // its own key, so without this line switching leaves the previous sketch on screen underneath the
  // new one — which looks like a rendering bug and makes the comparison the switch exists for
  // impossible. Cheap when nothing is there: a filtered `getItems` that matches nothing.
  if (appearance.renderer === "shader") {
    await clearStrokes().catch(() => {});
    await renderShaderStrokes(drawn, traced.dpi, appearance);
  } else {
    await clearShaderStrokes().catch(() => {});
    await renderStrokes(drawn, traced.dpi, appearance);
  }

  return {
    drawn: selection.segments.length,
    rescued: selection.rescued,
    suppressed: selection.suppressed,
  };
}

export function sketchSegmentCount(): number {
  return traced?.segments.length ?? 0;
}

/**
 * Subdividing for the wobble multiplies point count, and points are what the 8192-command item
 * limit is spent on — so this is the number that decides how many items the sketch costs.
 */
function countPoints(segments: readonly TracedSegment[]): number {
  let total = 0;
  for (const segment of segments) total += segment.points.length;
  return total;
}

/** Forget the trace and remove its strokes — a scene change, or a new map nomination. */
export async function resetSketch(): Promise<void> {
  traced = null;
  await clearBothRenderers();
}

/**
 * Remove whatever is on screen, whichever renderer put it there.
 *
 * Every path that means "there should be no sketch now" has to clear *both*, not just the one the
 * current setting names. A GM who switches to the shader renderer and then turns the sketch off for
 * the scene would otherwise be left looking at the `Path` sketch the previous setting drew — and
 * the toggle would appear broken rather than the clearing being incomplete.
 */
async function clearBothRenderers(): Promise<void> {
  await clearStrokes().catch(() => {});
  await clearShaderStrokes().catch(() => {});
}
