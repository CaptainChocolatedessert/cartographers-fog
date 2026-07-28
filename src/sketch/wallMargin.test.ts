import { describe, expect, it } from "vitest";

import { marginSource, wallMargin } from "./wallMargin";

/** The test scene: 816x1056 world units, 1 unit per map pixel, dpi 150. */
const scene = { dpi: 150, mapExtent: 816 };

describe("wallMargin", () => {
  it("scales with the measured ink width", () => {
    // A 6-unit wall line needs half its width to reach its edge, plus slack for the GM's wall
    // not sitting exactly on the art.
    expect(wallMargin({ ...scene, strokeWidthWorld: 6 })).toBeCloseTo(9);
    expect(wallMargin({ ...scene, strokeWidthWorld: 3 })).toBeCloseTo(4.5);
  });

  it("prefers the ink over the grid", () => {
    // The whole point: `getDpi` returns a value even on a scene whose grid never matched the
    // map, so a measurement of the art must win wherever one exists.
    const measured = wallMargin({ ...scene, strokeWidthWorld: 6 });
    const grid = wallMargin({ ...scene, strokeWidthWorld: 0 });
    expect(measured).not.toBeCloseTo(grid);
    expect(marginSource({ ...scene, strokeWidthWorld: 6 })).toBe("ink");
  });

  it("falls back to the grid when the ink cannot be measured", () => {
    // Contour mode has no skeleton, and a degenerate trace has no length.
    expect(wallMargin({ ...scene, strokeWidthWorld: 0 })).toBeCloseTo(15);
    expect(marginSource({ ...scene, strokeWidthWorld: 0 })).toBe("grid");
  });

  it("clamps against the map, not the grid", () => {
    // A filled region reports as one enormously wide stroke. Unclamped, the margin would leak
    // strokes through doorways into ground nobody entered. The ceiling is a share of the map's
    // shorter side so the clamp does not reintroduce the grid dependency.
    expect(wallMargin({ ...scene, strokeWidthWorld: 5000 })).toBeCloseTo(
      816 * 0.02,
    );
  });

  it("clamps the grid fallback too", () => {
    expect(
      wallMargin({ dpi: 100_000, mapExtent: 816, strokeWidthWorld: 0 }),
    ).toBeCloseTo(816 * 0.02);
  });

  it("returns nothing measurable when there is neither ink nor grid", () => {
    expect(wallMargin({ dpi: 0, mapExtent: 816, strokeWidthWorld: 0 })).toBe(0);
    expect(marginSource({ dpi: 0, mapExtent: 816, strokeWidthWorld: 0 })).toBe(
      "none",
    );
  });

  it("survives a map with no measurable extent", () => {
    // No ceiling to apply rather than a zero one — clamping to nothing would silently disable
    // the margin on a scene whose bounds could not be read.
    expect(
      wallMargin({ dpi: 150, mapExtent: 0, strokeWidthWorld: 6 }),
    ).toBeCloseTo(9);
  });

  it("ignores a negative measurement", () => {
    expect(wallMargin({ ...scene, strokeWidthWorld: -3 })).toBeCloseTo(15);
  });
});
