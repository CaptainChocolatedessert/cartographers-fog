import { describe, expect, it } from "vitest";
import { computeVisibilityPolygon } from "./visibility";
import type { Segment } from "../geometry/segment";
import { area, pointInPolygon } from "../geometry/polygon";
import {
  angleOf,
  distance,
  fromAngle,
  subtract,
  type Vector2,
} from "../geometry/vector";

const ORIGIN: Vector2 = { x: 0, y: 0 };

/** A closed 200x200 room centred on the origin. */
const room: Segment[] = [
  { a: { x: -100, y: -100 }, b: { x: 100, y: -100 } },
  { a: { x: 100, y: -100 }, b: { x: 100, y: 100 } },
  { a: { x: 100, y: 100 }, b: { x: -100, y: 100 } },
  { a: { x: -100, y: 100 }, b: { x: -100, y: -100 } },
];

/** A short wall above the origin, spanning x in [-50, 50] at y = 100. */
const overheadWall: Segment[] = [
  { a: { x: -50, y: 100 }, b: { x: 50, y: 100 } },
];

describe("computeVisibilityPolygon: unobstructed", () => {
  it("returns a radius-bounded ring when nothing blocks", () => {
    const polygon = computeVisibilityPolygon(ORIGIN, [], { radius: 100 });

    expect(polygon).toHaveLength(64);
    for (const vertex of polygon) {
      expect(distance(ORIGIN, vertex)).toBeCloseTo(100);
    }
  });

  it("approximates a circle's area", () => {
    const polygon = computeVisibilityPolygon(ORIGIN, [], { radius: 100 });
    // An inscribed 64-gon, so slightly under pi*r^2.
    expect(area(polygon)).toBeGreaterThan(Math.PI * 100 * 100 * 0.99);
    expect(area(polygon)).toBeLessThanOrEqual(Math.PI * 100 * 100);
  });

  it("honours arcSamples", () => {
    const coarse = computeVisibilityPolygon(ORIGIN, [], {
      radius: 100,
      arcSamples: 8,
    });
    expect(coarse).toHaveLength(8);
    // A coarser ring is a poorer approximation, so it encloses less.
    expect(area(coarse)).toBeLessThan(
      area(computeVisibilityPolygon(ORIGIN, [], { radius: 100 })),
    );
  });

  it("returns nothing for a non-positive radius", () => {
    expect(computeVisibilityPolygon(ORIGIN, room, { radius: 0 })).toEqual([]);
    expect(computeVisibilityPolygon(ORIGIN, room, { radius: -5 })).toEqual([]);
  });
});

describe("computeVisibilityPolygon: occlusion", () => {
  it("stops at the walls of an enclosing room", () => {
    const polygon = computeVisibilityPolygon(ORIGIN, room, { radius: 1000 });

    // Every vertex should sit on the room boundary, never out at the radius.
    for (const vertex of polygon) {
      expect(Math.max(Math.abs(vertex.x), Math.abs(vertex.y))).toBeCloseTo(100);
    }

    expect(area(polygon)).toBeGreaterThan(200 * 200 * 0.999);
    expect(area(polygon)).toBeLessThan(200 * 200 * 1.001);
  });

  it("casts a shadow behind a wall", () => {
    const polygon = computeVisibilityPolygon(ORIGIN, overheadWall, {
      radius: 1000,
    });

    expect(pointInPolygon({ x: 0, y: 50 }, polygon)).toBe(true); // in front
    expect(pointInPolygon({ x: 0, y: 150 }, polygon)).toBe(false); // behind
  });

  it("leaves sight lines past the ends of a wall intact", () => {
    const polygon = computeVisibilityPolygon(ORIGIN, overheadWall, {
      radius: 1000,
    });

    // Directly to the side, so the ray never reaches y = 100.
    expect(pointInPolygon({ x: 500, y: 0 }, polygon)).toBe(true);
  });

  it("never reports anything beyond the radius as visible", () => {
    const polygon = computeVisibilityPolygon(ORIGIN, overheadWall, {
      radius: 200,
    });

    expect(pointInPolygon({ x: 0, y: 500 }, polygon)).toBe(false);
    for (const vertex of polygon) {
      expect(distance(ORIGIN, vertex)).toBeLessThanOrEqual(200 + 1e-6);
    }
  });

  /**
   * Regression guard for the corner nudge. Casting only at the exact corner angle leaves the
   * polygon jumping straight from the corner to the next arc sample, and the chord between
   * them wrongly slices off the wedge of open space just past the wall's end. Arc sampling
   * hides this from coarser assertions, so the probe sits deliberately within a
   * thousandth of a radian of the corner.
   */
  it("sees past the end of a wall, not merely up to the corner", () => {
    const cornerAngle = angleOf(subtract({ x: 50, y: 100 }, ORIGIN));
    const justOutsideTheCorner = fromAngle(cornerAngle - 0.001, 900);

    const polygon = computeVisibilityPolygon(ORIGIN, overheadWall, {
      radius: 1000,
    });

    expect(pointInPolygon(justOutsideTheCorner, polygon)).toBe(true);
  });

  it("sees round a corner into an alcove", () => {
    // A wall with a gap in the middle: sight should pass through the gap.
    const gapped: Segment[] = [
      { a: { x: -200, y: 100 }, b: { x: -20, y: 100 } },
      { a: { x: 20, y: 100 }, b: { x: 200, y: 100 } },
    ];
    const polygon = computeVisibilityPolygon(ORIGIN, gapped, { radius: 1000 });

    expect(pointInPolygon({ x: 0, y: 300 }, polygon)).toBe(true); // through the gap
    expect(pointInPolygon({ x: -100, y: 300 }, polygon)).toBe(false); // behind a panel
  });
});

