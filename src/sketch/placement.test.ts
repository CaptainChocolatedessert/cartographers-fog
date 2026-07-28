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
  it("maps the raster's corners onto the item's bounds", () => {
    const placement = createPlacement(bounds, 500);
    expect(placement.unitsPerPixel).toBe(2);

    expect(toWorldPoint({ x: 0, y: 0 }, placement)).toEqual({ x: 100, y: 200 });
    // The far corner: 500px * 2 = 1000 units across, 375px * 2 = 750 down.
    expect(toWorldPoint({ x: 500, y: 375 }, placement)).toEqual({
      x: 1100,
      y: 950,
    });
  });

  it("scales y by the same factor as x", () => {
    // A uniform scale is the assumption the whole placement rests on. If y ever gained its own
    // factor, square features on the map would come out as rectangles.
    const placement = createPlacement(bounds, 500);
    expect(toWorldPoint({ x: 10, y: 10 }, placement)).toEqual({
      x: 120,
      y: 220,
    });
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
    const placement = createPlacement(bounds, 500);
    const world = toWorldSegment(segment, placement);

    expect(world.points).toEqual([
      { x: 100, y: 200 },
      { x: 120, y: 200 },
      { x: 120, y: 220 },
    ]);
    expect(world.midpoint).toEqual({ x: 120, y: 200 });
    expect(world.length).toBe(40);
  });

  it("transforms the midpoint rather than recomputing it", () => {
    // The mask tests this exact point, so it must stay the point `chop.ts` chose. A recomputed
    // midpoint would agree here but drift on any segment whose arc length is unevenly
    // distributed, so the property is asserted directly: midpoint maps like any other point.
    const placement = createPlacement(bounds, 500);
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
