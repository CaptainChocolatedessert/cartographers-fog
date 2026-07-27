/**
 * Pre-segmentation — DESIGN.md §3.
 *
 * Masking at runtime is a per-segment boolean: test a segment's midpoint against the current
 * visibility polygons and show or hide it. That only works if the segments are short enough
 * that "is the midpoint visible" is a fair answer for the whole piece, so the contours are cut
 * up once, here, at generation time.
 *
 * A segment is a short **polyline**, not a straight two-point piece. Cutting only at
 * simplification vertices would leave a straightened wall as one enormous segment; forcing
 * every piece straight would throw away the vertices simplification just decided were worth
 * keeping. Walking arc length and cutting where the budget runs out does neither — geometry
 * is preserved exactly, and pieces come out near-uniform in length whatever the vertex
 * spacing.
 *
 * Length is in the same units as the incoming points (pixels, at this stage). The caller
 * converts from grid units; see `pipeline.ts`.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "../geometry/vector";
import type { Contour } from "./marchingSquares";

export interface TracedSegment {
  /** At least two points. Never closed — a loop is cut into open pieces. */
  readonly points: readonly Vector2[];
  /** The point at half the segment's arc length: what masking tests. */
  readonly midpoint: Vector2;
  readonly length: number;
}

export function chopContours(
  contours: readonly Contour[],
  maxLength: number,
): TracedSegment[] {
  const out: TracedSegment[] = [];
  for (const contour of contours) {
    chopContour(contour, maxLength, out);
  }
  return out;
}

export function chopContour(
  contour: Contour,
  maxLength: number,
  into: TracedSegment[] = [],
): TracedSegment[] {
  const points =
    contour.closed && contour.points.length > 1
      ? [...contour.points, contour.points[0]!]
      : [...contour.points];

  if (points.length < 2) return into;

  const budget = maxLength > 0 ? maxLength : Infinity;

  let current: Vector2[] = [points[0]!];
  let accumulated = 0;

  for (let i = 1; i < points.length; i++) {
    let from = current[current.length - 1]!;
    const to = points[i]!;
    let remaining = distance(from, to);

    // Repeated points appear in traced contours; stepping nowhere would only push a duplicate
    // vertex, which costs a path command and draws nothing.
    if (remaining === 0) continue;

    // One source edge can span several segments, so this consumes it piece by piece rather
    // than assuming a cut lands at a vertex.
    while (accumulated + remaining > budget) {
      const wanted = budget - accumulated;
      // `wanted === 0` means the previous vertex already used the budget exactly, so the
      // piece ends there — cutting again would append the same point twice.
      if (wanted > 0) {
        const cut = interpolate(from, to, wanted / remaining);
        // A budget small enough that the cut rounds back onto the point it came from would
        // never consume the edge. Give up on subdividing this one rather than spin: an
        // over-long segment is visible and recoverable, a hang is neither.
        if (distance(from, cut) === 0) break;
        from = cut;
        current.push(from);
      }

      emit(into, current);
      current = [from];
      accumulated = 0;
      remaining = distance(from, to);
    }

    current.push(to);
    accumulated += remaining;
  }

  emit(into, current);
  return into;
}

function emit(into: TracedSegment[], points: Vector2[]): void {
  if (points.length < 2) return;

  const length = polylineLength(points);
  if (length === 0) return;

  into.push({ points, midpoint: pointAtLength(points, length / 2), length });
}

export function polylineLength(points: readonly Vector2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1]!, points[i]!);
  }
  return total;
}

/** The point `target` units along the polyline, clamped to its ends. */
export function pointAtLength(
  points: readonly Vector2[],
  target: number,
): Vector2 {
  if (points.length === 0) return { x: 0, y: 0 };
  if (target <= 0) return { ...points[0]! };

  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const step = distance(from, to);
    if (travelled + step >= target) {
      const t = step === 0 ? 0 : (target - travelled) / step;
      return interpolate(from, to, t);
    }
    travelled += step;
  }

  return { ...points[points.length - 1]! };
}

function interpolate(a: Vector2, b: Vector2, t: number): Vector2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function distance(a: Vector2, b: Vector2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
