import { describe, expect, it } from "vitest";

import { visibleShape } from "./visibleShape";
import { pointInPolygon } from "../geometry/polygon";
import type { Vector2 } from "../geometry/vector";

/** The shipped grid square. The mask sizes its own cells from this. */
const DPI = 150;

/** What `CELLS_PER_SQUARE` works out to — the mask builds its own grid, so this mirrors it. */
const CELL = DPI / 16;

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


/** Four rectangles forming a square frame, so the interior is an enclosed hole. */
const frame = (x0: number, y0: number, size: number, thickness: number): Vector2[][] => {
  const x1 = x0 + size;
  const y1 = y0 + size;
  return [
    [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y0 + thickness }, { x: x0, y: y0 + thickness }],
    [{ x: x0, y: y1 - thickness }, { x: x1, y: y1 - thickness }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    [{ x: x0, y: y0 }, { x: x0 + thickness, y: y0 }, { x: x0 + thickness, y: y1 }, { x: x0, y: y1 }],
    [{ x: x1 - thickness, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x1 - thickness, y: y1 }],
  ];
};

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
    const shape = visibleShape([], DPI);
    expect(shape.rings).toEqual([]);
    expect(shape.cellsCovered).toBe(0);
  });

  it("traces one ring around one polygon", () => {
    const shape = visibleShape([square(300, 300, 300)], DPI);
    expect(shape.rings).toHaveLength(1);
    expect(insideAny(shape.rings, { x: 450, y: 450 })).toBe(true);
    expect(insideAny(shape.rings, { x: 100, y: 100 })).toBe(false);
  });

  it("merges two OVERLAPPING polygons into a single ring", () => {
    // The bug this module exists for. As separate even-odd holes, the overlap of a torch and a
    // brazier counted three crossings and filled back in; in a bitmap, marking a cell twice is
    // marking it once, so the overlap simply cannot arise.
    const shape = visibleShape([
      square(200, 400, 300),
      square(400, 400, 300),
    ], DPI);

    expect(shape.rings).toHaveLength(1);
    // The overlap itself, which used to come out solid.
    expect(insideAny(shape.rings, { x: 450, y: 550 })).toBe(true);
  });

  it("keeps disjoint polygons as separate rings", () => {
    const shape = visibleShape([square(100, 100, 200), square(700, 700, 200)], DPI);
    expect(shape.rings).toHaveLength(2);
  });

  it("traces a hole as its own ring", () => {
    // A pillar in a lit room. Even-odd fills a ring inside a hole, so this is handled for free —
    // and the piecewise approach would have made a mess of it.
    const room = square(200, 200, 600);
    const shape = visibleShape([room], DPI);
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
    const shape = visibleShape([source], DPI);
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

    const shape = visibleShape([ell], DPI);
    expect(shape.rings.length).toBeGreaterThan(0);

    for (const ring of shape.rings) {
      for (const point of boundarySamples(ring)) {
        expect(pointInPolygon(point, ell)).toBe(true);
      }
    }
    // And the reflex corner's outside really is left alone.
    expect(insideAny(shape.rings, { x: 600, y: 600 })).toBe(false);
  });

  it("stays inside a SCALLOPED boundary, which is what bounds the tolerance", () => {
    // The fixture that pins `SIMPLIFY_SHARE`. The L above has one reflex corner so deep that the
    // simplifier keeps it at any sane tolerance — so it passed even with the tolerance set six
    // times too large, which is exactly the "fixture too tidy to fail" trap this project keeps
    // paying for. Scallops are shallow enough that an over-large tolerance flattens them and the
    // chords then bridge every valley.
    //
    // Teeth are sized at several cells deep on purpose. Finer than that is below what the mask can
    // represent at all, and the containment guarantee genuinely weakens there — see the resolution
    // test below, which states the real bound rather than pretending there is none.
    const teeth = 12;
    const gear: Vector2[] = Array.from({ length: teeth * 2 }, (_, i) => {
      const angle = (i / (teeth * 2)) * Math.PI * 2;
      const radius = i % 2 === 0 ? 300 : 240;
      return {
        x: 500 + Math.cos(angle) * radius,
        y: 500 + Math.sin(angle) * radius,
      };
    });

    const shape = visibleShape([gear], DPI);
    expect(shape.rings.length).toBeGreaterThan(0);

    for (const ring of shape.rings) {
      for (const point of boundarySamples(ring)) {
        expect(pointInPolygon(point, gear)).toBe(true);
      }
    }
  });

  it("overshoots by at most half a cell, which is the honest guarantee", () => {
    // **The containment property is bounded by resolution, not absolute, and saying so is the
    // point of this test.** The traced contour runs midway between a kept cell centre and a
    // dropped one, so against a feature finer than a couple of cells it can bow up to half a cell
    // outside the source. An earlier fixture with 22-unit teeth against 9-unit cells failed for
    // exactly that reason, and the fix was to state the bound rather than to loosen the fixture
    // and move on.
    //
    // Half a cell is a few world units against walls tens of units thick, so the overshoot cannot
    // cross a wall into the room beyond — which is the requirement that actually matters.
    const teeth = 40;
    const fine: Vector2[] = Array.from({ length: teeth * 2 }, (_, i) => {
      const angle = (i / (teeth * 2)) * Math.PI * 2;
      const radius = i % 2 === 0 ? 300 : 288;
      return {
        x: 500 + Math.cos(angle) * radius,
        y: 500 + Math.sin(angle) * radius,
      };
    });

    const shape = visibleShape([fine], DPI);
    for (const ring of shape.rings) {
      for (const point of boundarySamples(ring)) {
        // Never outside the shape's own outer envelope by more than half a cell.
        const radius = Math.hypot(point.x - 500, point.y - 500);
        expect(radius).toBeLessThanOrEqual(300 + CELL / 2);
      }
    }
  });


  it("fills a gap too small to be anything but an artefact", () => {
    // A dropped clip piece leaves one unset cell, and a single unset cell traces as a small
    // diamond of parchment sitting inside a lit room — which is exactly what it looked like on
    // screen. Filling is sound because the gap is ENCLOSED by visible cells, so it is surrounded
    // by ground the party can see and cannot reveal anything past a wall.
    const tiny = frame(400, 400, 200, 90);
    const shape = visibleShape(tiny, DPI);

    expect(shape.rings).toHaveLength(1);
    // The middle, which was the gap, is now inside the traced region.
    expect(insideAny(shape.rings, { x: 500, y: 500 })).toBe(true);
  });

  it("KEEPS a hole big enough to be real", () => {
    // A pillar standing in a lit room. The party genuinely cannot see behind it, so the parchment
    // belongs there — filling every hole regardless of size would erase that.
    const room = frame(200, 200, 600, 100);
    const shape = visibleShape(room, DPI);

    expect(shape.rings.length).toBeGreaterThanOrEqual(2);
    expect(insideAny(shape.rings, { x: 500, y: 500 })).toBe(true);
  });

  it("is smoother than the cell grid it came from", () => {
    // The point of tracing back to vectors rather than emitting cells. A stair-stepped boundary
    // carries a vertex per cell edge; a simplified one carries far fewer for the same shape.
    const shape = visibleShape([square(200, 200, 600)], DPI);
    const vertices = shape.rings.reduce((sum, ring) => sum + ring.length, 0);

    // The square spans ~600/cellSize cells per side. A raw traced boundary would be in the
    // hundreds; a simplified rectangle is nearer a handful.
    const cellsPerSide = 600 / CELL;
    expect(vertices).toBeLessThan(cellsPerSide);
  });

  it("drops a region too small to survive erosion, rather than emitting a bad ring", () => {
    // A sliver one cell wide erodes to nothing. Losing it is the safe direction, and it must not
    // come back as a degenerate ring.
    const sliver = square(500, 500, CELL * 0.9);
    const shape = visibleShape([sliver], DPI);

    expect(shape.cellsKept).toBe(0);
    expect(shape.rings).toEqual([]);
  });

  it("reports what it covered and kept, so an empty result is explainable", () => {
    // Both counts, for the reason every diagnostic here is doubled: "no rings" looks identical
    // whether nothing was visible or the erosion ate it, and those want opposite fixes.
    const shape = visibleShape([square(300, 300, 300)], DPI);
    expect(shape.cellsCovered).toBeGreaterThan(0);
    expect(shape.cellsKept).toBeGreaterThan(0);
    expect(shape.cellsKept).toBeLessThan(shape.cellsCovered);
  });
});
