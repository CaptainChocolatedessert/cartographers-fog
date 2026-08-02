import { describe, expect, it } from "vitest";

import {
  contourFractions,
  inkWidths,
  nibWidths,
  noise1,
  taperAt,
  tangents,
} from "./brushWidths";
import type { SegmentProvenance, TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

function segment(
  points: Vector2[],
  provenance?: Partial<SegmentProvenance>,
): TracedSegment {
  return {
    points,
    midpoint: points[Math.floor(points.length / 2)]!,
    length: 0,
    ...(provenance
      ? {
          provenance: {
            contour: 0,
            startFraction: 0,
            endFraction: 1,
            closed: false,
            ...provenance,
          },
        }
      : {}),
  };
}

/** A straight run at `degrees`, long enough to have interior points. */
function ray(degrees: number, count = 5): Vector2[] {
  const radians = (degrees * Math.PI) / 180;
  return Array.from({ length: count }, (_, i) => ({
    x: Math.cos(radians) * i * 10,
    y: Math.sin(radians) * i * 10,
  }));
}

describe("tangents", () => {
  it("returns one unit vector per point", () => {
    const result = tangents(ray(0));

    expect(result).toHaveLength(5);
    for (const t of result) expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 9);
  });

  it("follows the direction of travel", () => {
    const [first] = tangents(ray(90));
    expect(first!.x).toBeCloseTo(0, 9);
    expect(first!.y).toBeCloseTo(1, 9);
  });

  it("averages through a corner rather than jumping at it", () => {
    // Central differences at the elbow, so width varies smoothly across a bend instead of stepping.
    // A one-sided tangent would give the corner point the direction of one arm exactly.
    const corner = tangents([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);

    expect(corner[1]!.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(corner[1]!.y).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("steps over repeated points instead of returning a zero vector", () => {
    // Duplicate points survive into traced contours. A zero tangent sends `atan2` to an arbitrary
    // angle, which under a nib puts a random-width spot in the middle of a smooth mark.
    //
    // **Vertical deliberately.** The give-up fallback is (1, 0), which on a horizontal run happens
    // to be the right answer — so a horizontal fixture cannot tell the widening search from no
    // search at all. Here the correct tangent is (0, 1) and the fallback is plainly wrong.
    const result = tangents([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 0, y: 5 },
      { x: 0, y: 5 },
      { x: 0, y: 10 },
    ]);

    for (const t of result) expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 9);
    expect(result[2]!.y).toBeCloseTo(1, 6);
    expect(result[2]!.x).toBeCloseTo(0, 6);
  });

  it("survives degenerate input", () => {
    expect(tangents([])).toEqual([]);
    expect(tangents([{ x: 3, y: 4 }])).toHaveLength(1);
    expect(tangents([{ x: 0, y: 0 }, { x: 0, y: 0 }])).toHaveLength(2);
  });
});

describe("nibWidths", () => {
  const options = { halfWidth: 10, angle: 0, contrast: 0 };

  it("draws a hairline along the nib and full width across it", () => {
    // The whole behaviour of a broad nib. At contrast 0 the along-nib stroke vanishes entirely,
    // which is what a real pen does and what makes italic hands look the way they do.
    const along = nibWidths([segment(ray(0))], options)[0]!;
    const across = nibWidths([segment(ray(90))], options)[0]!;

    for (const w of along) expect(w).toBeCloseTo(0, 6);
    for (const w of across) expect(w).toBeCloseTo(10, 6);
  });

  it("follows the nib angle", () => {
    // Rotating the nib rotates which direction is thin. A width response that ignored the angle
    // would pass the test above and fail this one.
    const rotated = { ...options, angle: Math.PI / 2 };

    expect(nibWidths([segment(ray(0))], rotated)[0]![0]).toBeCloseTo(10, 6);
    expect(nibWidths([segment(ray(90))], rotated)[0]![0]).toBeCloseTo(0, 6);
  });

  it("treats a reversed stroke identically", () => {
    // A nib does not care which way along its edge you travel — |sin| rather than sin. Signed
    // would make a stroke and its reverse different thicknesses, and the tracer's walk direction
    // is arbitrary.
    const forward = nibWidths([segment(ray(30))], options)[0]!;
    const backward = nibWidths([segment(ray(210))], options)[0]!;

    expect(forward[0]).toBeCloseTo(backward[0]!, 6);
  });

  it("holds the hairline off zero at higher contrast", () => {
    const soft = nibWidths([segment(ray(0))], { ...options, contrast: 0.25 })[0]!;

    for (const w of soft) expect(w).toBeCloseTo(2.5, 6);
  });

  it("becomes a round pen at contrast 1", () => {
    // The honest comparison for judging whether the angle earns its place: at 1 direction stops
    // mattering entirely, so every stroke is one width.
    const round = { ...options, contrast: 1 };

    expect(nibWidths([segment(ray(0))], round)[0]![0]).toBeCloseTo(10, 6);
    expect(nibWidths([segment(ray(45))], round)[0]![0]).toBeCloseTo(10, 6);
  });

  it("returns one width per point, per segment", () => {
    const widths = nibWidths([segment(ray(0, 4)), segment(ray(90, 7))], options);

    expect(widths).toHaveLength(2);
    expect(widths[0]).toHaveLength(4);
    expect(widths[1]).toHaveLength(7);
  });
});

describe("taperAt", () => {
  it("is zero at both ends and one in the middle", () => {
    expect(taperAt(0, 0.2)).toBeCloseTo(0, 9);
    expect(taperAt(1, 0.2)).toBeCloseTo(0, 9);
    expect(taperAt(0.5, 0.2)).toBeCloseTo(1, 9);
  });

  it("reaches full width by the end of the taper span", () => {
    expect(taperAt(0.2, 0.2)).toBeCloseTo(1, 6);
    expect(taperAt(0.8, 0.2)).toBeCloseTo(1, 6);
  });

  it("is flat when taper is off", () => {
    for (const t of [0, 0.5, 1]) expect(taperAt(t, 0)).toBe(1);
  });

  it("eases rather than ramping linearly", () => {
    // A linear taper reads as a wedge — right for a chisel, wrong for a brush, whose tip lands and
    // spreads. Halfway along the taper span, smoothstep is exactly 0.5 but its *shape* differs:
    // a quarter of the way along it sits well below the linear 0.25.
    expect(taperAt(0.05, 0.2)).toBeLessThan(0.25);
    expect(taperAt(0.1, 0.2)).toBeCloseTo(0.5, 6);
  });
});

describe("contourFractions", () => {
  it("spreads points across the segment's span by arc length", () => {
    // By distance, not by index. The wobble subdivides long edges and leaves short ones alone, so
    // index spacing bears no fixed relation to distance travelled.
    const uneven: Vector2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 10, y: 0 },
    ];
    const result = contourFractions(uneven, {
      contour: 0,
      startFraction: 0,
      endFraction: 1,
      closed: false,
    });

    expect(result[0]).toBeCloseTo(0, 9);
    expect(result[1]).toBeCloseTo(0.1, 9);
    expect(result[2]).toBeCloseTo(1, 9);
  });

  it("maps into the segment's own slice of the contour", () => {
    const result = contourFractions(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      { contour: 3, startFraction: 0.4, endFraction: 0.6, closed: false },
    );

    expect(result[0]).toBeCloseTo(0.4, 9);
    expect(result[1]).toBeCloseTo(0.6, 9);
  });

  it("puts a segment with no provenance at the midpoint", () => {
    // Full width under any taper, and no end effects invented from information that is not there.
    const result = contourFractions([{ x: 0, y: 0 }, { x: 1, y: 0 }], undefined);

    expect(result).toEqual([0.5, 0.5]);
  });

  it("survives a zero-length segment", () => {
    const result = contourFractions(
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
      { contour: 0, startFraction: 0.25, endFraction: 0.3, closed: false },
    );

    for (const t of result) expect(Number.isFinite(t)).toBe(true);
  });
});

