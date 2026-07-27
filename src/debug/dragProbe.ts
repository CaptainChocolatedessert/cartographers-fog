/**
 * Does *any* Owlbear API expose a token's live position during a drag?
 *
 * Established already (2026-07-26): the item store does not. Dragging a token ~372 units emitted
 * no change events for the whole ~9s drag, and polling `getItems` every 100ms saw the position
 * jump once, at the drop. Dynamic Fog's source confirms it has no better access — its
 * `LightActor` sets a light's position once at creation and never moves it, and its reconciler
 * subscribes to the same two channels we do. The light follows its token because it is
 * `attachedTo` it and the **app renderer** composes that transform live.
 *
 * Which leaves one door untried, and it is the interesting one: `getItemBounds` is not a read of
 * the item record but the app *computing* geometry for us. If that computation runs against the
 * same scene graph the renderer draws from, it will reflect the live interaction transform even
 * while the stored position is stale — and then the true path is readable with a plain poll, with
 * no custom drag tool and no assumption about where the token went.
 *
 * So this samples three sources at once and reports any that disagree:
 *
 *   1. `light.position` — the item record. Known stale mid-drag; the control.
 *   2. bounds of the light itself, via `scene.local.getItemBounds`.
 *   3. bounds of the light's parent token, via `scene.items.getItemBounds` on `attachedTo`.
 *
 * Reading the result:
 *
 * - **`bounds` columns move while `pos` does not** → the renderer's geometry is reachable.
 *   Accumulation switches to polling bounds and the corridor fills honestly.
 * - **All three move together, only at the drop** → every extension-facing API is fed by the item
 *   store, the live transform exists solely inside the renderer, and sampling is dead as an
 *   approach. Delete this probe and stop revisiting it.
 *
 * Deliberately computes no visibility — positions only, so it costs nothing near the sweep.
 * Silent unless something moves.
 */

import OBR, { isLight, type Light } from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";
import { distance, type Vector2 } from "../geometry/vector";

/**
 * Fast enough that a real drag would produce many samples if any source were live: a token
 * crossing ~372 units in a second lands ~10 of them, against a light polygon about 90 units
 * across. A trail, if there is one, will be unmistakable.
 */
const POLL_MS = 100;

interface Reading {
  position: Vector2;
  lightBounds: Vector2;
  parentBounds: Vector2 | undefined;
}

let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
const lastReading = new Map<string, Reading>();
const lastMovedAt = new Map<string, number>();

export function installDragProbe(): () => void {
  if (!import.meta.env.DEV) return () => {};

  timer = setInterval(() => {
    void sample();
  }, POLL_MS);

  devLog(
    "info",
    `drag probe: polling position vs getItemBounds every ${POLL_MS}ms`,
  );

  return () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    lastReading.clear();
    lastMovedAt.clear();
  };
}

async function sample(): Promise<void> {
  // Bounds calls are round trips to the app. At 100ms a slow response would otherwise pile up
  // requests and make the timing in the log meaningless.
  if (inFlight) return;
  inFlight = true;

  try {
    if (!(await OBR.scene.isReady())) return;

    const lights = await OBR.scene.local.getItems<Light>(isLight);
    const now = performance.now();

    for (const light of lights) {
      const reading = await read(light);
      const previous = lastReading.get(light.id);
      lastReading.set(light.id, reading);

      if (!previous) {
        lastMovedAt.set(light.id, now);
        continue;
      }

      const moved = {
        position: distance(previous.position, reading.position),
        light: distance(previous.lightBounds, reading.lightBounds),
        parent:
          previous.parentBounds && reading.parentBounds
            ? distance(previous.parentBounds, reading.parentBounds)
            : 0,
      };

      if (moved.position < 0.5 && moved.light < 0.5 && moved.parent < 0.5) continue;

      const since = lastMovedAt.get(light.id) ?? now;
      lastMovedAt.set(light.id, now);

      // All three deltas every time, including the zeroes. Which sources moved *and* which did
      // not is the entire result — reporting only the ones that changed would make a live bounds
      // reading indistinguishable from a stale one.
      devLog(
        "info",
        `drag probe: ${light.id.slice(0, 4)} after ${(now - since).toFixed(0)}ms — ` +
          `pos +${moved.position.toFixed(0)} ` +
          `lightBounds +${moved.light.toFixed(0)} ` +
          `parentBounds +${moved.parent.toFixed(0)} ` +
          `(pos now ${reading.position.x.toFixed(0)},${reading.position.y.toFixed(0)}; ` +
          `lightBounds ${reading.lightBounds.x.toFixed(0)},${reading.lightBounds.y.toFixed(0)})`,
      );
    }
  } catch (error) {
    devLog("error", "drag probe failed", error);
  } finally {
    inFlight = false;
  }
}

async function read(light: Light): Promise<Reading> {
  const lightBounds = await OBR.scene.local.getItemBounds([light.id]);

  // The light is a local item attached to a networked token, so the parent has to be read from
  // the other side. A light with no `attachedTo` is possible (a standalone light source), and
  // simply has no parent reading to compare.
  let parentBounds: Vector2 | undefined;
  if (light.attachedTo) {
    try {
      const bounds = await OBR.scene.items.getItemBounds([light.attachedTo]);
      parentBounds = bounds.center;
    } catch {
      parentBounds = undefined;
    }
  }

  return {
    position: { ...light.position },
    lightBounds: lightBounds.center,
    parentBounds,
  };
}
