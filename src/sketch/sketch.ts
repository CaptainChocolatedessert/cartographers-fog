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

import { loadMapRaster, resolveSketchMap } from "./mapImage";
import { selectSketchSegments } from "./mask";
import { readSketchSettings } from "./sketchSettings";
import { marginSource, wallMargin } from "./wallMargin";
import { clearStrokes, renderStrokes } from "./strokes";
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
  /** Already in world space, so rendering never repeats the transform. */
  readonly segments: readonly TracedSegment[];
  readonly dpi: number;
  /** How far either side of a stroke counts as the same place — see `wallMargin.ts`. */
  readonly margin: number;
}

let traced: TracedMap | null = null;

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
      await clearStrokes().catch(() => {});
      return false;
    }

    const raster = await loadMapRaster(map);
    if (!raster) {
      traced = null;
      await clearStrokes().catch(() => {});
      return false;
    }

    const options = traceOptionsFor(raster.pixelsPerGrid);
    const result = traceImage(raster.pixels, options);
    const dpi = await OBR.scene.grid.getDpi();

    // Wobbled once, here, rather than per render. The displacement is a pure function of world
    // position (DESIGN.md §6 — never of time), so it is the same on every redraw and there is
    // nothing to recompute when a token moves.
    const startedWobble = performance.now();
    const segments = wobbleSegments(
      toWorldSegments(result.segments, raster.placement),
      wobbleOptionsFor(dpi),
    );
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

    traced = { mapId: raster.mapId, url: raster.url, segments, dpi, margin };

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
  await renderStrokes(selection.segments, traced.dpi);

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
  await clearStrokes().catch(() => {});
}
