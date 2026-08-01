import { describe, expect, it } from "vitest";
import { SUBDIVISIONS, createCellGrid, type Bounds } from "./cellGrid";
import {
  cloneMask,
  containsPoint,
  countSet,
  createMask,
  fillMask,
  isSet,
  rasterizePolygon,
  setCell,
  subtractPolygons,
  toRuns,
  unionInto,
} from "./regionMask";
import type { Vector2 } from "../geometry/vector";

// Deliberately non-square: a square fixture cannot distinguish a column from a row, so any
// axis confusion in code under test would pass unnoticed.
const BOUNDS: Bounds = { min: { x: 0, y: 0 }, max: { x: 1000, y: 600 } };

/** Keeps cells exactly 50 world units — a 20x12 grid — whatever SUBDIVISIONS is set to. */
const DPI = 50 * SUBDIVISIONS;

/**
 * `minCellSize` pins the cell at 50 units against `MIN_CELLS_PER_AXIS`, which would otherwise
 * refine this fixture to a 200-cell axis. These suites test mask arithmetic, not grid sizing.
 */
function grid() {
  return createCellGrid(BOUNDS, DPI, { minCellSize: 50 });
}

/** Axis-aligned rectangle as a polygon. */
function rect(x0: number, y0: number, x1: number, y1: number): Vector2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

describe("basic cell operations", () => {
  it("starts empty", () => {
    expect(countSet(createMask(grid()))).toBe(0);
  });

  it("fills every cell, corners included", () => {
    const filled = fillMask(grid());
    // 20x12 at this fixture's cell size. Counting rather than trusting the length guards against
    // a fill that covers the buffer but not the addressable grid, which `isSet` would still
    // report as false at the far corner.
    expect(countSet(filled)).toBe(20 * 12);
    expect(isSet(filled, 0, 0)).toBe(true);
    expect(isSet(filled, 19, 11)).toBe(true);
    // Still bounded — a filled mask must not claim ground off the map.
    expect(isSet(filled, 20, 11)).toBe(false);
    expect(containsPoint(filled, { x: 1200, y: 300 })).toBe(false);
  });

  it("fills a mask that round-trips through the run encoding as one run per row", () => {
    // The cheap-storage claim in `fillMask`'s comment, asserted rather than assumed: encoded size
    // scales with the region's perimeter, so a solid rectangle is the best case.
    expect(toRuns(fillMask(grid())).length).toBe(12);
  });

  it("sets and reads cells", () => {
    const mask = createMask(grid());
    setCell(mask, 3, 4);

    expect(isSet(mask, 3, 4)).toBe(true);
    expect(isSet(mask, 4, 3)).toBe(false);
    expect(countSet(mask)).toBe(1);
  });

  it("ignores out-of-range writes instead of corrupting neighbours", () => {
    const mask = createMask(grid());
    setCell(mask, -1, 0);
    setCell(mask, 0, 999);

    expect(countSet(mask)).toBe(0);
    expect(isSet(mask, -1, 0)).toBe(false);
  });

  it("tests world points against the containing cell", () => {
    const mask = createMask(grid());
    setCell(mask, 2, 2); // world 100..150

    expect(containsPoint(mask, { x: 125, y: 125 })).toBe(true);
    expect(containsPoint(mask, { x: 175, y: 125 })).toBe(false);
    expect(containsPoint(mask, { x: -50, y: -50 })).toBe(false);
  });

  it("clones without aliasing", () => {
    const original = createMask(grid());
    setCell(original, 1, 1);

    const copy = cloneMask(original);
    setCell(copy, 5, 5);

    expect(isSet(original, 5, 5)).toBe(false);
    expect(isSet(copy, 1, 1)).toBe(true);
  });
});

describe("unionInto", () => {
  it("adds cells and reports how many were new", () => {
    const target = createMask(grid());
    const addition = createMask(grid());
    setCell(target, 1, 1);
    setCell(addition, 1, 1);
    setCell(addition, 2, 2);

    expect(unionInto(target, addition)).toBe(1);
    expect(isSet(target, 2, 2)).toBe(true);
  });

  it("is idempotent — re-adding the same region grows nothing", () => {
    const target = createMask(grid());
    const addition = createMask(grid());
    setCell(addition, 4, 4);

    expect(unionInto(target, addition)).toBe(1);
    expect(unionInto(target, addition)).toBe(0);
  });

  it("never removes cells", () => {
    const target = createMask(grid());
    setCell(target, 7, 7);

    unionInto(target, createMask(grid()));
    expect(isSet(target, 7, 7)).toBe(true);
  });
});

