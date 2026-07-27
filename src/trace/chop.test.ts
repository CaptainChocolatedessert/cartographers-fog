import { describe, expect, it } from "vitest";
import type { Vector2 } from "../geometry/vector";
import {
  chopContour,
  chopContours,
  pointAtLength,
  polylineLength,
  type TracedSegment,
} from "./chop";
import type { Contour } from "./marchingSquares";

function openContour(points: readonly Vector2[]): Contour {
  return { points, closed: false };
}

function totalLength(segments: readonly TracedSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.length, 0);
}

describe("chopContour", () => {
  it("cuts a straight run into equal pieces", () => {
    const segments = chopContour(
      openContour([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
      25,
    );

    expect(segments).toHaveLength(4);
    for (const segment of segments) expect(segment.length).toBeCloseTo(25, 6);
    expect(segments[0]!.points[0]).toEqual({ x: 0, y: 0 });
    expect(segments[3]!.points[1]!.x).toBeCloseTo(100, 6);
  });

  it("cuts inside a single edge, not only at vertices", () => {
    // The edge is one straight run of 100 with no interior vertex, so a chopper that only
    // split at vertices would return it whole.
    const segments = chopContour(
      openContour([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
      30,
    );

    expect(segments).toHaveLength(4);
    expect(segments[3]!.length).toBeCloseTo(10, 6);
  });

  it("keeps interior vertices instead of straightening a piece", () => {
    const zigzag = openContour([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 6, y: 0 },
    ]);

    const [segment] = chopContour(zigzag, 100);

    expect(segment!.points).toHaveLength(3);
    expect(segment!.points[1]).toEqual({ x: 3, y: 4 });
    expect(segment!.length).toBeCloseTo(10, 6);
  });

  it("preserves total length exactly", () => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      x: i * 7,
      y: Math.sin(i) * 13,
    }));

    const segments = chopContour(openContour(points), 9);

    expect(totalLength(segments)).toBeCloseTo(polylineLength(points), 6);
  });

  it("reproduces the original path when the pieces are joined back up", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
    ];

    const segments = chopContour(openContour(points), 12);
    const rejoined: Vector2[] = [...segments[0]!.points];
    for (const segment of segments.slice(1)) {
      // Each piece starts where the last ended.
      expect(segment.points[0]).toEqual(rejoined[rejoined.length - 1]);
      rejoined.push(...segment.points.slice(1));
    }

    expect(rejoined[0]).toEqual(points[0]);
    expect(rejoined[rejoined.length - 1]).toEqual(points[2]);
    expect(polylineLength(rejoined)).toBeCloseTo(polylineLength(points), 6);
    for (const corner of points) expect(rejoined).toContainEqual(corner);
  });

  it("closes the loop on a closed contour", () => {
    const square = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      closed: true,
    };

    const segments = chopContour(square, 5);

    // The full perimeter, including the closing edge back to the start.
    expect(totalLength(segments)).toBeCloseTo(40, 6);
    expect(segments).toHaveLength(8);
  });

  it("never repeats a point inside a piece, even when a cut lands on a vertex", () => {
    // Every repeated vertex is a wasted path command against the 8192-entry item cap, and a
    // budget that divides the edge length exactly is the case that produces them.
    const square = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      closed: true,
    };

    for (const segment of chopContour(square, 5)) {
      for (let i = 1; i < segment.points.length; i++) {
        expect(segment.points[i]).not.toEqual(segment.points[i - 1]);
      }
    }
  });

  it("reports the midpoint at half the arc length, not half way between the ends", () => {
    const corner = openContour([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);

    const [segment] = chopContour(corner, 100);

    expect(segment!.midpoint).toEqual({ x: 10, y: 0 });
  });

  it("emits one piece when no maximum is set", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ x: i * 100, y: 0 }));

    expect(chopContour(openContour(points), 0)).toHaveLength(1);
    expect(chopContour(openContour(points), Infinity)).toHaveLength(1);
  });

  it("ignores degenerate contours rather than emitting zero-length pieces", () => {
    expect(chopContour(openContour([]), 10)).toEqual([]);
    expect(chopContour(openContour([{ x: 1, y: 1 }]), 10)).toEqual([]);
    expect(
      chopContour(
        openContour([
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ]),
        10,
      ),
    ).toEqual([]);
  });

  it("terminates on a contour with repeated points", () => {
    // Repeated points make an edge of length zero, which is where a consume-the-remainder
    // loop would spin.
    const repeated = openContour([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ]);

    const segments = chopContour(repeated, 10);

    expect(totalLength(segments)).toBeCloseTo(100, 6);
  });
});

describe("chopContours", () => {
  it("flattens every contour into one list of segments", () => {
    const segments = chopContours(
      [
        openContour([
          { x: 0, y: 0 },
          { x: 50, y: 0 },
        ]),
        openContour([
          { x: 0, y: 10 },
          { x: 30, y: 10 },
        ]),
      ],
      25,
    );

    expect(segments).toHaveLength(4);
    expect(totalLength(segments)).toBeCloseTo(80, 6);
  });
});

describe("pointAtLength", () => {
  it("clamps beyond either end", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];

    expect(pointAtLength(points, -5)).toEqual({ x: 0, y: 0 });
    expect(pointAtLength(points, 500)).toEqual({ x: 10, y: 0 });
  });

  it("walks across vertices", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];

    expect(pointAtLength(points, 15)).toEqual({ x: 10, y: 5 });
  });
});
