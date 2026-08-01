import { describe, expect, it } from "vitest";

import { effectiveOpacity, pencilPasses, type PencilOptions } from "./pencil";
import type { TracedSegment } from "../trace/chop";

const OPTIONS: PencilOptions = {
  passes: 3,
  scatter: 4,
  wavelength: 50,
  step: 8,
  seed: 0x5f3a91,
};

/** Two segments meeting at a shared point, which is the invariant most worth protecting. */
function segments(): TracedSegment[] {
  const first = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
  ];
  const second = [
    { x: 60, y: 0 },
    { x: 60, y: 60 },
  ];
  return [
    { points: first, midpoint: { x: 30, y: 0 }, length: 60 },
    { points: second, midpoint: { x: 60, y: 30 }, length: 60 },
  ];
}

describe("pencilPasses", () => {
  it("returns the input untouched when the texture is off", () => {
    const input = segments();

    // Identity, not a copy: the default settings must cost nothing at all, and must produce output
    // indistinguishable from a build without this feature.
    expect(pencilPasses(input, { ...OPTIONS, passes: 1 })[0]).toBe(input);
    expect(pencilPasses(input, { ...OPTIONS, scatter: 0 })[0]).toBe(input);
    expect(pencilPasses(input, { ...OPTIONS, passes: 1 })).toHaveLength(1);
  });

  it("produces one entry per pass, index-aligned with the input", () => {
    const input = segments();
    const passes = pencilPasses(input, OPTIONS);

    expect(passes).toHaveLength(3);
    for (const pass of passes) expect(pass).toHaveLength(input.length);
  });

  it("gives every pass a different path", () => {
    // If the seeds were correlated the passes would track each other and draw one slightly thick
    // line rather than a texture — the failure `PASS_SEED_STRIDE` exists to prevent.
    const passes = pencilPasses(segments(), OPTIONS);
    const firstPoints = passes.map((pass) => pass[0]!.points[0]!);

    for (let a = 0; a < firstPoints.length; a++) {
      for (let b = a + 1; b < firstPoints.length; b++) {
        const dx = firstPoints[a]!.x - firstPoints[b]!.x;
        const dy = firstPoints[a]!.y - firstPoints[b]!.y;
        expect(Math.hypot(dx, dy)).toBeGreaterThan(1e-6);
      }
    }
  });

  it("keeps shared points together within a pass", () => {
    // The property DESIGN.md's vector-field argument buys, re-asserted here because the pencil
    // multiplies the number of places it could break. `chop.ts` cuts contours into segments that
    // share endpoints; if a pass moved the two copies differently, every pre-cut boundary would
    // open into a visible gap.
    for (const pass of pencilPasses(segments(), OPTIONS)) {
      const endOfFirst = pass[0]!.points[pass[0]!.points.length - 1]!;
      const startOfSecond = pass[1]!.points[0]!;
      expect(endOfFirst.x).toBeCloseTo(startOfSecond.x, 10);
      expect(endOfFirst.y).toBeCloseTo(startOfSecond.y, 10);
    }
  });

  it("stays within the scatter it was given", () => {
    const scatter = 4;
    const passes = pencilPasses(segments(), { ...OPTIONS, scatter });

    for (const pass of passes) {
      for (const point of pass[0]!.points) {
        // The straight segment runs along y = 0, so any displacement off it is the scatter.
        expect(Math.abs(point.y)).toBeLessThanOrEqual(scatter + 1e-9);
      }
    }
  });

  it("is deterministic, so a reload and a second client agree", () => {
    const a = pencilPasses(segments(), OPTIONS);
    const b = pencilPasses(segments(), OPTIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("treats a fractional or absurd pass count sanely", () => {
    expect(pencilPasses(segments(), { ...OPTIONS, passes: 2.7 })).toHaveLength(2);
    expect(pencilPasses(segments(), { ...OPTIONS, passes: 0 })).toHaveLength(1);
    expect(pencilPasses(segments(), { ...OPTIONS, passes: -3 })).toHaveLength(1);
  });
});

describe("effectiveOpacity", () => {
  it("compounds passes rather than averaging them", () => {
    // The number the panel shows. Three passes at 50% read as 87.5%, not 50% — without saying so,
    // raising the pass count looks like it darkens the sketch for no reason.
    expect(effectiveOpacity(1, 0.5)).toBeCloseTo(0.5, 10);
    expect(effectiveOpacity(2, 0.5)).toBeCloseTo(0.75, 10);
    expect(effectiveOpacity(3, 0.5)).toBeCloseTo(0.875, 10);
  });

  it("leaves a single opaque pass exactly opaque", () => {
    // The default. Anything else here would mean the shipped look had changed.
    expect(effectiveOpacity(1, 1)).toBe(1);
  });

  it("clamps its inputs", () => {
    expect(effectiveOpacity(0, 0.5)).toBeCloseTo(0.5, 10);
    expect(effectiveOpacity(2, 5)).toBe(1);
    expect(effectiveOpacity(2, -1)).toBe(0);
  });
});
