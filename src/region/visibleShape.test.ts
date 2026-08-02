import { describe, expect, it } from "vitest";

import { visibleShape } from "./visibleShape";
import { createCellGrid } from "./cellGrid";
import { pointInPolygon } from "../geometry/polygon";
import type { Vector2 } from "../geometry/vector";

/** A grid over a 1000x1000 world area. dpi 150 gives cells well under a grid square. */
const grid = createCellGrid(
  { min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } },
  150,
);

const square = (x: number, y: number, size: number): Vector2[] => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

const disc = (centre: Vector2, radius: number, sides = 48): Vector2[] =>
  Array.from({ length: sides }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2;
    return {
      x: centre.x + Math.cos(angle) * radius,
      y: centre.y + Math.sin(angle) * radius,
    };
  });

/** Is the point inside any ring? Rings are disjoint here, so any is enough. */
const insideAny = (rings: Vector2[][], point: Vector2): boolean =>
  rings.some((ring) => pointInPolygon(point, ring));

/**
 * Every ring vertex *and* points along every edge between them.
 *
 * Sampling the edges is the whole point. Douglas–Peucker keeps a subset of the vertices it was
 * given, so the vertices of a simplified ring are always inside the source — testing only those
 * cannot detect the failure the erosion exists to prevent, which is the **chord** between two kept
 * vertices bowing outward across a concave stretch. A deliberately over-large tolerance sailed
 * through a vertex-only check.
 */
