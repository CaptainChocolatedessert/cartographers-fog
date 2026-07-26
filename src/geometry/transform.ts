/**
 * Item-local to world-space transforms.
 *
 * Wall `points` are in the item's local space, so they must be transformed by the item's
 * position, rotation and scale before any visibility maths touches them.
 *
 * This mirrors the SDK's `MathM.fromItem`, which composes translate x rotate x scale:
 *
 *   fromItem(item) = multiply(multiply(T, R), S)
 *
 * Expanding T*R*S and applying it to a column vector gives
 *
 *   x' = cos*sx*x - sin*sy*y + px
 *   y' = sin*sx*x + cos*sy*y + py
 *
 * i.e. scale first, then rotate, then translate — which is what `toWorld` does directly.
 * Reimplemented rather than imported because the SDK cannot load in a headless test; the
 * conventions here were read off `MathM.fromItem` and `MathM.fromRotation`, not assumed.
 *
 * Rotation is in **degrees**, per the SDK's own doc comment.
 */

import type { Vector2 } from "./vector";

/** The parts of an SDK `Item` that affect its transform. */
export interface Transformable {
  position: Vector2;
  rotation: number;
  scale: Vector2;
}

const DEGREES_TO_RADIANS = Math.PI / 180;

/** Transform a point from `item`'s local space into world space. */
export function toWorld(point: Vector2, item: Transformable): Vector2 {
  const radians = item.rotation * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const sx = point.x * item.scale.x;
  const sy = point.y * item.scale.y;

  return {
    x: cos * sx - sin * sy + item.position.x,
    y: sin * sx + cos * sy + item.position.y,
  };
}

/** Transform every point of `points` from `item`'s local space into world space. */
export function toWorldAll(
  points: readonly Vector2[],
  item: Transformable,
): Vector2[] {
  return points.map((point) => toWorld(point, item));
}
