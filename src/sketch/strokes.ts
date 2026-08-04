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
import type { Appearance } from "./appearance";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const SKETCH_KEY = `${NAMESPACE}/sketch-strokes`;

/**
 * Above FOG, so remembered ground can be drawn into the dark.
 *
 * **`POINTER` since 2026-08-04**, moved down from `CONTROL` — which the open question here had
 * been leaning towards for a while, on the grounds that `CONTROL` reads semantically as the layer
 * for tool chrome and Outliner puts comparable marks on `POINTER`. What settled it was the
 * annotation feature: a GM raising a label to `POINTER` found it hidden, because `CONTROL` draws
 * over `POINTER` (user, measured in a room). Something had to give, and moving the sketch down is
 * the direction that puts this extension where a peer extension already agreed sketched marks
 * belong.
 *
 * `CONTROL` remains measured to draw over `FOG` — proven in step 3, when the wash rendered above
 * the fog for a GM and a player alike. `POINTER` above `FOG` is inference from the declared order
 * plus Outliner's own use of it, **not** a measurement of ours; it is the thing to look at first
 * if the sketch ever stops appearing over unexplored ground.
 *
 * The one live risk of the move is that `POINTER` is a layer another extension exposes for
 * drawing, so our items may clutter its object list. Our output is added as *local* items rather
 * than scene items, which ought to keep it out of any list built from the scene — unverified, and
 * the sketch comes back to `CONTROL` if it turns out otherwise (user, 2026-08-04).
 *
 * **This line is the one that matters.** `wash.ts` and `debug/visibilityOverlay.ts` declare their
 * own layers and are deliberately left on `CONTROL`; neither is installed, so neither affects what
 * anyone sees, and the debug overlay wants to stay *above* the sketch it is used to check.
 */
const SKETCH_LAYER = "POINTER" as const;

/**
 * Colour and width now come from the GM's settings — see `appearance.ts`, whose defaults are the
 * values judged in a room on 2026-07-28 (sepia `#603F21`, 1/12 of a grid square).
 *
 * They were constants here until the settings panel existed. Worth knowing why the defaults are
 * where they are: the sepia was picked by eye against the fog it is drawn over rather than taken
 * from the landing page's palette, because what matters is the contrast with the darkness, not
 * agreement with a sheet. And 1/12 is up from an earlier 1/30 — thin strokes read as a technical
 * drawing rather than a pen.
 */

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
 * Above the parchment overlay, explicitly.
 *
 * Auto z-index would decide this from creation order, and the two renderers are separate
 * `addItems` calls made in whatever order a redraw happens to make them. Ink on top of paper is not
 * a preference, it is the point — so it is pinned. `PARCHMENT_Z` is the other half of the pair.
 */
const SKETCH_Z = 10;

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
/**
 * @param passes one entry per pencil pass, each holding the *same* strokes along a slightly
 * different path — see `pencil.ts`. A single entry is the ordinary un-textured sketch.
 */
export async function renderStrokes(
  passes: readonly (readonly TracedSegment[])[],
  dpi: number,
  appearance: Appearance,
): Promise<number> {
  const strokeWidth = Math.max(1, dpi * appearance.strokeWidthSquares);
  const dash =
    DASH_SQUARES > 0 ? [dpi * DASH_SQUARES, dpi * GAP_SQUARES] : [];

  // Each pass becomes its own items. It has to: `strokeOpacity` is per-item, so overlapping
  // faint copies is only expressible as separate items — which is the whole reason the texture
  // is built from passes rather than from varying one stroke's style along its length.
  const items: Item[] = [];
  for (const pass of passes) {
    for (const chunk of chunkSegments(pass)) {
      items.push(
        toStrokeItem(
          chunk,
          strokeWidth,
          dash,
          appearance.strokeColor,
          appearance.pencilOpacity,
        ),
      );
    }
  }

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
  strokeColor: string,
  strokeOpacity: number,
): Item {
  const commands: PathCommand[] = [];
  for (const segment of segments) appendStroke(commands, segment.points);

  return (
    buildPath()
      .commands(commands)
      // Points are already world-space, so the item itself sits at the origin.
      .position({ x: 0, y: 0 })
      .strokeColor(strokeColor)
      .strokeOpacity(strokeOpacity)
      .strokeWidth(strokeWidth)
      .strokeDash([...dash])
      // Open polylines, so any fill would flood the area they enclose rather than tint a line.
      .fillOpacity(0)
      .zIndex(SKETCH_Z)
      .disableAutoZIndex(true)
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
