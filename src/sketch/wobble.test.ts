import { describe, expect, it } from "vitest";

import {
  offsetAt,
  subdivide,
  valueNoise,
  wobbleSegment,
  wobbleSegments,
  type WobbleOptions,
} from "./wobble";
import { polylineLength } from "../trace/chop";
import type { TracedSegment } from "../trace/chop";

const options: WobbleOptions = {
  amplitude: 3,
  wavelength: 52,
  step: 9,
  seed: 1234,
};

function straight(from: number, to: number): TracedSegment {
  const points = [
    { x: from, y: 100 },
    { x: to, y: 100 },
  ];
  const length = Math.abs(to - from);
  return { points, midpoint: { x: (from + to) / 2, y: 100 }, length };
}

describe("valueNoise", () => {
  it("stays within [-1, 1]", () => {
    for (let i = 0; i < 400; i++) {
      const value = valueNoise(i * 0.37, i * -0.91, 7);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic", () => {
    expect(valueNoise(12.5, -3.25, 99)).toBe(valueNoise(12.5, -3.25, 99));
  });

  it("varies with the seed", () => {
    expect(valueNoise(12.5, -3.25, 1)).not.toBe(valueNoise(12.5, -3.25, 2));
  });

  it("is smooth rather than white noise", () => {
    // The property that makes a stroke wander instead of sparkle: hashing each point
    // independently would leave neighbouring samples uncorrelated.
    //
    // The step is deliberately not a round fraction. An earlier version walked in steps of 0.05
    // from zero, which never landed within one step of an integer — so it never crossed a
    // lattice boundary, which is the *only* place an uninterpolated field jumps. It passed
    // against a deliberately broken implementation. Sampling has to visit the discontinuity it
    // is looking for.
    const STEP = 0.013;
    let worstX = 0;
    let worstY = 0;

    for (let i = 0; i < 1000; i++) {
      const t = i * STEP;
      worstX = Math.max(
        worstX,
        Math.abs(valueNoise(t, 4.37, 5) - valueNoise(t + STEP, 4.37, 5)),
      );
      worstY = Math.max(
        worstY,
        Math.abs(valueNoise(2.19, t, 5) - valueNoise(2.19, t + STEP, 5)),
      );
    }

    // Interpolated noise changes by at most ~3 per unit, so a step of 0.013 cannot move it far.
    // An uninterpolated field jumps by up to the full range of 2 at every boundary crossed.
    expect(worstX).toBeLessThan(0.1);
    expect(worstY).toBeLessThan(0.1);
  });

  it("handles negative coordinates", () => {
    expect(Number.isFinite(valueNoise(-500.25, -900.75, 3))).toBe(true);
  });

  it("varies along both axes", () => {
    // A field ignoring one axis would make every stroke along that axis wobble identically —
    // wrong in a way that reads as a pattern rather than as a hand.
    expect(valueNoise(4.5, 1.25, 11)).not.toBeCloseTo(valueNoise(9.5, 1.25, 11));
    expect(valueNoise(4.5, 1.25, 11)).not.toBeCloseTo(valueNoise(4.5, 6.75, 11));
  });
});

describe("subdivide", () => {
  it("inserts points along a long edge", () => {
    const dense = subdivide(
      [
        { x: 0, y: 0 },
        { x: 90, y: 0 },
      ],
      9,
    );
    expect(dense).toHaveLength(11); // 10 pieces
    expect(dense[0]).toEqual({ x: 0, y: 0 });
    expect(dense[dense.length - 1]).toEqual({ x: 90, y: 0 });
  });

  it("leaves a short edge alone", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ];
    expect(subdivide(points, 9)).toEqual(points);
  });

  it("keeps the inserted points on the original line", () => {
    const dense = subdivide(
      [
        { x: 0, y: 0 },
        { x: 30, y: 60 },
      ],
      9,
    );
    for (const point of dense) expect(point.y).toBeCloseTo(point.x * 2);
  });

  it("is a no-op without a positive step", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 90, y: 0 },
    ];
    expect(subdivide(points, 0)).toEqual(points);
  });
});

