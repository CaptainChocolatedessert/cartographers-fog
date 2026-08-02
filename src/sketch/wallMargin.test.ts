import { describe, expect, it } from "vitest";

import {
  DEFAULT_MARGIN_STROKE_WIDTHS,
  MAX_MARGIN_STROKE_WIDTHS,
  MIN_MARGIN_STROKE_WIDTHS,
  marginSource,
  readMarginStrokeWidths,
  wallMargin,
} from "./wallMargin";

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

describe("the adjustable multiplier", () => {
  it("leaves the shipped margin exactly as it was when omitted", () => {
    // The property that matters most: this became a parameter, and every scene that has never
    // touched the setting must mask precisely as it did before. Both paths, ink and grid.
    expect(wallMargin({ ...scene, strokeWidthWorld: 6 })).toBe(
      wallMargin({ ...scene, strokeWidthWorld: 6 }, DEFAULT_MARGIN_STROKE_WIDTHS),
    );
    expect(wallMargin({ ...scene, strokeWidthWorld: 0 })).toBe(
      wallMargin({ ...scene, strokeWidthWorld: 0 }, DEFAULT_MARGIN_STROKE_WIDTHS),
    );
  });

  it("scales the margin", () => {
    const inputs = { ...scene, strokeWidthWorld: 6 };
    expect(wallMargin(inputs, 1)).toBeCloseTo(6);
    expect(wallMargin(inputs, 2)).toBeCloseTo(12);
    expect(wallMargin(inputs, 0.5)).toBeCloseTo(3);
  });

  it("is genuinely OFF at zero, rather than falling back to the grid", () => {
    // The trap this control walks straight into. Zero makes the ink term zero, and the fallback
    // below it reads a zero ink term as "unmeasurable" — so without a short circuit, sliding the
    // control to nothing would quietly hand back a grid-derived margin on every scene whose grid
    // is set. The off end would not be off, and it would look like the control doing nothing.
    expect(wallMargin({ ...scene, strokeWidthWorld: 6 }, 0)).toBe(0);
    expect(wallMargin({ ...scene, strokeWidthWorld: 0 }, 0)).toBe(0);
    expect(wallMargin({ ...scene, strokeWidthWorld: 0 }, 0)).not.toBeCloseTo(15);
  });

  it("scales the grid fallback too, and matches the old constant at the default", () => {
    // A trace with unmeasurable ink still has to respond to the control, or the setting appears
    // dead on exactly the maps where it is most needed. Written as a ratio so the default is the
    // shipped 0.1 grid squares exactly rather than a value that rounds to it.
    //
    // A roomier map than `scene` on purpose: at 816 units the 2% ceiling is 16.32, so the scaled
    // fallback hits the clamp and this would measure the clamp instead of the scaling it claims
    // to test. It was written that way first and passed for the wrong reason.
    const roomy = { dpi: 150, mapExtent: 5000, strokeWidthWorld: 0 };

    expect(wallMargin(roomy)).toBeCloseTo(150 * 0.1);
    expect(wallMargin(roomy, 3)).toBeCloseTo(150 * 0.1 * 2);
    expect(wallMargin(roomy, 0.75)).toBeCloseTo(150 * 0.1 * 0.5);
  });

  it("still clamps against the map however wide the setting", () => {
    // The control must not be able to defeat the guard that keeps a filled region from leaking
    // strokes into unentered ground.
    expect(
      wallMargin({ ...scene, strokeWidthWorld: 5000 }, MAX_MARGIN_STROKE_WIDTHS),
    ).toBeCloseTo(816 * 0.02);
  });

  it("treats a negative setting as off", () => {
    expect(wallMargin({ ...scene, strokeWidthWorld: 6 }, -1)).toBe(0);
  });
});

describe("readMarginStrokeWidths", () => {
  it("gives a scene that never set one the judged default", () => {
    // The compatibility guarantee: every existing scene reads this key as absent, so it must mask
    // exactly as it did before the control existed.
    expect(readMarginStrokeWidths(undefined)).toBe(DEFAULT_MARGIN_STROKE_WIDTHS);
    expect(readMarginStrokeWidths(null)).toBe(DEFAULT_MARGIN_STROKE_WIDTHS);
  });

  it("keeps a value inside the range", () => {
    expect(readMarginStrokeWidths(0)).toBe(0);
    expect(readMarginStrokeWidths(2.25)).toBe(2.25);
    expect(readMarginStrokeWidths(MAX_MARGIN_STROKE_WIDTHS)).toBe(
      MAX_MARGIN_STROKE_WIDTHS,
    );
  });

  it("clamps rather than rejecting an out-of-range number", () => {
    // A value slightly outside is one somebody chose; the nearest legal one is what they meant.
    // Rejecting it back to the default would silently undo a deliberate setting.
    expect(readMarginStrokeWidths(99)).toBe(MAX_MARGIN_STROKE_WIDTHS);
    expect(readMarginStrokeWidths(-5)).toBe(MIN_MARGIN_STROKE_WIDTHS);
  });

  it("discards a value that is not a finite number", () => {
    // Scene metadata is writable by any client and a future build could store another shape here.
    for (const raw of ["1.5", {}, [], NaN, Infinity, true]) {
      expect(readMarginStrokeWidths(raw)).toBe(DEFAULT_MARGIN_STROKE_WIDTHS);
    }
  });
});
