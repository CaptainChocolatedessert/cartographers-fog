/**
 * One place that watches walls and lights and computes visibility, shared by every consumer.
 *
 * There are two: the debug overlay, which draws the polygons, and the region tracker, which
 * accumulates them into the discovered region. Running a separate watcher for each would
 * duplicate the sweep — the single most expensive thing this extension does — so listeners
 * share one computation.
 *
 * Three subtleties this encapsulates, each learned the hard way:
 *
 * - Dynamic Fog materialises `WALL` and `LIGHT` as **local** items, so `scene.items.onChange`
 *   never fires for them; `scene.local.onChange` must be subscribed too.
 * - Our own output is local as well, so that subscription feeds back on itself. Redraws are
 *   gated on a signature of the inputs actually consumed, not merely debounced — a debounce
 *   only slows a loop down.
 * - Walls are not present at startup. Dynamic Fog materialises them a beat after the scene
 *   becomes ready, so the first pass legitimately finds nothing and the subscription is what
 *   recovers.
 */

import OBR, {
  isLight,
  isWall,
  type Item,
  type Light,
  type Wall,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { computeVisibilityPolygon } from "./visibility";
import { wallsToSegments } from "./walls";
import { type StarPolygon } from "../geometry/starClip";
import { litInSight } from "./litInSight";
import type { Segment } from "../geometry/segment";
import type { Vector2 } from "../geometry/vector";

export interface LightView {
  light: Light;
  polygon: Vector2[];
}

export interface VisibilitySnapshot {
  walls: Wall[];
  lights: Light[];
  segments: Segment[];
  /** One entry per light that produced a usable polygon. */
  views: LightView[];
  /**
   * The party's line of sight — one entry per light that reveals on its own, swept at map scale.
   *
   * Exposed because the region tracker needs it to replay a *moving* secondary light: a lantern
   * carried by an NPC lights ground as it goes, and what the party remember of that is gated on
   * the same line of sight the watcher uses for the current frame. Empty when no light depends on
   * it, since the sweep is then not run at all.
   */
  sight: StarPolygon[];
  elapsedMs: number;
}

export type VisibilityListener = (snapshot: VisibilitySnapshot) => void;

/**
 * Minimum gap between recomputes.
 *
 * This is a throttle rather than a debounce, which is the better shape for a stream of changes
 * and costs nothing — but be clear about what it does **not** buy, because an earlier version of
 * this comment claimed the opposite and sent a session chasing the wrong fix.
 *
 * It does not close the corridor gap. Measured 2026-07-26: dragging a token 372 units produced
 * no change events for the entire ~9s drag, and polling `getItems` every 100ms saw the position
 * jump in one step at the drop. The item store itself is not updated mid-drag. Dynamic Fog's
 * `LightActor` sets a light's position once at creation and never moves it; the light follows
 * its token because it is `attachedTo` it and the *app renderer* composes that transform live.
 * So the movement you see on screen exists only as a render-time transform, and no extension —
 * Dynamic Fog included, its source confirms — can observe intermediate positions.
 *
 * Consequence: sampling frequency is not the lever. Changing this constant cannot make a drag
 * discoverable, and lowering it only spends sweeps re-confirming a position that hasn't moved.
 */
const THROTTLE_MS = 120;

const listeners = new Set<VisibilityListener>();
let unsubscribers: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let lastRunAt = 0;
let lastSignature = "";
let lastSnapshot: VisibilitySnapshot | undefined;

/**
 * Change events seen since the last throttle tick, counted so a tick can report what provoked
 * it. See `logTick` — this is the number that separates "nothing arrived" from "something
 * arrived that the sweep considered identical".
 */
let eventsSinceTick = 0;
let tickCount = 0;

/**
 * Register a listener. The watcher starts with the first listener and stops with the last.
 *
 * A late subscriber is given the most recent snapshot immediately. Without that it would
 * receive nothing until walls or lights next changed, because recompute short-circuits on an
 * unchanged signature — so a listener joining after the first computation would sit blank
 * until someone moved a token. That is exactly how the region wash failed to appear for a
 * player rejoining a room.
 *
 * @returns an unsubscribe function.
 */
export function subscribeVisibility(listener: VisibilityListener): () => void {
  listeners.add(listener);

  if (listeners.size === 1) start();
  else if (lastSnapshot) listener(lastSnapshot);
  else scheduleRecompute();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** Force a recompute — used when something other than items changed, such as the grid. */
export function refreshVisibility(): void {
  lastSignature = "";
  scheduleRecompute();
}

/** The most recent snapshot, if one has been computed for this scene. */
export function latestSnapshot(): VisibilitySnapshot | undefined {
  return lastSnapshot;
}

function start(): void {
  unsubscribers = [
    OBR.scene.items.onChange(onItemsChanged),
    OBR.scene.local.onChange(onItemsChanged),
    OBR.scene.onReadyChange((ready) => {
      if (ready) refreshVisibility();
    }),
  ];
  scheduleRecompute();
}

/**
 * Counted separately from scheduling so a tick can report how many change events it absorbed.
 * A tick provoked by zero events means the platform is not streaming anything.
 */
function onItemsChanged(): void {
  eventsSinceTick++;
  scheduleRecompute();
}

function stop(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  lastRunAt = 0;
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  lastSignature = "";
  lastSnapshot = undefined;
  eventsSinceTick = 0;
  tickCount = 0;
}

/**
 * Throttle: run at most every `THROTTLE_MS`, but keep running while changes continue arriving.
 * Once a run is pending, further calls are absorbed rather than pushing it back.
 */
function scheduleRecompute(): void {
  if (timer !== undefined) return;

  const sinceLast = Date.now() - lastRunAt;
  const delay = Math.max(0, THROTTLE_MS - sinceLast);

  timer = setTimeout(() => {
    timer = undefined;
    lastRunAt = Date.now();
    void recompute();
  }, delay);
}

async function recompute(): Promise<void> {
  try {
    if (!(await OBR.scene.isReady())) return;

    const [walls, lights] = await Promise.all([
      collectItems<Wall>(isWall),
      collectItems<Light>(isLight),
    ]);

    const signature = inputSignature(walls, lights);
    logTick(lights, signature !== lastSignature);
    if (signature === lastSignature) return;
    lastSignature = signature;

    const startedAt = performance.now();
    const segments = wallsToSegments(walls);
    const { views, sight } = sweepLights(lights, segments);
    const elapsedMs = performance.now() - startedAt;

    const snapshot: VisibilitySnapshot = {
      walls,
      lights,
      segments,
      views,
      sight,
      elapsedMs,
    };
    lastSnapshot = snapshot;
    for (const listener of listeners) listener(snapshot);
  } catch (error) {
    devLog("error", "visibility recompute failed", error);
  }
}


/**
 * How far a light can *see*, as opposed to how far it lights.
 *
 * Line of sight is not bounded by your own lamp — you can see a lit hall from much further away
 * than your torch reaches — so this has to stand in for "unbounded". It is the diagonal of
 * everything walled in the scene, which is guaranteed to cover anything sight could reach, with
 * walls doing the real work of stopping it. Deriving it from the light's own radius would be
 * wrong in a way that is easy to miss: a dim lamp does not make its bearer short-sighted.
 */
function sightRadius(segments: readonly Segment[]): number {
  if (segments.length === 0) return 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const segment of segments) {
    for (const point of [segment.a, segment.b]) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * Sweep every light, treating the ones Dynamic Fog only reveals in line of sight differently.
 *
 * ## The rule
 *
 * A `PRIMARY` light is a torch in someone's hand: it lights an area and reveals it outright. A
 * `SECONDARY` light is a brazier standing in a room — it lights the room, but the party only see
 * that light where they can also *see into* the room. Treating both as primary is what put holes
 * in the parchment over three rooms nobody had entered (user, 2026-08-02), which advertises that
 * those rooms exist.
 *
 * So a non-primary light contributes its illuminated area **intersected with the party's line of
 * sight**, and nothing where the two do not meet.
 *
 * ## Two things that make this affordable
 *
 * Line of sight comes free with the illuminated polygon. Occlusion is radial — the nearest hit
 * along a ray is `min(wall, R)`, so clamping each vertex to a smaller `r` gives exactly the
 * `r` polygon — so one long sweep yields both the sight polygon and the lit one. DESIGN.md
 * records this as a spare part looking for a use; this is the use.
 *
 * And the clipper's cost is the product of two vertex counts, which is millions of triangle pairs
 * at the ~2,750 vertices a raw visibility polygon carries. Both sides are simplified first. The
 * primary polygons keep their full precision for their *own* contribution — that boundary moves
 * with the party and is looked at directly — and only the secondary-derived pieces are built from
 * simplified geometry, where a few units of raggedness is explicitly acceptable.
 */
function sweepLights(
  lights: readonly Light[],
  segments: Segment[],
): { views: LightView[]; sight: StarPolygon[] } {
  const views: LightView[] = [];
  const sight: StarPolygon[] = [];
  const secondary: { light: Light; polygon: Vector2[] }[] = [];

  // Nothing needs line of sight unless a light depends on it, and the sight sweep is the expensive
  // one — its radius defeats the distance pruning, so every ray tests every wall in the scene. Most
  // scenes have no secondary light at all, and they must not pay for this.
  const needsSight = lights.some((light) => light.lightType !== "PRIMARY");
  const sightRange = needsSight ? sightRadius(segments) : 0;

  for (const light of lights) {
    const options = {
      // `outerAngle` is the outer extent; see `VisibilityOptions.coneAngle` for why not the inner.
      coneAngle: (light.outerAngle * Math.PI) / 180,
      facing: (light.rotation * Math.PI) / 180,
    };

    if (light.lightType === "PRIMARY") {
      if (sightRange <= light.attenuationRadius) {
        const lit = computeVisibilityPolygon(light.position, segments, {
          ...options,
          radius: light.attenuationRadius,
        });
        if (lit.length >= 3) views.push({ light, polygon: lit });
        continue;
      }

      // One sweep at sight range, then clamped down for what the lamp actually lights.
      const seen = computeVisibilityPolygon(light.position, segments, {
        ...options,
        radius: sightRange,
      });
      if (seen.length >= 3) {
        sight.push({ origin: light.position, polygon: seen });
      }

      const lit = clampToRadius(seen, light.position, light.attenuationRadius);
      if (lit.length >= 3) views.push({ light, polygon: lit });
      continue;
    }

    const polygon = computeVisibilityPolygon(light.position, segments, {
      ...options,
      radius: light.attenuationRadius,
    });
    if (polygon.length >= 3) secondary.push({ light, polygon });
  }

  // Clipped after every primary is known, since a secondary may be seen from any of them. The
  // rule itself lives in `litInSight` because the region tracker needs the identical answer when
  // it replays a moving light's path, and two copies of it would drift.
  for (const entry of secondary) {
    for (const piece of litInSight(entry.polygon, entry.light.position, sight)) {
      // Each piece stands alone. Two primaries that both see the same brazier produce overlapping
      // pieces, which is harmless now the overlay unions them in a bitmap rather than punching a
      // ring each.
      views.push({ light: entry.light, polygon: piece });
    }
  }

  return { views, sight };
}

/**
 * The polygon a shorter radius would have produced, by pulling each vertex in.
 *
 * Valid because occlusion is radial: a ray's length is `min(wall, R)`, and clamping to `r < R`
 * gives `min(wall, R, r) = min(wall, r)`, which is what sweeping at `r` would have returned.
 */
function clampToRadius(
  polygon: readonly Vector2[],
  origin: Vector2,
  radius: number,
): Vector2[] {
  return polygon.map((point) => {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const length = Math.hypot(dx, dy);
    if (length <= radius || length === 0) return point;
    const scale = radius / length;
    return { x: origin.x + dx * scale, y: origin.y + dy * scale };
  });
}

/**
 * Report every throttle tick, whatever it found.
 *
 * The corridor gap was first blamed on the timer, then on the sweep being too slow to keep up.
 * Neither can be distinguished from the third possibility — that Owlbear stages a token drag as
 * an interaction and only commits the item position when the drag ends, so no intermediate
 * position is ever delivered to us — unless the ticks themselves are visible. Three readings,
 * three different fixes:
 *
 * - **No ticks at all during a drag** → no change events arrive. The platform is not streaming
 *   intermediate positions and no amount of timer tuning will conjure them.
 * - **Ticks with events, signature unchanged** → events arrive, but Dynamic Fog has not moved
 *   its local `LIGHT` yet. The light lags the token, and the light is what we sweep from.
 * - **Ticks with the signature changing** → positions do stream, and the sampling gap is ours.
 *
 * Logging only the ticks that proceed to a sweep would show the same silence for the first two,
 * which is exactly how a stalled accumulator produced no evidence last session.
 */
function logTick(lights: readonly Light[], changed: boolean): void {
  const absorbed = eventsSinceTick;
  eventsSinceTick = 0;
  tickCount++;

  // Type and cone reported alongside the position, because the sweep currently ignores both and
  // treats every light as a token's own omnidirectional torch. A light Dynamic Fog only reveals
  // when it is in line of sight still gets a full polygon here, which marks its whole room as
  // currently visible — and, since the same polygons feed the accumulator, as discovered.
  const where = lights
    .map((light) => {
      const cone =
        light.outerAngle > 0 && light.outerAngle < 360
          ? ` cone ${light.outerAngle.toFixed(0)}°`
          : "";
      return (
        `(${light.position.x.toFixed(0)},${light.position.y.toFixed(0)} ` +
        `${light.lightType}${light.visible ? "" : " HIDDEN"}${cone})`
      );
    })
    .join(" ");

  devLog(
    "info",
    `watch: tick ${tickCount} absorbed ${absorbed} events, signature ` +
      `${changed ? "CHANGED" : "same"}, lights ${where || "none"}`,
  );
}

/**
 * Read matching items from both the networked scene and this client's local items.
 * Dynamic Fog's walls and lights live in the latter; reading both keeps this working if that
 * ever changes.
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

/** A signature of everything the sweep actually reads. */
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
