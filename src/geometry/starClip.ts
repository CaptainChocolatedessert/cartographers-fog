/**
 * Intersecting two visibility polygons, by decomposing both into triangle fans.
 *
 * ## Why this exists
 *
 * A light Dynamic Fog only reveals when it is in line of sight — a `SECONDARY` light, a brazier in
 * a room rather than a torch in a hand — illuminates an area the party can see *only where they
 * also have line of sight to it*. Expressing that needs a genuine polygon intersection: the lit
 * region, clipped to what can be seen. Nothing else in this project needed one, because every other
 * consumer works by testing points.
 *
 * ## Why fans, rather than a general polygon clipper
 *
 * General simple-polygon intersection means Greiner–Hormann or a sweep line, and both are notorious
 * for breaking on degeneracies — vertices lying exactly on edges, collinear overlaps. Visibility
 * polygons are unusually rich in exactly those cases, because their vertices sit on wall lines and
 * on shared ray directions, so the hard cases here are the common ones rather than the exotic ones.
 *
 * A visibility polygon is **star-shaped about its own light**: every point in it is joined to the
 * light by a segment lying wholly inside it, which is what "visible from here" means. So the fan of
 * triangles from the light to each boundary edge tiles the polygon exactly. Intersecting two
 * polygons then reduces to intersecting every pair of triangles — and a triangle is *convex*, which
 * puts the whole computation on Sutherland–Hodgman, the well-behaved case: it is exact for a convex
 * clip region, it is a dozen lines, and it has no degeneracy folklore attached.
 *
 * The result comes back as **a list of convex pieces rather than one polygon**, because merging
 * them would need the union operation this is deliberately avoiding. Every consumer here is happy
 * with pieces: the mask tests points against a list of polygons already, and the parchment stencil
 * punches a ring per piece.
 *
 * ## The soundness property, which is the point
 *
 * The requirement this serves is asymmetric (user, 2026-08-02): a hole in the parchment where none
 * should be reveals that a room exists at all, while a slightly ragged hole around somewhere the
 * party can genuinely see is fine. So every piece returned must lie **inside both inputs**, and
 * losing a sliver at a boundary costs nothing.
 *
 * Fan decomposition gives that by construction. Each triangle lies inside its own polygon by
 * star-shapedness, and Sutherland–Hodgman against a convex region returns a subset of the subject.
 * Simplification downstream keeps it, too: dropping vertices from a *convex* polygon can only
 * shrink it, and every piece here is convex.
 *
 * Pure: no SDK, no DOM.
 */

import { area, boundingBox, type BoundingBox } from "./polygon";
import type { Vector2 } from "./vector";

/** Pieces smaller than this in world units squared are dropped as numerical dust. */
const MIN_PIECE_AREA = 1e-6;

/**
 * The average of a convex polygon's vertices, which for a convex polygon is strictly interior.
 *
 * Used to decide which side of each edge is "inside" **without assuming a winding convention**.
 * The first version of this normalised winding with `signedArea` instead and inverted the whole
 * test, because that helper uses the trapezoid form whose sign is the opposite of the standard
 * shoelace — every vertex was clipped away and every result came back empty. Deriving the sense
 * from the polygon itself cannot go wrong that way, and Owlbear's y-down world makes any inherited
 * notion of "counter-clockwise" a poor thing to rely on regardless.
 */
function centroidOf(polygon: readonly Vector2[]): Vector2 {
  let x = 0;
  let y = 0;
  for (const point of polygon) {
    x += point.x;
    y += point.y;
  }
  return { x: x / polygon.length, y: y / polygon.length };
}

/**
 * Clip `subject` to the inside of convex `clip` (Sutherland–Hodgman).
 *
 * **`clip` must be convex** — that is the algorithm's one precondition, and the reason everything
 * above goes to the trouble of reducing to triangles. A non-convex clip silently returns nonsense
 * rather than failing, which is exactly the kind of quiet wrongness this project keeps paying for,
 * so callers inside this module only ever pass triangles.
 *
 * `subject` may be any simple polygon; the result is a subset of it.
 */
