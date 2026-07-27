import { describe, expect, it } from "vitest";
import { boundingBox } from "../geometry/polygon";
import { polylineLength } from "./chop";
import { fieldAt } from "./field";
import { blackRectangleOnWhite, greyImage } from "./fixtures";
import {
  DEFAULT_TRACE_OPTIONS,
  buildField,
  traceImage,
  type TraceOptions,
} from "./pipeline";

/** Contour mode with the blur off, so fixtures land on exact coordinates. */
const SHARP: TraceOptions = {
  ...DEFAULT_TRACE_OPTIONS,
  mode: "contour",
  blurSigma: 0,
  simplifyTolerance: 0.5,
  minContourLength: 4,
  segmentLength: 10,
};

/** Centerline mode on clean art, where a global cutoff is the honest comparison. */
const CENTERLINE: TraceOptions = {
  ...DEFAULT_TRACE_OPTIONS,
  mode: "centerline",
  blurSigma: 0,
  simplifyTolerance: 0.5,
  minContourLength: 4,
  segmentLength: 10,
  centerline: {
    ...DEFAULT_TRACE_OPTIONS.centerline,
    threshold: "global",
    level: 0.5,
    stubLength: 4,
  },
};

/** A dark stroke of the given thickness across the middle of a white image. */
function horizontalStroke(
  width: number,
  height: number,
  thickness: number,
): ReturnType<typeof greyImage> {
  const top = Math.round((height - thickness) / 2);
  return greyImage(width, height, (x, y) =>
    y >= top && y < top + thickness && x >= 10 && x < width - 10 ? 0 : 1,
  );
}

describe("buildField", () => {
  it("passes luminance through when that is the field asked for", () => {
    const field = buildField(greyImage(4, 4, (x) => x / 3), SHARP);

    expect(fieldAt(field, 0, 0)).toBeCloseTo(0, 3);
    expect(fieldAt(field, 3, 0)).toBeCloseTo(1, 3);
  });

  it("finds an edge of either polarity with the Sobel field", () => {
    const sobel: TraceOptions = {
      ...SHARP,
      contour: { ...SHARP.contour, field: "sobel" },
    };
    const darkOnLight = buildField(
      blackRectangleOnWhite(40, 40, { x: 10, y: 10, width: 20, height: 20 }),
      sobel,
    );
    const lightOnDark = buildField(
      greyImage(40, 40, (x, y) =>
        x >= 10 && x < 30 && y >= 10 && y < 30 ? 1 : 0,
      ),
      sobel,
    );

    expect(fieldAt(darkOnLight, 10, 20)).toBeGreaterThan(0.5);
    expect(fieldAt(lightOnDark, 10, 20)).toBeGreaterThan(0.5);
    expect(fieldAt(darkOnLight, 20, 20)).toBeCloseTo(0, 5);
  });

  it("uses luminance in centerline mode whatever the contour field says", () => {
    const field = buildField(greyImage(4, 4, (x) => x / 3), {
      ...CENTERLINE,
      contour: { field: "sobel", level: 0.5 },
    });

    expect(fieldAt(field, 3, 0)).toBeCloseTo(1, 3);
  });
});

