import { describe, expect, it } from "vitest";

import { litInSight } from "./litInSight";
import { area, pointInPolygon } from "../geometry/polygon";
import type { Vector2 } from "../geometry/vector";

const disc = (centre: Vector2, radius: number, sides = 48): Vector2[] =>
  Array.from({ length: sides }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2;
    return {
      x: centre.x + Math.cos(angle) * radius,
      y: centre.y + Math.sin(angle) * radius,
    };
  });

const totalArea = (pieces: Vector2[][]): number =>
  pieces.reduce((sum, piece) => sum + area(piece), 0);

describe("litInSight", () => {
  it("gives nothing when the party cannot see the lit area at all", () => {
    // The bug this whole rule exists for: a brazier lighting a room nobody is looking into must
    // contribute nothing, or its room gets cut out of the parchment and advertises that it exists.
    const lit = disc({ x: 1000, y: 1000 }, 200);
    const sight = [{ origin: { x: 0, y: 0 }, polygon: disc({ x: 0, y: 0 }, 300) }];

    expect(litInSight(lit, { x: 1000, y: 1000 }, sight)).toEqual([]);
  });

  it("gives nothing when there is no line of sight at all", () => {
    // No primary light in the scene means nobody is looking, so nothing a fixture lights counts.
    const lit = disc({ x: 0, y: 0 }, 200);
    expect(litInSight(lit, { x: 0, y: 0 }, [])).toEqual([]);
  });

  it("returns only the overlap, not the whole lit area", () => {
    // A hall lit by a brazier, seen through a doorway: the party get the part they can see, and
    // emphatically not the rest of the room.
    const lit = disc({ x: 0, y: 0 }, 200, 128);
    const sight = [
      { origin: { x: 200, y: 0 }, polygon: disc({ x: 200, y: 0 }, 200, 128) },
    ];

    const pieces = litInSight(lit, { x: 0, y: 0 }, sight);
    expect(pieces.length).toBeGreaterThan(0);

    // Two discs of radius r with centres r apart overlap by r^2(2pi/3 - sqrt(3)/2).
    const exact = 200 * 200 * ((2 * Math.PI) / 3 - Math.sqrt(3) / 2);
    const recovered = totalArea(pieces);

    // **Bounded below the true overlap, never above it, and that asymmetry is the point.** The
    // polygons are simplified before clipping to keep the cost sane, which inscribes them, so a
    // few percent goes missing. Losing a sliver of ground the party can see is invisible; claiming
    // ground they cannot is a hole in the parchment revealing a room. Asserting equality would
    // have pinned the wrong property and would fail the moment the tolerance moved.
    expect(recovered).toBeLessThanOrEqual(exact);
    expect(recovered).toBeGreaterThan(exact * 0.9);
    expect(recovered).toBeLessThan(area(lit));
  });

  it("never returns ground outside BOTH the lit area and the line of sight", () => {
    // The soundness property. Credited ground the party cannot actually see becomes a hole in the
    // parchment revealing a room, and later a sketch of one.
    const lit = disc({ x: 0, y: 0 }, 200, 64);
    const sight = [
      { origin: { x: 150, y: 60 }, polygon: disc({ x: 150, y: 60 }, 220, 64) },
    ];

    const pieces = litInSight(lit, { x: 0, y: 0 }, sight);
    expect(pieces.length).toBeGreaterThan(0);

    for (const piece of pieces) {
      const centroid = piece.reduce(
        (sum, p) => ({ x: sum.x + p.x / piece.length, y: sum.y + p.y / piece.length }),
        { x: 0, y: 0 },
      );
      expect(pointInPolygon(centroid, lit)).toBe(true);
      expect(pointInPolygon(centroid, sight[0]!.polygon)).toBe(true);
    }
  });

  it("accumulates across several viewers", () => {
    // Two party members looking into the same lit room from different doorways see more of it
    // between them than either does alone.
    const lit = disc({ x: 0, y: 0 }, 200, 96);
    const one = { origin: { x: 180, y: 0 }, polygon: disc({ x: 180, y: 0 }, 200, 96) };
    const two = { origin: { x: -180, y: 0 }, polygon: disc({ x: -180, y: 0 }, 200, 96) };

    const alone = totalArea(litInSight(lit, { x: 0, y: 0 }, [one]));
    const together = totalArea(litInSight(lit, { x: 0, y: 0 }, [one, two]));

    expect(together).toBeGreaterThan(alone);
    // Still bounded by the lit area itself — the two viewers' shares barely meet here, so this
    // also catches the pieces being double counted.
    expect(together).toBeLessThanOrEqual(area(lit) + 1e-6);
  });

  it("over-reports a scalloped sight polygon by no more than the clip tolerance", () => {
    // **This pins a bound, not exactness, and the distinction is the honest part.**
    //
    // A real line-of-sight polygon is non-convex, and simplifying it before clipping moves the
    // boundary *outward* across shallow concave stretches — claiming a sliver of ground the party
    // cannot see. The centroid check in `litInSight` was written to catch that and does not: a fan
    // triangle is anchored at the light, so its centroid sits around two thirds of the way out,
    // nowhere near the boundary being tested. Switching that check off breaks no fixture here, and
    // I could not construct one where it fires — the simplifier keeps deep notches, and the
    // shallow ones it flattens produce bulges the centroid never sees.
    //
    // What genuinely holds is that the error is bounded by the simplify tolerance — a few world
    // units, against walls tens of units thick — so it cannot reach past a wall into another room.
    // That is the guarantee worth asserting.
    const teeth = 60;
    const scalloped: Vector2[] = Array.from({ length: teeth * 2 }, (_, i) => {
      const angle = (i / (teeth * 2)) * Math.PI * 2;
      const radius = i % 2 === 0 ? 200 : 197;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });

    const lit = disc({ x: 0, y: 0 }, 300, 96);
    const pieces = litInSight(lit, { x: 0, y: 0 }, [
      { origin: { x: 0, y: 0 }, polygon: scalloped },
    ]);
    expect(pieces.length).toBeGreaterThan(0);

    // Never past the outer envelope, whatever the simplifier did to the valleys.
    for (const piece of pieces) {
      for (const vertex of piece) {
        expect(Math.hypot(vertex.x, vertex.y)).toBeLessThanOrEqual(200 + 1e-6);
      }
    }
    // And the claimed area exceeds the true one only by the sliver the valleys give up.
    expect(totalArea(pieces)).toBeLessThanOrEqual(area(scalloped) * 1.02);
  });

  it("degrades to nothing rather than throwing on degenerate input", () => {
    const sight = [{ origin: { x: 0, y: 0 }, polygon: disc({ x: 0, y: 0 }, 100) }];
    expect(litInSight([], { x: 0, y: 0 }, sight)).toEqual([]);
    expect(litInSight([{ x: 0, y: 0 }, { x: 1, y: 1 }], { x: 0, y: 0 }, sight)).toEqual([]);
    expect(
      litInSight(disc({ x: 0, y: 0 }, 50), { x: 0, y: 0 }, [
        { origin: { x: 0, y: 0 }, polygon: [] },
      ]),
    ).toEqual([]);
  });
});
