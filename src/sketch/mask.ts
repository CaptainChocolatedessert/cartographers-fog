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

/**
 * The segments that belong to `sketch_region`: discovered, and not currently in sight.
 *
 * Order is preserved, which keeps the emitted items stable between renders — a segment does not
 * migrate between chunks just because a neighbour was hidden.
 */
export function selectSketchSegments(
  segments: readonly TracedSegment[],
  discovered: RegionMask,
  visible: readonly (readonly Vector2[])[],
): TracedSegment[] {
  const occluders: { polygon: readonly Vector2[]; bounds: BoundingBox }[] = [];
  for (const polygon of visible) {
    if (polygon.length < 3) continue;
    occluders.push({ polygon, bounds: boundingBox(polygon) });
  }

  const selected: TracedSegment[] = [];

  for (const segment of segments) {
    const midpoint = segment.midpoint;

    // Cheapest test first, and the one that rejects most segments on a partly-explored map.
    if (!containsPoint(discovered, midpoint)) continue;

    let inSight = false;
    for (const occluder of occluders) {
      if (pointInPolygon(midpoint, occluder.polygon, occluder.bounds)) {
        inSight = true;
        break;
      }
    }

    if (!inSight) selected.push(segment);
  }

  return selected;
}
