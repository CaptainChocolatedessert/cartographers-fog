import { describe, expect, it } from "vitest";
import {
  MAX_CELLS,
  SUBDIVISIONS,
  cellBounds,
  cellCentre,
  cellCount,
  cellIndex,
  columnAt,
  createCellGrid,
  isInside,
  rowAt,
  sameGrid,
  type Bounds,
} from "./cellGrid";

const bounds: Bounds = { min: { x: 0, y: 0 }, max: { x: 1000, y: 500 } };

/**
 * Chosen so one cell is exactly 50 world units whatever SUBDIVISIONS is set to. Hardcoding a
 * dpi would couple every expectation below to a tunable constant.
 */
const DPI = 50 * SUBDIVISIONS;

describe("createCellGrid", () => {
  it("subdivides the scene grid", () => {
    const grid = createCellGrid(bounds, DPI);

    expect(grid.cellSize).toBe(DPI / SUBDIVISIONS);
    expect(grid.columns).toBe(1000 / (DPI / SUBDIVISIONS));
    expect(grid.rows).toBe(500 / (DPI / SUBDIVISIONS));
  });

  it("anchors the origin at the bounds minimum", () => {
    const offset = createCellGrid(
      { min: { x: -300, y: 40 }, max: { x: 100, y: 240 } },
      DPI,
    );
    expect(offset.origin).toEqual({ x: -300, y: 40 });
  });

  it("rounds partial cells up so no area is lost", () => {
    const grid = createCellGrid(
      { min: { x: 0, y: 0 }, max: { x: 101, y: 1 } },
      DPI,
    );
    expect(grid.columns).toBe(3); // 101 / 50 = 2.02 -> 3
    expect(grid.rows).toBe(1);
  });

  it("coarsens rather than clipping when a map is huge", () => {
    const huge = createCellGrid(
      { min: { x: 0, y: 0 }, max: { x: 100_000, y: 100_000 } },
      DPI,
    );

    expect(cellCount(huge)).toBeLessThanOrEqual(MAX_CELLS);
    // Still covers the whole map — coarser cells, not fewer of them.
    expect(huge.columns * huge.cellSize).toBeGreaterThanOrEqual(100_000);
    expect(huge.rows * huge.cellSize).toBeGreaterThanOrEqual(100_000);
  });

  it("survives a degenerate dpi without producing an infinite grid", () => {
    const grid = createCellGrid(bounds, 0);
    expect(grid.cellSize).toBeGreaterThan(0);
    expect(cellCount(grid)).toBeLessThanOrEqual(MAX_CELLS);
  });

  it("always has at least one cell", () => {
    const empty = createCellGrid(
      { min: { x: 5, y: 5 }, max: { x: 5, y: 5 } },
      DPI,
    );
    expect(cellCount(empty)).toBe(1);
  });
});

describe("coordinate mapping", () => {
  const grid = createCellGrid(bounds, DPI); // cellSize 50

  it("maps world positions to cells", () => {
    expect(columnAt(grid, 0)).toBe(0);
    expect(columnAt(grid, 49.9)).toBe(0);
    expect(columnAt(grid, 50)).toBe(1);
    expect(rowAt(grid, 125)).toBe(2);
  });

  it("reports out-of-range positions rather than clamping them", () => {
    expect(columnAt(grid, -1)).toBe(-1);
    expect(isInside(grid, -1, 0)).toBe(false);
    expect(isInside(grid, 0, grid.rows)).toBe(false);
    expect(isInside(grid, 0, 0)).toBe(true);
  });

  it("round-trips a cell centre back to its own cell", () => {
    for (const [column, row] of [[0, 0], [3, 7], [19, 9]] as const) {
      const centre = cellCentre(grid, column, row);
      expect(columnAt(grid, centre.x)).toBe(column);
      expect(rowAt(grid, centre.y)).toBe(row);
    }
  });

  it("gives cell bounds that meet exactly, without gaps or overlap", () => {
    const left = cellBounds(grid, 2, 0);
    const right = cellBounds(grid, 3, 0);
    expect(left.max.x).toBe(right.min.x);
    expect(left.max.x - left.min.x).toBe(grid.cellSize);
  });

  it("indexes rows contiguously", () => {
    expect(cellIndex(grid, 0, 0)).toBe(0);
    expect(cellIndex(grid, 1, 0)).toBe(1);
    expect(cellIndex(grid, 0, 1)).toBe(grid.columns);
  });
});

describe("sameGrid", () => {
  it("accepts identical grids and rejects any difference", () => {
    const grid = createCellGrid(bounds, DPI);

    expect(sameGrid(grid, createCellGrid(bounds, DPI))).toBe(true);
    expect(sameGrid(grid, createCellGrid(bounds, DPI * 2))).toBe(false);
    expect(
      sameGrid(
        grid,
        createCellGrid({ min: { x: 1, y: 0 }, max: { x: 1001, y: 500 } }, DPI),
      ),
    ).toBe(false);
  });
});
