import { describe, expect, it } from "vitest";

import { clipToConvex, intersectStarPolygons } from "./starClip";
import { area, pointInPolygon } from "./polygon";
import type { Vector2 } from "./vector";

const square = (x: number, y: number, size: number): Vector2[] => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

/** A regular polygon, standing in for a visibility polygon in open space. */
const disc = (centre: Vector2, radius: number, sides = 16): Vector2[] =>
  Array.from({ length: sides }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2;
    return {
      x: centre.x + Math.cos(angle) * radius,
      y: centre.y + Math.sin(angle) * radius,
    };
  });

describe("clipToConvex", () => {
  it("keeps a subject entirely inside the clip", () => {
    const subject = square(2, 2, 2);
    expect(area(clipToConvex(subject, square(0, 0, 10)))).toBeCloseTo(4);
  });

  it("returns nothing for a subject entirely outside", () => {
    expect(clipToConvex(square(50, 50, 2), square(0, 0, 10))).toEqual([]);
  });

  it("cuts a subject that straddles the boundary", () => {
    // Half in, half out. The clip is tall enough to cut in x only — a square clip would cross the
    // subject in both axes and leave a quarter, which is what this asserted at first.
    const tall = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(area(clipToConvex(square(4, 4, 2), tall))).toBeCloseTo(2);
  });

  it("does not depend on the winding of either polygon", () => {
    // Owlbear's y points down, so no winding convention can be assumed. Every combination has to
    // give the same answer or the result would flip with the coordinate system.
    const subject = square(4, 4, 2);
    const clip = square(0, 0, 5);
    // A quarter: the 2x2 subject at (4,4) crosses the clip's edge in x and in y alike.
    const expected = 1;

    for (const s of [subject, [...subject].reverse()]) {
      for (const c of [clip, [...clip].reverse()]) {
        expect(area(clipToConvex(s, c))).toBeCloseTo(expected);
      }
    }
  });

  it("handles a subject sharing an edge with the clip", () => {
    // The degenerate case that breaks general clippers, and the one visibility polygons produce
    // constantly because their vertices sit on wall lines.
    const shared = clipToConvex(square(0, 0, 5), square(0, 0, 5));
    expect(area(shared)).toBeCloseTo(25);
  });
});

describe("intersectStarPolygons", () => {
  const totalArea = (pieces: Vector2[][]): number =>
    pieces.reduce((sum, piece) => sum + area(piece), 0);

  it("returns nothing for polygons that do not meet", () => {
    const a = { origin: { x: 0, y: 0 }, polygon: disc({ x: 0, y: 0 }, 5) };
    const b = { origin: { x: 100, y: 0 }, polygon: disc({ x: 100, y: 0 }, 5) };
    expect(intersectStarPolygons(a, b)).toEqual([]);
  });

  it("recovers the smaller polygon when one contains the other", () => {
    const big = { origin: { x: 0, y: 0 }, polygon: disc({ x: 0, y: 0 }, 50, 64) };
    const small = { origin: { x: 0, y: 0 }, polygon: disc({ x: 0, y: 0 }, 5, 64) };
    // Pieces tile the smaller polygon, so their areas sum to its area.
    expect(totalArea(intersectStarPolygons(big, small))).toBeCloseTo(
      area(small.polygon),
      3,
    );
  });

  it("gives the overlap of two offset discs", () => {
    const a = { origin: { x: 0, y: 0 }, polygon: disc({ x: 0, y: 0 }, 10, 128) };
    const b = { origin: { x: 10, y: 0 }, polygon: disc({ x: 10, y: 0 }, 10, 128) };

    // Two unit discs of radius r with centres r apart overlap by r^2(2pi/3 - sqrt(3)/2).
    const expected = 100 * ((2 * Math.PI) / 3 - Math.sqrt(3) / 2);
    expect(totalArea(intersectStarPolygons(a, b))).toBeCloseTo(expected, 0);
  });

  it("is sound on random star-shaped polygons — every piece lies inside BOTH inputs", () => {
    // The property the whole feature rests on. A piece outside either input is a hole punched in
    // the parchment where the party cannot see, which reveals that a room exists at all — the one
    // error the user said is unacceptable. Slivers lost at the boundary are explicitly fine, so
    // this checks containment rather than exactness.
    //
    // Randomised because hand-written fixtures are too tidy to produce the degeneracies that break
    // clippers: vertices landing on edges, collinear runs, near-zero-area slivers.
    let seed = 20260802;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Star-shaped about its origin by construction: one radius per angular step.
    const randomStar = (origin: Vector2, maxRadius: number): Vector2[] => {
      const sides = 6 + Math.floor(random() * 18);
      return Array.from({ length: sides }, (_, i) => {
        const angle = (i / sides) * Math.PI * 2;
        const radius = maxRadius * (0.15 + random() * 0.85);
        return {
          x: origin.x + Math.cos(angle) * radius,
          y: origin.y + Math.sin(angle) * radius,
        };
      });
    };

    let checked = 0;
    for (let trial = 0; trial < 200; trial++) {
      const firstOrigin = { x: random() * 20, y: random() * 20 };
      const secondOrigin = { x: random() * 20, y: random() * 20 };
      const first = { origin: firstOrigin, polygon: randomStar(firstOrigin, 15) };
      const second = { origin: secondOrigin, polygon: randomStar(secondOrigin, 15) };

      for (const piece of intersectStarPolygons(first, second)) {
        // Test the centroid rather than the vertices: a piece's corners legitimately lie *on* the
        // boundary of an input, where point-in-polygon promises nothing either way. The interior
        // is what must be contained, and for a convex piece the centroid is squarely in it.
        const centroid = piece.reduce(
          (sum, p) => ({ x: sum.x + p.x / piece.length, y: sum.y + p.y / piece.length }),
          { x: 0, y: 0 },
        );
        expect(pointInPolygon(centroid, first.polygon)).toBe(true);
        expect(pointInPolygon(centroid, second.polygon)).toBe(true);
        checked++;
      }
    }

    // A soundness test that never produced a piece would pass against a function returning nothing
    // at all — the failure this project keeps paying for. Assert the trials actually did work.
    expect(checked).toBeGreaterThan(500);
  });

  it("never exceeds the area of either input", () => {
    // The other half of soundness, at the aggregate level: pieces are interior-disjoint, so their
    // total cannot exceed the smaller input. Catches double-counted overlaps, which containment
    // alone would not.
    const a = { origin: { x: 0, y: 0 }, polygon: disc({ x: 0, y: 0 }, 10, 32) };
    const b = { origin: { x: 6, y: 3 }, polygon: disc({ x: 6, y: 3 }, 8, 32) };

    const total = totalArea(intersectStarPolygons(a, b));
    expect(total).toBeLessThanOrEqual(area(a.polygon) + 1e-6);
    expect(total).toBeLessThanOrEqual(area(b.polygon) + 1e-6);
  });
});
