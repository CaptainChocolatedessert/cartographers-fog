import { describe, expect, it } from "vitest";
import {
  blocksFrom,
  distanceToPointSquared,
  isDegenerate,
  rayHitDistance,
  sideOf,
  type Segment,
} from "./segment";
import { fromAngle, normalize, type Vector2 } from "./vector";

/** A vertical wall at x = 10, spanning y in [-5, 5]. */
const wall: Segment = { a: { x: 10, y: -5 }, b: { x: 10, y: 5 } };
const origin: Vector2 = { x: 0, y: 0 };

const RIGHT = { x: 1, y: 0 };
const UP = { x: 0, y: 1 };
const LEFT = { x: -1, y: 0 };

describe("rayHitDistance", () => {
  it("returns the distance to a wall straight ahead", () => {
    expect(rayHitDistance(origin, RIGHT, wall)).toBeCloseTo(10);
  });

  it("misses when the ray points away", () => {
    expect(rayHitDistance(origin, LEFT, wall)).toBeNull();
  });

  it("misses when the ray passes beyond the segment's extent", () => {
    // Aimed at (10, 20), which is well past the wall's end at y = 5.
    expect(rayHitDistance(origin, normalize({ x: 10, y: 20 }), wall)).toBeNull();
  });

  it("misses when parallel", () => {
    expect(rayHitDistance(origin, UP, wall)).toBeNull();
  });

  it("does not report a hit behind the ray origin", () => {
    // Starting past the wall and looking further right.
    expect(rayHitDistance({ x: 20, y: 0 }, RIGHT, wall)).toBeNull();
  });

  it("reports a true distance for a diagonal ray", () => {
    const diagonal: Segment = { a: { x: 0, y: 10 }, b: { x: 20, y: 10 } };
    const hit = rayHitDistance(origin, normalize({ x: 1, y: 1 }), diagonal);
    expect(hit).toBeCloseTo(Math.hypot(10, 10));
  });

  it("hits exactly at a segment endpoint", () => {
    const hit = rayHitDistance(origin, normalize({ x: 10, y: 5 }), wall);
    expect(hit).toBeCloseTo(Math.hypot(10, 5));
  });

  it("finds the wall at every angle facing it", () => {
    for (let i = -4; i <= 4; i++) {
      const angle = (i / 10) * Math.PI * 0.25;
      expect(rayHitDistance(origin, fromAngle(angle), wall)).not.toBeNull();
    }
  });
});

describe("sideOf and blocksFrom", () => {
  it("gives opposite signs either side of the line", () => {
    const left = sideOf(wall, { x: 0, y: 0 });
    const right = sideOf(wall, { x: 20, y: 0 });

    expect(Math.sign(left)).not.toBe(Math.sign(right));
    expect(left).not.toBe(0);
  });

  it("gives zero for a collinear point", () => {
    expect(sideOf(wall, { x: 10, y: 100 })).toBe(0);
  });

  it("blocks from both sides when not one-sided", () => {
    expect(blocksFrom(wall, { x: 0, y: 0 })).toBe(true);
    expect(blocksFrom(wall, { x: 20, y: 0 })).toBe(true);
  });

  it("blocks from exactly one side when one-sided", () => {
    const oneSided: Segment = { ...wall, oneSided: true };
    const fromLeft = blocksFrom(oneSided, { x: 0, y: 0 });
    const fromRight = blocksFrom(oneSided, { x: 20, y: 0 });

    // Which side is the front depends on FRONT_SIDE_SIGN, an unverified convention. What
    // must hold regardless is that the two sides disagree.
    expect(fromLeft).not.toBe(fromRight);
  });
});

describe("distanceToPointSquared", () => {
  it("measures perpendicular distance when the foot lies on the segment", () => {
    expect(distanceToPointSquared(wall, origin)).toBeCloseTo(100);
  });

  it("measures to the nearest endpoint when the foot lies beyond it", () => {
    // (10, 15) is 10 past the wall's top end at (10, 5).
    expect(distanceToPointSquared(wall, { x: 10, y: 15 })).toBeCloseTo(100);
  });

  it("is zero for a point on the segment", () => {
    expect(distanceToPointSquared(wall, { x: 10, y: 0 })).toBeCloseTo(0);
  });

  it("handles a degenerate segment without dividing by zero", () => {
    const point: Segment = { a: { x: 3, y: 4 }, b: { x: 3, y: 4 } };
    expect(distanceToPointSquared(point, origin)).toBeCloseTo(25);
  });
});

describe("isDegenerate", () => {
  it("detects zero-length segments", () => {
    expect(isDegenerate({ a: { x: 1, y: 1 }, b: { x: 1, y: 1 } })).toBe(true);
    expect(isDegenerate(wall)).toBe(false);
  });
});
