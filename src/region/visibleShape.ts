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

/**
 * Cells per grid square for the transient mask this module rasterises into.
 *
 * **Not the region's own grid, and reusing that one was a mistake worth recording.** The region
 * grid is sized for something else entirely: it is persisted, covers the whole map, and trades
 * precision for encoded size. On a large map that lands around a quarter of a grid square per
 * cell — which quantised the visible outline into something visibly chunky, made the erosion bite
 * a quarter-square inward, and cost ~60ms per redraw scanning a whole-map grid to find a region
 * occupying under three hundred cells of it.
 *
 * This mask is transient, never stored, and only ever needs to cover what is currently visible. So
 * it is built fresh over the visible bounds at a resolution chosen for the boundary rather than for
 * storage. Sixteen per square is about 9 world units on the shipped grid — comfortably finer than
 * the mottle it is cutting — and because it covers a room or two rather than a map, the cell count
 * *falls* even as the cells shrink.
 */
const CELLS_PER_SQUARE = 16;

/**
 * Ceiling on the transient mask, so a scene with lights scattered across a huge map degrades to
 * coarser cells rather than to a pause. Cells are made bigger until it fits.
 */
const MAX_MASK_CELLS = 400_000;

/**
 * Enclosed gaps up to this many cells are filled before the outline is traced.
 *
 * Clipping a lit area to line of sight leaves the odd one-cell gap where a piece was dropped, and
 * a single unset cell traces as a small diamond — which is exactly the artefact it looked like on
 * screen. Filling is sound here in the way a general dilation would not be: a gap **enclosed by
 * visible cells** is surrounded by ground the party can see, so filling it cannot reveal anything
 * beyond a wall. Bounded by size so a genuine hole — a pillar standing in a lit room, which the
 * party really cannot see behind — survives and keeps its parchment.
 */
const MAX_FILLED_GAP_CELLS = 12;

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
 * @param dpi world units per grid square, which sets the mask's resolution. The mask is built
 * here rather than passed in — see `CELLS_PER_SQUARE` for why the region's own grid is the wrong
 * one to borrow.
 */
export function visibleShape(
  polygons: readonly (readonly Vector2[])[],
  dpi: number,
): VisibleShape {
  const usable = polygons.filter((polygon) => polygon.length >= 3);
  const grid = maskGridFor(usable, dpi);
  if (!grid) return { rings: [], cellsCovered: 0, cellsKept: 0 };

  const mask = createMask(grid);
  for (const polygon of usable) rasterizePolygon(mask, polygon);

  const covered = countCells(mask);
  fillEnclosedGaps(mask);
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
 * A mask covering everything visible, at a resolution chosen for the boundary.
 *
 * One cell of slack all round, so the border of zeroes the tracer needs is genuinely outside the
 * region and every ring closes into a loop rather than running off the edge.
 *
 * @returns `undefined` when there is nothing to cover.
 */
function maskGridFor(
  polygons: readonly (readonly Vector2[])[],
  dpi: number,
): CellGrid | undefined {
  if (polygons.length === 0) return undefined;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const point of polygon) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (!(maxX > minX) || !(maxY > minY)) return undefined;

  const width = maxX - minX;
  const height = maxY - minY;
  let cellSize = (dpi > 0 ? dpi : 150) / CELLS_PER_SQUARE;

  // Coarsen rather than clip, so a scene with lights spread across a big map loses precision
  // instead of losing area — the same trade the region's own grid makes.
  while ((width / cellSize + 3) * (height / cellSize + 3) > MAX_MASK_CELLS) {
    cellSize *= 2;
  }

  return {
    origin: { x: minX - cellSize, y: minY - cellSize },
    cellSize,
    columns: Math.ceil(width / cellSize) + 3,
    rows: Math.ceil(height / cellSize) + 3,
  };
}

/**
 * Fill unset regions that do not touch the mask's border, up to `MAX_FILLED_GAP_CELLS`.
 *
 * A flood fill from the border marks everything outside; whatever unset cells it never reaches are
 * enclosed, and therefore surrounded by ground the party can see. Filling those cannot reveal
 * anything past a wall, which is what separates this from a general dilation — a dilation would
 * push the *outer* boundary outward too, and outward beside a wall is the one move that is not
 * allowed here.
 */
function fillEnclosedGaps(mask: RegionMask): void {
  const { grid } = mask;
  const total = grid.columns * grid.rows;
  const outside = new Uint8Array(total);
  const queue: number[] = [];

  const consider = (column: number, row: number): void => {
    if (!isInside(grid, column, row)) return;
    const index = row * grid.columns + column;
    if (outside[index] === 1 || isSet(mask, column, row)) return;
    outside[index] = 1;
    queue.push(index);
  };

  for (let column = 0; column < grid.columns; column++) {
    consider(column, 0);
    consider(column, grid.rows - 1);
  }
  for (let row = 0; row < grid.rows; row++) {
    consider(0, row);
    consider(grid.columns - 1, row);
  }

  while (queue.length > 0) {
    const index = queue.pop()!;
    const column = index % grid.columns;
    const row = (index - column) / grid.columns;
    consider(column - 1, row);
    consider(column + 1, row);
    consider(column, row - 1);
    consider(column, row + 1);
  }

  // Every unset cell the flood never reached is enclosed. Group them so a big genuine hole — a
  // pillar — is kept while the one-cell gaps left by a dropped clip piece are filled.
  const visited = new Uint8Array(total);
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const index = row * grid.columns + column;
      if (outside[index] === 1 || visited[index] === 1) continue;
      if (isSet(mask, column, row)) continue;

      const group: number[] = [];
      const pending = [index];
      visited[index] = 1;
      while (pending.length > 0) {
        const current = pending.pop()!;
        group.push(current);
        const currentColumn = current % grid.columns;
        const currentRow = (current - currentColumn) / grid.columns;
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const nextColumn = currentColumn + dx;
          const nextRow = currentRow + dy;
          if (!isInside(grid, nextColumn, nextRow)) continue;
          const next = nextRow * grid.columns + nextColumn;
          if (visited[next] === 1 || outside[next] === 1) continue;
          if (isSet(mask, nextColumn, nextRow)) continue;
          visited[next] = 1;
          pending.push(next);
        }
      }

      if (group.length <= MAX_FILLED_GAP_CELLS) {
        for (const cell of group) {
          setCell(mask, cell % grid.columns, (cell - (cell % grid.columns)) / grid.columns);
        }
      }
    }
  }
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
