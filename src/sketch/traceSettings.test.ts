import { describe, expect, it } from "vitest";

import { DEFAULT_APPEARANCE } from "./appearance";
import { wobbleOptionsFor } from "./traceSettings";

const DPI = 150;

describe("wobbleOptionsFor", () => {
  it("reproduces the validated configuration at the default settings", () => {
    // The step used to be a constant 0.06 squares and is now derived from the wavelength, so that
    // shortening the period does not undersample the noise. This pins the one property that makes
    // the change safe: at the settings judged in a room on 2026-07-28, the derived step is exactly
    // the constant it replaced. If this drifts, the shipped look has quietly changed.
    const options = wobbleOptionsFor(
      DPI,
      DEFAULT_APPEARANCE.wobbleSquares,
      DEFAULT_APPEARANCE.wobbleWavelengthSquares,
    );

    expect(options.amplitude).toBeCloseTo(DPI * 0.02, 10);
    expect(options.wavelength).toBeCloseTo(DPI * 0.35, 10);
    expect(options.step).toBeCloseTo(DPI * 0.06, 10);
  });

  it("keeps the sampling density constant as the period changes", () => {
    // The reason the step is derived at all. `wobble.ts` puts a second octave at a third of the
    // wavelength, so the step has to shrink with the period or the tremor aliases into white
    // noise — the exact artifact `valueNoise`'s interpolation exists to prevent.
    const ratios = [0.1, 0.35, 0.8, 1.5].map((wavelengthSquares) => {
      const options = wobbleOptionsFor(DPI, 0.02, wavelengthSquares);
      return options.wavelength / options.step;
    });

    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0]!, 10);
  });

  it("treats a zero amplitude as off without disturbing the rest", () => {
    const options = wobbleOptionsFor(DPI, 0, 0.35);
    expect(options.amplitude).toBe(0);
    // Still positive, so nothing downstream divides by zero if the amplitude is raised later.
    expect(options.wavelength).toBeGreaterThan(0);
    expect(options.step).toBeGreaterThan(0);
  });

  it("falls back to a sane grid size when the scene reports none", () => {
    // `getDpi` can return 0 on a scene with no grid; a zero here would scale every length to zero
    // and the wobble would silently vanish.
    const options = wobbleOptionsFor(0, 0.02, 0.35);
    expect(options.amplitude).toBeGreaterThan(0);
    expect(options.wavelength).toBeGreaterThan(0);
  });

  it("never returns a negative length from a negative setting", () => {
    const options = wobbleOptionsFor(DPI, -1, -1);
    expect(options.amplitude).toBe(0);
    expect(options.wavelength).toBe(0);
    expect(options.step).toBe(0);
  });
});