describe("inkWidths", () => {
  const options = {
    halfWidth: 10,
    taperFraction: 0.2,
    pressure: 0,
    seed: 1234,
  };

  it("tapers at the ends of the contour, not of each segment", () => {
    // The reason `SegmentProvenance` exists. These two segments are the middle of a long stroke,
    // so neither may taper — tapering per segment would turn a wall into a row of dashes.
    const middle = [
      segment(ray(0), { startFraction: 0.4, endFraction: 0.5 }),
      segment(ray(0), { startFraction: 0.5, endFraction: 0.6 }),
    ];

    for (const widths of inkWidths(middle, options)) {
      for (const w of widths) expect(w).toBeCloseTo(10, 6);
    }
  });

  it("thins at the true start and end of a contour", () => {
    const first = inkWidths(
      [segment(ray(0), { startFraction: 0, endFraction: 0.1 })],
      options,
    )[0]!;
    const last = inkWidths(
      [segment(ray(0), { startFraction: 0.9, endFraction: 1 })],
      options,
    )[0]!;

    expect(first[0]!).toBeLessThan(first[first.length - 1]!);
    expect(last[last.length - 1]!).toBeLessThan(last[0]!);
  });

  it("never tapers a closed contour", () => {
    // A loop has no ends. Tapering one would put a thin patch wherever the tracer happened to
    // start walking it — a defect that would move if the tracer changed.
    const loop = [
      segment(ray(0), { startFraction: 0, endFraction: 0.1, closed: true }),
    ];

    for (const w of inkWidths(loop, options)[0]!) expect(w).toBeCloseTo(10, 6);
  });

  it("draws at full width when provenance is missing", () => {
    // Degrades to something reasonable rather than to a stroke that is all taper.
    for (const w of inkWidths([segment(ray(0))], options)[0]!) {
      expect(w).toBeCloseTo(10, 6);
    }
  });

  it("varies along the stroke once pressure is up, and never vanishes", () => {
    const varied = inkWidths(
      [segment(ray(0, 40), { startFraction: 0, endFraction: 1, closed: true })],
      { ...options, pressure: 1 },
    )[0]!;

    expect(Math.max(...varied)).toBeGreaterThan(Math.min(...varied));
    for (const w of varied) expect(w).toBeGreaterThan(0);
  });

  it("floors the width so a tapered tip is thin, never absent", () => {
    // At the very start of an open contour the taper profile is exactly zero, so without a floor
    // the first points carry no width at all. A zero-radius slot draws nothing, which reads as a
    // gap at the end of every wall rather than as a brush tip.
    const tip = inkWidths(
      [segment(ray(0), { startFraction: 0, endFraction: 0.05 })],
      options,
    )[0]!;

    expect(tip[0]!).toBeGreaterThan(0);
    // Still visibly a taper — the floor is a floor, not a defeat of the effect.
    expect(tip[0]!).toBeLessThan(options.halfWidth * 0.25);
  });

  it("is deterministic", () => {
    // §6: the same map must redraw identically, so the pressure field is seeded, never random.
    const twice = () =>
      inkWidths([segment(ray(0, 20), {})], { ...options, pressure: 0.8 })[0]!;

    expect(twice()).toEqual(twice());
  });

  it("returns one width per point", () => {
    const widths = inkWidths([segment(ray(0, 6), {})], options);
    expect(widths[0]).toHaveLength(6);
  });
});

describe("noise1", () => {
  it("is smooth across lattice boundaries", () => {
    // The mistake this project has made before: a smoothness test that steps in 0.05 from zero
    // never lands within one step of an integer, so it never crosses the discontinuity it claims
    // to test. These samples straddle 3 deliberately.
    const near = [2.98, 2.99, 3.0, 3.01, 3.02].map((x) => noise1(x, 7));

    for (let i = 1; i < near.length; i++) {
      expect(Math.abs(near[i]! - near[i - 1]!)).toBeLessThan(0.1);
    }
  });

  it("stays in range and varies with the seed", () => {
    for (let i = 0; i < 50; i++) {
      const v = noise1(i * 0.37, 99);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(noise1(1.5, 1)).not.toBeCloseTo(noise1(1.5, 2), 6);
  });
});
