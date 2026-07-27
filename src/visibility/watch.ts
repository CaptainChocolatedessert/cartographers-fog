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

    const views: LightView[] = [];
    for (const light of lights) {
      // Full attenuation radius: walls, not distance, gate what was seen, and
      // under-reporting leaves conspicuous holes. See DESIGN.md §4.
      const polygon = computeVisibilityPolygon(light.position, segments, {
        radius: light.attenuationRadius,
      });
      if (polygon.length >= 3) views.push({ light, polygon });
    }
    const elapsedMs = performance.now() - startedAt;

    const snapshot: VisibilitySnapshot = {
      walls,
      lights,
      segments,
      views,
      elapsedMs,
    };
    lastSnapshot = snapshot;
    for (const listener of listeners) listener(snapshot);
  } catch (error) {
    devLog("error", "visibility recompute failed", error);
  }
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

  const where = lights
    .map(
      (light) =>
        `(${light.position.x.toFixed(0)},${light.position.y.toFixed(0)})`,
    )
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
