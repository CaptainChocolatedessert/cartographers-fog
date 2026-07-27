/**
 * Debug overlay: draws the CPU visibility polygons on top of the scene so they can be
 * compared by eye against Owlbear's GPU fog.
 *
 * This exists because of the risk recorded in DESIGN.md §1 — the reference implementation is
 * the closed-source Owlbear renderer, so the only way to know whether our polygons match is to
 * look at both at once. Verified in a room: the outline tracks the real boundary and, with a
 * fading light, matches the outer extent of the fade.
 *
 * Development only. `installVisibilityOverlay` is a no-op in production builds and the whole
 * module tree-shakes out. Items go through `OBR.scene.local`, so they are visible to this
 * client only and never touch the network.
 */

import OBR, {
  Command,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { subscribeVisibility, type VisibilitySnapshot } from "../visibility/watch";
import type { Vector2 } from "../geometry/vector";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const OVERLAY_KEY = `${NAMESPACE}/debug-overlay`;

/**
 * Layers above FOG are POINTER, POST_PROCESS and CONTROL. The outline has to sit above the
 * fog to be compared against it, and CONTROL is the one intended for overlay furniture.
 */
const OVERLAY_LAYER = "CONTROL" as const;

const STROKE_COLOR = "#00e5ff";
const STROKE_WIDTH = 6;

/**
 * A polygon is one command per vertex plus a CLOSE, and items cap at 8192 array entries. A
 * large light in a complex scene can exceed that on its own, so outlines are chunked too.
 */
const MAX_VERTICES_PER_ITEM = 8000;

export function installVisibilityOverlay(): () => void {
  if (!import.meta.env.DEV) return () => {};

  const unsubscribe = subscribeVisibility((snapshot) => {
    void redraw(snapshot);
  });

  return () => {
    unsubscribe();
    void clearOverlay();
  };
}

async function redraw(snapshot: VisibilitySnapshot): Promise<void> {
  try {
    const items = snapshot.views.flatMap((view) => toOutlineItems(view.polygon));

    await clearOverlay();
    if (items.length > 0) await OBR.scene.local.addItems(items);

    // Feeds the performance-budget question in DESIGN.md with real numbers.
    devLog(
      "info",
      `visibility: ${snapshot.walls.length} walls -> ${snapshot.segments.length} segments, ` +
        `${snapshot.lights.length} lights, ` +
        `${snapshot.views.reduce((n, v) => n + v.polygon.length, 0)} vertices, ` +
        `${snapshot.elapsedMs.toFixed(1)}ms`,
    );
  } catch (error) {
    devLog("error", "visibility overlay redraw failed", error);
  }
}

/** One item per chunk, so an enormous polygon is not refused outright. */
function toOutlineItems(polygon: readonly Vector2[]): Item[] {
  const items: Item[] = [];

  for (let start = 0; start < polygon.length; start += MAX_VERTICES_PER_ITEM) {
    const slice = polygon.slice(start, start + MAX_VERTICES_PER_ITEM);
    const first = slice[0];
    if (!first) continue;

    const commands: PathCommand[] = [[Command.MOVE, first.x, first.y]];
    for (let i = 1; i < slice.length; i++) {
      const point = slice[i]!;
      commands.push([Command.LINE, point.x, point.y]);
    }
    // Only close the final chunk — a partial outline should not join back on itself.
    if (start + MAX_VERTICES_PER_ITEM >= polygon.length) commands.push([Command.CLOSE]);

    items.push(
      buildPath()
        .commands(commands)
        .position({ x: 0, y: 0 })
        .fillOpacity(0)
        .strokeColor(STROKE_COLOR)
        .strokeOpacity(0.9)
        .strokeWidth(STROKE_WIDTH)
        .layer(OVERLAY_LAYER)
        .locked(true)
        .disableHit(true)
        .name("Cartographer's Fog debug visibility")
        .metadata({ [OVERLAY_KEY]: true })
        .build(),
    );
  }

  return items;
}

async function clearOverlay(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => OVERLAY_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}
