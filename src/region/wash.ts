/**
 * Draws `sketch_region` as a flat wash — build order step 3's "plain revealed areas".
 *
 * This is a region marker, not a view of anything: the region sits *under* Owlbear's fog, and
 * this extension does not control the fog, so a wash drawn above it shows where the party has
 * been with no terrain in it. That is exactly right for verifying the tracking, and is not a
 * shipping renderer — see DESIGN.md, "Rendering modes for `sketch_region`".
 *
 * Items are local, so they never touch the network and each client draws its own.
 */

import OBR, {
  Command,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import { chunkRuns } from "./pathChunks";
import { subtractPolygons, toRuns, type RegionMask } from "./regionMask";
import type { Bounds } from "./cellGrid";
import type { Vector2 } from "../geometry/vector";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const WASH_KEY = `${NAMESPACE}/region-wash`;

/** Above FOG, so the wash is visible over the ground it describes. */
const WASH_LAYER = "CONTROL" as const;

const FILL_COLOR = "#d9c7a7";
const FILL_OPACITY = 0.25;

/**
 * Replace the wash with one derived from `discovered` minus the currently visible polygons.
 *
 * Emitted across as many items as needed: a fragmented region already exceeds one item's
 * 8192-command limit at current cell resolution.
 */
export async function renderWash(
  discovered: RegionMask,
  visible: readonly (readonly Vector2[])[],
): Promise<number> {
  const sketchRegion = subtractPolygons(discovered, visible);
  const runs = toRuns(sketchRegion);
  const chunks = chunkRuns(runs);

  const items = chunks.map((chunk) => toWashItem(chunk));

  await clearWash();
  if (items.length > 0) await OBR.scene.local.addItems(items);

  return runs.length;
}

export async function clearWash(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => WASH_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}

function toWashItem(runs: readonly Bounds[]): Item {
  const commands: PathCommand[] = [];

  for (const run of runs) {
    // MOVE, three LINEs, CLOSE — the fourth edge is implied, which is where
    // COMMANDS_PER_RUN comes from.
    commands.push([Command.MOVE, run.min.x, run.min.y]);
    commands.push([Command.LINE, run.max.x, run.min.y]);
    commands.push([Command.LINE, run.max.x, run.max.y]);
    commands.push([Command.LINE, run.min.x, run.max.y]);
    commands.push([Command.CLOSE]);
  }

  return buildPath()
    .commands(commands)
    // Commands are already world-space, so the item itself sits at the origin.
    .position({ x: 0, y: 0 })
    .fillColor(FILL_COLOR)
    .fillOpacity(FILL_OPACITY)
    .strokeOpacity(0)
    .strokeWidth(0)
    .fillRule("nonzero")
    .layer(WASH_LAYER)
    .locked(true)
    .disableHit(true)
    .name("Cartographer's Fog discovered region")
    .metadata({ [WASH_KEY]: true })
    .build();
}
