/**
 * CPU visibility polygons. See DESIGN.md §1.
 *
 * Owlbear computes fog on the GPU and never hands "what can this token see" back to an
 * extension, so persistence requires rebuilding that answer in JS from `Wall` items.
 *
 * Algorithm: cast a ray at every wall endpoint (plus a nudge either side, so the ray slips
 * past the corner and finds whatever stands behind it), take the nearest hit along each,
 * and join the hits in angular order. Unobstructed directions are clamped to the light's
 * radius, and the circle is additionally sampled at a fixed interval so that arcs of open
 * space come out curved rather than as one enormous chord.
 *
 * Cost is O(angles x segments), which is fine because this is not a per-frame computation:
 * DESIGN.md §2 and §3 arrange for it to run on state change, with per-frame work reduced to
 * a point-in-polygon test per pre-cut segment.
 *
 * NOT handled yet: `Light.innerAngle` / `outerAngle`. Cone-shaped lights are treated as full
 * circles, which over-reports visibility for them. Fine for the common case — Dynamic Fog's
 * default lights are omnidirectional — but it must be added before cone lights are supported.
 */

import {
  add,
  angleOf,
  fromAngle,
  scale,
  subtract,
  type Vector2,
} from "../geometry/vector";
import {
  blocksFrom,
  distanceToPointSquared,
  isDegenerate,
  rayHitDistance,
  type Segment,
} from "../geometry/segment";

export interface VisibilityOptions {
  /** Maximum sight distance. Maps to `Light.attenuationRadius`. */
  radius: number;
  /**
   * How many evenly spaced rays to add around the full circle. These tessellate arcs of
   * open space; raising it makes unobstructed boundaries rounder at linear cost.
   */
  arcSamples?: number;
  /**
   * Angular nudge, in radians, applied either side of each corner ray so the sweep can see
   * past corners. Too small and floating point swallows it; too large and corners visibly
   * round off.
   */
  cornerEpsilon?: number;
  /**
   * When true (the default), walls with `doubleSided: false` block from both sides.
   *
   * The winding convention that decides a one-sided wall's front face is undocumented and
   * unverified — see `FRONT_SIDE_SIGN`. Blocking from both sides is the conservative choice
   * until it is confirmed in a real room: it can only ever over-occlude, never leak sight
   * through a wall that should be solid.
   */
  treatOneSidedAsSolid?: boolean;
}

const DEFAULT_ARC_SAMPLES = 64;
const DEFAULT_CORNER_EPSILON = 1e-5;
const ANGLE_DEDUPE_EPSILON = 1e-9;
const TWO_PI = Math.PI * 2;

/**
 * Build the polygon of everything visible from `origin`.
 *
 * @returns polygon vertices in ascending angular order, or an empty array for a
 * non-positive radius. The result always encloses `origin`.
 */
export function computeVisibilityPolygon(
  origin: Vector2,
  segments: readonly Segment[],
  options: VisibilityOptions,
): Vector2[] {
  const { radius } = options;
  if (!(radius > 0)) return [];

  const arcSamples = options.arcSamples ?? DEFAULT_ARC_SAMPLES;
  const cornerEpsilon = options.cornerEpsilon ?? DEFAULT_CORNER_EPSILON;
  const treatOneSidedAsSolid = options.treatOneSidedAsSolid ?? true;

  const occluders = occludingSegments(
    origin,
    segments,
    radius,
    treatOneSidedAsSolid,
  );
  const angles = candidateAngles(
    origin,
    occluders,
    arcSamples,
    cornerEpsilon,
  );

  const polygon: Vector2[] = [];
  for (const angle of angles) {
    const rayDirection = fromAngle(angle);

    let nearest = radius;
    for (const segment of occluders) {
      const hit = rayHitDistance(origin, rayDirection, segment);
      if (hit !== null && hit < nearest) nearest = hit;
    }

    polygon.push(add(origin, scale(rayDirection, nearest)));
  }

  return polygon;
}

/**
 * Discard segments that cannot affect the result: degenerate ones, those lying entirely
 * beyond the radius, and — when one-sided walls are honoured — those facing away.
 */
function occludingSegments(
  origin: Vector2,
  segments: readonly Segment[],
  radius: number,
  treatOneSidedAsSolid: boolean,
): Segment[] {
  const radiusSquared = radius * radius;
  const occluders: Segment[] = [];

  for (const segment of segments) {
    if (isDegenerate(segment)) continue;
    if (distanceToPointSquared(segment, origin) > radiusSquared) continue;
    if (!treatOneSidedAsSolid && !blocksFrom(segment, origin)) continue;
    occluders.push(segment);
  }

  return occluders;
}

/** Every angle worth casting a ray along, normalised to [0, 2PI) and deduplicated. */
function candidateAngles(
  origin: Vector2,
  segments: readonly Segment[],
  arcSamples: number,
  cornerEpsilon: number,
): number[] {
  const angles: number[] = [];

  for (let i = 0; i < arcSamples; i++) {
    angles.push((i / arcSamples) * TWO_PI);
  }

  for (const segment of segments) {
    for (const endpoint of [segment.a, segment.b]) {
      const angle = angleOf(subtract(endpoint, origin));
      // The exact ray lands on the corner; the nudged pair reaches whatever is behind it.
      angles.push(angle - cornerEpsilon, angle, angle + cornerEpsilon);
    }
  }

  return sortedUniqueAngles(angles);
}

function sortedUniqueAngles(angles: readonly number[]): number[] {
  const normalized = angles
    .map((angle) => ((angle % TWO_PI) + TWO_PI) % TWO_PI)
    .sort((a, b) => a - b);

  const unique: number[] = [];
  for (const angle of normalized) {
    const previous = unique[unique.length - 1];
    if (previous === undefined || angle - previous > ANGLE_DEDUPE_EPSILON) {
      unique.push(angle);
    }
  }

  return unique;
}
