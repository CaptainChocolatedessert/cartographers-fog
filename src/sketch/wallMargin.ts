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
 */
const MARGIN_STROKE_WIDTHS = 1.5;

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

export function wallMargin(inputs: WallMarginInputs): number {
  const measured =
    inputs.strokeWidthWorld > 0
      ? inputs.strokeWidthWorld * MARGIN_STROKE_WIDTHS
      : 0;

  const fallback =
    inputs.dpi > 0 ? inputs.dpi * FALLBACK_MARGIN_SQUARES : 0;

  const wanted = measured > 0 ? measured : fallback;
  if (!(wanted > 0)) return 0;

  const ceiling =
    inputs.mapExtent > 0 ? inputs.mapExtent * MAX_MARGIN_EXTENT_SHARE : Infinity;

  return Math.min(wanted, ceiling);
}

/** Whether a margin came from the map's ink or fell back to the grid — for reporting. */
export function marginSource(inputs: WallMarginInputs): "ink" | "grid" | "none" {
  if (inputs.strokeWidthWorld > 0) return "ink";
  return inputs.dpi > 0 ? "grid" : "none";
}
