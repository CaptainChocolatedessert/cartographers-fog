/**
 * Drawing the sketch — build order step 5's output.
 *
 * Local `Path` items on a layer above the fog, one per chunk of segments. Local because every
 * client derives its own sketch from shared state rather than receiving geometry over the
 * network (DESIGN.md §5), and because local items leave nothing behind in the GM's scene.
 *
 * Strokes arrive already wobbled — see `wobble.ts`, which runs once at trace time because the
 * displacement is static by §6. What this file adds is the drawn *line*: quadratic curves rather
 * than chained straight edges, sepia ink, and a broken dash.
 *
 * Note the debug red is gone as of step 6, and with it the property that a misplaced stroke was
 * obvious at a glance. Sketch geometry now looks like map art whether or not it is in the right
 * place.
 */

import OBR, {
  Command,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import { chunkSegments } from "../trace/strokeChunks";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const SKETCH_KEY = `${NAMESPACE}/sketch-strokes`;

/**
 * Above FOG, so remembered ground can be drawn into the dark.
 *
 * `CONTROL` is measured to draw over `FOG` — proven in step 3, when the wash rendered above the
 * fog for a GM and a player alike. The open question is whether it is the *right* one of the four
 * layers above `FOG`: it reads semantically as the layer for tool chrome, and the Outliner
 * extension puts comparable marks on `POINTER`. Worth one room test with both installed — see
 * DESIGN.md, "Rendering modes for `sketch_region`".
 *
 * **This line is the one that matters.** `wash.ts` and `debug/visibilityOverlay.ts` declare their
 * own layers, but neither is installed, so neither affects what anyone sees.
 */
const SKETCH_LAYER = "CONTROL" as const;

/**
 * Sepia ink, chosen against a real map by the author (2026-07-28).
 *
 * The landing page's palette is the reference for the project's look — parchment `#f4ecd8`,
 * ink `#4a3728`, pale sepia `#d9c7a7` — but the right value depends on the fog it is drawn
 * over, so this was picked by eye in a room rather than taken from the sheet. One constant if
 * it wants revisiting.
 */
const STROKE_COLOR = "#603F21";

/**
 * Stroke width as a fraction of a grid square, so it reads the same on any scene's scale.
 *
 * Judged in a room at 1/12 (2026-07-28), up from 1/30 — thin strokes read as a technical
 * drawing rather than a pen.
 */
const STROKE_WIDTH_SQUARES = 1 / 12;

/**
 * Dash and gap as fractions of a grid square. **Off**, judged in a room 2026-07-28.
 *
 * Kept rather than deleted because it is one value from being back: a long dash with a short
 * gap reads as a hurried stroke, while anything more even reads as a deliberate dashed border,
 * which is a different thing entirely.
 */
const DASH_SQUARES = 0;
const GAP_SQUARES = 0.035;

/**
 * Replace the sketch with these segments.
 *
 * Delete-and-replace rather than diffing. The visible set changes wholesale as a token moves,
 * the item count is small (segments batch into a handful of items), and a diff would have to
 * track identity per segment for no measurable gain. Step 6's fade will need per-item cohorts,
 * which is the point to revisit this.
 *
 * @returns how many items were drawn.
 */
export async function renderStrokes(
  segments: readonly TracedSegment[],
  dpi: number,
): Promise<number> {
  const chunks = chunkSegments(segments);
  const strokeWidth = Math.max(1, dpi * STROKE_WIDTH_SQUARES);
  const dash =
    DASH_SQUARES > 0 ? [dpi * DASH_SQUARES, dpi * GAP_SQUARES] : [];
  const items = chunks.map((chunk) => toStrokeItem(chunk, strokeWidth, dash));

  await clearStrokes();
  if (items.length > 0) await OBR.scene.local.addItems(items);

  return items.length;
}

export async function clearStrokes(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => SKETCH_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}

function toStrokeItem(
  segments: readonly TracedSegment[],
  strokeWidth: number,
  dash: readonly number[],
): Item {
  const commands: PathCommand[] = [];
  for (const segment of segments) appendStroke(commands, segment.points);

  return (
    buildPath()
      .commands(commands)
      // Points are already world-space, so the item itself sits at the origin.
      .position({ x: 0, y: 0 })
      .strokeColor(STROKE_COLOR)
      .strokeOpacity(1)
      .strokeWidth(strokeWidth)
      .strokeDash([...dash])
      // Open polylines, so any fill would flood the area they enclose rather than tint a line.
      .fillOpacity(0)
      .layer(SKETCH_LAYER)
      .locked(true)
      .disableHit(true)
      .name("Cartographer's Fog sketch")
      .metadata({ [SKETCH_KEY]: true })
      .build()
  );
}

/**
 * Append one stroke as quadratic curves through the vertex midpoints.
 *
 * Each vertex becomes a *control* point and the curve passes through the midpoints between
 * them, which is the standard way to smooth a polyline. Chaining straight edges instead would
 * put a visible corner at every one of the subdivision points `wobble.ts` inserts — turning a
 * wobble into a zigzag, and defeating the point of the exercise.
 *
 * The command count is unchanged at one per point: a MOVE, a QUAD per interior vertex, and a
 * closing LINE. `strokeChunks` budgets on `points.length`, so it stays correct as written.
 */
export function appendStroke(
  commands: PathCommand[],
  points: readonly Vector2[],
): void {
  const first = points[0];
  if (!first || points.length < 2) return;

  commands.push([Command.MOVE, first.x, first.y]);

  // Two points cannot be curved through, so they stay a straight edge.
  if (points.length === 2) {
    const last = points[1]!;
    commands.push([Command.LINE, last.x, last.y]);
    return;
  }

  for (let i = 1; i < points.length - 1; i++) {
    const control = points[i]!;
    const next = points[i + 1]!;
    commands.push([
      Command.QUAD,
      control.x,
      control.y,
      (control.x + next.x) / 2,
      (control.y + next.y) / 2,
    ]);
  }

  const last = points[points.length - 1]!;
  commands.push([Command.LINE, last.x, last.y]);
}
