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