export function clipToConvex(
  subject: readonly Vector2[],
  clip: readonly Vector2[],
): Vector2[] {
  if (subject.length < 3 || clip.length < 3) return [];

  const interior = centroidOf(clip);
  let output = [...subject];

  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const edgeA = clip[i]!;
    const edgeB = clip[(i + 1) % clip.length]!;

    const cross = (p: Vector2): number =>
      (edgeB.x - edgeA.x) * (p.y - edgeA.y) - (edgeB.y - edgeA.y) * (p.x - edgeA.x);

    // Whichever side the interior point falls on is inside, whatever the winding. A zero here
    // means the centroid is collinear with the edge, which only happens on a degenerate clip;
    // skipping the edge keeps more than it should, which is the safe direction.
    const sense = cross(interior);
    if (sense === 0) continue;
    const side = (p: Vector2): number => cross(p) * Math.sign(sense);

    const input = output;
    output = [];

    for (let j = 0; j < input.length; j++) {
      const current = input[j]!;
      const previous = input[(j + input.length - 1) % input.length]!;
      const currentSide = side(current);
      const previousSide = side(previous);

      if (currentSide >= 0) {
        // Crossing into the half-plane: emit the crossing point before the vertex itself.
        if (previousSide < 0) {
          const crossing = intersectAt(previous, current, previousSide, currentSide);
          if (crossing) output.push(crossing);
        }
        output.push(current);
      } else if (previousSide >= 0) {
        const crossing = intersectAt(previous, current, previousSide, currentSide);
        if (crossing) output.push(crossing);
      }
    }
  }

  return output;
}

/** Where the segment crosses the edge, by linear interpolation on the two signed distances. */
function intersectAt(
  from: Vector2,
  to: Vector2,
  fromSide: number,
  toSide: number,
): Vector2 | null {
  const denominator = fromSide - toSide;
  if (denominator === 0) return null;
  const t = fromSide / denominator;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/** The triangle fan tiling a star-shaped polygon, skipping slivers with no area. */
function fanTriangles(
  origin: Vector2,
  polygon: readonly Vector2[],
): Vector2[][] {
  const triangles: Vector2[][] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const triangle = [origin, a, b];
    if (area(triangle) > MIN_PIECE_AREA) triangles.push(triangle);
  }
  return triangles;
}

export interface StarPolygon {
  /** The point the polygon is star-shaped about — the light it was swept from. */
  readonly origin: Vector2;
  readonly polygon: readonly Vector2[];
}

/**
 * The intersection of two star-shaped polygons, as a list of convex pieces.
 *
 * Every piece lies inside both inputs. The pieces are interior-disjoint and may be numerous; they
 * are not merged, for the reason the module header gives.
 *
 * Cost is the product of the two vertex counts, so **simplify before calling this**. At the ~2,750
 * vertices a raw visibility polygon carries, the product is millions of triangle pairs per redraw
 * and quite unaffordable; at the few dozen a simplified one carries it is trivial. The bounding-box
 * rejection below removes the great majority of pairs regardless, since two lights that overlap at
 * all usually overlap in a small part of each other's reach.
 */
export function intersectStarPolygons(
  first: StarPolygon,
  second: StarPolygon,
  minArea = MIN_PIECE_AREA,
): Vector2[][] {
  if (first.polygon.length < 3 || second.polygon.length < 3) return [];

  // Whole-polygon rejection first: the common case is two lights nowhere near each other.
  if (!boundsOverlap(boundingBox(first.polygon), boundingBox(second.polygon))) {
    return [];
  }

  const firstFan = fanTriangles(first.origin, first.polygon);
  const secondFan = fanTriangles(second.origin, second.polygon);
  const secondBounds = secondFan.map((triangle) => boundingBox(triangle));

  const pieces: Vector2[][] = [];
  for (const triangle of firstFan) {
    const bounds = boundingBox(triangle);
    for (let i = 0; i < secondFan.length; i++) {
      if (!boundsOverlap(bounds, secondBounds[i]!)) continue;
      const piece = clipToConvex(triangle, secondFan[i]!);
      // Slivers are dropped rather than kept. A fan intersection generates a great many of them
      // along the seams between triangles, and they cost as much to carry as a real piece — the
      // parchment stencil started dropping cut-outs wholesale under their weight. Discarding is
      // also the safe direction: less revealed, never more.
      if (piece.length >= 3 && area(piece) > minArea) {
        pieces.push(piece);
      }
    }
  }

  return pieces;
}

function boundsOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return !(
    a.max.x < b.min.x ||
    b.max.x < a.min.x ||
    a.max.y < b.min.y ||
    b.max.y < a.min.y
  );
}
