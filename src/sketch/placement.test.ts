import { describe, expect, it } from "vitest";

import {
  aspectMismatch,
  chooseTraceWidth,
  createPlacement,
  pixelsPerGridSquare,
  rasterHeightFor,
  toWorldPoint,
  toWorldSegment,
} from "./placement";
import {
  effectivePixelsPerGrid,
  HARNESS_PIXELS_PER_GRID,
} from "./traceSettings";
import type { TracedSegment } from "../trace/chop";

const bounds = { min: { x: 100, y: 200 }, max: { x: 1100, y: 950 } };

describe("chooseTraceWidth", () => {
  it("caps a large source at the trace width", () => {
    expect(chooseTraceWidth(4000, 1024)).toBe(1024);
  });

  it("never upscales a smaller source", () => {
    // Enlarging invents detail nobody drew, and leaves thinning chasing interpolation
    // artifacts rather than ink.
    expect(chooseTraceWidth(800, 1024)).toBe(800);
  });

  it("ignores the scene grid entirely", () => {
    // The regression this guards. Choosing width from grid density picked a 174px raster for
    // the test scene's 5.4-square map, which thins every line out of existence. Width is a
    // property of the image, never of how many squares it happens to span.
    expect(chooseTraceWidth(2048, 1024)).toBe(1024);
  });

  it("stays at least one pixel wide", () => {
    expect(chooseTraceWidth(0, 1024)).toBe(1);
  });
});

describe("effectivePixelsPerGrid", () => {
  it("is the harness figure when nothing is downscaled", () => {
    expect(effectivePixelsPerGrid(1024, 800)).toBe(HARNESS_PIXELS_PER_GRID);
  });

  it("falls with the downscale ratio", () => {
    // A 2048-wide source traced at 1024 holds half as many pixels per square.
    expect(effectivePixelsPerGrid(1024, 2048)).toBeCloseTo(35);
  });

  it("never drops below one", () => {
    expect(effectivePixelsPerGrid(1, 100000)).toBe(1);
  });
});

describe("pixelsPerGridSquare", () => {
  it("reports the density a raster achieves", () => {
    expect(pixelsPerGridSquare(320, 1000, 100)).toBeCloseTo(32);
  });

  it("is zero when the scene cannot be measured", () => {
    expect(pixelsPerGridSquare(320, 0, 100)).toBe(0);
    expect(pixelsPerGridSquare(320, 1000, 0)).toBe(0);
  });
});

describe("rasterHeightFor", () => {
  it("preserves the source aspect", () => {
    expect(rasterHeightFor(2000, 1500, 400)).toBe(300);
  });

  it("never rounds away to nothing", () => {
    expect(rasterHeightFor(4000, 3, 100)).toBe(1);
  });
});

describe("createPlacement and toWorldPoint", () => {
  it("places a traced coordinate at its pixel's centre, not the raster's corner", () => {
    const placement = createPlacement(bounds, 500, 375);
    expect(placement.unitsPerPixel).toEqual({ x: 2, y: 2 });

    // Pixel (0,0) *covers* the first two world units on each axis, so its centre is one unit in.
    // Reading it as the bounds' corner is what shifted every stroke up and left.
    expect(toWorldPoint({ x: 0, y: 0 }, placement)).toEqual({ x: 101, y: 201 });

    // ...and the last pixel sits symmetrically inside the far corner, never on it.
    expect(toWorldPoint({ x: 499, y: 374 }, placement)).toEqual({
      x: 1099,
      y: 949,
    });
  });

  it("scales each axis by its own factor", () => {
    // Deliberately the opposite of what this file used to assert. The old test reasoned that a
    // per-axis scale would turn square map features into rectangles — but when an image's world
    // bounds are not a uniform scaling of its pixels, those features are *already* rectangles on
    // screen, and matching the image is what puts strokes on the art. Reproducing the image's own
    // proportions is a different goal from reproducing its placement, and placement is the job.
    const stretched = { min: { x: 0, y: 0 }, max: { x: 1000, y: 800 } };
    const placement = createPlacement(stretched, 500, 500);
    expect(placement.unitsPerPixel).toEqual({ x: 2, y: 1.6 });

    expect(toWorldPoint({ x: 10, y: 10 }, placement)).toEqual({
      x: 21,
      y: 16.8,
    });
  });

  it("does not drift down the map when the bounds are slightly out of proportion", () => {
    // "Lair Of The Lamb" as measured 2026-07-31 — a map nudged a little out of proportion to line
    // its art up with the grid. The aspect mismatch is 0.275%, far under MAX_ASPECT_MISMATCH, and
    // a width-derived scale turned it into +21.7 world units of downward drift at the bottom edge:
    // past the edge of wall linework about 30 units wide. This is the regression that matters, and
    // it is invisible at the top of the map, which is why it survived a room test.
    const map = {
      min: { x: -1668.5, y: -1501.4 },
      max: { x: -1668.5 + 10275.3, y: -1501.4 + 7915.5 },
    };
    const placement = createPlacement(map, 1024, 791);

    const bottomRow = toWorldPoint({ x: 0, y: 790 }, placement);
    expect(bottomRow.y).toBeCloseTo(map.max.y - placement.unitsPerPixel.y / 2, 6);

    // What the single-scale version would have produced, kept as the contrast.
    const drifted = map.min.y + 790.5 * placement.unitsPerPixel.x;
    expect(drifted - bottomRow.y).toBeCloseTo(21.8, 1);
  });
});

describe("toWorldSegment", () => {
  const segment: TracedSegment = {
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    midpoint: { x: 10, y: 0 },
    length: 20,
  };

  it("moves points, midpoint and length together", () => {
    const placement = createPlacement(bounds, 500, 375);
    const world = toWorldSegment(segment, placement);

    expect(world.points).toEqual([
      { x: 101, y: 201 },
      { x: 121, y: 201 },
      { x: 121, y: 221 },
    ]);
    expect(world.midpoint).toEqual({ x: 121, y: 201 });
    expect(world.length).toBe(40);
  });

  it("takes length from the x scale under a per-axis placement", () => {
    // A length has no direction, so there is no correct single factor once the axes differ. The x
    // scale is the choice; asserted so a later reader sees it was chosen rather than overlooked.
    const stretched = { min: { x: 0, y: 0 }, max: { x: 1000, y: 800 } };
    const world = toWorldSegment(segment, createPlacement(stretched, 500, 500));
    expect(world.length).toBe(40);
  });

  it("transforms the midpoint rather than recomputing it", () => {
    // The mask tests this exact point, so it must stay the point `chop.ts` chose. A recomputed
    // midpoint would agree here but drift on any segment whose arc length is unevenly
    // distributed, so the property is asserted directly: midpoint maps like any other point.
    const placement = createPlacement(bounds, 500, 375);
    const world = toWorldSegment(segment, placement);
    expect(world.midpoint).toEqual(toWorldPoint(segment.midpoint, placement));
  });
});

describe("aspectMismatch", () => {
  it("is zero when the bounds are the image scaled", () => {
    // 1000x750 of world against a 4:3 raster.
    expect(aspectMismatch(bounds, 800, 600)).toBeCloseTo(0);
  });

  it("catches bounds that do not match the raster's shape", () => {
    // A square box around a 4:3 image — what a rotation produces, and what would put strokes in
    // the wrong place with no other symptom.
    const square = { min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } };
    expect(aspectMismatch(square, 800, 600)).toBeCloseTo(0.25);
  });

  it("is zero rather than NaN on a degenerate box", () => {
    const empty = { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
    expect(aspectMismatch(empty, 800, 600)).toBe(0);
  });
});
