import { describe, expect, it } from "vitest";
import type { Vector2 } from "../geometry/vector";
import type { Contour } from "./marchingSquares";
import { simplifyContour, simplifyPolyline } from "./simplify";

function line(count: number, step = 1): Vector2[] {
  return Array.from({ length: count }, (_, i) => ({ x: i * step, y: 0 }));
}

function closedContour(points: readonly Vector2[]): Contour {
  return { points, closed: true };
}

describe("simplifyPolyline", () => {
  it("reduces a straight run to its two ends", () => {
    expect(simplifyPolyline(line(50), 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 49, y: 0 },
    ]);
  });

  it("keeps a deviation larger than the tolerance", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 3 },
      { x: 10, y: 0 },
    ];
    expect(simplifyPolyline(points, 1)).toHaveLength(3);
  });

  it("drops a deviation smaller than the tolerance", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0.4 },
      { x: 10, y: 0 },
    ];
    expect(simplifyPolyline(points, 1)).toHaveLength(2);
  });

  it("measures deviation perpendicular to the chord, not along it", () => {
    // A point far from both ends but exactly on the line between them carries no shape.
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ];
    expect(simplifyPolyline(points, 0.001)).toHaveLength(2);
  });

  it("keeps every point when the tolerance is zero or negative", () => {
    const points = line(10);
    expect(simplifyPolyline(points, 0)).toHaveLength(10);
    expect(simplifyPolyline(points, -1)).toHaveLength(10);
  });

  it("returns a copy, leaving the input untouched", () => {
    const points = line(3);
    const result = simplifyPolyline(points, 0);

    expect(result).not.toBe(points);
    expect(result).toEqual(points);
  });

  it("preserves order and both endpoints", () => {
    const zigzag = Array.from({ length: 200 }, (_, i) => ({
      x: i,
      y: i % 2 === 0 ? 0 : 3,
    }));
    const result = simplifyPolyline(zigzag, 1);

    expect(result[0]).toEqual(zigzag[0]);
    expect(result[result.length - 1]).toEqual(zigzag[zigzag.length - 1]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.x).toBeGreaterThan(result[i - 1]!.x);
    }
  });

  it("handles a contour of the size a real trace produces", () => {
    // Marching squares emits roughly a point per pixel of contour, so this is the scale the
    // simplifier actually sees. It is a termination and cost guard, not a proof about
    // recursion depth — that is why the implementation is iterative, but a balanced input
    // like this one would not expose a recursive version.
    const long = Array.from({ length: 200_000 }, (_, i) => ({
      x: i,
      y: Math.sin(i / 5000) * 0.4,
    }));

    expect(() => simplifyPolyline(long, 0.1)).not.toThrow();
    expect(simplifyPolyline(long, 0.1).length).toBeLessThan(long.length);
  });
});

describe("simplifyContour", () => {
  it("reduces a densely sampled square loop to its four corners", () => {
    const points: Vector2[] = [];
    for (let x = 0; x < 40; x++) points.push({ x, y: 0 });
    for (let y = 0; y < 40; y++) points.push({ x: 40, y });
    for (let x = 40; x > 0; x--) points.push({ x, y: 40 });
    for (let y = 40; y > 0; y--) points.push({ x: 0, y });

    const result = simplifyContour(closedContour(points), 0.5);

    expect(result.closed).toBe(true);
    expect(result.points).toHaveLength(4);
    expect(result.points).toContainEqual({ x: 0, y: 0 });
    expect(result.points).toContainEqual({ x: 40, y: 0 });
    expect(result.points).toContainEqual({ x: 40, y: 40 });
    expect(result.points).toContainEqual({ x: 0, y: 40 });
  });

  it("does not repeat the first point at the end of a loop", () => {
    const points = Array.from({ length: 64 }, (_, i) => ({
      x: 50 + 20 * Math.cos((i / 64) * Math.PI * 2),
      y: 50 + 20 * Math.sin((i / 64) * Math.PI * 2),
    }));

    const result = simplifyContour(closedContour(points), 0.2);

    expect(result.points[0]).not.toEqual(
      result.points[result.points.length - 1],
    );
    expect(result.points.length).toBeGreaterThan(4);
    expect(result.points.length).toBeLessThan(64);
  });

  it("leaves a contour too short to simplify alone", () => {
    const contour: Contour = {
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: false,
    };
    expect(simplifyContour(contour, 5)).toBe(contour);
  });
});