describe("traceImage — contour mode", () => {
  const rectangle = blackRectangleOnWhite(60, 60, {
    x: 20,
    y: 20,
    width: 20,
    height: 20,
  });

  it("traces a rectangle to one closed contour on its edge", () => {
    const { contours } = traceImage(rectangle, SHARP);

    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);

    const bounds = boundingBox(contours[0]!.points);
    expect(bounds.min.x).toBeCloseTo(19.5, 6);
    expect(bounds.min.y).toBeCloseTo(19.5, 6);
    expect(bounds.max.x).toBeCloseTo(39.5, 6);
    expect(bounds.max.y).toBeCloseTo(39.5, 6);
  });

  it("simplifies that contour to its corners", () => {
    expect(traceImage(rectangle, SHARP).contours[0]!.points).toHaveLength(4);
  });

  it("chops the perimeter into segments of the requested length", () => {
    const { contours, segments } = traceImage(rectangle, SHARP);

    // Slightly under 80: marching squares chamfers each corner of a block, cutting the
    // diagonal between two crossings rather than turning through the corner sample, and
    // simplification then keeps one end of each chamfer.
    const outline = [...contours[0]!.points, contours[0]!.points[0]!];
    const perimeter = polylineLength(outline);
    expect(perimeter).toBeGreaterThan(77);
    expect(perimeter).toBeLessThan(80);

    expect(segments).toHaveLength(8);
    for (const segment of segments.slice(0, -1)) {
      expect(segment.length).toBeCloseTo(10, 6);
    }
    expect(segments[7]!.length).toBeCloseTo(perimeter - 70, 6);
  });

  it("drops specks below the minimum contour length", () => {
    const speckled = greyImage(60, 60, (x, y) => {
      const inRectangle = x >= 20 && x < 40 && y >= 20 && y < 40;
      const isSpeck = x === 5 && y === 5;
      return inRectangle || isSpeck ? 0 : 1;
    });

    expect(traceImage(speckled, SHARP).contours).toHaveLength(1);
    expect(
      traceImage(speckled, { ...SHARP, minContourLength: 0 }).contours,
    ).toHaveLength(2);
  });

  it("reports counts and timings that match the geometry it returned", () => {
    const { contours, segments, stats } = traceImage(rectangle, SHARP);

    expect(stats.imageWidth).toBe(60);
    expect(stats.imageHeight).toBe(60);
    expect(stats.keptContours).toBe(contours.length);
    expect(stats.segments).toBe(segments.length);
    expect(stats.keptPoints).toBe(
      contours.reduce((sum, contour) => sum + contour.points.length, 0),
    );
    expect(stats.rawPoints).toBeGreaterThan(stats.keptPoints);
    expect(stats.totalMs).toBeGreaterThanOrEqual(0);
    // Contour mode never binarises.
    expect(stats.inkFraction).toBe(0);
  });

  it("reports a field range that explains an empty trace", () => {
    // The case that made this stat necessary: on a blurred Sobel field the magnitudes are
    // nowhere near 1, so a luminance-shaped level of 0.5 returns nothing and looks exactly
    // like a broken pipeline. The reported maximum is what distinguishes them.
    const options: TraceOptions = {
      ...SHARP,
      blurSigma: 1.5,
      contour: { field: "sobel", level: 0.5 },
    };
    const { contours, stats } = traceImage(rectangle, options);

    expect(stats.fieldMax).toBeLessThan(options.contour.level);
    expect(contours).toEqual([]);

    const workable = traceImage(rectangle, {
      ...options,
      contour: { ...options.contour, level: stats.fieldMax / 2 },
    });
    expect(workable.contours.length).toBeGreaterThan(0);
  });

  it("returns nothing for a blank map rather than a contour round the frame", () => {
    const result = traceImage(greyImage(40, 40, () => 1), SHARP);

    expect(result.contours).toEqual([]);
    expect(result.segments).toEqual([]);
  });
});

