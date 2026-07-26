/**
 * Adapter from Owlbear `Wall` items to the pure geometry the visibility code consumes.
 *
 * This is the boundary DESIGN.md's testing strategy depends on: everything downstream is
 * pure functions over plain data, so it runs headlessly. `Wall` is imported as a **type
 * only** — erased at compile time under `verbatimModuleSyntax`, so nothing here pulls the
 * SDK into a test process, which matters because importing the SDK touches `window` at
 * module load and throws outside a browser.
 */

import type { Wall } from "@owlbear-rodeo/sdk";
import { toWorldAll } from "../geometry/transform";
import type { Transformable } from "../geometry/transform";
import { isDegenerate, type Segment } from "../geometry/segment";
import type { Vector2 } from "../geometry/vector";

/**
 * The parts of a `Wall` that matter here.
 *
 * Declared structurally rather than as the SDK's `Wall` so tests can build fixtures without
 * inventing the dozen unrelated `Item` fields (`id`, `lastModifiedUserId`, `metadata`, ...).
 */
export interface WallLike extends Transformable {
  points: readonly Vector2[];
  blocking: boolean;
  doubleSided: boolean;
}

/**
 * Compile-time proof that the SDK's real `Wall` still satisfies `WallLike`. If Owlbear
 * changes the shape of `Wall`, this fails to compile rather than failing silently at
 * runtime in a room.
 */
type AssertAssignable<T extends U, U> = T extends U ? true : never;
export type WallSatisfiesWallLike = AssertAssignable<Wall, WallLike>;

/**
 * Flatten walls into world-space segments.
 *
 * A `Wall` is a polyline, so each consecutive pair of its points becomes a segment. Points
 * are in item-local space and are transformed by the item's position, rotation and scale.
 *
 * Non-blocking walls are dropped — `blocking` is the semantic flag for whether a wall stops
 * sight. Note that `visible` is deliberately *not* consulted: it governs whether the wall is
 * drawn in the editor, not whether it occludes.
 */
export function wallsToSegments(walls: readonly WallLike[]): Segment[] {
  const segments: Segment[] = [];

  for (const wall of walls) {
    if (!wall.blocking) continue;
    if (wall.points.length < 2) continue;

    const worldPoints = toWorldAll(wall.points, wall);
    const oneSided = !wall.doubleSided;

    for (let i = 1; i < worldPoints.length; i++) {
      const a = worldPoints[i - 1]!;
      const b = worldPoints[i]!;
      const segment: Segment = { a, b, oneSided };

      // Duplicate consecutive points are common in hand-drawn walls and contribute
      // nothing but a divide-by-zero risk downstream.
      if (isDegenerate(segment)) continue;

      segments.push(segment);
    }
  }

  return segments;
}