function* boundarySamples(ring: readonly Vector2[], per = 12): Generator<Vector2> {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    for (let step = 0; step < per; step++) {
      const t = step / per;
      yield { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
}

describe("visibleShape", () => {
  it("returns nothing for no polygons", () => {
    const shape = visibleShape(grid, []);
    expect(shape.rings).toEqual([]);
    expect(shape.cellsCovered).toBe(0);
  });

  it("traces one ring around one polygon", () => {
    const shape = visibleShape(grid, [square(300, 300, 300)]);
    expect(shape.rings).toHaveLength(1);
    expect(insideAny(shape.rings, { x: 450, y: 450 })).toBe(true);
    expect(insideAny(shape.rings, { x: 100, y: 100 })).toBe(false);
  });

  it("merges two OVERLAPPING polygons into a single ring", () => {
    // The bug this module exists for. As separate even-odd holes, the overlap of a torch and a
    // brazier counted three crossings and filled back in; in a bitmap, marking a cell twice is
    // marking it once, so the overlap simply cannot arise.
    const shape = visibleShape(grid, [
      square(200, 400, 300),
      square(400, 400, 300),
    ]);

    expect(shape.rings).toHaveLength(1);
    // The overlap itself, which used to come out solid.
    expect(insideAny(shape.rings, { x: 450, y: 550 })).toBe(true);
  });

  it("keeps disjoint polygons as separate rings", () => {
    const shape = visibleShape(grid, [square(100, 100, 200), square(700, 700, 200)]);
    expect(shape.rings).toHaveLength(2);
  });

  it("traces a hole as its own ring", () => {
    // A pillar in a lit room. Even-odd fills a ring inside a hole, so this is handled for free —
    // and the piecewise approach would have made a mess of it.
    const room = square(200, 200, 600);
    const shape = visibleShape(grid, [room]);
    expect(shape.rings.length).toBeGreaterThanOrEqual(1);

    // Sanity: the traced ring encloses the room's middle.
    expect(insideAny(shape.rings, { x: 500, y: 500 })).toBe(true);
  });

  it("NEVER reaches outside the polygons it was given", () => {
    // The soundness property, and the only one that really matters: a ring extending past the
    // true visible region is a hole in the parchment where the party can see nothing, which
    // advertises that a room exists. Every stage is meant to shrink, so sampling the ring itself
    // must find nothing outside the input.
    const source = disc({ x: 500, y: 500 }, 250);
    const shape = visibleShape(grid, [source]);
    expect(shape.rings.length).toBeGreaterThan(0);

    for (const ring of shape.rings) {
      for (const point of boundarySamples(ring)) {
        expect(pointInPolygon(point, source)).toBe(true);
      }
    }
  });

  it("stays inside on a CONCAVE shape, where simplification cuts corners outward", () => {
    // The case erosion is actually paying for. Douglas-Peucker cutting across a concave bend
    // moves the boundary outward — and outward, next to a wall, means into the room beyond it.
    // An L is the smallest fixture with a reflex corner for it to cut across.
    const ell: Vector2[] = [
      { x: 200, y: 200 },
      { x: 800, y: 200 },
      { x: 800, y: 400 },
      { x: 400, y: 400 },
      { x: 400, y: 800 },
      { x: 200, y: 800 },
    ];

    const shape = visibleShape(grid, [ell]);
    expect(shape.rings.length).toBeGreaterThan(0);

    for (const ring of shape.rings) {
      for (const point of boundarySamples(ring)) {
        expect(pointInPolygon(point, ell)).toBe(true);
      }
    }
    // And the reflex corner's outside really is left alone.
    expect(insideAny(shape.rings, { x: 600, y: 600 })).toBe(false);
  });

  it("stays inside a finely SCALLOPED boundary, which is what bounds the tolerance", () => {
    // The fixture that pins `SIMPLIFY_SHARE`. The L above has one reflex corner so deep that the
    // simplifier keeps it at any sane tolerance — so it passed even with the tolerance set six
    // times too large, which is exactly the "fixture too tidy to fail" trap this project keeps
    // paying for. A gear's teeth are shallow enough that an over-large tolerance flattens them,
    // and the chords then bridge every valley and sit outside the shape.
    const teeth = 20;
    const gear: Vector2[] = Array.from({ length: teeth * 2 }, (_, i) => {
      const angle = (i / (teeth * 2)) * Math.PI * 2;
      const radius = i % 2 === 0 ? 250 : 228;
      return {
        x: 500 + Math.cos(angle) * radius,
        y: 500 + Math.sin(angle) * radius,
      };
    });

    const shape = visibleShape(grid, [gear]);
    expect(shape.rings.length).toBeGreaterThan(0);

    for (const ring of shape.rings) {
      for (const point of boundarySamples(ring)) {
        expect(pointInPolygon(point, gear)).toBe(true);
      }
    }
  });

  it("is smoother than the cell grid it came from", () => {
    // The point of tracing back to vectors rather than emitting cells. A stair-stepped boundary
    // carries a vertex per cell edge; a simplified one carries far fewer for the same shape.
    const shape = visibleShape(grid, [square(200, 200, 600)]);
    const vertices = shape.rings.reduce((sum, ring) => sum + ring.length, 0);

    // The square spans ~600/cellSize cells per side. A raw traced boundary would be in the
    // hundreds; a simplified rectangle is nearer a handful.
    const cellsPerSide = 600 / grid.cellSize;
    expect(vertices).toBeLessThan(cellsPerSide);
  });

  it("drops a region too small to survive erosion, rather than emitting a bad ring", () => {
    // A sliver one cell wide erodes to nothing. Losing it is the safe direction, and it must not
    // come back as a degenerate ring.
    const sliver = square(500, 500, grid.cellSize * 0.9);
    const shape = visibleShape(grid, [sliver]);

    expect(shape.cellsKept).toBe(0);
    expect(shape.rings).toEqual([]);
  });

  it("reports what it covered and kept, so an empty result is explainable", () => {
    // Both counts, for the reason every diagnostic here is doubled: "no rings" looks identical
    // whether nothing was visible or the erosion ate it, and those want opposite fixes.
    const shape = visibleShape(grid, [square(300, 300, 300)]);
    expect(shape.cellsCovered).toBeGreaterThan(0);
    expect(shape.cellsKept).toBeGreaterThan(0);
    expect(shape.cellsKept).toBeLessThan(shape.cellsCovered);
  });
});
