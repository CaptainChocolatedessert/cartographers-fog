/**
 * The trace settings the extension runs, and where they came from.
 *
 * These reproduce the trace harness at its defaults — the configuration the author judged on a
 * real map (2026-07-27) and found robust, degrading only at extreme values. This file exists to
 * carry that judgment into the extension, where there is no one to move a slider.
 *
 * ## The settings are pixel constants at a 1024-capped raster
 *
 * The harness *presents* three of its lengths in grid squares — `VTT_Maps`' rule, and the
 * portable way to express them. But the conversion runs through a "source pixels per grid
 * square" field that the author left at its **default of 70**, never having measured the real
 * figure. So those three were in practice `0.2 × 70`, `0.2 × 70` and `0.35 × 70`, scaled by the
 * downscale ratio — pixel values, tied to the raster, with no relation to the scene's grid at
 * all. The other four constants were always raw pixels.
 *
 * That matters for how they port. Deriving lengths from the scene's *true* grid density would
 * not be a more faithful version of what was validated, it would be a different configuration
 * — on the test scene, ~188 px/square against the nominal 70, so nearly triple every length.
 * So this file keeps the harness's arithmetic verbatim, placeholder and all, and the real
 * grid-relative calibration is unfinished work rather than something quietly assumed done.
 *
 * ## Why the width is capped rather than density-targeted
 *
 * An earlier revision chose the raster width to hit a target *density* — pixels per scene grid
 * square — reasoning that the four pixel-denominated constants are only meaningful against the
 * ink scale they were tuned on, so holding density constant would make them portable.
 *
 * That is sound in principle and wrong in practice, and the test scene shows why: its map spans
 * 816 world units at dpi 150, which is **5.4 grid squares**. Targeting 32 px/square would have
 * chosen a raster 174 pixels wide and thinned every line out of existence. The harness's own
 * 24 px/square warning was calibrated on maps where a grid square is a small slice of the
 * image; on a map a few squares across, the same rule discards nearly all the resolution.
 *
 * So the width is capped at what was validated and never chosen from the grid. The true scene
 * density is still computed and logged, because it is the measurement a proper calibration
 * would need — see `mapImage.ts`.
 */

import type { TraceOptions } from "../trace/pipeline";
import type { WobbleOptions } from "./wobble";

/**
 * Raster width to trace at, matching the harness default. The source is never upscaled to reach
 * it — enlarging invents detail that was never drawn and leaves thinning chasing interpolation
 * artifacts.
 */
export const TRACE_WIDTH = 1024;

/**
 * The harness's unmeasured "source pixels per grid square" default.
 *
 * Not a real property of any map. It is the number the validated lengths were computed through,
 * so reproducing them means reproducing it. Replacing it with a measured density is a retune,
 * not a fix — do that deliberately, against a map, not as a tidy-up.
 */
export const HARNESS_PIXELS_PER_GRID = 70;

// Scaled by the downscale ratio, exactly as the harness does.
const STUB_LENGTH_SQUARES = 0.2;
const MIN_STROKE_SQUARES = 0.2;
const SEGMENT_LENGTH_SQUARES = 0.35;

// Raw pixels in the traced raster, in the harness and here.
const BLUR_SIGMA_PX = 1;
const SIMPLIFY_TOLERANCE_PX = 1.5;
const SAUVOLA_RADIUS_PX = 12;
const WELD_RADIUS_PX = 3;

const SAUVOLA_K = 0.34;
const MAX_TURN_DEGREES = 40;

// -------------------------------------------------------------------------------------
// Hand-drawn wobble — build order step 6, DESIGN.md §6
// -------------------------------------------------------------------------------------

