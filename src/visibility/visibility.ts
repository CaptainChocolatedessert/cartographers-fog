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
 * Cone lights are handled — see `coneAngle`. The convention they assume is unverified, but the
 * direction of any error is safe: a cone is a subset of the circle this used to sweep regardless
 * of its facing, so a wrong guess can only reveal less, never more.
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
  /**
   * Full angular width of a cone light, in radians. Omit, or pass a full turn, for a circle.
   *
   * Maps to `Light.outerAngle` — the *outer* extent, deliberately, not `innerAngle`. Inner is where
   * the falloff begins, so sweeping it would under-report the dim fringe, and §4 records why
   * under-reporting is the worse error: it leaves permanent holes in explored ground.
   *
   * **The convention here is assumed, not verified**, in the same way `FRONT_SIDE_SIGN` is: the
   * cone is taken to be centred on `facing`, with `outerAngle` the total width rather than a
   * half-angle. No cone light has been available to check against. What makes shipping it safe
   * anyway is that a cone of *any* facing is a subset of the full circle this used to sweep — so
   * getting the convention wrong can only ever reveal less than the present behaviour does, never
   * more. It cannot introduce a reveal that is not already happening.
   */
  coneAngle?: number;
  /** Direction the cone points, in radians. Ignored unless `coneAngle` is a partial turn. */
  facing?: number;
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
  const cone = coneHalfWidth(options.coneAngle);
  const angles =
    cone === null
      ? candidateAngles(origin, occluders, arcSamples, cornerEpsilon)
      : coneAngles(
          origin,
          occluders,
          arcSamples,
          cornerEpsilon,
          options.facing ?? 0,
          cone,
        );

  // A cone is a pie slice, so the apex is part of the boundary. A full circle wraps around the
  // origin instead and must not include it — inserting it there would pinch the polygon shut
  // through its own middle.
  const polygon: Vector2[] = cone === null ? [] : [origin];
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

/**
 * Half the cone's width, or `null` when it is a full circle and the old path applies.
 *
 * Anything at or above a full turn is a circle. Anything at or below zero is treated as one too,
 * rather than as a light that sees nothing: a zero here is far more likely to mean "this light has
 * no cone configured" than "this light is blind", and the second reading would silently delete a
 * light's contribution.
 */
function coneHalfWidth(coneAngle: number | undefined): number | null {
  if (coneAngle === undefined) return null;
  if (!Number.isFinite(coneAngle)) return null;
  if (coneAngle <= 0 || coneAngle >= TWO_PI) return null;
  return coneAngle / 2;
}

/** Signed difference between two angles, wrapped to [-PI, PI]. */
function angleDelta(angle: number, from: number): number {
  let delta = (angle - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

/**
 * Candidate angles restricted to a cone, in order from one rim to the other.
 *
 * Ordered by offset from `facing` rather than by absolute angle, because a cone straddling zero
 * would otherwise be sorted into two groups at opposite ends of the range and the polygon would
 * fold through itself.
 *
 * Arc samples are spread across the cone rather than around the circle, so a narrow cone keeps a
 * smooth rim instead of inheriting whichever few of the circle's samples happened to land in it.
 */
function coneAngles(
  origin: Vector2,
  segments: readonly Segment[],
  arcSamples: number,
  cornerEpsilon: number,
  facing: number,
  halfWidth: number,
): number[] {
  // Both rims exactly, so the slice's straight edges are where they should be.
  const deltas: number[] = [-halfWidth, halfWidth];

  for (let i = 0; i <= arcSamples; i++) {
    deltas.push(-halfWidth + (i / arcSamples) * halfWidth * 2);
  }

  for (const segment of segments) {
    for (const endpoint of [segment.a, segment.b]) {
      const angle = angleOf(subtract(endpoint, origin));
      for (const candidate of [angle - cornerEpsilon, angle, angle + cornerEpsilon]) {
        const delta = angleDelta(candidate, facing);
        if (Math.abs(delta) <= halfWidth) deltas.push(delta);
      }
    }
  }

  deltas.sort((a, b) => a - b);

  const out: number[] = [];
  for (const delta of deltas) {
    if (out.length > 0 && Math.abs(delta - out[out.length - 1]!) < ANGLE_DEDUPE_EPSILON) {
      continue;
    }
    out.push(delta);
  }

  return out.map((delta) => facing + delta);
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
