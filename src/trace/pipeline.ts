/**
 * The whole trace, composed — build order step 4.
 *
 * Two front ends, one tail. Both produce polylines in **image pixel space**, and everything
 * after that — speck filter, simplification, chopping into the pre-cut segments §3 masks
 * against — is shared:
 *
 *   contour:     pixels → field → blur → contours at a level
 *   centerline:  pixels → luminance → blur → binarize → thin → skeleton → weld
 *                                                                              ↘
 *                                          drop specks → simplify → chop → segments
 *
 * **Centerline is the mode this project wants.** Contouring traces the *silhouette* of ink, so
 * a drawn line comes back as a loop around it — two lines where the cartographer drew one.
 * Thinning finds the stroke's spine instead, which is what "redraw this map by hand" needs.
 * The contour mode is kept because it is the right answer for *filled regions* (a solid water
 * body has no spine worth drawing) and because having both in the harness is what shows which
 * a given map wants.
 *
 * Placing the result in the scene is step 5's job, and it should do it from the `Image` item's
 * bounds rather than by composing dpi, offset, scale and rotation by hand — the same reasoning
 * as `region/sceneGrid.ts`.
 *
 * The wobble pass (DESIGN.md §2 step 4) is deliberately *not* here. It belongs with the rest
 * of the hand-drawn treatment in build order step 6, and keeping it out means this stage's
 * output can be compared against the map to judge whether the trace found the right lines,
 * without the noise that will later be the point.
 *
 * Pure: no DOM, no SDK.
 */

import {
  globalBinarize,
  sauvolaBinarize,
  countInk,
  type BinaryMask,
} from "./binarize";
import { chopContours, polylineLength, type TracedSegment } from "./chop";
import {
  blur,
  luminanceField,
  sobelMagnitude,
  type PixelImage,
  type ScalarField,
} from "./field";
import { traceContours, type Contour } from "./marchingSquares";
import { simplifyContours } from "./simplify";
import { skeletonize, traceSkeleton, weldChains } from "./skeleton";

export type TraceMode = "contour" | "centerline";
export type FieldKind = "luminance" | "sobel";
export type ThresholdKind = "sauvola" | "global";

export interface ContourOptions {
  /**
   * Which scalar field to contour. See `field.ts` — luminance lands on the visible edge of
   * dark linework, Sobel finds edges of either polarity but traces both flanks of each.
   */
  readonly field: FieldKind;
  /**
   * Contour level, in field units — both fields are scaled to roughly 0..1. On luminance this
   * is "how dark counts as ink", and it is also the polarity control: see `field.ts` on why
   * there is no separate invert.
   */
  readonly level: number;
}

export interface CenterlineOptions {
  /**
   * How ink is separated from background. **Sauvola unless the map is clean line art on flat
   * white** — a global cutoff cannot survive fake parchment or cross-hatching, because the
   * texture and the ink share a luminance range.
   */
  readonly threshold: ThresholdKind;
  /** Cutoff for the global threshold. Ignored by Sauvola, which computes its own per pixel. */
  readonly level: number;
  readonly sauvolaRadius: number;
  readonly sauvolaK: number;
  /**
   * Dead-end branches shorter than this are pruned, in pixels. `VTT_Maps` keys it to the grid
   * — 0.2 of a grid square — which is the portable way to express it; the harness does that
   * conversion, so the pipeline stays in pixel space.
   */
  readonly stubLength: number;
  /** Chain ends within this many pixels weld into one node. */
  readonly weldRadius: number;
  /** Carry strokes through junctions of three or more branches. See `skeleton.ts`. */
  readonly joinThroughJunctions: boolean;
  readonly maxTurnDegrees: number;
}

export interface TraceOptions {
  readonly mode: TraceMode;
  /** Gaussian blur applied before anything else, in pixels. The texture-suppression knob. */
  readonly blurSigma: number;
  /** Douglas–Peucker tolerance, in pixels. */
  readonly simplifyTolerance: number;
  /** Contours shorter than this, measured before simplification, are discarded as specks. */
  readonly minContourLength: number;
  /** Target length of each pre-cut segment, in pixels. */
  readonly segmentLength: number;
  readonly contour: ContourOptions;
  readonly centerline: CenterlineOptions;
}

/**
 * Starting point, not a recommendation — the values that make a given map read as hand-drawn
 * are a judgment about how it looks, which is what the harness is for.
 */
export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  mode: "centerline",
  blurSigma: 1,
  simplifyTolerance: 1.5,
  minContourLength: 12,
  segmentLength: 25,
  contour: {
    field: "luminance",
    level: 0.5,
  },
  centerline: {
    threshold: "sauvola",
    level: 0.5,
    sauvolaRadius: 12,
    sauvolaK: 0.34,
    stubLength: 14,
    weldRadius: 3,
    joinThroughJunctions: false,
    maxTurnDegrees: 40,
  },
};

