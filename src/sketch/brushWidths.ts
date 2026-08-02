/**
 * How wide the mark is, point by point — the half of a brush that is geometry rather than shading.
 *
 * The liner and charcoal draw at one width everywhere; a nib pen and an ink brush do not, and that
 * is most of what makes them read as those tools. This module decides the width at every point of
 * every segment, and the shader interpolates between the two ends of each straight piece.
 *
 * ## Why this is CPU work and not shader work
 *
 * The shader's per-pixel cost is what limits the whole renderer, and it is paid per pixel *per
 * slot* inside the unrolled distance chain. Anything computed here is paid once per point at trace
 * time instead — a few thousand operations, once, against millions per frame. The shader's share is
 * one `mix` and one subtraction per slot, which is the smallest addition that expresses varying
 * width at all.
 *
 * It also means the interesting logic is pure and testable. A nib's direction response and a
 * brush's taper are exactly the sort of thing that is judged by eye and then quietly broken by a
 * refactor, so they belong somewhere a test can hold them.
 *
 * ## Pure: no SDK, no DOM.
 */

import type { SegmentProvenance, TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

/**
 * Half-widths for one segment, one per point — so `widths[i].length === segments[i].points.length`.
 *
 * Per point rather than per segment because width has to vary *along* a mark. A per-segment width
 * would quantise the taper to the masking cut length, and the eye finds those steps immediately —
 * the same failure that made the `PathStyle` route unworkable and led to the shader in the first
 * place.
 */
export type SegmentWidths = readonly number[];

export interface NibOptions {
  /** Half-width of the broadest mark the nib can make, in world units. */
  readonly halfWidth: number;
  /**
   * The angle the nib is held at, in radians.
   *
   * A broad nib is an edge, not a point. Travelling across that edge draws its full breadth;
   * travelling along it draws a hairline. That is the whole behaviour, and it is why italic
   * lettering has thick downstrokes and thin cross-strokes without the writer varying pressure.
   */
  readonly angle: number;
  /**
   * How thin the hairline gets, as a fraction of the full width. **Zero is maximum contrast.**
   *
   * At 0 a stroke travelling exactly along the nib vanishes, which is what a real pen does and what
   * makes the effect striking. It is also a floor worth having available: at 1 the nib is a round
   * pen and the angle stops mattering, which is a useful thing to be able to dial back to when
   * comparing.
   */
  readonly contrast: number;
}

/**
 * Half-width at every point, from the direction of travel there.
 *
 * ### The direction at a shared point is not quite shared
 *
 * `chop.ts` cuts contours into segments, so consecutive segments meet at a point that exists twice.
 * Each copy's direction is computed from its own neighbours, and at a cut the two copies see
 * different neighbours — so the widths can differ slightly and the mark can step at the join.
 *
 * This is the same shape of problem `wobble.ts` documents for normals, but far milder, and the
 * reason is worth stating rather than leaving to be rediscovered. The wobble's normal problem moved
 * the two copies of a point to *different places*, visibly tearing the stroke apart. Here the point
 * stays put and only its width differs — and because the two edges meeting at a cut are consecutive
 * along one contour and the geometry has already been subdivided by the wobble, they are very
 * nearly parallel, so the widths very nearly agree. A step of a fraction of a percent of a stroke
 * width is not visible; a torn stroke was.
 *
 * Central differences are used in the interior for the same reason: they average the edges either
 * side, so the width varies smoothly through a corner rather than jumping at it.
 */
export function nibWidths(
  segments: readonly TracedSegment[],
  options: NibOptions,
): SegmentWidths[] {
  const contrast = clamp01(options.contrast);
  return segments.map((segment) =>
    tangents(segment.points).map((tangent) => {
      // |sin| of the angle between travel and the nib's edge. Absolute because a nib does not care
      // which way along its edge you go — reversing a stroke draws the same width.
      const across = Math.abs(
        Math.sin(Math.atan2(tangent.y, tangent.x) - options.angle),
      );
      return options.halfWidth * (contrast + (1 - contrast) * across);
    }),
  );
}

export interface InkOptions {
  /** Half-width at full pressure, in world units. */
  readonly halfWidth: number;
  /**
   * How much of each end of a stroke is taper, as a fraction of the contour's length.
   *
   * **Of the contour, not of the segment** — see `SegmentProvenance`. Tapering per segment would
   * make every masking cut a brush lift, and a wall would read as a row of dashes.
   */
  readonly taperFraction: number;
  /**
   * How much the width wanders along a stroke, 0–1. **Zero is a mark of constant thickness.**
   *
   * A real brush varies with pressure and speed, and a stroke of perfectly even weight is the main
   * thing that reads as machine-drawn. This is a slow variation along the mark, not a grain — it is
   * the difference between a hand and a plotter, where charcoal's grain is the difference between
   * paper and glass.
   */
  readonly pressure: number;
  /** Fixed, so the same map redraws identically. §6 — never seeded from time. */
  readonly seed: number;
}

/** How many pressure cycles fall along one contour. Low, so the variation reads as a hand. */
const PRESSURE_CYCLES = 3.5;

/** Never quite zero, so a stroke's middle cannot vanish where pressure and taper coincide. */
const MIN_WIDTH_SHARE = 0.06;

/**
 * Half-width at every point, from position along the *original contour*.
 *
 * Two effects combined: a taper at each end of the stroke, and a slow pressure variation along it.
 * A segment with no provenance cannot know where it sits, so it is drawn at full width with
 * pressure alone — that degrades to something reasonable rather than to a stroke that is all taper.
 *
 * **Closed contours are never tapered.** A loop has no ends, so a taper would put a thin patch at
 * whatever arbitrary point the tracer began walking it — a defect that would move if the tracer
 * changed, which is the worst kind.
 */
export function inkWidths(
  segments: readonly TracedSegment[],
  options: InkOptions,
): SegmentWidths[] {
  const taper = clamp01(options.taperFraction);
  const pressure = clamp01(options.pressure);

  return segments.map((segment) => {
    const provenance = segment.provenance;
    const fractions = contourFractions(segment.points, provenance);

    return fractions.map((t) => {
      const shape =
        provenance && !provenance.closed ? taperAt(t, taper) : 1;
      // Centred on 1 so raising pressure thickens as often as it thins, rather than making the
      // whole sketch lighter as the slider moves.
      const wander =
        1 + pressure * (noise1(t * PRESSURE_CYCLES, options.seed) - 0.5);
      const share = Math.max(MIN_WIDTH_SHARE, shape * wander);
      return options.halfWidth * share;
    });
  });
}

/**
 * Taper profile: zero at the very ends, one across the middle.
 *
 * `smoothstep` rather than a linear ramp, so the width leaves the tip smoothly and arrives at full
 * weight smoothly. A linear taper reads as a wedge — correct for a chisel, wrong for a brush, whose
 * tip lands and spreads.
 */
export function taperAt(t: number, taperFraction: number): number {
  if (!(taperFraction > 0)) return 1;
  const span = Math.min(0.5, taperFraction);
  return smoothstep(clamp01(t / span)) * smoothstep(clamp01((1 - t) / span));
}

/**
 * Where each point sits along its source contour, 0–1.
 *
 * Interpolated across the segment by **arc length**, not by point index. Index would be wrong
 * wherever the points are unevenly spaced, which is everywhere: the wobble subdivides long edges
 * and leaves short ones alone, so index spacing bears no fixed relation to distance travelled.
 */
export function contourFractions(
  points: readonly Vector2[],
  provenance: SegmentProvenance | undefined,
): number[] {
  if (points.length === 0) return [];
  // No provenance means no position along anything. The midpoint of the stroke is the least
  // opinionated answer: full width under any taper, and no end effects invented from nothing.
  if (!provenance) return points.map(() => 0.5);

  const spans: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    );
    spans.push(total);
  }

  const { startFraction, endFraction } = provenance;
  const width = endFraction - startFraction;
  if (!(total > 0)) return points.map(() => startFraction);

  return spans.map((s) => startFraction + (s / total) * width);
}

