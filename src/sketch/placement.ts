/**
 * Putting a traced map where the map is — image pixel space to world space.
 *
 * The trace pipeline works entirely in the pixel space of whatever raster it was handed
 * (`trace/pipeline.ts`), so every point it returns needs one affine step to reach the scene.
 * That step is a per-axis scale plus translation, which is all an unrotated map image needs.
 *
 * **Per-axis, not uniform** — see `TracePlacement.unitsPerPixel`. Assuming one scale was this
 * module's one real bug: it put strokes progressively further down the map than the walls they
 * were traced from, and it was invisible in the trace harness, which never leaves pixel space.
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
  /** World position of the raster's top-left *corner* — the boundary, not a pixel's centre. */
  readonly origin: Vector2;
  /**
   * World units per traced pixel, per axis.
   *
   * **Not uniform, and it must not be.** An earlier version derived one scale from the width and
   * applied it to both axes, on the reasoning that the raster is a scaled copy of the image. The
   * raster is; the *placement* need not be. A map stretched slightly to line its art up with the
   * scene grid occupies world bounds that are not a uniform scaling of its pixels, and a single
   * scale then turns that discrepancy into a y error growing from zero at the map's top edge to
   * its full size at the bottom.
   *
   * Measured on "Lair Of The Lamb" (2026-07-31): 3.1137 world units per source pixel across
   * against 3.1041 down — 0.275%, silent under `MAX_ASPECT_MISMATCH`, and **+21.7 world units of
   * downward drift** at the map's bottom edge against wall linework about 30 units wide. Strokes
   * left the walls they were traced from. See DESIGN.md, "Strokes drift off the wall down the map".
   *
   * Two axes also absorb the raster height's rounding exactly (791 rows standing in for 791.27),
   * which a width-derived scale cannot.
   */
  readonly unitsPerPixel: Vector2;
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
  rasterHeight: number,
): TracePlacement {
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  return {
    origin: { ...bounds.min },
    unitsPerPixel: {
      x: rasterWidth > 0 ? width / rasterWidth : 0,
      y: rasterHeight > 0 ? height / rasterHeight : 0,
    },
  };
}

/**
 * How far the world bounds' aspect ratio departs from the raster's, as a fraction.
 *
 * **A rotation detector, and nothing more.** It used to double as a displacement budget, on the
 * reasoning that a uniform scale misplaces strokes in proportion to this figure — which was true,
 * and was the bug: a threshold expressed as a ratio was silently permitting a drift measured in
 * world units, and nobody had converted between the two. Per-axis scaling now absorbs any aspect
 * discrepancy exactly, so a non-zero value here no longer means strokes are misplaced.
 *
 * What it still catches is rotation, where the bounds are the box the corners span rather than the
 * image's own footprint. Per-axis scaling does *not* rescue that case — it stretches the strokes
 * to fill the box instead — so the warning stays. Note it cannot catch a rotated *square* image,
 * whose box keeps a 1:1 aspect at every angle.
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

/**
 * A traced coordinate names a **pixel**, and `origin` is the raster's outer corner, so the pixel's
 * world position is half a pixel in from that corner.
 *
 * Both trace modes agree on this. The skeleton walk emits pixel indices directly, and marching
 * squares samples the field at pixel centres and keys its crossings to that same lattice — so
 * integer coordinates mean pixel centres in either mode, never corners.
 *
 * Dropping the half pixel placed pixel 0's centre on the map's very edge and shifted every stroke
 * up and left — 5 world units on the map this was measured against. Small next to the axis bug
 * above, but in the same direction, so the two compounded.
 */
export function toWorldPoint(
  point: Vector2,
  placement: TracePlacement,
): Vector2 {
  return {
    x: placement.origin.x + (point.x + 0.5) * placement.unitsPerPixel.x,
    y: placement.origin.y + (point.y + 0.5) * placement.unitsPerPixel.y,
  };
}

/**
 * Move a segment into world space.
 *
 * The midpoint is transformed rather than recomputed. The map is affine, so the point at half
 * the arc length maps to the point at half the transformed arc length exactly — and recomputing
 * would risk the runtime mask testing a slightly different point than the one `chop.ts` chose.
 *
 * `length` takes the x scale alone, because under a non-uniform scale a length has no single
 * factor — it depends on the segment's direction, which is not worth carrying. The two axes are
 * within a fraction of a percent of each other on any map that is not visibly stretched, and the
 * only consumer is the ink-width estimator feeding the wall margin, whose own error is measured in
 * tens of percent (DESIGN.md, "Measured on a real walled map").
 */
export function toWorldSegment(
  segment: TracedSegment,
  placement: TracePlacement,
): TracedSegment {
  return {
    points: segment.points.map((point) => toWorldPoint(point, placement)),
    midpoint: toWorldPoint(segment.midpoint, placement),
    length: segment.length * placement.unitsPerPixel.x,
  };
}

export function toWorldSegments(
  segments: readonly TracedSegment[],
  placement: TracePlacement,
): TracedSegment[] {
  return segments.map((segment) => toWorldSegment(segment, placement));
}
