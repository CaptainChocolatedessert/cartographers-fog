/**
 * Line segments and ray casting against them.
 *
 * Walls arrive as polylines; each consecutive pair of points becomes one `Segment`, and
 * visibility is computed by casting rays at these.
 */

import { cross, dot, lengthSquared, subtract, type Vector2 } from "./vector";

export interface Segment {
  readonly a: Vector2;
  readonly b: Vector2;
  /**
   * When true this segment only blocks sight from its front face, mirroring a `Wall` with
   * `doubleSided: false`. See `FRONT_SIDE_SIGN`.
   */
  readonly oneSided?: boolean;
}

/**
 * Which sign of `cross(direction, viewer - a)` counts as the front of a one-sided wall.
 *
 * UNVERIFIED — Owlbear does not document the winding convention for `doubleSided: false`,
 * and it cannot be determined from the SDK types. Flipping this constant inverts which side
 * of a one-sided wall blocks. Needs checking in a real room against a one-sided wall; until
 * then, prefer `treatOneSidedAsSolid` when calling into visibility, which sidesteps the
 * question entirely by blocking from both sides.
 */
export const FRONT_SIDE_SIGN = 1;

/** A tiny denominator means the ray and segment are parallel. */
const PARALLEL_EPSILON = 1e-12;

export function direction(segment: Segment): Vector2 {
  return subtract(segment.b, segment.a);
}

/**
 * Signed side of the infinite line through `segment` that `point` lies on.
 * Positive and negative denote opposite sides; zero means collinear.
 */
export function sideOf(segment: Segment, point: Vector2): number {
  return cross(direction(segment), subtract(point, segment.a));
}

/** Does this segment block sight originating at `viewer`? */
export function blocksFrom(segment: Segment, viewer: Vector2): boolean {
  if (!segment.oneSided) return true;
  return Math.sign(sideOf(segment, viewer)) === FRONT_SIDE_SIGN;
}

/**
 * Cast a ray from `origin` along the unit vector `rayDirection` at `segment`.
 *
 * @returns distance along the ray to the hit, or `null` when it misses. Because
 * `rayDirection` is a unit vector, the returned parameter is a true distance.
 */
export function rayHitDistance(
  origin: Vector2,
  rayDirection: Vector2,
  segment: Segment,
): number | null {
  const seg = direction(segment);
  const denominator = cross(rayDirection, seg);
  if (Math.abs(denominator) < PARALLEL_EPSILON) return null;

  const toSegmentStart = subtract(segment.a, origin);
  const distanceAlongRay = cross(toSegmentStart, seg) / denominator;
  const positionAlongSegment = cross(toSegmentStart, rayDirection) / denominator;

  if (distanceAlongRay < 0) return null;
  if (positionAlongSegment < 0 || positionAlongSegment > 1) return null;

  return distanceAlongRay;
}

/**
 * Squared distance from `point` to the nearest position on `segment`.
 * Used to cull walls that lie entirely outside a light's radius.
 */
export function distanceToPointSquared(segment: Segment, point: Vector2): number {
  const seg = direction(segment);
  const lengthSq = lengthSquared(seg);
  if (lengthSq === 0) return lengthSquared(subtract(point, segment.a));

  const t = Math.max(
    0,
    Math.min(1, dot(subtract(point, segment.a), seg) / lengthSq),
  );
  const closest = { x: segment.a.x + seg.x * t, y: segment.a.y + seg.y * t };
  return lengthSquared(subtract(point, closest));
}

export function isDegenerate(segment: Segment): boolean {
  return segment.a.x === segment.b.x && segment.a.y === segment.b.y;
}