describe("computeVisibilityPolygon: invariants", () => {
  it("always encloses the origin", () => {
    for (const segments of [[], room, overheadWall]) {
      const polygon = computeVisibilityPolygon(ORIGIN, segments, {
        radius: 1000,
      });
      expect(pointInPolygon(ORIGIN, polygon)).toBe(true);
    }
  });

  it("returns vertices in ascending angular order", () => {
    const polygon = computeVisibilityPolygon(ORIGIN, room, { radius: 1000 });

    let previous = -Infinity;
    for (const vertex of polygon) {
      const angle = angleOf(subtract(vertex, ORIGIN));
      const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
      expect(normalized).toBeGreaterThanOrEqual(previous);
      previous = normalized;
    }
  });

  it("works from an off-centre origin", () => {
    const viewer = { x: 50, y: 50 };
    const polygon = computeVisibilityPolygon(viewer, room, { radius: 1000 });

    expect(pointInPolygon(viewer, polygon)).toBe(true);
    expect(pointInPolygon({ x: 0, y: 0 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 300, y: 300 }, polygon)).toBe(false);
  });
});

describe("computeVisibilityPolygon: culling", () => {
  it("ignores walls that lie entirely beyond the radius", () => {
    const distant: Segment[] = [
      { a: { x: 5000, y: -100 }, b: { x: 5000, y: 100 } },
    ];

    expect(
      computeVisibilityPolygon(ORIGIN, distant, { radius: 100 }),
    ).toEqual(computeVisibilityPolygon(ORIGIN, [], { radius: 100 }));
  });

  it("ignores degenerate segments", () => {
    const degenerate: Segment[] = [
      { a: { x: 10, y: 10 }, b: { x: 10, y: 10 } },
    ];

    expect(
      computeVisibilityPolygon(ORIGIN, degenerate, { radius: 100 }),
    ).toEqual(computeVisibilityPolygon(ORIGIN, [], { radius: 100 }));
  });
});

describe("computeVisibilityPolygon: one-sided walls", () => {
  const oneSided: Segment[] = [
    { a: { x: -50, y: 100 }, b: { x: 50, y: 100 }, oneSided: true },
  ];

  it("blocks from both sides by default", () => {
    const below = computeVisibilityPolygon({ x: 0, y: 0 }, oneSided, {
      radius: 1000,
    });
    const above = computeVisibilityPolygon({ x: 0, y: 200 }, oneSided, {
      radius: 1000,
    });

    expect(pointInPolygon({ x: 0, y: 150 }, below)).toBe(false);
    expect(pointInPolygon({ x: 0, y: 50 }, above)).toBe(false);
  });

  it("blocks from exactly one side when one-sided walls are honoured", () => {
    const options = { radius: 1000, treatOneSidedAsSolid: false };

    const below = computeVisibilityPolygon({ x: 0, y: 0 }, oneSided, options);
    const above = computeVisibilityPolygon({ x: 0, y: 200 }, oneSided, options);

    const seesThroughFromBelow = pointInPolygon({ x: 0, y: 150 }, below);
    const seesThroughFromAbove = pointInPolygon({ x: 0, y: 50 }, above);

    // Which side blocks depends on FRONT_SIDE_SIGN, which is unverified. What must hold
    // either way is that the wall is solid from one side and transparent from the other.
    expect(seesThroughFromBelow).not.toBe(seesThroughFromAbove);
  });
});

