/**
 * The cell grid the discovered region is tracked on.
 *
 * DESIGN.md's open question on region encoding resolves to a grid bitmask: cheapest to
 * point-test, fits the 16KB scene-metadata cap once compressed, and makes tile classification
 * nearly free if the raster renderer is ever built.
 *
 * Cells are a subdivision of the scene grid rather than whole grid squares. A whole square
 * would be marked explored when the party only glimpsed its corner, which both over-reports
 * exploration and risks revealing map detail nobody saw. Halving is a compromise, not a
 * principle — `SUBDIVISIONS` is the knob.
 */

import type { Vector2 } from "../geometry/vector";

/**
 * Cells per grid square along each axis.
 *
 * Finer is better and the ideal is pixel resolution, which a stored bitmask cannot reach: a
 * pixel mask of a 4096-square map is megabytes before encoding, against a ~16KB metadata cap.
 * So this is a compromise, and how much it costs depends on the renderer — for vector sketch
 * strokes it is already finer than the segments it gates (DESIGN.md §3), but for a masked map
 * image the region boundary *is* the visible edge and stair-stepping shows.
 *
 * If the raster renderer wins, expect to store the region as polygons instead and derive a
 * mask like this one locally for cheap point tests. See DESIGN.md, "Storing the discovered
 * region".
 */
export const SUBDIVISIONS = 4;

/**
 * Upper bound on total cells, so a very large map coarsens instead of blowing the metadata
 * budget. 65536 cells is 8KB raw and far less once run-length encoded.
 */
export const MAX_CELLS = 256 * 256;

export interface Bounds {
  min: Vector2;
  max: Vector2;
}

export interface CellGrid {
  /** World-space origin of cell (0, 0). */
  readonly origin: Vector2;
  /** World-space size of one cell, square. */
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
}

/**
 * Build a cell grid covering `bounds`.
 *
 * `dpi` is the scene grid's world units per square (`OBR.scene.grid.getDpi()`). The requested
 * cell size is `dpi / SUBDIVISIONS`, coarsened by whole steps until the grid fits `MAX_CELLS`
 * — coarsening rather than clipping, so a big map loses precision instead of losing area.
 */
export function createCellGrid(bounds: Bounds, dpi: number): CellGrid {
  const width = Math.max(0, bounds.max.x - bounds.min.x);
  const height = Math.max(0, bounds.max.y - bounds.min.y);

  let cellSize = dpi / SUBDIVISIONS;
  if (!(cellSize > 0)) cellSize = dpi > 0 ? dpi : 1;

  let columns = Math.max(1, Math.ceil(width / cellSize));
  let rows = Math.max(1, Math.ceil(height / cellSize));

  while (columns * rows > MAX_CELLS) {
    cellSize *= 2;
    columns = Math.max(1, Math.ceil(width / cellSize));
    rows = Math.max(1, Math.ceil(height / cellSize));
  }

  return { origin: { ...bounds.min }, cellSize, columns, rows };
}

/** Column index containing world x. May fall outside [0, columns). */
export function columnAt(grid: CellGrid, x: number): number {
  return Math.floor((x - grid.origin.x) / grid.cellSize);
}

/** Row index containing world y. May fall outside [0, rows). */
export function rowAt(grid: CellGrid, y: number): number {
  return Math.floor((y - grid.origin.y) / grid.cellSize);
}

export function isInside(grid: CellGrid, column: number, row: number): boolean {
  return column >= 0 && row >= 0 && column < grid.columns && row < grid.rows;
}

export function cellIndex(grid: CellGrid, column: number, row: number): number {
  return row * grid.columns + column;
}

export function cellCount(grid: CellGrid): number {
  return grid.columns * grid.rows;
}

/** World-space centre of a cell — the point tested against visibility polygons. */
export function cellCentre(
  grid: CellGrid,
  column: number,
  row: number,
): Vector2 {
  return {
    x: grid.origin.x + (column + 0.5) * grid.cellSize,
    y: grid.origin.y + (row + 0.5) * grid.cellSize,
  };
}

/** World-space bounds of a cell, used when emitting the region as geometry. */
export function cellBounds(
  grid: CellGrid,
  column: number,
  row: number,
): Bounds {
  const x = grid.origin.x + column * grid.cellSize;
  const y = grid.origin.y + row * grid.cellSize;
  return {
    min: { x, y },
    max: { x: x + grid.cellSize, y: y + grid.cellSize },
  };
}

/**
 * Whether two grids address the same cells. Persisted regions are only meaningful against the
 * grid they were recorded on, so this gates reuse of stored data.
 */
export function sameGrid(a: CellGrid, b: CellGrid): boolean {
  return (
    a.columns === b.columns &&
    a.rows === b.rows &&
    a.cellSize === b.cellSize &&
    a.origin.x === b.origin.x &&
    a.origin.y === b.origin.y
  );
}
