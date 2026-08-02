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
  /**
   * Where this piece came from, and where along it.
   *
   * **Cutting for masking destroys the notion of a stroke, and some brushes need it back.** A brush
   * that tapers — an ink brush thinning to nothing at the start and end of a mark — must taper at
   * the ends of the *original contour*, not at the ends of every masking segment. Tapering each
   * segment would turn a continuous wall into a row of dashes, which looks like a rendering fault
   * rather than a brush.
   *
   * So the cut records what it is destroying. `contour` identifies the source stroke, and the two
   * fractions say what part of its arc length this piece spans, 0 at the contour's start and 1 at
   * its end. `sketch/brushWidths.ts` is the only consumer.
   *
   * Optional because the field arrived late and every fixture predating it is still valid — a
   * segment without provenance simply cannot be tapered, and the brushes that do not taper never
   * look.
   */
  readonly provenance?: SegmentProvenance;
}

export interface SegmentProvenance {
  /** Index of the source contour. Pieces of one stroke share it. */
  readonly contour: number;
  /** Normalised arc position of the first point along that contour, 0–1. */
  readonly startFraction: number;
  /** ...and of the last point. Always greater than `startFraction`. */
  readonly endFraction: number;
  /**
   * Whether the source contour was a closed loop.
   *
   * A loop has no ends, so tapering it would put a spurious thin patch at the arbitrary point the
   * tracer happened to start walking. Brushes must leave closed contours at full width.
   */
  readonly closed: boolean;
}

/**
 * Rebuild a segment around new points, carrying its provenance.
 *
 * Every stage after `chop` rewrites points — `placement` maps them to world space, `wobble`
 * subdivides and displaces them, `pencil` offsets them — and each rebuilt the segment literally,
 * which silently dropped anything added here. This is the one place that knows the invariant
 * (`midpoint` is the point at half the *drawn* arc length) and the one place that has to remember
 * the new field, so both live together.
 */
export function reshapeSegment(
  segment: TracedSegment,
  points: readonly Vector2[],
): TracedSegment {
  const length = polylineLength(points);
  return {
    points,
    midpoint: pointAtLength(points, length / 2),
    length,
    ...(segment.provenance ? { provenance: segment.provenance } : {}),
  };
}

export function chopContours(
  contours: readonly Contour[],
  maxLength: number,
): TracedSegment[] {
  const out: TracedSegment[] = [];
  contours.forEach((contour, index) => {
    chopContour(contour, maxLength, out, index);
  });
  return out;
}

export function chopContour(
  contour: Contour,
  maxLength: number,
  into: TracedSegment[] = [],
  contourIndex = 0,
): TracedSegment[] {
  const points =
    contour.closed && contour.points.length > 1
      ? [...contour.points, contour.points[0]!]
      : [...contour.points];

  if (points.length < 2) return into;

  const budget = maxLength > 0 ? maxLength : Infinity;

  // Total arc length of the *whole* contour, measured before any cutting, so each piece can say
  // where along the original stroke it sits. A zero-length contour would divide by zero; it also
  // cannot emit anything, so the guard costs nothing.
  const contourLength = polylineLength(points);
  let consumed = 0;

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

      consumed = emit(into, current, contourIndex, consumed, contourLength, contour.closed);
      current = [from];
      accumulated = 0;
      remaining = distance(from, to);
    }

    current.push(to);
    accumulated += remaining;
  }

  emit(into, current, contourIndex, consumed, contourLength, contour.closed);
  return into;
}

/**
 * Append one piece, recording where along its source contour it lies.
 *
 * @returns the arc length consumed so far, so the caller can hand it back for the next piece. A
 * running total threaded through the return value rather than a mutable field, because the cut
 * loop already has three pieces of state and a fourth hidden one is how this sort of code goes
 * wrong.
 */
function emit(
  into: TracedSegment[],
  points: Vector2[],
  contour: number,
  consumed: number,
  contourLength: number,
  closed: boolean,
): number {
  if (points.length < 2) return consumed;

  const length = polylineLength(points);
  if (length === 0) return consumed;

  const scale = contourLength > 0 ? 1 / contourLength : 0;
  into.push({
    points,
    midpoint: pointAtLength(points, length / 2),
    length,
    provenance: {
      contour,
      startFraction: consumed * scale,
      // Clamped: floating-point accumulation over many pieces can carry the last one a hair past
      // 1, and a taper profile fed 1.0000001 would report the stroke's final piece as beyond its
      // own end.
      endFraction: Math.min(1, (consumed + length) * scale),
      closed,
    },
  });

  return consumed + length;
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
