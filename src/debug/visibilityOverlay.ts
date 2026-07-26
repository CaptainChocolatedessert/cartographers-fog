/**
 * Debug overlay: draws the CPU visibility polygons on top of the scene so they can be
 * compared by eye against Owlbear's GPU fog.
 *
 * This exists because of the risk recorded in DESIGN.md §1 — the reference implementation
 * is the closed-source Owlbear renderer, so the only way to know whether our polygons match
 * is to look at both at once. `Light.falloff` is a gradient with no polygon equivalent, so
 * an exact match is not even well defined; the question is whether the boundary lands close
 * enough that sketch strokes never bleed into plainly visible ground.
 *
 * Development only. `installVisibilityOverlay` is a no-op in production builds, and the
 * whole module tree-shakes out.
 *
 * Items are added through `OBR.scene.local`, so they are visible to this client only and
 * never touch the network or the scene's saved state (DESIGN.md §5).
 */

import OBR, {
  buildPath,
  Command,
  isLight,
  isWall,
  type Item,
  type Light,
  type PathCommand,
  type Wall,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { computeVisibilityPolygon } from "../visibility/visibility";
import { wallsToSegments } from "../visibility/walls";
import type { Vector2 } from "../geometry/vector";

/** Marks our own local items so the overlay can clear itself without touching anything else. */
const OVERLAY_KEY = "rodeo.owlbear.cartographers-fog/debug-overlay";

/**
 * Layers above FOG are POINTER, POST_PROCESS and CONTROL. The outline has to sit above the
 * fog to be compared against it, and CONTROL is the one intended for overlay furniture.
 */
const OVERLAY_LAYER = "CONTROL" as const;

const STROKE_COLOR = "#00e5ff";
const STROKE_WIDTH = 6;

/** Coalesce bursts of item changes — dragging a token emits a great many. */
const REDRAW_DEBOUNCE_MS = 120;

export function installVisibilityOverlay(): () => void {
  if (!import.meta.env.DEV) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRedraw = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void redraw();
    }, REDRAW_DEBOUNCE_MS);
  };

  const unsubscribeItems = OBR.scene.items.onChange(scheduleRedraw);
  // Dynamic Fog materialises its walls and lights as *local* items, which
  // scene.items.onChange never reports. Without this the overlay goes stale the moment a
  // wall is drawn.
  const unsubscribeLocal = OBR.scene.local.onChange(scheduleRedraw);
  const unsubscribeReady = OBR.scene.onReadyChange((ready) => {
    if (ready) scheduleRedraw();
    else void clearOverlay();
  });

  scheduleRedraw();

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribeItems();
    unsubscribeLocal();
    unsubscribeReady();
    void clearOverlay();
  };
}

async function redraw(): Promise<void> {
  try {
    if (!(await OBR.scene.isReady())) return;

    const [walls, lights] = await Promise.all([
      collectItems<Wall>(isWall),
      collectItems<Light>(isLight),
    ]);

    // Nothing to draw is ambiguous: it could mean the scene genuinely has no walls or
    // lights, or that we are looking in the wrong place. Report what the scene actually
    // holds so the difference is visible rather than guessed at.
    if (walls.length === 0 || lights.length === 0) await reportSceneCensus();

    // Our own overlay items are local, so adding them re-triggers scene.local.onChange.
    // Bail when the inputs we actually consume are unchanged, or that becomes a loop.
    const signature = inputSignature(walls, lights);
    if (signature === lastSignature) return;
    lastSignature = signature;

    const startedAt = performance.now();
    const segments = wallsToSegments(walls);

    const polygons: Vector2[][] = [];
    for (const light of lights) {
      const polygon = computeVisibilityPolygon(light.position, segments, {
        radius: light.attenuationRadius,
      });
      if (polygon.length >= 3) polygons.push(polygon);
    }
    const elapsedMs = performance.now() - startedAt;

    await clearOverlay();
    if (polygons.length > 0) {
      await OBR.scene.local.addItems(polygons.map(toOutlineItem));
    }

    // Feeds the "performance budget" open question in DESIGN.md with real numbers rather
    // than guesses about what a scene can carry.
    devLog(
      "info",
      `visibility: ${walls.length} walls -> ${segments.length} segments, ` +
        `${lights.length} lights, ${polygons.reduce((n, p) => n + p.length, 0)} vertices, ` +
        `${elapsedMs.toFixed(1)}ms`,
    );
  } catch (error) {
    devLog("error", "visibility overlay redraw failed", error);
  }
}

function toOutlineItem(polygon: readonly Vector2[]): Item {
  const first = polygon[0]!;

  const commands: PathCommand[] = [[Command.MOVE, first.x, first.y]];
  for (let i = 1; i < polygon.length; i++) {
    const point = polygon[i]!;
    commands.push([Command.LINE, point.x, point.y]);
  }
  commands.push([Command.CLOSE]);

  return buildPath()
    .commands(commands)
    // Commands are already in world space, so the item itself sits at the origin.
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
    .build();
}

/**
 * Read matching items from both the networked scene and this client's local items.
 *
 * Dynamic Fog keeps the shared, networked representation as `LINE`/`PATH` items on the FOG
 * layer and materialises `WALL` and `LIGHT` items **locally on each client** from them —
 * confirmed by watching a scene census while drawing: each new networked LINE produced
 * exactly one new local WALL. So `OBR.scene.items` alone finds nothing.
 *
 * Both sources are read rather than just local, so this keeps working if walls ever arrive
 * as networked items instead.
 */
async function collectItems<ItemType extends Item>(
  filter: (item: Item) => item is ItemType,
): Promise<ItemType[]> {
  const [sceneItems, localItems] = await Promise.all([
    OBR.scene.items.getItems<ItemType>(filter),
    OBR.scene.local.getItems<ItemType>(filter),
  ]);
  return [...sceneItems, ...localItems];
}

/**
 * A signature of everything the visibility computation actually reads. Redrawing only when
 * this changes both breaks the local-items feedback loop and skips the many redundant
 * redraws that item churn would otherwise trigger.
 */
let lastSignature = "";

function inputSignature(
  walls: readonly Wall[],
  lights: readonly Light[],
): string {
  const wallPart = walls
    .map((wall) =>
      [
        wall.id,
        wall.blocking,
        wall.doubleSided,
        wall.position.x,
        wall.position.y,
        wall.rotation,
        wall.scale.x,
        wall.scale.y,
        wall.points.map((point) => `${point.x},${point.y}`).join(" "),
      ].join("|"),
    )
    .sort()
    .join(";");

  const lightPart = lights
    .map((light) =>
      [
        light.id,
        light.position.x,
        light.position.y,
        light.attenuationRadius,
      ].join("|"),
    )
    .sort()
    .join(";");

  return `${wallPart}//${lightPart}`;
}

/**
 * Log a census of every item in the scene, by type and layer, for both networked and local
 * items. Redraws fire constantly, so this only speaks when the picture changes.
 */
let lastCensus = "";

async function reportSceneCensus(): Promise<void> {
  const [sceneItems, localItems] = await Promise.all([
    OBR.scene.items.getItems(),
    OBR.scene.local.getItems(),
  ]);

  const census = `scene[${tally(sceneItems)}] local[${tally(localItems)}]`;
  if (census === lastCensus) return;

  lastCensus = census;
  devLog("info", `census: ${census}`);
}

function tally(items: readonly Item[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = `${item.type}:${item.layer}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (counts.size === 0) return "empty";
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}=${count}`)
    .join(" ");
}

async function clearOverlay(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => OVERLAY_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}
