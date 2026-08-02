/**
 * How far either side of a stroke counts as "the same place" for masking.
 *
 * ## The problem this exists for
 *
 * A visibility polygon is bounded *by the walls* — its boundary is the wall. A traced stroke
 * runs down the centerline of the wall drawn in the map art, and the GM's Dynamic Fog wall is
 * drawn approximately along that same art. So a wall stroke's midpoint sits within a few units
 * of the polygon boundary, and `pointInPolygon` explicitly does not guarantee either answer for
 * a point on an edge.
 *
 * Which side wins therefore depends on where the GM's line happens to fall relative to the art,
 * and that wanders along a wall's length. Untreated, wall linework appears in patches — present
 * here, missing there, along one wall — and walls are most of what the sketch has to show.
 *
 * The margin is applied to **both** terms of `discovered − currently_visible` (see `mask.ts`).
 * Widening only `discovered` would sketch over a wall the party is currently looking at, which
 * is what the subtraction exists to prevent.
 *
 * ## Why it is measured from the map's ink, not from the grid
 *
 * A grid square is the obvious unit and it is not a dependable one: `getDpi` still returns a
 * value on a scene whose grid was never set to match the map, or set oddly, and the margin
 * would then be silently wrong. The map's own linework is the thing the margin is actually
 * about, and `TraceStats.strokeWidthPx` measures it directly — ink area over skeleton arc
 * length. The grid remains a fallback for the paths where no measurement exists (contour mode,
 * or a degenerate trace), not the primary basis.
 *
 * Pure: no DOM, no SDK.
 */

export interface WallMarginInputs {
  /** Measured mean ink width in world units. Zero or less when unmeasurable. */
  readonly strokeWidthWorld: number;
  /** World units per grid square. Only used as a fallback. */
  readonly dpi: number;
  /** Shorter side of the map in world units — bounds the clamp without involving the grid. */
  readonly mapExtent: number;
}

/**
 * Margin as a multiple of the measured ink width.
 *
 * Half of it covers centerline-to-edge of the drawn wall; the rest is slack for the GM's line
 * not sitting exactly on the art.
 *
 * **This is not a principled figure, and that is why it is adjustable per scene.** The estimator
 * it multiplies is known to over-report — `strokeWidthPx` describes the *mask*, which runs ~0.8px
 * wider per side than the visible core, and a filled region reports as one enormously wide stroke
 * — so 1.5 is a number that lands correctly *given* a measurement inflated by a known amount. The
 * two are entangled: make the measurement accurate on its own and the margin shrinks below what
 * makes wall linework appear at all.
 *
 * The other reason a human needs the lever: this is a single mean over the whole map. A map with
 * heavy walls and fine interior linework averages to a figure suiting neither, and no measurement
 * of this shape can fix that.
 */
export const DEFAULT_MARGIN_STROKE_WIDTHS = 1.5;

/** Off. Wall linework goes patchy, which is the price of never over-reaching on a tight map. */
export const MIN_MARGIN_STROKE_WIDTHS = 0;

/**
 * Ceiling on the control, distinct from the extent clamp below.
 *
 * Twice the judged value. Past this the margin stops being slack for a hand-drawn wall and starts
 * reaching into the next room, which the extent clamp bounds but does not make sensible.
 */
export const MAX_MARGIN_STROKE_WIDTHS = 3;

/** Fallback only, in grid squares, for when the ink cannot be measured. */
const FALLBACK_MARGIN_SQUARES = 0.1;

/**
 * Ceiling, as a share of the map's shorter side.
 *
 * Guards the estimator's known failure: a filled region reports as one enormously wide stroke
 * and would otherwise produce a margin that leaks strokes through doorways into ground nobody
 * has entered. Expressed against the map rather than the grid so the clamp does not reintroduce
 * the dependency being removed.
 */
const MAX_MARGIN_EXTENT_SHARE = 0.02;

export function wallMargin(
  inputs: WallMarginInputs,
  strokeWidths: number = DEFAULT_MARGIN_STROKE_WIDTHS,
): number {
  // Zero means off, and it has to short-circuit rather than fall through. Otherwise `measured`
  // lands at zero, which the fallback below reads as "the ink could not be measured" and answers
  // with a grid-derived margin — so the off end of the control would quietly produce a margin
  // instead of none, on every scene where the grid happens to be set.
  if (!(strokeWidths > 0)) return 0;

  const measured =
    inputs.strokeWidthWorld > 0 ? inputs.strokeWidthWorld * strokeWidths : 0;

  // The fallback scales with the control too, so the slider still does something on a trace whose
  // ink was unmeasurable. Written as a ratio against the default so that at the default it is
  // exactly the 0.1 squares this shipped with, rather than a value that merely rounds to it.
  const fallback =
    inputs.dpi > 0
      ? inputs.dpi *
        FALLBACK_MARGIN_SQUARES *
        (strokeWidths / DEFAULT_MARGIN_STROKE_WIDTHS)
      : 0;

  const wanted = measured > 0 ? measured : fallback;
  if (!(wanted > 0)) return 0;

  const ceiling =
    inputs.mapExtent > 0 ? inputs.mapExtent * MAX_MARGIN_EXTENT_SHARE : Infinity;

  return Math.min(wanted, ceiling);
}

/**
 * Validate a stored margin setting.
 *
 * Lives here rather than in `sketchSettings.ts` for two reasons. It belongs beside the bounds it
 * clamps against, so a range change cannot leave a validator behind. And `sketchSettings.ts`
 * imports the SDK, which makes it untestable in a node environment — the layering rule this
 * project keeps rediscovering — whereas this module is pure, so the rule below gets a test.
 *
 * Clamped rather than rejected, matching the appearance validator: a value just outside the range
 * is one somebody chose, and the nearest legal one is what they meant. Only a non-number is
 * meaningless enough to discard, and that includes the absent case — a scene predating this
 * setting takes the judged default and masks exactly as it did before.
 */
export function readMarginStrokeWidths(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_MARGIN_STROKE_WIDTHS;
  }
  return Math.min(
    MAX_MARGIN_STROKE_WIDTHS,
    Math.max(MIN_MARGIN_STROKE_WIDTHS, raw),
  );
}

/** Whether a margin came from the map's ink or fell back to the grid — for reporting. */
export function marginSource(inputs: WallMarginInputs): "ink" | "grid" | "none" {
  if (inputs.strokeWidthWorld > 0) return "ink";
  return inputs.dpi > 0 ? "grid" : "none";
}
