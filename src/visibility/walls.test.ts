import { describe, expect, it } from "vitest";
import { wallsToSegments, type WallLike } from "./walls";

function wall(overrides: Partial<WallLike> = {}): WallLike {
  return {
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    blocking: true,
    doubleSided: true,
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    ...overrides,
  };
}

describe("wallsToSegments", () => {
  it("splits a polyline into consecutive segments", () => {
    const segments = wallsToSegments([
      wall({
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.a).toEqual({ x: 0, y: 0 });
    expect(segments[0]!.b).toEqual({ x: 10, y: 0 });
    expect(segments[1]!.a).toEqual({ x: 10, y: 0 });
    expect(segments[1]!.b).toEqual({ x: 10, y: 10 });
  });

  it("drops non-blocking walls", () => {
    expect(wallsToSegments([wall({ blocking: false })])).toEqual([]);
  });

  it("keeps walls that are not visible, since visibility is an editor concern", () => {
    // `visible` is deliberately not part of WallLike — only `blocking` decides occlusion.
    expect(wallsToSegments([wall()])).toHaveLength(1);
  });

  it("applies the item transform to local points", () => {
    const segments = wallsToSegments([
      wall({
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
        position: { x: 100, y: 200 },
        rotation: 90,
        scale: { x: 2, y: 1 },
      }),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.a.x).toBeCloseTo(100);
    expect(segments[0]!.a.y).toBeCloseTo(200);
    // scale (5,0) -> (10,0); rotate 90 -> (0,10); translate -> (100,210)
    expect(segments[0]!.b.x).toBeCloseTo(100);
    expect(segments[0]!.b.y).toBeCloseTo(210);
  });

  it("marks segments from a single-sided wall as one-sided", () => {
    const [doubleSided] = wallsToSegments([wall({ doubleSided: true })]);
    const [singleSided] = wallsToSegments([wall({ doubleSided: false })]);

    expect(doubleSided!.oneSided).toBe(false);
    expect(singleSided!.oneSided).toBe(true);
  });

  it("skips duplicated consecutive points", () => {
    const segments = wallsToSegments([
      wall({
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
      }),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.a).toEqual({ x: 0, y: 0 });
    expect(segments[0]!.b).toEqual({ x: 10, y: 0 });
  });

  it("skips walls with fewer than two points", () => {
    expect(wallsToSegments([wall({ points: [] })])).toEqual([]);
    expect(wallsToSegments([wall({ points: [{ x: 1, y: 1 }] })])).toEqual([]);
  });

  it("flattens several walls into one list", () => {
    const segments = wallsToSegments([
      wall({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }),
      wall({ points: [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }] }),
    ]);

    expect(segments).toHaveLength(3);
  });

  it("returns an empty list for no walls", () => {
    expect(wallsToSegments([])).toEqual([]);
  });
});
