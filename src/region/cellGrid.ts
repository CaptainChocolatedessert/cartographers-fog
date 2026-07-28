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
 * Fewest cells along either axis, whatever the scene's grid says.
 *
 * `SUBDIVISIONS` alone ties cell size to the *grid*, which breaks down on a map that spans few
 * grid squares. Measured on the test scene: 816x1056 world units at dpi 150 is 5.4 squares
 * across, giving 37.5-unit cells — a 22x29 grid for the whole map. Two things were then wrong
 * at once. The cells were larger than the traced segments they gate (37.5 against ~24.5 units),
 * inverting DESIGN.md §3's assumption that the mask is finer than the geometry it masks; and
 * they were comparable to a light's own diameter (90 units), so a token's whole field of view
 * quantised to a handful of cells and exploration was recorded as blocks rather than a path.
 *
 * 200 per axis puts the test scene at ~4 units per cell: six times finer than a segment, and
 * over twenty times finer than a light. Bounded below by the map's own pixel size — see
 * `CellGridOptions.minCellSize` — since a cell smaller than a pixel records detail the image
 * does not have.
 */
export const MIN_CELLS_PER_AXIS = 200;

/**
 * Upper bound on total cells.
 *
 * Raised from 256x256 when `MIN_CELLS_PER_AXIS` arrived, which the old ceiling would have
 * fought on any map more elongated than about 1.6:1. Storage is not the constraint it was
 * assumed to be: no metadata limit was found below 512KB per key, against realistic encoded
 * regions of 0.5-4KB, and encoding scales with the region's perimeter rather than its cell
 * count (DESIGN.md, "Storage limits"). Masking scales with visible area, not grid size, and
 * measured ~11ms at 1024x1024. The wash renderer already chunks against the item command limit.
 */
export const MAX_CELLS = 512 * 512;

export interface CellGridOptions {
  /**
   * Never make a cell smaller than this — one pixel of the map image, in world units.
   *
   * Below a pixel the region records distinctions the source cannot support, at a cost in
   * memory and encoded size that buys nothing.
   */
  readonly minCellSize?: number;
}

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
 * `dpi` is the scene grid's world units per square (`OBR.scene.grid.getDpi()`). Cell size starts
 * at `dpi / SUBDIVISIONS`, is then refined until both axes hold at least `MIN_CELLS_PER_AXIS`
 * cells — never below `minCellSize` — and finally coarsened by whole steps until the grid fits
 * `MAX_CELLS`. Coarsening rather than clipping, so a big map loses precision instead of area.
 *
 * The refinement is what makes the grid usable on a map spanning few grid squares; the
 * subdivision alone is far too coarse there. On a large map the subdivision is already finer
 * than the floor and nothing changes.
 */
export function createCellGrid(
  bounds: Bounds,
  dpi: number,
  options: CellGridOptions = {},
): CellGrid {
  const width = Math.max(0, bounds.max.x - bounds.min.x);
  const height = Math.max(0, bounds.max.y - bounds.min.y);

  let cellSize = dpi / SUBDIVISIONS;
  if (!(cellSize > 0)) cellSize = dpi > 0 ? dpi : 1;

  // Refine to the per-axis floor. Driven by the *shorter* axis's requirement, since cells are
  // square and both axes must clear the floor.
  const minCellSize =
    options.minCellSize && options.minCellSize > 0 ? options.minCellSize : 0;
  const byFloor = Math.min(
    width > 0 ? width / MIN_CELLS_PER_AXIS : Infinity,
    height > 0 ? height / MIN_CELLS_PER_AXIS : Infinity,
  );
  if (Number.isFinite(byFloor)) {
    // Only ever refines. Without this guard a `minCellSize` coarser than the subdivision would
    // make cells *larger* than asked for, which is not what a floor on cell size means.
    const refined = Math.max(byFloor, minCellSize);
    if (refined < cellSize) cellSize = refined;
  }

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
