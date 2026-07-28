/**
 * Drawing the sketch — build order step 5's output.
 *
 * Local `Path` items on a layer above the fog, one per chunk of segments. Local because every
 * client derives its own sketch from shared state rather than receiving geometry over the
 * network (DESIGN.md §5), and because local items leave nothing behind in the GM's scene.
 *
 * **Deliberately not hand-drawn yet.** Straight polylines in a flat, loud red: this step is
 * about whether the right strokes appear in the right places, and wobble, sepia, dash and fade
 * are build order step 6. A colour that could be mistaken for map art would make a misplaced
 * stroke hard to spot, which is the opposite of what this step needs.
 */

import OBR, {
  Command,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import { chunkSegments } from "../trace/strokeChunks";
import type { TracedSegment } from "../trace/chop";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const SKETCH_KEY = `${NAMESPACE}/sketch-strokes`;

/**
 * Above FOG, so remembered ground can be drawn into the dark.
 *
 * Same layer as the region wash, and the same open question: `CONTROL` is measured to draw over
 * `FOG`, but it reads semantically as the layer for tool chrome, and the Outliner extension puts
 * comparable marks on `POINTER`. Worth one room test with both extensions installed — see
 * DESIGN.md, "Rendering modes for `sketch_region`". Changing it is this line and `wash.ts`.
 */
const SKETCH_LAYER = "CONTROL" as const;

/** Debug red. Step 6 replaces this with the sepia palette. */
const STROKE_COLOR = "#ff2d2d";

/** Stroke width as a fraction of a grid square, so it reads the same on any scene's scale. */
const STROKE_WIDTH_SQUARES = 1 / 30;

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
  const items = chunks.map((chunk) => toStrokeItem(chunk, strokeWidth));

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
): Item {
  const commands: PathCommand[] = [];

  for (const segment of segments) {
    // One MOVE plus a LINE per remaining point — the cost `strokeChunks` budgets against.
    const [first, ...rest] = segment.points;
    if (!first) continue;

    commands.push([Command.MOVE, first.x, first.y]);
    for (const point of rest) commands.push([Command.LINE, point.x, point.y]);
  }

  return (
    buildPath()
      .commands(commands)
      // Points are already world-space, so the item itself sits at the origin.
      .position({ x: 0, y: 0 })
      .strokeColor(STROKE_COLOR)
      .strokeOpacity(1)
      .strokeWidth(strokeWidth)
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
