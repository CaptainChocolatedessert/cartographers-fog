/**
 * Douglas–Peucker simplification.
 *
 * Marching squares emits a point per grid-cell crossing, so a traced contour has roughly one
 * vertex per pixel it passes through — a 2000px map easily yields six figures of vertices.
 * That is a problem twice over: items cap at 8192 command entries (DESIGN.md, "Items cap"),
 * and the wobble pass in build-order step 6 perturbs *control points*, so a contour with a
 * vertex per pixel cannot be made to look hand-drawn. It has to be reduced to the few points
 * that carry the shape before anything downstream is worth doing.
 *
 * Tolerance is in pixels, and is the coarse control over how the linework reads: small values
 * follow every wobble of the source art, large ones straighten walls into architectural runs.
 *
 * Iterative rather than recursive. Douglas–Peucker's recursion depth is data-dependent — it is
 * shallow when splits land near the middle and can approach one frame per retained point when
 * they do not — and contours here run to six figures of points. An explicit stack costs
 * nothing and removes the question.
 */

import type { Vector2 } from "../geometry/vector";
import type { Contour } from "./marchingSquares";

export function simplifyContour(contour: Contour, tolerance: number): Contour {
  if (!(tolerance > 0) || contour.points.length <= 2) return contour;

  if (!contour.closed) {
    return { ...contour, points: simplifyPolyline(contour.points, tolerance) };
  }

  // A loop has no endpoints to anchor the recursion, so it is cut at the vertex furthest from
  // the first — the point most likely to be a real corner, and therefore the least damaging
  // place to force a fixed vertex.
  const points = contour.points;
  const first = points[0]!;
  let furthest = 0;
  let furthestDistance = -1;
  for (let i = 1; i < points.length; i++) {
    const distance = squaredDistance(first, points[i]!);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthest = i;
    }
  }

  const front = simplifyPolyline(points.slice(0, furthest + 1), tolerance);
  const back = simplifyPolyline(
    [...points.slice(furthest), first],
    tolerance,
  );
  // `front` ends at the cut and `back` starts there and ends back at `first`; drop both
  // duplicates so the loop keeps the "no repeated closing point" convention.
  const merged = [...front, ...back.slice(1, -1)];
  return { ...contour, points: merged };
}

export function simplifyContours(
  contours: readonly Contour[],
  tolerance: number,
): Contour[] {
  return contours.map((contour) => simplifyContour(contour, tolerance));
}

export function simplifyPolyline(
  points: readonly Vector2[],
  tolerance: number,
): Vector2[] {
  if (points.length <= 2 || !(tolerance > 0)) return [...points];

  const toleranceSquared = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;

    const a = points[start]!;
    const b = points[end]!;
    let furthest = -1;
    let furthestDistance = 0;

    for (let i = start + 1; i < end; i++) {
      const distance = squaredDistanceToSegment(points[i]!, a, b);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthest = i;
      }
    }

    if (furthest !== -1 && furthestDistance > toleranceSquared) {
      keep[furthest] = 1;
      stack.push([start, furthest], [furthest, end]);
    }
  }

  const out: Vector2[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i] === 1) out.push(points[i]!);
  }
  return out;
}

function squaredDistanceToSegment(
  point: Vector2,
  a: Vector2,
  b: Vector2,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return squaredDistance(point, a);

  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = point.x - cx;
  const ey = point.y - cy;
  return ex * ex + ey * ey;
}

function squaredDistance(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
