import { describe, expect, it } from "vitest";

import { samplePoints, selectSketchSegments } from "./mask";
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

    expect(selectSketchSegments([inside, outside], discovered, []).segments).toEqual([
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
    ]).segments;
    expect(selected).toEqual([remembered]);
  });

  it("hides a segment seen by any one light", () => {
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    const segment = segmentAt({ x: 300, y: 300 });
    const selected = selectSketchSegments([segment], discovered, [
      square(0, 0, 100),
      square(250, 250, 100),
    ]).segments;
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
      ]).segments,
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
    ]).segments;
    expect(selected).toEqual(segments);
  });

  it("draws nothing when nothing has been discovered", () => {
    const discovered = createMask(grid);
    expect(
      selectSketchSegments([segmentAt({ x: 100, y: 100 })], discovered, [])
        .segments,
    ).toEqual([]);
  });

  it("drops segments whose midpoint falls outside the grid entirely", () => {
    // The grid covers only the MAP images, and walls and tokens can be anywhere. A midpoint
    // off the map addresses no cell, and must not be treated as discovered.
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    expect(
      selectSketchSegments([segmentAt({ x: 5000, y: 5000 })], discovered, [])
        .segments,
    ).toEqual([]);
  });
});

describe("the wall margin", () => {
  /**
   * The case the margin exists for: a wall stroke lying on the visibility boundary. The polygon
   * stops at the wall, so the stroke's midpoint sits right on the edge — where `pointInPolygon`
   * guarantees nothing — and the discovered cells stop there too.
   */
  const wallY = 200;

  /** A stroke running along a wall at y=200, so its normal points in y. */
  function wallStroke(x: number, y: number): TracedSegment {
    return {
      points: [
        { x: x - 12, y },
        { x: x + 12, y },
      ],
      midpoint: { x, y },
      length: 24,
    };
  }

  function exploredBelow(): ReturnType<typeof createMask> {
    // Everything up to the wall is discovered; nothing beyond it.
    const discovered = createMask(grid);
    rasterizePolygon(discovered, [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: wallY },
      { x: 0, y: wallY },
    ]);
    return discovered;
  }

  it("draws a wall stroke sitting just beyond the discovered edge", () => {
    const discovered = exploredBelow();
    // 10 units past the boundary — the art's line is on the far side of the GM's wall.
    const stroke = wallStroke(200, wallY + 10);

    expect(selectSketchSegments([stroke], discovered, []).segments).toEqual([]);
    expect(selectSketchSegments([stroke], discovered, [], 20).segments).toEqual([
      stroke,
    ]);
  });

  it("counts what it rescued", () => {
    const discovered = exploredBelow();
    const selection = selectSketchSegments(
      [wallStroke(200, wallY + 10)],
      discovered,
      [],
      20,
    );
    expect(selection.rescued).toBe(1);
    expect(selection.suppressed).toBe(0);
  });

  it("still hides a wall the party is looking at", () => {
    // The symmetry that matters. Widening only `discovered` would sketch over a wall in plain
    // sight; widened on both sides, the stroke is discovered *and* visible, so it stays hidden.
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    const stroke = wallStroke(200, wallY + 10);
    const sight = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: wallY },
      { x: 0, y: wallY },
    ];

    expect(selectSketchSegments([stroke], discovered, sight ? [sight] : [], 20).segments).toEqual(
      [],
    );
  });

  it("counts what it suppressed", () => {
    const discovered = createMask(grid);
    rasterizePolygon(discovered, square(0, 0, 400));

    const stroke = wallStroke(200, wallY + 10);
    const sight = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: wallY },
      { x: 0, y: wallY },
    ];

    const selection = selectSketchSegments([stroke], discovered, [sight], 20);
    expect(selection.suppressed).toBe(1);
    expect(selection.rescued).toBe(0);
  });

  it("samples across the stroke, not along it", () => {
    // A stroke runs *along* a wall, so its endpoints are as ambiguous as its midpoint. All the
    // uncertainty is perpendicular, and that is the only direction worth widening.
    const stroke = wallStroke(200, wallY);
    const samples = samplePoints(stroke, 20);

    expect(samples).toHaveLength(3);
    expect(samples.map((point) => point.x)).toEqual([200, 200, 200]);
    expect(samples.map((point) => point.y).sort((a, b) => a - b)).toEqual([
      wallY - 20,
      wallY,
      wallY + 20,
    ]);
  });

  it("falls back to the midpoint alone without a margin", () => {
    expect(samplePoints(wallStroke(200, wallY), 0)).toEqual([
      { x: 200, y: wallY },
    ]);
  });

  it("falls back to the midpoint when a piece has no direction", () => {
    // A closed loop's ends coincide, so there is no normal. Widening in an arbitrary direction
    // would be worse than not widening.
    const loop: TracedSegment = {
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 10, y: 10 },
      ],
      midpoint: { x: 20, y: 20 },
      length: 28,
    };
    expect(samplePoints(loop, 20)).toEqual([{ x: 20, y: 20 }]);
  });
});
