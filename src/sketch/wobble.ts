/**
 * The hand-drawn wobble — DESIGN.md §2 step 4 and §6.
 *
 * A traced stroke follows the map exactly, which is the opposite of what this project wants: it
 * should look like somebody redrew the map by hand, in a hurry, by firelight. So every point is
 * displaced by a smooth noise field, and long straight runs are subdivided first so a ruled wall
 * bows gently instead of staying rigid.
 *
 * ## Seeded from world position, never from time
 *
 * §6 is emphatic and worth repeating: a `time`-driven squiggle makes the whole map appear to
 * breathe, which is genuinely unpleasant to look at across a multi-hour session. The noise here
 * is a pure function of world position, so the same ground always wobbles the same way — across
 * re-renders, across scene reloads, and across clients, which each trace independently.
 *
 * ## Why a 2D vector field rather than a displacement along the normal
 *
 * Pushing each point along its local normal is the obvious approach and it breaks strokes apart.
 * `chop.ts` cuts contours into segments, so two segments share an endpoint; the *offset* at that
 * point is shared because it depends only on position, but the *normal* is computed from
 * neighbouring vertices, which differ on either side of a cut that lands on a vertex. The two
 * copies of that point then move differently and the stroke visibly separates.
 *
 * Offsetting by a vector field removes the failure rather than patching it: displacement depends
 * on position and nothing else, so every copy of a shared point lands in the same place, always.
 * The cost is that part of the offset runs along the stroke instead of across it, which slides a
 * point slightly rather than bending the line — invisible in practice.
 *
 * Pure: no DOM, no SDK.
 */

import { reshapeSegment, type TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

export interface WobbleOptions {
  /** Peak displacement, in world units. The main aesthetic knob. */
  readonly amplitude: number;
  /** Wavelength of the slow bow, in world units. */
  readonly wavelength: number;
  /** Edges longer than this are subdivided so they can bend. World units. */
  readonly step: number;
  /** Fixed, so the same map redraws identically. Not a source of variety — position is. */
  readonly seed: number;
}

/** Second octave, as a fraction of the first's wavelength and amplitude. */
const FINE_WAVELENGTH_RATIO = 1 / 3;
const FINE_AMPLITUDE_SHARE = 0.25;

/** Offsets the y channel's seed so the two axes are independent rather than identical. */
const Y_CHANNEL_SEED = 0x9e3779b9;

export function wobbleSegments(
  segments: readonly TracedSegment[],
  options: WobbleOptions,
): TracedSegment[] {
  return segments.map((segment) => wobbleSegment(segment, options));
}

export function wobbleSegment(
  segment: TracedSegment,
  options: WobbleOptions,
): TracedSegment {
  if (segment.points.length < 2 || !(options.amplitude > 0)) return segment;

  const dense = subdivide(segment.points, options.step);
  const points = dense.map((point) => {
    const offset = offsetAt(point, options);
    return { x: point.x + offset.x, y: point.y + offset.y };
  });

  // Recomputed rather than displaced, so the invariant `chop.ts` documents still holds: the
  // midpoint is the point at half the *drawn* arc length. Masking tests this point, so it
  // should describe where the ink actually ended up.
  //
  // Via `reshapeSegment` so the segment's provenance survives. Wobbling moves and multiplies the
  // points but changes nothing about *which stroke* they came from or where along it they sit —
  // and rebuilding the object literally here is precisely how that got dropped before.
  return reshapeSegment(segment, points);
}

/**
 * Insert points along any edge longer than `step`.
 *
 * Without this a straight run stays straight: the noise field only ever moves the points it is
 * given, so a two-point edge can be tilted but never bowed. Subdividing is what turns a ruled
 * wall into a drawn one.
 */
export function subdivide(
  points: readonly Vector2[],
  step: number,
): Vector2[] {
  if (!(step > 0) || points.length < 2) return [...points];

  const out: Vector2[] = [points[0]!];

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const pieces = Math.ceil(span / step);

    for (let piece = 1; piece < pieces; piece++) {
      const t = piece / pieces;
      out.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      });
    }

    out.push(to);
  }

  return out;
}

/** Displacement at a world point. Depends on position alone — see the module header. */
export function offsetAt(point: Vector2, options: WobbleOptions): Vector2 {
  return {
    x: fbm(point.x, point.y, options.seed, options.wavelength) * options.amplitude,
    y:
      fbm(point.x, point.y, options.seed ^ Y_CHANNEL_SEED, options.wavelength) *
      options.amplitude,
  };
}

/**
 * Two octaves of value noise: a slow bow with a finer tremor on top.
 *
 * One octave alone reads as either a bend or a jitter, never as a pen — the hand moves at more
 * than one scale at once.
 */
function fbm(x: number, y: number, seed: number, wavelength: number): number {
  if (!(wavelength > 0)) return 0;

  const fine = wavelength * FINE_WAVELENGTH_RATIO;
  const slow = valueNoise(x / wavelength, y / wavelength, seed);
  const tremor = valueNoise(x / fine, y / fine, seed ^ 0x85ebca6b);

  return slow * (1 - FINE_AMPLITUDE_SHARE) + tremor * FINE_AMPLITUDE_SHARE;
}

/**
 * Smoothly interpolated lattice noise in [-1, 1].
 *
 * Interpolated deliberately. Hashing each point independently gives white noise, which makes a
 * stroke sparkle rather than wander — every vertex jumps somewhere unrelated to its neighbours.
 * Smoothstep between hashed lattice corners is what makes the result read as a wobble.
 */
export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);

  const top = lerp(hash(x0, y0, seed), hash(x0 + 1, y0, seed), fx);
  const bottom = lerp(hash(x0, y0 + 1, seed), hash(x0 + 1, y0 + 1, seed), fx);

  return lerp(top, bottom, fy) * 2 - 1;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Integer lattice hash, in [0, 1). Negative coordinates wrap through ToUint32 — deterministic. */
function hash(ix: number, iy: number, seed: number): number {
  let h = (seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
