/**
 * Putting a traced map where the map is — image pixel space to world space.
 *
 * The trace pipeline works entirely in the pixel space of whatever raster it was handed
 * (`trace/pipeline.ts`), so every point it returns needs one affine step to reach the scene.
 * That step is uniform scale plus translation, which is all an unrotated map image needs.
 *
 * **World bounds come from `getItemBounds`, not from composing the transform by hand.** Same
 * reasoning as `region/sceneGrid.ts`: dpi, grid offset, image scale and rotation compose in an
 * order the SDK documents nowhere, and this project has already paid for guessing at
 * undocumented conventions once. Let the app answer the question it can answer exactly.
 *
 * The cost of that choice is the one real limitation here: `getItemBounds` returns an
 * axis-aligned box, so a **rotated** map image reports the box its corners span rather than its
 * own footprint, and strokes placed against it would be both mis-scaled and mis-positioned.
 * `aspectMismatch` is how that gets noticed rather than shipped — a rotated image's box has a
 * different aspect ratio from the image, so the two disagreeing is the signal. Handling rotation
 * properly means reading the item's own transform, which is a later job.
 *
 * Pure: no DOM, no SDK.
 */

import type { Bounds } from "../region/cellGrid";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

export interface TracePlacement {
  /** World position of the raster's pixel (0, 0). */
  readonly origin: Vector2;
  /** World units per traced pixel. Uniform — the raster is a scaled copy of the image. */
  readonly unitsPerPixel: number;
}

/**
 * Raster width to trace at: the cap, or the source if it is smaller.
 *
 * Deliberately not derived from the scene's grid. An earlier version chose the width to hit a
 * target pixels-per-grid-square, which reads well until a map spans only a few squares — the
 * test scene's is 5.4 across, where a 32 px/square target picks a 174-pixel raster and thinning
 * erases every line. The cap is what the trace harness was validated at; see `traceSettings.ts`.
 *
 * Never upscales, since enlarging invents detail nobody drew and leaves thinning chasing
 * interpolation artifacts.
 */
export function chooseTraceWidth(sourceWidth: number, maxWidth: number): number {
  return Math.max(1, Math.floor(Math.min(sourceWidth, maxWidth)));
}

/**
 * Pixels per grid square a raster of this width achieves against the *scene's* grid.
 *
 * Diagnostic only — nothing is tuned from it. It is the measurement a real grid-relative
 * calibration would need, and reporting it is how the gap between the harness's nominal
 * 70 px/square and a map's actual density becomes visible instead of assumed.
 */
export function pixelsPerGridSquare(
  rasterWidth: number,
  worldWidth: number,
  dpi: number,
): number {
  if (!(worldWidth > 0) || !(dpi > 0)) return 0;
  return (rasterWidth * dpi) / worldWidth;
}

/** Raster height preserving the source aspect, at least one pixel. */
export function rasterHeightFor(
  sourceWidth: number,
  sourceHeight: number,
  rasterWidth: number,
): number {
  if (!(sourceWidth > 0)) return 1;
  return Math.max(1, Math.round((sourceHeight * rasterWidth) / sourceWidth));
}

export function createPlacement(
  bounds: Bounds,
  rasterWidth: number,
): TracePlacement {
  const width = bounds.max.x - bounds.min.x;
  return {
    origin: { ...bounds.min },
    unitsPerPixel: rasterWidth > 0 ? width / rasterWidth : 0,
  };
}

/**
 * How far the world bounds' aspect ratio departs from the raster's, as a fraction.
 *
 * Zero for an axis-aligned image. Non-zero means the bounds are not simply the image scaled —
 * rotation being the expected cause — and a uniform scale will place strokes wrongly.
 */
export function aspectMismatch(
  bounds: Bounds,
  rasterWidth: number,
  rasterHeight: number,
): number {
  const worldWidth = bounds.max.x - bounds.min.x;
  const worldHeight = bounds.max.y - bounds.min.y;
  if (!(worldWidth > 0) || !(worldHeight > 0) || !(rasterWidth > 0) || !(rasterHeight > 0)) {
    return 0;
  }

  const worldAspect = worldWidth / worldHeight;
  const rasterAspect = rasterWidth / rasterHeight;
  return Math.abs(worldAspect - rasterAspect) / rasterAspect;
}

export function toWorldPoint(
  point: Vector2,
  placement: TracePlacement,
): Vector2 {
  return {
    x: placement.origin.x + point.x * placement.unitsPerPixel,
    y: placement.origin.y + point.y * placement.unitsPerPixel,
  };
}

/**
 * Move a segment into world space.
 *
 * The midpoint is transformed rather than recomputed. The map is affine, so the point at half
 * the arc length maps to the point at half the transformed arc length exactly — and recomputing
 * would risk the runtime mask testing a slightly different point than the one `chop.ts` chose.
 */
export function toWorldSegment(
  segment: TracedSegment,
  placement: TracePlacement,
): TracedSegment {
  return {
    points: segment.points.map((point) => toWorldPoint(point, placement)),
    midpoint: toWorldPoint(segment.midpoint, placement),
    length: segment.length * placement.unitsPerPixel,
  };
}

export function toWorldSegments(
  segments: readonly TracedSegment[],
  placement: TracePlacement,
): TracedSegment[] {
  return segments.map((segment) => toWorldSegment(segment, placement));
}
