import { describe, expect, it } from "vitest";

import { selectSketchSegments } from "./mask";
import { createCellGrid } from "../region/cellGrid";
import { createMask, rasterizePolygon } from "../region/regionMask";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

/** 400x400 world units, dpi 100 — cells of 25 units, 16x16 of them. */
const grid = createCellGrid(
  { min: { x: 0, y: 0 }, max: { x: 400, y: 400 } },
  100,
);

function segmentAt(midpoint: Vector2): TracedSegment {
  return {
    points: [
      { x: midpoint.x - 5, y: midpoint.y },
      { x: midpoint.x + 5, y: midpoint.y },
    ],
    midpoint,
    length: 10,
  };
}

function square(minX: number, minY: number, size: number): Vector2[] {
  return [
    { x: minX, y: minY },
    { x: minX + size, y: minY },
    { x: minX + size, y: minY + size },
    { x: minX, y: minY + size },
  ];
}

describe("selectSketchSegments", () => {
  it("keeps discovered segments and drops undiscovered ones", () => {
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 200));

    const inside = segmentAt({ x: 100, y: 100 });
    const outside = segmentAt({ x: 300, y: 300 });

    expect(selectSketchSegments([inside, outside], discovered, [])).toEqual([
      inside,
    ]);
  });

  it("drops segments that are currently in sight", () => {
    // This is `discovered − currently_visible`: the party is standing in ground they have
    // explored, and the sketch must not draw over what they can see directly.
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    const remembered = segmentAt({ x: 300, y: 300 });
    const inSight = segmentAt({ x: 50, y: 50 });

    const selected = selectSketchSegments([remembered, inSight], discovered, [
      square(0, 0, 100),
    ]);
    expect(selected).toEqual([remembered]);
  });

  it("hides a segment seen by any one light", () => {
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    const segment = segmentAt({ x: 300, y: 300 });
    const selected = selectSketchSegments([segment], discovered, [
      square(0, 0, 100),
      square(250, 250, 100),
    ]);
    expect(selected).toEqual([]);
  });

  it("ignores degenerate polygons rather than treating them as cover", () => {
    // A light with fewer than three vertices computes to nothing. Letting it through as an
    // occluder would be harmless; letting it *hide* geometry would blank the sketch whenever a
    // sweep degenerated, which is the failure that looks like the feature not working.
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    const segment = segmentAt({ x: 300, y: 300 });
    expect(
      selectSketchSegments([segment], discovered, [
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      ]),
    ).toEqual([segment]);
  });

  it("preserves input order", () => {
    // Order stability keeps the emitted chunks stable between renders, so a segment does not
    // migrate between items just because a neighbour was hidden.
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    const segments = [
      segmentAt({ x: 300, y: 60 }),
      segmentAt({ x: 60, y: 300 }),
      segmentAt({ x: 300, y: 300 }),
    ];
    const selected = selectSketchSegments(segments, discovered, [
      square(0, 0, 40),
    ]);
    expect(selected).toEqual(segments);
  });

  it("draws nothing when nothing has been discovered", () => {
    const discovered = createMask(grid);
    expect(
      selectSketchSegments([segmentAt({ x: 100, y: 100 })], discovered, []),
    ).toEqual([]);
  });

  it("drops segments whose midpoint falls outside the grid entirely", () => {
    // The grid covers only the MAP images, and walls and tokens can be anywhere. A midpoint
    // off the map addresses no cell, and must not be treated as discovered.
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    expect(
      selectSketchSegments([segmentAt({ x: 5000, y: 5000 })], discovered, []),
    ).toEqual([]);
  });
});