export interface TraceStats {
  readonly imageWidth: number;
  readonly imageHeight: number;
  /**
   * Range of the scalar field the level was applied to.
   *
   * Reported because the useful level depends on the field and is not guessable: luminance
   * spans the full 0..1, while a blurred Sobel magnitude on a real map peaks around 0.3 — so
   * a level of 0.5 finds *nothing at all* and looks exactly like a broken trace. Without this
   * the only diagnosis is trying levels until something appears.
   */
  readonly fieldMax: number;
  readonly fieldMean: number;
  /**
   * Share of pixels classified as ink, centerline mode only.
   *
   * The threshold diagnostic. Line art runs a few percent; a tenth or more means the
   * background texture is being read as ink, which shows up downstream as a thicket of short
   * chains rather than as an obvious failure.
   */
  readonly inkFraction: number;
  /** Contours before the speck filter. */
  readonly rawContours: number;
  readonly rawPoints: number;
  readonly keptContours: number;
  /** Points after simplification — the number that matters for the command budget. */
  readonly keptPoints: number;
  readonly segments: number;
  readonly fieldMs: number;
  /** Binarize and thin, centerline only. */
  readonly maskMs: number;
  /** Contouring, or skeleton tracing and welding. */
  readonly contourMs: number;
  readonly simplifyMs: number;
  readonly chopMs: number;
  readonly totalMs: number;
}

export interface TraceResult {
  readonly contours: readonly Contour[];
  readonly segments: readonly TracedSegment[];
  readonly stats: TraceStats;
}

/** The scalar field the current mode works from — the harness previews it. */
export function buildField(
  image: PixelImage,
  options: TraceOptions,
): ScalarField {
  const blurred = blur(luminanceField(image), options.blurSigma);

  // Blur before Sobel, never after: Sobel differentiates, which amplifies exactly the noise
  // blur removes, and smoothing the gradient afterwards only spreads it.
  return options.mode === "contour" && options.contour.field === "sobel"
    ? sobelMagnitude(blurred)
    : blurred;
}

/** The ink mask, centerline mode only — also previewed by the harness. */
export function buildMask(
  field: ScalarField,
  options: CenterlineOptions,
): BinaryMask {
  return options.threshold === "global"
    ? globalBinarize(field, options.level)
    : sauvolaBinarize(field, {
        radius: options.sauvolaRadius,
        k: options.sauvolaK,
      });
}

/** The thinned skeleton, centerline mode only — the harness previews this too. */
export function buildSkeleton(
  mask: BinaryMask,
  options: CenterlineOptions,
): BinaryMask {
  return skeletonize(mask, options.stubLength);
}

export function traceImage(
  image: PixelImage,
  options: TraceOptions = DEFAULT_TRACE_OPTIONS,
): TraceResult {
  const start = now();

  const field = buildField(image, options);
  const afterField = now();

  let inkFraction = 0;
  let traced: Contour[];
  let afterMask = afterField;

  if (options.mode === "centerline") {
    const mask = buildMask(field, options.centerline);
    inkFraction =
      mask.data.length === 0 ? 0 : countInk(mask) / mask.data.length;

    const skeleton = buildSkeleton(mask, options.centerline);
    afterMask = now();

    traced = weldChains(traceSkeleton(skeleton), {
      radius: options.centerline.weldRadius,
      joinThroughJunctions: options.centerline.joinThroughJunctions,
      maxTurnDegrees: options.centerline.maxTurnDegrees,
    });
  } else {
    traced = traceContours(field, options.contour.level);
  }

  const afterContours = now();

  let rawPoints = 0;
  for (const contour of traced) rawPoints += contour.points.length;

  // Filtered before simplification, on true traced length: after simplification a speck may
  // be three points and a straight-ish 4px wall run may also be three points, and length is
  // the property that actually distinguishes them.
  const kept =
    options.minContourLength > 0
      ? traced.filter(
          (contour) => contourLength(contour) >= options.minContourLength,
        )
      : traced;

  const simplified = simplifyContours(kept, options.simplifyTolerance);
  const afterSimplify = now();

  const segments = chopContours(simplified, options.segmentLength);
  const afterChop = now();

  let keptPoints = 0;
  for (const contour of simplified) keptPoints += contour.points.length;

  return {
    contours: simplified,
    segments,
    stats: {
      imageWidth: image.width,
      imageHeight: image.height,
      ...fieldRange(field),
      inkFraction,
      rawContours: traced.length,
      rawPoints,
      keptContours: simplified.length,
      keptPoints,
      segments: segments.length,
      fieldMs: afterField - start,
      maskMs: afterMask - afterField,
      contourMs: afterContours - afterMask,
      simplifyMs: afterSimplify - afterContours,
      chopMs: afterChop - afterSimplify,
      totalMs: afterChop - start,
    },
  };
}

function fieldRange(field: ScalarField): {
  fieldMax: number;
  fieldMean: number;
} {
  let max = 0;
  let total = 0;
  for (const value of field.data) {
    if (value > max) max = value;
    total += value;
  }
  return {
    fieldMax: max,
    fieldMean: field.data.length === 0 ? 0 : total / field.data.length,
  };
}

function contourLength(contour: Contour): number {
  const points = contour.closed
    ? [...contour.points, contour.points[0]!]
    : contour.points;
  return polylineLength(points);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
