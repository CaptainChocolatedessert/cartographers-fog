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
import { clearStrokes, renderStrokes } from "./strokes";
import { toWorldSegments } from "./placement";
import { traceOptionsFor } from "./traceSettings";
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

    traced = {
      mapId: raster.mapId,
      url: raster.url,
      segments: toWorldSegments(result.segments, raster.placement),
      dpi,
    };

    // `inkFraction` and `fieldMax` are reported for the reason DESIGN.md §2 gives: both failure
    // modes look like nothing rather than like an error. A threshold reading paper as ink
    // returns a thicket of short strokes, and a level above the field's maximum returns none.
    devLog(
      "info",
      `sketch: traced ${result.stats.keptContours} strokes -> ${result.stats.segments} segments ` +
        `in ${result.stats.totalMs.toFixed(0)}ms ` +
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
): Promise<number | null> {
  if (!traced) return null;

  const selected = selectSketchSegments(traced.segments, discovered, visible);
  await renderStrokes(selected, traced.dpi);
  return selected.length;
}

export function sketchSegmentCount(): number {
  return traced?.segments.length ?? 0;
}

/** Forget the trace and remove its strokes — a scene change, or a new map nomination. */
export async function resetSketch(): Promise<void> {
  traced = null;
  await clearStrokes().catch(() => {});
}