describe("rasterizePolygon", () => {
  it("fills cells whose centre lies inside", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(0, 0, 100, 100));

    // Cells 0 and 1 have centres at 25 and 75, both inside; cell 2's is at 125.
    expect(isSet(mask, 0, 0)).toBe(true);
    expect(isSet(mask, 1, 1)).toBe(true);
    expect(isSet(mask, 2, 0)).toBe(false);
    expect(countSet(mask)).toBe(4);
  });

  it("excludes cells only clipped at the edge", () => {
    const mask = createMask(grid());
    // Reaches x=130, so cell 2 (centre 125) is in but cell 2's neighbour is not.
    rasterizePolygon(mask, rect(0, 0, 130, 60));

    expect(isSet(mask, 2, 0)).toBe(true);
    expect(isSet(mask, 3, 0)).toBe(false);
    // Under-reports at the boundary, which is the wanted direction for `discovered`.
    expect(isSet(mask, 0, 1)).toBe(false);
  });

  it("accumulates across calls rather than replacing", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(0, 0, 100, 100));
    rasterizePolygon(mask, rect(200, 200, 300, 300));

    expect(countSet(mask)).toBe(8);
    expect(isSet(mask, 0, 0)).toBe(true);
    expect(isSet(mask, 4, 4)).toBe(true);
  });

  it("ignores degenerate polygons", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, []);
    rasterizePolygon(mask, [{ x: 0, y: 0 }, { x: 10, y: 10 }]);

    expect(countSet(mask)).toBe(0);
  });

  it("clips to the grid when the polygon overhangs it", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(-500, -500, 100, 100));

    expect(countSet(mask)).toBe(4);
    expect(isSet(mask, 0, 0)).toBe(true);
  });

  it("handles a concave polygon, not just its bounding box", () => {
    const mask = createMask(grid());
    // A C-shape opening to the right, spanning 0..300 with a notch at 100..300 y 100..200.
    rasterizePolygon(mask, [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 200 },
      { x: 300, y: 200 },
      { x: 300, y: 300 },
      { x: 0, y: 300 },
    ]);

    expect(isSet(mask, 0, 3)).toBe(true); // inside the left bar
    expect(isSet(mask, 4, 3)).toBe(false); // inside the notch
  });
});

describe("subtractPolygons", () => {
  it("removes cells covered by a polygon", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(0, 0, 200, 200));

    const remaining = subtractPolygons(mask, [rect(0, 0, 100, 100)]);

    expect(countSet(mask)).toBe(16); // original untouched
    expect(countSet(remaining)).toBe(12);
    expect(isSet(remaining, 0, 0)).toBe(false);
    expect(isSet(remaining, 3, 3)).toBe(true);
  });

  it("returns a copy when nothing is subtracted", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(0, 0, 200, 200));

    const remaining = subtractPolygons(mask, []);
    expect(countSet(remaining)).toBe(countSet(mask));

    setCell(remaining, 10, 10);
    expect(isSet(mask, 10, 10)).toBe(false);
  });

  it("subtracts the union of several polygons", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(0, 0, 200, 100));

    const remaining = subtractPolygons(mask, [
      rect(0, 0, 100, 100),
      rect(100, 0, 200, 100),
    ]);
    expect(countSet(remaining)).toBe(0);
  });
});

describe("toRuns", () => {
  it("merges a contiguous row into one run", () => {
    const mask = createMask(grid());
    for (let column = 0; column < 4; column++) setCell(mask, column, 0);

    const runs = toRuns(mask);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.min).toEqual({ x: 0, y: 0 });
    expect(runs[0]!.max).toEqual({ x: 200, y: 50 });
  });

  it("splits a row at gaps", () => {
    const mask = createMask(grid());
    setCell(mask, 0, 0);
    setCell(mask, 2, 0);

    expect(toRuns(mask)).toHaveLength(2);
  });

  it("does not merge across rows", () => {
    const mask = createMask(grid());
    setCell(mask, 0, 0);
    setCell(mask, 0, 1);

    expect(toRuns(mask)).toHaveLength(2);
  });

  it("closes a run that reaches the last column", () => {
    const mask = createMask(grid());
    const lastColumn = mask.grid.columns - 1;
    setCell(mask, lastColumn, 0);

    const runs = toRuns(mask);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.max.x).toBe(mask.grid.columns * mask.grid.cellSize);
  });

  it("returns nothing for an empty mask", () => {
    expect(toRuns(createMask(grid()))).toEqual([]);
  });

  it("collapses a solid region into one run per row", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(0, 0, 1000, 600));

    expect(countSet(mask)).toBe(20 * 12);
    expect(toRuns(mask)).toHaveLength(12);
  });
});