describe("traceImage — centerline mode", () => {
  it("returns ONE stroke for a drawn line where contouring returns a loop round it", () => {
    // The reason this mode exists. A 5px stroke has two edges, so contouring reports its
    // silhouette; thinning reports its spine.
    const stroke = horizontalStroke(80, 40, 5);

    const contoured = traceImage(stroke, SHARP);
    const centered = traceImage(stroke, CENTERLINE);

    expect(contoured.contours).toHaveLength(1);
    expect(contoured.contours[0]!.closed).toBe(true);

    expect(centered.contours).toHaveLength(1);
    expect(centered.contours[0]!.closed).toBe(false);
  });

  it("puts the stroke down the middle of the ink, not on its edges", () => {
    const thickness = 7;
    const top = Math.round((40 - thickness) / 2);
    const spine = top + (thickness - 1) / 2;

    const { contours } = traceImage(
      horizontalStroke(80, 40, thickness),
      CENTERLINE,
    );

    const bounds = boundingBox(contours[0]!.points);
    expect(bounds.min.y).toBeCloseTo(spine, 6);
    expect(bounds.max.y).toBeCloseTo(spine, 6);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(50);
  });

  it("returns half the geometry contouring does for the same stroke", () => {
    const stroke = horizontalStroke(120, 40, 5);

    const contoured = traceImage(stroke, SHARP);
    const centered = traceImage(stroke, CENTERLINE);

    expect(centered.stats.segments).toBeLessThan(contoured.stats.segments);
    expect(centered.stats.keptPoints).toBeLessThanOrEqual(
      contoured.stats.keptPoints,
    );
  });

  it("reports the ink fraction, the diagnostic for a bad threshold", () => {
    const stroke = horizontalStroke(80, 40, 5);
    const { stats } = traceImage(stroke, CENTERLINE);

    // 100 × 5 of ink in an 80 × 40 image, before thinning.
    expect(stats.inkFraction).toBeGreaterThan(0.05);
    expect(stats.inkFraction).toBeLessThan(0.15);

    // A level above the background reads the whole map as ink. That failure is invisible in
    // the geometry — it comes back as a thicket of short chains, not as an error — so the
    // fraction is the only thing that names it.
    const parchment = greyImage(80, 40, (x, y) =>
      y >= 18 && y <= 22 && x >= 10 && x < 70 ? 0.1 : 0.85,
    );
    const flooded = traceImage(parchment, {
      ...CENTERLINE,
      centerline: { ...CENTERLINE.centerline, level: 0.95 },
    });
    expect(flooded.stats.inkFraction).toBeGreaterThan(0.9);
  });

  it("finds pale linework on a textured background that a global cutoff cannot", () => {
    // Sauvola's case, end to end: the line is darker than its surroundings everywhere, but
    // the background's own range overlaps the line's.
    const parchment = greyImage(120, 60, (x, y) => {
      const onLine = y >= 29 && y <= 31 && x >= 10 && x < 110;
      const background = 0.9 - (0.3 * x) / 120 + (x % 2 === y % 2 ? 0.04 : 0);
      return onLine ? background - 0.25 : background;
    });

    const sauvola = traceImage(parchment, {
      ...CENTERLINE,
      centerline: {
        ...CENTERLINE.centerline,
        threshold: "sauvola",
        sauvolaRadius: 10,
        sauvolaK: 0.2,
      },
    });

    expect(sauvola.stats.inkFraction).toBeLessThan(0.15);
    const bounds = boundingBox(sauvola.contours.flatMap((c) => [...c.points]));
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(70);
    expect(bounds.min.y).toBeGreaterThan(25);
    expect(bounds.max.y).toBeLessThan(35);
  });

  it("traces a corner as one stroke that turns, not two", () => {
    const corner = greyImage(80, 80, (x, y) => {
      const across = y >= 38 && y <= 41 && x >= 10 && x <= 41;
      const down = x >= 38 && x <= 41 && y >= 38 && y <= 70;
      return across || down ? 0 : 1;
    });

    const { contours } = traceImage(corner, CENTERLINE);

    expect(contours).toHaveLength(1);
    expect(contours[0]!.points.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps two crossing strokes as strokes when joining through junctions", () => {
    const cross = greyImage(80, 80, (x, y) => {
      const across = y >= 38 && y <= 41 && x >= 10 && x <= 70;
      const down = x >= 38 && x <= 41 && y >= 10 && y <= 70;
      return across || down ? 0 : 1;
    });

    const split = traceImage(cross, CENTERLINE);
    const joined = traceImage(cross, {
      ...CENTERLINE,
      centerline: { ...CENTERLINE.centerline, joinThroughJunctions: true },
    });

    expect(split.contours.length).toBeGreaterThan(joined.contours.length);
    expect(joined.contours).toHaveLength(2);
  });

  it("returns nothing for a blank map", () => {
    const result = traceImage(greyImage(40, 40, () => 1), CENTERLINE);

    expect(result.contours).toEqual([]);
    expect(result.segments).toEqual([]);
  });

  it("runs a full-size map in a workable time", () => {
    // 1024×1024 is the resolution DESIGN.md's CDN transform note suggests fetching at, and
    // this stage runs once per map rather than per frame — but "once" still has to be
    // tolerable in a UI.
    const map = greyImage(1024, 1024, (x, y) =>
      (x % 128 < 4 || y % 128 < 4) && x > 60 && y > 60 ? 0.1 : 0.9,
    );

    const { stats } = traceImage(map, {
      ...DEFAULT_TRACE_OPTIONS,
      mode: "centerline",
    });

    expect(stats.segments).toBeGreaterThan(0);
    expect(stats.totalMs).toBeLessThan(30_000);
  });
});
