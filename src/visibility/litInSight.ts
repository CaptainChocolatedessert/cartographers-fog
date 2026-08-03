/**
 * What the party can see of a light that does not reveal on its own.
 *
 * A `SECONDARY` light — Dynamic Fog's "only visible in line of sight" kind — illuminates an area,
 * but the party see that light only where they can also see *into* it. So its contribution is its
 * lit area intersected with the party's line of sight, and nothing where the two do not meet.
 *
 * **Shared because two places need the same answer.** The watcher computes it for what is
 * *currently* visible; the region tracker computes it again when replaying a moving light's
 * recorded path. Two copies of this rule would drift, and a disagreement between them is precisely
 * the class of bug that put holes in the parchment over rooms nobody had entered — one half of the
 * pipeline honouring a light type and the other ignoring it.
 *
 * Pure: no SDK, no DOM.
 */

import { intersectStarPolygons, type StarPolygon } from "../geometry/starClip";
import { pointInPolygon } from "../geometry/polygon";
import { simplifyPolyline } from "../trace/simplify";
import type { Vector2 } from "../geometry/vector";

/**
 * Tolerance the polygons are simplified to before clipping, in world units.
 *
 * The clipper's cost is the product of two vertex counts, and a raw visibility polygon carries
 * ~2,750 — millions of triangle pairs, quite unaffordable per redraw. A few dozen vertices makes it
 * trivial. Simplifying is safe here only because every piece is checked against the *unsimplified*
 * polygons afterwards; see below.
 */
const CLIP_TOLERANCE = 4;

/** Pieces below this, in square world units, are numerical dust from the fan seams. */
const MIN_PIECE_AREA = 1e-6;

/**
 * The parts of `lit` the party can actually see, as convex pieces.
 *
 * @param lit the light's illuminated polygon, star-shaped about `origin`.
 * @param sight one entry per light that reveals on its own — the party's line of sight, swept at
 * map scale rather than at lamp range, because you can see a lit hall from further away than your
 * own torch reaches.
 */
export function litInSight(
  lit: readonly Vector2[],
  origin: Vector2,
  sight: readonly StarPolygon[],
): Vector2[][] {
  if (lit.length < 3 || sight.length === 0) return [];

  const simplified = simplifyPolyline(lit, CLIP_TOLERANCE);
  if (simplified.length < 3) return [];

  const pieces: Vector2[][] = [];
  for (const seen of sight) {
    if (seen.polygon.length < 3) continue;

    const clipped = intersectStarPolygons(
      { origin, polygon: simplified },
      {
        origin: seen.origin,
        polygon: simplifyPolyline(seen.polygon, CLIP_TOLERANCE),
      },
      MIN_PIECE_AREA,
    );

    for (const piece of clipped) {
      // Rejects a piece that lands wholly outside either input — which simplification can produce
      // if it ever bridges a concavity entirely.
      //
      // **Its reach is narrower than it looks, and pretending otherwise would be worse than not
      // having it.** It cannot detect a *boundary* bulge, which is the more likely error: a fan
      // triangle is anchored at the light, so its centroid sits around two thirds of the way out,
      // nowhere near the edge being tested. No fixture has been found that makes this line fire,
      // and switching it off breaks no test. It is kept as cheap insurance against a gross
      // misplacement rather than as the guarantee.
      //
      // The real guarantee is that simplification moves a boundary by at most `CLIP_TOLERANCE` —
      // a few world units, against walls tens of units thick — so a bulge cannot reach past a wall
      // into a room the party cannot see. A test pins that bound.
      //
      // The centroid rather than every vertex: a piece's corners legitimately lie *on* a boundary,
      // where point-in-polygon promises nothing, and a convex piece's centroid is squarely inside.
      const centroid = centroidOf(piece);
      if (!pointInPolygon(centroid, seen.polygon)) continue;
      if (!pointInPolygon(centroid, lit)) continue;
      pieces.push(piece);
    }
  }

  return pieces;
}

function centroidOf(piece: readonly Vector2[]): Vector2 {
  let x = 0;
  let y = 0;
  for (const point of piece) {
    x += point.x;
    y += point.y;
  }
  return { x: x / piece.length, y: y / piece.length };
}
