/**
 * Polygon predicates.
 *
 * `pointInPolygon` is the primitive the whole masking scheme rests on — DESIGN.md §3 reduces
 * per-frame masking to testing each pre-cut segment's midpoint against the current visibility
 * polygons, so this runs a great many times and must stay cheap.
 *
 * The SDK ships an equivalent `Math2.pointInPolygon`, but it cannot be imported headlessly,
 * so this is the same even-odd ray casting algorithm reimplemented — including its
 * bounding-box early-out, which is most of why it is fast in the common "nowhere near"
 * case.
 */

import type { Vector2 } from "./vector";

export interface BoundingBox {
  min: Vector2;
  max: Vector2;
}

export function boundingBox(points: readonly Vector2[]): BoundingBox {
  if (points.length === 0) {
    return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/**
 * Even-odd ray casting. Points exactly on an edge are not guaranteed either way, which is
 * fine here: segment midpoints landing precisely on a visibility boundary are measure-zero,
 * and the fade in DESIGN.md §7 blurs that boundary anyway.
 *
 * Pass `bounds` when testing many points against the same polygon. Without it the bounding
 * box is rebuilt on every call, which makes the "early out" cost a full pass over the
 * vertices *before* it can reject — so a far-away point costs O(vertices) rather than O(1).
 * Real visibility polygons run to thousands of vertices, and this is called once per cell, so
 * hoisting it is the difference between 135ms and 8ms on a realistic mask.
 */
export function pointInPolygon(
  point: Vector2,
  polygon: readonly Vector2[],
  precomputedBounds?: BoundingBox,
): boolean {
  if (polygon.length < 3) return false;

  const bounds = precomputedBounds ?? boundingBox(polygon);
  if (
    point.x < bounds.min.x ||
    point.x > bounds.max.x ||
    point.y < bounds.min.y ||
    point.y > bounds.max.y
  ) {
    return false;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;

    const straddles = pi.y > point.y !== pj.y > point.y;
    if (
      straddles &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Signed area via the shoelace formula. Positive and negative indicate opposite winding.
 * Mostly useful for asserting in tests that a computed polygon is the size it should be.
 */
export function signedArea(polygon: readonly Vector2[]): number {
  if (polygon.length < 3) return 0;

  let total = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    total += (pj.x + pi.x) * (pj.y - pi.y);
  }
  return total / 2;
}

export function area(polygon: readonly Vector2[]): number {
  return Math.abs(signedArea(polygon));
}
