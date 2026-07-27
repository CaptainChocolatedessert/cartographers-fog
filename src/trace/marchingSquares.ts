/**
 * Marching squares — isocontours of a scalar field, stitched into polylines.
 *
 * DESIGN.md §2 step 3. The output is the raw traced geometry, before simplification and
 * before being chopped into the per-segment units §3 masks against.
 *
 * ## Why crossings are keyed by grid edge rather than by coordinate
 *
 * The textbook implementation emits two loose points per cell and then joins segments whose
 * endpoints coincide. That join is a float equality test, and it fails intermittently: the
 * same crossing computed from two adjacent cells can differ in the last bit, so a contour
 * silently breaks into fragments and every downstream count is wrong in a way that looks
 * like a tracing artifact rather than a bug.
 *
 * Here a crossing is identified by *which grid edge it lies on* — an integer — and its
 * coordinate is computed once per edge. Stitching is then exact integer bookkeeping, and
 * two cells sharing an edge share the point object by construction.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "../geometry/vector";
import type { ScalarField } from "./field";

export interface Contour {
  /** Pixel-space points. Closed contours do NOT repeat the first point at the end. */
  readonly points: readonly Vector2[];
  /** True when the contour forms a loop; false for one that runs off the image border. */
  readonly closed: boolean;
}

/**
 * Trace every contour at `level`.
 *
 * Cells are the squares *between* samples, so a `w × h` field has `(w-1) × (h-1)` cells and
 * contours live strictly inside the image. A feature touching the image border produces an
 * open contour ending at the border rather than a loop.
 */
export function traceContours(
  field: ScalarField,
  level: number,
): Contour[] {
  const { width, height } = field;
  if (width < 2 || height < 2) return [];

  // A crossing point per grid edge, created on demand. Horizontal edges are indexed
  // (y * width + x) for the edge from (x,y) to (x+1,y); vertical edges use the same layout
  // for the edge from (x,y) to (x,y+1), offset past the horizontal block.
  const verticalBase = width * height;
  const points = new Map<number, Vector2>();
  // Up to two neighbouring crossings per crossing — a contour never branches, because each
  // cell contributes at most one segment per edge it uses.
  const links = new Map<number, number[]>();

  const value = (x: number, y: number) => field.data[y * width + x]!;

  const horizontalKey = (x: number, y: number) => y * width + x;
  const verticalKey = (x: number, y: number) => verticalBase + y * width + x;

  const crossing = (
    key: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number => {
    if (!points.has(key)) {
      const a = value(ax, ay);
      const b = value(bx, by);
      const denominator = b - a;
      // A zero denominator means both corners sit exactly on the level; the midpoint is as
      // defensible as anything else and keeps the contour continuous.
      const t = denominator === 0 ? 0.5 : (level - a) / denominator;
      const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
      points.set(key, {
        x: ax + (bx - ax) * clamped,
        y: ay + (by - ay) * clamped,
      });
    }
    return key;
  };

  const connect = (a: number, b: number) => {
    (links.get(a) ?? setEmpty(links, a)).push(b);
    (links.get(b) ?? setEmpty(links, b)).push(a);
  };

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const topLeft = value(x, y);
      const topRight = value(x + 1, y);
      const bottomRight = value(x + 1, y + 1);
      const bottomLeft = value(x, y + 1);

      // Bit per corner, set when the corner is at or above the level.
      const code =
        (topLeft >= level ? 1 : 0) |
        (topRight >= level ? 2 : 0) |
        (bottomRight >= level ? 4 : 0) |
        (bottomLeft >= level ? 8 : 0);

      if (code === 0 || code === 15) continue;

      const top = () => crossing(horizontalKey(x, y), x, y, x + 1, y);
      const bottom = () =>
        crossing(horizontalKey(x, y + 1), x, y + 1, x + 1, y + 1);
      const left = () => crossing(verticalKey(x, y), x, y, x, y + 1);
      const right = () => crossing(verticalKey(x + 1, y), x + 1, y, x + 1, y + 1);

      switch (code) {
        case 1:
        case 14:
          connect(left(), top());
          break;
        case 2:
        case 13:
          connect(top(), right());
          break;
        case 3:
        case 12:
          connect(left(), right());
          break;
        case 4:
        case 11:
          connect(right(), bottom());
          break;
        case 6:
        case 9:
          connect(top(), bottom());
          break;
        case 7:
        case 8:
          connect(left(), bottom());
          break;
        // Ambiguous saddles: two opposite corners inside, two outside, and the cell alone
        // cannot say whether the inside or the outside is the connected one. Resolved by the
        // centre's value, estimated as the corner average — the standard resolution, and the
        // one that keeps a diagonal corridor connected rather than pinching it shut.
        case 5: {
          const centreInside =
            (topLeft + topRight + bottomRight + bottomLeft) / 4 >= level;
          if (centreInside) {
            connect(top(), right());
            connect(left(), bottom());
          } else {
            connect(left(), top());
            connect(right(), bottom());
          }
          break;
        }
        case 10: {
          const centreInside =
            (topLeft + topRight + bottomRight + bottomLeft) / 4 >= level;
          if (centreInside) {
            connect(left(), top());
            connect(right(), bottom());
          } else {
            connect(top(), right());
            connect(left(), bottom());
          }
          break;
        }
      }
    }
  }

  return stitch(points, links);
}

function setEmpty(map: Map<number, number[]>, key: number): number[] {
  const list: number[] = [];
  map.set(key, list);
  return list;
}

/**
 * Walk the crossing graph into polylines.
 *
 * Open contours first, started from their endpoints (degree 1) so each is walked once end to
 * end; whatever remains is loops. Doing it the other way round would enter an open contour in
 * the middle and split it in two.
 */
function stitch(
  points: Map<number, Vector2>,
  links: Map<number, number[]>,
): Contour[] {
  const contours: Contour[] = [];
  const visited = new Set<number>();

  const walk = (start: number, closed: boolean): Contour => {
    const chain: Vector2[] = [];
    let current = start;
    let previous = -1;

    for (;;) {
      visited.add(current);
      chain.push(points.get(current)!);

      const neighbours = links.get(current) ?? [];
      let next = -1;
      for (const candidate of neighbours) {
        if (candidate !== previous && !visited.has(candidate)) {
          next = candidate;
          break;
        }
      }
      if (next === -1) break;

      previous = current;
      current = next;
    }

    return { points: chain, closed };
  };

  for (const [key, neighbours] of links) {
    if (neighbours.length === 1 && !visited.has(key)) {
      contours.push(walk(key, false));
    }
  }

  for (const key of links.keys()) {
    if (!visited.has(key)) contours.push(walk(key, true));
  }

  return contours.filter((contour) => contour.points.length >= 2);
}
