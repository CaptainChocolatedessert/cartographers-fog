/**
 * The currently-visible region as a small set of smooth rings, for the parchment stencil.
 *
 * ## Why this exists rather than punching each polygon as its own hole
 *
 * The stencil is one `Path` with `fillRule: "evenodd"` — the map's extent as the outer ring and
 * everything visible punched out as inner rings. That works only while the inner rings are
 * *disjoint*, and two things broke that once lights stopped being interchangeable:
 *
 * - **Overlapping holes fill back in.** Even-odd counts crossings, so a point inside the outer
 *   ring and two holes has three and is filled. A torch standing in a brazier-lit room overlaps
 *   that brazier's lit area, so the overlap turned back into parchment (user, 2026-08-02).
 * - **Abutting holes show their seams.** Clipping a lit area to line of sight produced a fan of
 *   small pieces sharing radial edges, and those edges rasterised as dotted lines running
 *   outward from every light.
 *
 * Both are properties of the representation rather than bugs in the geometry, and patching either
 * one bought the other. So the region is unioned in a **bitmap**, where overlap is meaningless —
 * marking a cell twice is marking it once — and there are no internal edges to show. Then it is
 * traced back out to vectors, so the result is still resolution-independent linework rather than
 * visible stair-steps.
 *
 * ## Every approximation shrinks, and that is the whole safety argument
 *
 * The requirement is asymmetric (user, 2026-08-02): a hole where none belongs advertises that a
 * room exists, while a slightly small or slightly ragged hole around ground the party can see is
 * fine. So each stage errs inward, and the result is sound by construction rather than by
 * inspection:
 *
 * 1. **Rasterising samples cell centres**, so a cell counts only when its middle is visible.
 * 2. **Eroding** drops any cell with an unset neighbour, pulling the boundary a full cell inside.
 * 3. **Simplifying** may cut a corner outward, but by at most its tolerance — which is held at or
 *    below the erosion distance, so it can never spend more than step 2 banked.
 *
 * Step 3 is the one that matters and the reason erosion is not optional: Douglas–Peucker cutting
 * across a concave bend moves the boundary *outward*, and outward next to a wall means into the
 * room beyond it. Smoothing a raster without first eroding it would reintroduce exactly the
 * failure this whole design exists to prevent.
 *
 * Pure: no SDK, no DOM.
 */

import { isInside, type CellGrid } from "./cellGrid";
import {
  createMask,
  isSet,
  rasterizePolygon,
  setCell,
  type RegionMask,
} from "./regionMask";
import { traceContours } from "../trace/marchingSquares";
import { simplifyPolyline } from "../trace/simplify";
import type { Vector2 } from "../geometry/vector";

/**
 * How far the simplifier may move a vertex, as a share of the erosion it is spending.
 *
 * Strictly under one so the two cannot cancel exactly at a corner where the simplifier moves the
 * boundary its full tolerance outward and the erosion has bought precisely that much.
 */
const SIMPLIFY_SHARE = 0.8;

/** Rings bounding the visible region, in world space, ready to punch as stencil holes. */
export interface VisibleShape {
  readonly rings: Vector2[][];
  /** Cells marked visible before erosion — reported so an empty result can be explained. */
  readonly cellsCovered: number;
  /** Cells surviving erosion. A large drop from `cellsCovered` means slivers, not a fault. */
  readonly cellsKept: number;
}

/**
 * Trace the union of `polygons` into rings.
 *
 * @param grid the region's own cell grid, reused so this inherits its sizing decisions rather
 * than inventing another. Its resolution is the fidelity ceiling here.
 */
export function visibleShape(
  grid: CellGrid,
  polygons: readonly (readonly Vector2[])[],
): VisibleShape {
  const mask = createMask(grid);
  for (const polygon of polygons) {
    if (polygon.length >= 3) rasterizePolygon(mask, polygon);
  }

  const covered = countCells(mask);
  const eroded = erode(mask);
  const kept = countCells(eroded);
  if (kept === 0) {
    return { rings: [], cellsCovered: covered, cellsKept: 0 };
  }

  // A one-cell border of zeroes all round, so a region touching the grid's edge still closes into
  // a loop. Without it marching squares returns an *open* contour ending at the border, which a
  // stencil ring cannot use — the hole would not be enclosed.
  const width = grid.columns + 2;
  const height = grid.rows + 2;
  const data = new Float32Array(width * height);
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      if (isSet(eroded, column, row)) data[(row + 1) * width + (column + 1)] = 1;
    }
  }

  const tolerance = grid.cellSize * SIMPLIFY_SHARE;
  const rings: Vector2[][] = [];
  for (const contour of traceContours({ width, height, data }, 0.5)) {
    // Field sample (i, j) is cell (i-1, j-1), whose centre is the sample's position — so a
    // contour coordinate maps to world by undoing the border and the half-cell centre offset.
    const world = contour.points.map((point) => ({
      x: grid.origin.x + (point.x - 0.5) * grid.cellSize,
      y: grid.origin.y + (point.y - 0.5) * grid.cellSize,
    }));

    const simplified = simplifyPolyline(world, tolerance);
    if (simplified.length >= 3) rings.push(simplified);
  }

  return { rings, cellsCovered: covered, cellsKept: kept };
}

/**
 * Drop every cell that has an unset neighbour, pulling the boundary one cell inward.
 *
 * Four-connected rather than eight: a diagonal neighbour touches only at a corner, and requiring
 * it as well erodes diagonal runs twice as fast for no gain in safety. Cells outside the grid
 * count as unset, so the region also pulls back from the grid's own edge.
 */
function erode(mask: RegionMask): RegionMask {
  const { grid } = mask;
  const out = createMask(grid);

  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      if (!isSet(mask, column, row)) continue;
      if (
        neighbourSet(mask, column - 1, row) &&
        neighbourSet(mask, column + 1, row) &&
        neighbourSet(mask, column, row - 1) &&
        neighbourSet(mask, column, row + 1)
      ) {
        setCell(out, column, row);
      }
    }
  }

  return out;
}

function neighbourSet(mask: RegionMask, column: number, row: number): boolean {
  if (!isInside(mask.grid, column, row)) return false;
  return isSet(mask, column, row);
}

function countCells(mask: RegionMask): number {
  let total = 0;
  for (let i = 0; i < mask.cells.length; i++) if (mask.cells[i] !== 0) total++;
  return total;
}