/**
 * The subdivision step, as a fraction of the wobble's wavelength.
 *
 * **Derived rather than constant, and that is deliberate.** Both were fixed constants — 0.06 and
 * 0.35 squares — until the wavelength became a GM setting. Holding the step fixed while the period
 * moved would have broken the wobble at the short end: `wobble.ts` layers a second octave at a
 * third of the wavelength, so the finest feature at the default is 0.117 squares against a 0.06
 * step. That is two samples per cycle — right on the sampling limit *already*. Any shorter period
 * would have undersampled it, and an undersampled smooth field does not look like a smaller
 * wobble, it looks like white noise, which is the exact failure `valueNoise`'s interpolation
 * exists to avoid.
 *
 * The ratio is written as the two shipped constants rather than rounded, so the default wavelength
 * reproduces the validated step of 0.06 exactly and this change is invisible at the setting that
 * was judged in a room.
 *
 * Cost note: point count scales inversely with the step, and points are what the 8192-command item
 * budget is spent on. `MIN_WOBBLE_WAVELENGTH_SQUARES` is where that is bounded.
 */
const WOBBLE_STEP_PER_WAVELENGTH = 0.06 / 0.35;

/**
 * Fixed, and deliberately not derived from the map or the scene.
 *
 * Variety comes from position — the noise field differs everywhere — so a per-map seed would
 * add nothing except the risk of a map redrawing itself differently after a reload.
 */
const WOBBLE_SEED = 0x5f3a91;

/**
 * Wobble options for a scene, from its grid size in world units.
 *
 * An amplitude of zero is "off" all the way down rather than a separate path: `wobbleSegments`
 * returns a segment untouched when the amplitude is not positive, so no displacement *and* no
 * subdivision. The subdivision half matters — it exists only so a long straight run has somewhere
 * to bend, and leaving it in with a zero offset would multiply the point count, and therefore the
 * item count, for nothing visible.
 *
 * @param amplitudeSquares how far the pen strays, as a fraction of a grid square — the GM's
 * setting, see `appearance.ts`.
 * @param wavelengthSquares how far it travels between strays. The step follows it, so that the
 * noise is sampled at the same density whatever the period.
 */
export function wobbleOptionsFor(
  dpi: number,
  amplitudeSquares: number,
  wavelengthSquares: number,
): WobbleOptions {
  const squares = dpi > 0 ? dpi : 150;
  const wavelength = squares * Math.max(0, wavelengthSquares);
  return {
    amplitude: squares * Math.max(0, amplitudeSquares),
    wavelength,
    step: wavelength * WOBBLE_STEP_PER_WAVELENGTH,
    seed: WOBBLE_SEED,
  };
}

/**
 * The harness's effective pixels-per-grid figure for a raster downscaled from a source.
 *
 * `HARNESS_PIXELS_PER_GRID` describes the *source*, so a downscaled raster holds proportionally
 * fewer. Mirrors `traceHarness.ts`'s `pixelsPerGrid`, including its floor of 1.
 */
export function effectivePixelsPerGrid(
  rasterWidth: number,
  sourceWidth: number,
): number {
  if (!(sourceWidth > 0)) return HARNESS_PIXELS_PER_GRID;
  const ratio = Math.min(rasterWidth, sourceWidth) / sourceWidth;
  return Math.max(1, HARNESS_PIXELS_PER_GRID * ratio);
}

/**
 * Trace options for a raster at the given effective density.
 *
 * @param pixelsPerGrid from `effectivePixelsPerGrid` — the harness's figure, not the scene's.
 */
export function traceOptionsFor(pixelsPerGrid: number): TraceOptions {
  const perGrid = pixelsPerGrid > 0 ? pixelsPerGrid : HARNESS_PIXELS_PER_GRID;

  return {
    mode: "centerline",
    blurSigma: BLUR_SIGMA_PX,
    simplifyTolerance: SIMPLIFY_TOLERANCE_PX,
    minContourLength: MIN_STROKE_SQUARES * perGrid,
    segmentLength: SEGMENT_LENGTH_SQUARES * perGrid,
    contour: {
      field: "luminance",
      level: 0.5,
    },
    centerline: {
      threshold: "sauvola",
      level: 0.5,
      sauvolaRadius: SAUVOLA_RADIUS_PX,
      sauvolaK: SAUVOLA_K,
      stubLength: STUB_LENGTH_SQUARES * perGrid,
      weldRadius: WELD_RADIUS_PX,
      joinThroughJunctions: false,
      maxTurnDegrees: MAX_TURN_DEGREES,
    },
  };
}
