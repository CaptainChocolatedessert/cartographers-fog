import { describe, expect, it } from "vitest";
import { area, boundingBox, pointInPolygon, signedArea } from "./polygon";
import type { Vector2 } from "./vector";

const square: Vector2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

/** An L, so that the notch is inside the bounding box but outside the polygon. */
const lShape: Vector2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 10 },
  { x: 0, y: 10 },
];

describe("pointInPolygon", () => {
  it("accepts interior points and rejects exterior ones", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 20 }, square)).toBe(false);
  });

  it("handles concavity rather than just the bounding box", () => {
    expect(pointInPolygon({ x: 2, y: 2 }, lShape)).toBe(true);
    // Inside the bounding box, but in the missing corner of the L.
    expect(pointInPolygon({ x: 8, y: 8 }, lShape)).toBe(false);
  });

  it("rejects degenerate polygons", () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBe(false);
    expect(
      pointInPolygon({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }]),
    ).toBe(false);
  });

  it("is unaffected by winding direction", () => {
    const reversed = [...square].reverse();
    expect(pointInPolygon({ x: 5, y: 5 }, reversed)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 15 }, reversed)).toBe(false);
  });
});

describe("boundingBox", () => {
  it("spans the extremes", () => {
    expect(boundingBox(square)).toEqual({
      min: { x: 0, y: 0 },
      max: { x: 10, y: 10 },
    });
  });

  it("handles negatives", () => {
    expect(
      boundingBox([{ x: -5, y: 3 }, { x: 2, y: -7 }]),
    ).toEqual({ min: { x: -5, y: -7 }, max: { x: 2, y: 3 } });
  });

  it("returns a zero box for no points rather than Infinity", () => {
    expect(boundingBox([])).toEqual({
      min: { x: 0, y: 0 },
      max: { x: 0, y: 0 },
    });
  });
});

describe("area", () => {
  it("measures a square", () => {
    expect(area(square)).toBeCloseTo(100);
  });

  it("measures a concave shape", () => {
    // 10x10 minus the 6x6 notch.
    expect(area(lShape)).toBeCloseTo(64);
  });

  it("flips sign with winding but keeps magnitude", () => {
    const forward = signedArea(square);
    const backward = signedArea([...square].reverse());

    expect(Math.sign(forward)).not.toBe(Math.sign(backward));
    expect(Math.abs(forward)).toBeCloseTo(Math.abs(backward));
  });

  it("is zero for degenerate input", () => {
    expect(area([])).toBe(0);
    expect(area([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
  });
});
