import { describe, expect, it } from "vitest";
import { boundingBox } from "../geometry/polygon";
import { field, fieldFromRows } from "./fixtures";
import { traceContours } from "./marchingSquares";

/** 1 inside an axis-aligned block of samples, 0 outside. */
function block(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
) {
  return field(width, height, (x, y) =>
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
      ? 1
      : 0,
  );
}

describe("traceContours", () => {
  it("returns nothing for a field with no cells", () => {
    expect(traceContours(field(1, 1, () => 1), 0.5)).toEqual([]);
    expect(traceContours(field(0, 0, () => 1), 0.5)).toEqual([]);
  });

  it("returns nothing when the level is outside the field's range", () => {
    expect(traceContours(block(7, 7, { x: 2, y: 2, width: 3, height: 3 }), 2)).toEqual(
      [],
    );
  });

  it("wraps a block in one closed contour, cutting halfway to the outside samples", () => {
    const contours = traceContours(
      block(7, 7, { x: 2, y: 2, width: 3, height: 3 }),
      0.5,
    );

    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);

    const bounds = boundingBox(contours[0]!.points);
    expect(bounds.min.x).toBeCloseTo(1.5, 6);
    expect(bounds.min.y).toBeCloseTo(1.5, 6);
    expect(bounds.max.x).toBeCloseTo(4.5, 6);
    expect(bounds.max.y).toBeCloseTo(4.5, 6);
  });

  it("visits each boundary crossing once and does not repeat the closing point", () => {
    const [contour] = traceContours(
      block(7, 7, { x: 2, y: 2, width: 3, height: 3 }),
      0.5,
    );

    // Six horizontal and six vertical grid edges cross the block's boundary.
    expect(contour!.points).toHaveLength(12);
    expect(contour!.points[0]).not.toEqual(
      contour!.points[contour!.points.length - 1],
    );
  });

  it("keeps a long smooth boundary in ONE contour, not fragments", () => {
    // The regression test for stitching. Joining crossings by float coordinate equality
    // works on small fixtures and breaks up a real trace into dozens of pieces, because the
    // same crossing computed from two adjacent cells can differ in the last bit.
    const radius = 15;
    const disc = field(41, 41, (x, y) =>
      Math.hypot(x - 20, y - 20) <= radius ? 1 : 0,
    );

    const contours = traceContours(disc, 0.5);

    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
    expect(contours[0]!.points.length).toBeGreaterThan(50);
  });

  it("separates two blobs into two contours", () => {
    const two = field(15, 7, (x, y) => {
      const inFirst = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      const inSecond = x >= 9 && x <= 11 && y >= 2 && y <= 4;
      return inFirst || inSecond ? 1 : 0;
    });

    const contours = traceContours(two, 0.5);

    expect(contours).toHaveLength(2);
    expect(contours.every((contour) => contour.closed)).toBe(true);
  });

  it("leaves a contour open where the feature runs off the image", () => {
    const contours = traceContours(
      field(5, 5, (x) => (x <= 1 ? 1 : 0)),
      0.5,
    );

    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(false);
    expect(contours[0]!.points).toHaveLength(5);
    for (const point of contours[0]!.points) expect(point.x).toBeCloseTo(1.5, 6);
  });

  it("interpolates the crossing rather than snapping to a sample", () => {
    // A ramp crossing 0.5 exactly at x = 5, and at a quarter-cell on a coarser ramp.
    const ramp = traceContours(
      field(11, 3, (x) => x / 10),
      0.5,
    );
    for (const point of ramp[0]!.points) expect(point.x).toBeCloseTo(5, 6);

    const quarter = traceContours(
      field(3, 3, (x) => (x === 0 ? 0.4 : 0.8)),
      0.5,
    );
    for (const point of quarter[0]!.points) expect(point.x).toBeCloseTo(0.25, 6);
  });

  it("resolves an ambiguous saddle by the cell's centre value", () => {
    // Opposite corners inside, and the cell alone cannot say whether the inside or the
    // outside is connected through the middle. Corner average 0.5 counts as inside, so the
    // two inside corners join and the outside corners are cut off individually.
    const saddle = fieldFromRows([
      [0, 1],
      [1, 0],
    ]);

    const contours = traceContours(saddle, 0.5);

    expect(contours).toHaveLength(2);
    for (const contour of contours) {
      expect(contour.closed).toBe(false);
      expect(contour.points).toHaveLength(2);
    }

    // One piece cuts the top-left corner off, the other the bottom-right.
    const corners = contours
      .map((contour) => boundingBox(contour.points))
      .sort((a, b) => a.min.x + a.min.y - (b.min.x + b.min.y));

    expect(corners[0]!.max.x).toBeCloseTo(0.5, 6);
    expect(corners[0]!.max.y).toBeCloseTo(0.5, 6);
    expect(corners[1]!.min.x).toBeCloseTo(0.5, 6);
    expect(corners[1]!.min.y).toBeCloseTo(0.5, 6);
  });

  it("keeps a diagonal corridor connected rather than pinching it shut", () => {
    // Two rooms joined corner to corner. The saddle rule decides whether the traced outline
    // is one shape or two, and a map's diagonal doorways depend on it.
    const corridor = fieldFromRows([
      [0, 0, 0, 0, 0, 0],
      [0, 1, 1, 0, 0, 0],
      [0, 1, 1, 0, 0, 0],
      [0, 0, 0, 1, 1, 0],
      [0, 0, 0, 1, 1, 0],
      [0, 0, 0, 0, 0, 0],
    ]);

    const contours = traceContours(corridor, 0.5);

    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
  });
});
