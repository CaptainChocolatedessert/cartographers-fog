import { describe, expect, it } from "vitest";
import { toWorld, toWorldAll, type Transformable } from "./transform";

const identity: Transformable = {
  position: { x: 0, y: 0 },
  rotation: 0,
  scale: { x: 1, y: 1 },
};

function expectPoint(actual: { x: number; y: number }, x: number, y: number) {
  expect(actual.x).toBeCloseTo(x, 10);
  expect(actual.y).toBeCloseTo(y, 10);
}

describe("toWorld", () => {
  it("is a no-op under an identity transform", () => {
    expectPoint(toWorld({ x: 5, y: -3 }, identity), 5, -3);
  });

  it("translates", () => {
    const item = { ...identity, position: { x: 10, y: 20 } };
    expectPoint(toWorld({ x: 5, y: 0 }, item), 15, 20);
  });

  it("rotates in degrees, not radians", () => {
    // If this were treated as radians, 90 would land nowhere near (0, 5).
    const item = { ...identity, rotation: 90 };
    expectPoint(toWorld({ x: 5, y: 0 }, item), 0, 5);
  });

  it("rotates 180 and 270 as expected", () => {
    expectPoint(toWorld({ x: 5, y: 0 }, { ...identity, rotation: 180 }), -5, 0);
    expectPoint(toWorld({ x: 5, y: 0 }, { ...identity, rotation: 270 }), 0, -5);
  });

  it("scales per axis", () => {
    const item = { ...identity, scale: { x: 2, y: 3 } };
    expectPoint(toWorld({ x: 5, y: 5 }, item), 10, 15);
  });

  /**
   * The SDK composes fromItem as multiply(multiply(T, R), S) — scale applied first, then
   * rotation, then translation. Getting that order backwards is the classic bug here and it
   * is invisible whenever rotation or scale happens to be identity, so pin it with a case
   * where both are non-trivial and the two orderings disagree.
   */
  it("applies scale before rotation, matching MathM.fromItem's T*R*S", () => {
    const item: Transformable = {
      position: { x: 100, y: 200 },
      rotation: 90,
      scale: { x: 2, y: 1 },
    };

    // scale (5,0) -> (10,0); rotate 90 -> (0,10); translate -> (100,210).
    // Rotating before scaling would give (5,0) -> (0,5) -> (0,5) -> (100,205).
    expectPoint(toWorld({ x: 5, y: 0 }, item), 100, 210);
  });

  it("handles negative scale (a mirrored item)", () => {
    const item = { ...identity, scale: { x: -1, y: 1 } };
    expectPoint(toWorld({ x: 5, y: 2 }, item), -5, 2);
  });
});

describe("toWorldAll", () => {
  it("transforms every point and preserves order", () => {
    const item = { ...identity, position: { x: 1, y: 1 } };
    const result = toWorldAll([{ x: 0, y: 0 }, { x: 2, y: 0 }], item);

    expect(result).toHaveLength(2);
    expectPoint(result[0]!, 1, 1);
    expectPoint(result[1]!, 3, 1);
  });

  it("returns an empty array for no points", () => {
    expect(toWorldAll([], identity)).toEqual([]);
  });
});