describe("cone lights", () => {
  const open: Segment[] = [];

  it("treats an absent, zero or full-turn cone as a circle", () => {
    // A zero almost certainly means "no cone configured" rather than "this light is blind", and
    // reading it the other way would silently delete a light's whole contribution.
    const circle = area(computeVisibilityPolygon(ORIGIN, open, { radius: 100 }));

    for (const coneAngle of [undefined, 0, -1, Math.PI * 2, Math.PI * 3, NaN]) {
      const swept = computeVisibilityPolygon(ORIGIN, open, {
        radius: 100,
        coneAngle,
      });
      expect(area(swept)).toBeCloseTo(circle, 0);
    }
  });

  it("sweeps half the area at a half-turn, and a quarter at a quarter", () => {
    const circle = area(computeVisibilityPolygon(ORIGIN, open, { radius: 100 }));

    const half = computeVisibilityPolygon(ORIGIN, open, {
      radius: 100,
      coneAngle: Math.PI,
    });
    const quarter = computeVisibilityPolygon(ORIGIN, open, {
      radius: 100,
      coneAngle: Math.PI / 2,
    });

    expect(area(half) / circle).toBeCloseTo(0.5, 1);
    expect(area(quarter) / circle).toBeCloseTo(0.25, 1);
  });

  it("includes the apex, so the slice is closed through the light", () => {
    // A pie slice's boundary passes through its apex. A full circle's must not — inserting the
    // origin there would pinch the polygon shut through its own middle.
    const cone = computeVisibilityPolygon(ORIGIN, open, {
      radius: 100,
      coneAngle: Math.PI / 2,
    });
    expect(cone.some((p) => p.x === ORIGIN.x && p.y === ORIGIN.y)).toBe(true);
  });

  it("points where it is facing", () => {
    const facingRight = computeVisibilityPolygon(ORIGIN, open, {
      radius: 100,
      coneAngle: Math.PI / 2,
      facing: 0,
    });

    expect(pointInPolygon({ x: 60, y: 0 }, facingRight)).toBe(true);
    expect(pointInPolygon({ x: -60, y: 0 }, facingRight)).toBe(false);
    expect(pointInPolygon({ x: 0, y: 60 }, facingRight)).toBe(false);
  });

  it("works when the cone straddles zero", () => {
    // Ordering by absolute angle would split this into two groups at opposite ends of the range
    // and fold the polygon through itself, so the area would come out wrong or negative.
    const straddling = computeVisibilityPolygon(ORIGIN, open, {
      radius: 100,
      coneAngle: Math.PI / 2,
      facing: 0,
    });
    const rotated = computeVisibilityPolygon(ORIGIN, open, {
      radius: 100,
      coneAngle: Math.PI / 2,
      facing: Math.PI,
    });
    expect(area(straddling)).toBeCloseTo(area(rotated), 0);
    expect(pointInPolygon({ x: 60, y: 0 }, straddling)).toBe(true);
  });

  it("is always a subset of the full circle, whatever the facing", () => {
    // The property that makes shipping an unverified cone convention safe: getting the facing
    // wrong can only reveal LESS than the circle this used to sweep, never more. So it cannot
    // introduce a reveal that is not already happening.
    const circle = computeVisibilityPolygon(ORIGIN, room, { radius: 150 });

    for (let i = 0; i < 12; i++) {
      const cone = computeVisibilityPolygon(ORIGIN, room, {
        radius: 150,
        coneAngle: Math.PI / 3,
        facing: (i / 12) * Math.PI * 2,
      });
      expect(area(cone)).toBeLessThanOrEqual(area(circle) + 1e-6);
    }
  });

  it("is still bounded by walls", () => {
    // A cone must not see through a wall just because the wall is inside its wedge.
    const wall: Segment[] = [{ a: { x: 50, y: -100 }, b: { x: 50, y: 100 } }];
    const cone = computeVisibilityPolygon(ORIGIN, wall, {
      radius: 200,
      coneAngle: Math.PI / 2,
      facing: 0,
    });

    expect(pointInPolygon({ x: 30, y: 0 }, cone)).toBe(true);
    expect(pointInPolygon({ x: 120, y: 0 }, cone)).toBe(false);
  });
});