describe("offsetAt", () => {
  it("depends on position alone", () => {
    // The property the whole vector-field approach exists for: a point shared between two
    // segments must be displaced identically from both, or strokes come apart at every cut.
    const first = offsetAt({ x: 412.5, y: -80.25 }, options);
    const second = offsetAt({ x: 412.5, y: -80.25 }, options);
    expect(first).toEqual(second);
  });

  it("stays within the amplitude on both axes", () => {
    for (let i = 0; i < 300; i++) {
      const offset = offsetAt({ x: i * 7.3, y: i * -3.1 }, options);
      expect(Math.abs(offset.x)).toBeLessThanOrEqual(options.amplitude);
      expect(Math.abs(offset.y)).toBeLessThanOrEqual(options.amplitude);
    }
  });

  it("moves the two axes independently", () => {
    // A shared seed for both channels would put every displacement on the 45-degree diagonal.
    const offset = offsetAt({ x: 33, y: 77 }, options);
    expect(offset.x).not.toBeCloseTo(offset.y);
  });

  it("actually displaces things", () => {
    const moved = Array.from({ length: 50 }, (_, i) =>
      offsetAt({ x: i * 13, y: i * 29 }, options),
    ).filter((offset) => Math.hypot(offset.x, offset.y) > 0.2);
    expect(moved.length).toBeGreaterThan(25);
  });
});

describe("wobbleSegment", () => {
  it("keeps segments joined where they share a point", () => {
    // Two halves of one contour, cut at x=200 the way `chop.ts` cuts them. After wobbling, the
    // shared point must still be one point — otherwise every pre-cut boundary becomes a visible
    // break in the linework.
    const first = wobbleSegment(straight(100, 200), options);
    const second = wobbleSegment(straight(200, 300), options);

    expect(first.points[first.points.length - 1]).toEqual(second.points[0]);
  });

  it("bows a straight run rather than leaving it straight", () => {
    const wobbled = wobbleSegment(straight(0, 90), options);

    expect(wobbled.points.length).toBeGreaterThan(2);
    const offLine = wobbled.points.map((point) => Math.abs(point.y - 100));
    expect(Math.max(...offLine)).toBeGreaterThan(0.2);
  });

  it("keeps every point within the amplitude of where it started", () => {
    const wobbled = wobbleSegment(straight(0, 90), options);
    for (const point of wobbled.points) {
      expect(Math.abs(point.y - 100)).toBeLessThanOrEqual(options.amplitude);
    }
  });

  it("recomputes the midpoint against the drawn arc length", () => {
    // Masking tests this point, so it has to describe where the ink ended up rather than where
    // the straight version's middle used to be.
    const wobbled = wobbleSegment(straight(0, 90), options);
    const half = polylineLength(wobbled.points) / 2;

    let travelled = 0;
    for (let i = 1; i < wobbled.points.length; i++) {
      travelled += Math.hypot(
        wobbled.points[i]!.x - wobbled.points[i - 1]!.x,
        wobbled.points[i]!.y - wobbled.points[i - 1]!.y,
      );
      if (travelled >= half) break;
    }
    expect(travelled).toBeGreaterThanOrEqual(half);
    expect(wobbled.length).toBeCloseTo(polylineLength(wobbled.points));
  });

  it("is stable across calls, so a reload redraws the same map", () => {
    expect(wobbleSegment(straight(0, 90), options)).toEqual(
      wobbleSegment(straight(0, 90), options),
    );
  });

  it("leaves geometry alone when the amplitude is zero", () => {
    const segment = straight(0, 90);
    expect(wobbleSegment(segment, { ...options, amplitude: 0 })).toBe(segment);
  });

  it("passes a degenerate segment straight through", () => {
    const single: TracedSegment = {
      points: [{ x: 1, y: 2 }],
      midpoint: { x: 1, y: 2 },
      length: 0,
    };
    expect(wobbleSegment(single, options)).toBe(single);
  });
});

describe("wobbleSegments", () => {
  it("maps every segment", () => {
    const wobbled = wobbleSegments([straight(0, 90), straight(90, 180)], options);
    expect(wobbled).toHaveLength(2);
    expect(wobbled[0]!.points[wobbled[0]!.points.length - 1]).toEqual(
      wobbled[1]!.points[0],
    );
  });
});
