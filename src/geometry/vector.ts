/**
 * Vector2 maths.
 *
 * Structurally identical to the SDK's `Vector2`, so real scene items pass straight in —
 * but with no import from `@owlbear-rodeo/sdk`, which touches `window` at module load and
 * therefore cannot be imported into a headless test. See DESIGN.md, "Testing strategy":
 * the pure layer stays SDK-free so the hard logic is testable without a browser.
 */

export interface Vector2 {
  x: number;
  y: number;
}

export const ORIGIN: Vector2 = { x: 0, y: 0 };

export function add(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vector2, k: number): Vector2 {
  return { x: v.x * k, y: v.y * k };
}

export function dot(a: Vector2, b: Vector2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * 2D cross product — the z component of the 3D cross product.
 *
 * Sign tells you which side of `a` the vector `b` lies on, which is the workhorse of both
 * ray/segment intersection and the one-sided wall test.
 */
export function cross(a: Vector2, b: Vector2): number {
  return a.x * b.y - a.y * b.x;
}

export function lengthSquared(v: Vector2): number {
  return v.x * v.x + v.y * v.y;
}

export function length(v: Vector2): number {
  return Math.sqrt(lengthSquared(v));
}

export function distanceSquared(a: Vector2, b: Vector2): number {
  return lengthSquared(subtract(a, b));
}

export function distance(a: Vector2, b: Vector2): number {
  return Math.sqrt(distanceSquared(a, b));
}

/** Returns a zero vector when `v` has no length, matching the SDK's `Math2.normalize`. */
export function normalize(v: Vector2): Vector2 {
  const len = length(v);
  return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

/** Unit vector at `radians`, measured with atan2 conventions. */
export function fromAngle(radians: number, magnitude = 1): Vector2 {
  return { x: Math.cos(radians) * magnitude, y: Math.sin(radians) * magnitude };
}

/** Angle of `v` in radians, in (-PI, PI]. */
export function angleOf(v: Vector2): number {
  return Math.atan2(v.y, v.x);
}

export function equals(a: Vector2, b: Vector2, epsilon = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}