/**
 * Unit tangent at every point: central differences inside, one-sided at the ends.
 *
 * Degenerate edges are stepped over rather than producing a zero vector — repeated points survive
 * into traced contours, and a zero tangent would send `atan2` to an arbitrary angle and put a
 * random-width spot in the middle of an otherwise smooth mark.
 */
export function tangents(points: readonly Vector2[]): Vector2[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: 1, y: 0 }];

  return points.map((_, i) => {
    const before = points[Math.max(0, i - 1)]!;
    const after = points[Math.min(n - 1, i + 1)]!;
    let dx = after.x - before.x;
    let dy = after.y - before.y;

    if (dx === 0 && dy === 0) {
      // Neighbours coincide. Widen the window until something has direction, rather than giving up.
      for (let step = 2; step < n; step++) {
        const a = points[Math.max(0, i - step)]!;
        const b = points[Math.min(n - 1, i + step)]!;
        dx = b.x - a.x;
        dy = b.y - a.y;
        if (dx !== 0 || dy !== 0) break;
      }
    }

    const length = Math.hypot(dx, dy);
    return length > 0 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
  });
}

/**
 * Smooth 1D value noise in [0, 1].
 *
 * Its own tiny implementation rather than a reach into `wobble.ts`: that one is a 2D field keyed to
 * world position, because a displacement must agree wherever two strokes share a point. This is
 * keyed to position *along a stroke*, which is a different space entirely — two strokes crossing
 * should not suddenly agree about pressure.
 */
export function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = smoothstep(x - i);
  return hash1(i, seed) + (hash1(i + 1, seed) - hash1(i, seed)) * f;
}

function hash1(i: number, seed: number): number {
  let h = (seed ^ Math.imul(i, 0x27d4eb2d)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
