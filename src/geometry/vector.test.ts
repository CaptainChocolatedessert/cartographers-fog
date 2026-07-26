import { describe, expect, it } from "vitest";
import {
  add,
  angleOf,
  cross,
  distance,
  dot,
  equals,
  fromAngle,
  length,
  normalize,
  scale,
  subtract,
} from "./vector";

describe("vector arithmetic", () => {
  it("adds, subtracts and scales componentwise", () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(subtract({ x: 3, y: 4 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 2 });
    expect(scale({ x: 2, y: -3 }, 2)).toEqual({ x: 4, y: -6 });
  });

  it("computes dot and length", () => {
    expect(dot({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(0);
    expect(length({ x: 3, y: 4 })).toBe(5);
    expect(distance({ x: 1, y: 1 }, { x: 4, y: 5 })).toBe(5);
  });
});

describe("cross", () => {
  // The sign is what the one-sided wall test and ray intersection both rely on, so it is
  // worth pinning rather than trusting.
  it("is positive turning from +x to +y, negative the other way", () => {
    expect(cross({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(cross({ x: 0, y: 1 }, { x: 1, y: 0 })).toBe(-1);
  });

  it("is zero for parallel vectors", () => {
    expect(cross({ x: 2, y: 4 }, { x: 1, y: 2 })).toBe(0);
    expect(cross({ x: 2, y: 4 }, { x: -1, y: -2 })).toBe(0);
  });
});

describe("normalize", () => {
  it("produces a unit vector", () => {
    expect(length(normalize({ x: 3, y: 4 }))).toBeCloseTo(1);
  });

  it("returns zero for a zero vector rather than NaN", () => {
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("angles", () => {
  it("round-trips through fromAngle and angleOf", () => {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, 3, -1.2]) {
      expect(angleOf(fromAngle(angle))).toBeCloseTo(angle, 10);
    }
  });

  it("scales magnitude", () => {
    expect(length(fromAngle(1.1, 7))).toBeCloseTo(7);
  });
});

describe("equals", () => {
  it("respects the epsilon", () => {
    expect(equals({ x: 1, y: 1 }, { x: 1 + 1e-12, y: 1 })).toBe(true);
    expect(equals({ x: 1, y: 1 }, { x: 1.5, y: 1 })).toBe(false);
    expect(equals({ x: 1, y: 1 }, { x: 1.4, y: 1 }, 0.5)).toBe(true);
  });
});
