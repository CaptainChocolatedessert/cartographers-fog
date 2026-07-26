/**
 * The discovered region, as a set of cells on a `CellGrid`.
 *
 * One byte per cell rather than packed bits: the constrained resource is scene metadata, not
 * RAM, and the codec run-length encodes for storage anyway. A 256x256 grid is 64KB in memory
 * and a few hundred bytes on the wire.
 *
 * `discovered` only ever grows (DESIGN.md §4), which is what makes `union` the only mutating
 * operation needed and makes repeated accumulation idempotent.
 */

import {
  cellBounds,
  cellCentre,
  cellCount,
  cellIndex,
  columnAt,
  isInside,
  rowAt,
  type Bounds,
  type CellGrid,
} from "./cellGrid";
import { pointInPolygon } from "../geometry/polygon";
import { boundingBox } from "../geometry/polygon";
import type { Vector2 } from "../geometry/vector";

export interface RegionMask {
  readonly grid: CellGrid;
  readonly cells: Uint8Array;
}

export function createMask(grid: CellGrid): RegionMask {
  return { grid, cells: new Uint8Array(cellCount(grid)) };
}

export function cloneMask(mask: RegionMask): RegionMask {
  return { grid: mask.grid, cells: new Uint8Array(mask.cells) };
}

export function isSet(mask: RegionMask, column: number, row: number): boolean {
  if (!isInside(mask.grid, column, row)) return false;
  return mask.cells[cellIndex(mask.grid, column, row)] === 1;
}

export function setCell(mask: RegionMask, column: number, row: number): void {
  if (!isInside(mask.grid, column, row)) return;
  mask.cells[cellIndex(mask.grid, column, row)] = 1;
}

/** Whether the cell containing this world point is set. The masking primitive. */
export function containsPoint(mask: RegionMask, point: Vector2): boolean {
  return isSet(
    mask,
    columnAt(mask.grid, point.x),
    rowAt(mask.grid, point.y),
  );
}

export function countSet(mask: RegionMask): number {
  let total = 0;
  for (const cell of mask.cells) if (cell === 1) total++;
  return total;
}

/**
 * Add every cell of `addition` into `target`.
 *
 * @returns how many cells this actually added — zero means the region did not grow, which is
 * worth knowing before writing to shared metadata.
 */
export function unionInto(target: RegionMask, addition: RegionMask): number {
  let added = 0;
  const size = Math.min(target.cells.length, addition.cells.length);
  for (let i = 0; i < size; i++) {
    if (addition.cells[i] === 1 && target.cells[i] !== 1) {
      target.cells[i] = 1;
      added++;
    }
  }
  return added;
}

/**
 * Mark every cell whose centre falls inside `polygon`.
 *
 * Centre sampling, so a cell counts as explored only when the party could see its middle. That
 * errs toward under-reporting at the boundary, which is the right direction for `discovered`
 * per DESIGN.md §4 — over-reporting would mark ground explored that nobody could make out.
 *
 * Only cells within the polygon's bounding box are tested, which matters because this runs
 * against a fresh visibility polygon on every commit.
 */
export function rasterizePolygon(
  mask: RegionMask,
  polygon: readonly Vector2[],
): void {
  if (polygon.length < 3) return;

  const bounds = boundingBox(polygon);
  const firstColumn = Math.max(0, columnAt(mask.grid, bounds.min.x));
  const lastColumn = Math.min(
    mask.grid.columns - 1,
    columnAt(mask.grid, bounds.max.x),
  );
  const firstRow = Math.max(0, rowAt(mask.grid, bounds.min.y));
  const lastRow = Math.min(mask.grid.rows - 1, rowAt(mask.grid, bounds.max.y));

  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      if (isSet(mask, column, row)) continue;
      // `bounds` is already computed above — reuse it rather than let pointInPolygon
      // rebuild it per cell.
      if (pointInPolygon(cellCentre(mask.grid, column, row), polygon, bounds)) {
        setCell(mask, column, row);
      }
    }
  }
}

/**
 * Cells set in `mask` but not covered by any polygon in `subtract`.
 *
 * This is `sketch_region = discovered − currently_visible` (DESIGN.md §4). The subtraction
 * takes polygons rather than a mask so it stays at full precision — `currently_visible` is
 * transient and never persisted, so there is no reason to quantise it.
 */
export function subtractPolygons(
  mask: RegionMask,
  subtract: readonly (readonly Vector2[])[],
): RegionMask {
  const result = createMask(mask.grid);
  if (subtract.length === 0) {
    result.cells.set(mask.cells);
    return result;
  }

  // Start from everything discovered, then clear what is currently visible. Inverting the
  // loop this way bounds the work by the *visible* area rather than the whole grid: cells
  // outside every polygon's bounding box cannot be cleared, so they need never be visited.
  // Since `currently_visible` is a few lights' worth of area on a map that may be mostly
  // explored, that is the difference between scanning 65,536 cells and about a thousand.
  result.cells.set(mask.cells);

  for (const polygon of subtract) {
    if (polygon.length < 3) continue;

    // Hoisted deliberately. Rebuilding this inside `pointInPolygon` costs a full pass over
    // the vertices before it can reject, and visibility polygons carry thousands of them.
    const bounds = boundingBox(polygon);

    const firstColumn = Math.max(0, columnAt(mask.grid, bounds.min.x));
    const lastColumn = Math.min(
      mask.grid.columns - 1,
      columnAt(mask.grid, bounds.max.x),
    );
    const firstRow = Math.max(0, rowAt(mask.grid, bounds.min.y));
    const lastRow = Math.min(mask.grid.rows - 1, rowAt(mask.grid, bounds.max.y));

    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        if (!isSet(result, column, row)) continue;
        if (pointInPolygon(cellCentre(mask.grid, column, row), polygon, bounds)) {
          result.cells[cellIndex(mask.grid, column, row)] = 0;
        }
      }
    }
  }

  return result;
}

/**
 * Merge set cells into maximal horizontal runs.
 *
 * Emitting one rectangle per cell would put tens of thousands of path commands into a single
 * item; runs typically cut that by an order of magnitude and are trivial to compute, since a
 * row is already contiguous in memory.
 */
export function toRuns(mask: RegionMask): Bounds[] {
  const runs: Bounds[] = [];

  for (let row = 0; row < mask.grid.rows; row++) {
    let runStart = -1;

    for (let column = 0; column <= mask.grid.columns; column++) {
      const filled = column < mask.grid.columns && isSet(mask, column, row);

      if (filled && runStart === -1) {
        runStart = column;
      } else if (!filled && runStart !== -1) {
        const start = cellBounds(mask.grid, runStart, row);
        const end = cellBounds(mask.grid, column - 1, row);
        runs.push({ min: start.min, max: end.max });
        runStart = -1;
      }
    }
  }

  return runs;
}
