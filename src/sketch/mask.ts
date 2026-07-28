/**
 * Per-segment masking — DESIGN.md §3 and §4.
 *
 * `sketch_region = discovered − currently_visible`, and a segment is drawn when its midpoint
 * falls in it. The two terms are tested by deliberately different means:
 *
 * - **`discovered`** is a cell lookup, O(1) and already quantised — it is stored that way.
 * - **`currently_visible`** is tested against the polygons at full precision, *not* against a
 *   pre-subtracted mask. Quantising it would stair-step the inner boundary to the cell size,
 *   and that boundary is the one that moves with the party and gets looked at directly. The
 *   region wash can afford cells because it is a region marker; linework cannot.
 *
 * Polygon bounding boxes are hoisted out of the loop. `pointInPolygon` rebuilds them otherwise,
 * which costs a full pass over the vertices *before* the early-out can reject — and visibility
 * polygons run to thousands of vertices against thousands of segments. Measured at 193× on the
 * equivalent region code; see DESIGN.md, "Masking cost".
 *
 * Pure: no DOM, no SDK.
 */

import { boundingBox, pointInPolygon, type BoundingBox } from "../geometry/polygon";
import { containsPoint, type RegionMask } from "../region/regionMask";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

export interface SketchSelection {
  readonly segments: TracedSegment[];
  /**
   * Drawn only because of the margin — they fail the plain midpoint test.
   *
   * This is the measurement that says whether the margin is doing anything. Near zero on a
   * walled scene means it is set wrong, not that it is unnecessary.
   */
  readonly rescued: number;
  /**
   * Hidden only because of the margin — the midpoint alone would have drawn them.
   *
   * The other half of the symmetry, and the one that keeps ink off a wall being looked at
   * directly. Reported for the same reason: a silent half is an unverifiable half.
   */
  readonly suppressed: number;
}

/**
 * The segments that belong to `sketch_region`: discovered, and not currently in sight.
 *
 * `margin` widens both terms by sampling perpendicular to the stroke — see `wallMargin.ts` for
 * why wall linework needs it, and why it must widen both. Perpendicular specifically: a stroke
 * runs *along* a wall, so its own endpoints are equally ambiguous and all the uncertainty lies
 * across it.
 *
 * Order is preserved, which keeps the emitted items stable between renders — a segment does not
 * migrate between chunks just because a neighbour was hidden.
 */
export function selectSketchSegments(
  segments: readonly TracedSegment[],
  discovered: RegionMask,
  visible: readonly (readonly Vector2[])[],
  margin = 0,
): SketchSelection {
  const occluders: { polygon: readonly Vector2[]; bounds: BoundingBox }[] = [];
  for (const polygon of visible) {
    if (polygon.length < 3) continue;
    occluders.push({ polygon, bounds: boundingBox(polygon) });
  }

  const selected: TracedSegment[] = [];
  let rescued = 0;
  let suppressed = 0;

  for (const segment of segments) {
    const samples = samplePoints(segment, margin);

    let isDiscovered = false;
    for (const sample of samples) {
      if (containsPoint(discovered, sample)) {
        isDiscovered = true;
        break;
      }
    }
    // Cheapest test first, and the one that rejects most segments on a partly-explored map.
    if (!isDiscovered) {
      if (plainly(segment, discovered, occluders)) suppressed++;
      continue;
    }

    let inSight = false;
    for (const sample of samples) {
      if (isInSight(sample, occluders)) {
        inSight = true;
        break;
      }
    }

    if (inSight) {
      if (plainly(segment, discovered, occluders)) suppressed++;
      continue;
    }

    selected.push(segment);
    if (!plainly(segment, discovered, occluders)) rescued++;
  }

  return { segments: selected, rescued, suppressed };
}

/** What the midpoint alone would have decided — the baseline the counters measure against. */
function plainly(
  segment: TracedSegment,
  discovered: RegionMask,
  occluders: readonly { polygon: readonly Vector2[]; bounds: BoundingBox }[],
): boolean {
  return (
    containsPoint(discovered, segment.midpoint) &&
    !isInSight(segment.midpoint, occluders)
  );
}

function isInSight(
  point: Vector2,
  occluders: readonly { polygon: readonly Vector2[]; bounds: BoundingBox }[],
): boolean {
  for (const occluder of occluders) {
    if (pointInPolygon(point, occluder.polygon, occluder.bounds)) return true;
  }
  return false;
}

/**
 * The midpoint, plus one point either side of the stroke at `margin`.
 *
 * Direction is taken end to end rather than from the edge the midpoint happens to lie on.
 * Segments are short and near-straight by the time `chop.ts` is done with them, so the two
 * agree closely, and the end-to-end version cannot be thrown by one noisy vertex.
 */
export function samplePoints(
  segment: TracedSegment,
  margin: number,
): Vector2[] {
  const midpoint = segment.midpoint;
  if (!(margin > 0)) return [midpoint];

  const first = segment.points[0];
  const last = segment.points[segment.points.length - 1];
  if (!first || !last) return [midpoint];

  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy);

  // A closed or degenerate piece has no direction to be perpendicular to. Widening it in an
  // arbitrary direction would be worse than not widening it.
  if (!(length > 0)) return [midpoint];

  const nx = (-dy / length) * margin;
  const ny = (dx / length) * margin;

  return [
    midpoint,
    { x: midpoint.x + nx, y: midpoint.y + ny },
    { x: midpoint.x - nx, y: midpoint.y - ny },
  ];
}
