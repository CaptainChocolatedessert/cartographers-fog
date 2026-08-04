/**
 * Moving a GM's annotations above Owlbear's fog, and putting them back where they came from.
 *
 * ## What this is for
 *
 * A label, an arrow or a room name drawn on the map is hidden by the fog like anything else, which
 * is wrong for the class of annotation meant to be read at all times. Four layers sit above `FOG`
 * — `POINTER`, `POST_PROCESS`, `CONTROL` and `POPOVER` — and `POINTER` is the one another
 * extension (Outliner) already uses for sketched marks, so it is the least surprising home for
 * this and the one DESIGN.md records as intended for the purpose.
 *
 * ## Why the original layer is remembered rather than assumed
 *
 * Sending an annotation back needs to know where it came from, and there is no good default: a
 * drawing, a text label and a prop all belong somewhere different, and guessing wrong silently
 * moves a GM's item to a layer they never chose. So raising records the layer it left, in the
 * item's own metadata under this extension's namespace. That also makes "which items did we
 * raise?" answerable without keeping a list anywhere — the items carry the answer, so it survives
 * a reload, a different client, and this extension being removed and reinstalled.
 *
 * ## Pure on purpose
 *
 * No SDK import, so this can be tested headlessly — the standing rule here, and it earns its keep
 * for a function whose whole job is edge cases: an item raised twice, metadata holding a layer
 * that no longer exists, and the one that actually strands an annotation, metadata claiming the
 * original layer *was* `POINTER`.
 */

import type { Layer } from "@owlbear-rodeo/sdk";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";

/**
 * Where the original layer is stored on the item.
 *
 * Namespaced because item metadata is a shared space every extension writes into, and a bare key
 * like `raisedFrom` is an invitation to collide with someone else's.
 */
export const RAISED_FROM = `${NAMESPACE}/raisedFrom`;

/** Above `FOG`, and the layer Outliner uses for the same job. See the module header. */
export const RAISED_LAYER = "POINTER" satisfies Layer;

/**
 * Where an annotation goes when its remembered layer is unusable.
 *
 * `DRAWING` because it is where Owlbear's own pen puts things, so an annotation landing there is
 * somewhere ordinary rather than somewhere strange. The alternative — refusing to move an item
 * whose metadata is unreadable — leaves it stranded above the fog, which is the worse failure of
 * the two: the point of this fallback is that there is always a way down.
 */
export const FALLBACK_LAYER = "DRAWING" satisfies Layer;

/**
 * The layers the SDK declares, for validating what comes back out of metadata.
 *
 * `satisfies` fails the build if one of these names stops being a `Layer`. It cannot catch Owlbear
 * *adding* a layer, which would then be rejected here as unknown and sent to the fallback — a
 * visible, harmless wrong answer rather than a silent one.
 */
const LAYERS = [
  "MAP",
  "GRID",
  "DRAWING",
  "PROP",
  "MOUNT",
  "CHARACTER",
  "ATTACHMENT",
  "NOTE",
  "TEXT",
  "RULER",
  "FOG",
  "POINTER",
  "POST_PROCESS",
  "CONTROL",
  "POPOVER",
] as const satisfies readonly Layer[];

/** The shape this needs from an item, kept structural so fixtures stay small. */
export interface RaisableItem {
  readonly id: string;
  readonly layer: Layer;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface LayerChange {
  readonly id: string;
  readonly layer: Layer;
  /** What to store under {@link RAISED_FROM}; `undefined` means erase the key. */
  readonly raisedFrom: Layer | undefined;
}

/** Whether this extension is the reason the item is above the fog. */
export function isRaised(item: RaisableItem): boolean {
  return item.metadata[RAISED_FROM] !== undefined;
}

/**
 * What to change to bring items above the fog.
 *
 * Items already raised are skipped rather than raised again — a second raise would overwrite the
 * remembered layer with `POINTER`, and the way back would then lead nowhere. Items already sitting
 * on `POINTER` for their own reasons are skipped too: this extension did not put them there and
 * must not claim ownership of them, or sending them "back" would move something that was never
 * moved.
 */
export function planRaise(items: readonly RaisableItem[]): LayerChange[] {
  const changes: LayerChange[] = [];
  for (const item of items) {
    if (isRaised(item) || item.layer === RAISED_LAYER) continue;
    changes.push({
      id: item.id,
      layer: RAISED_LAYER,
      raisedFrom: item.layer,
    });
  }
  return changes;
}

/**
 * What to change to send raised items back where they came from.
 *
 * Only items this extension raised are touched, which is what keeps it from dragging down an
 * annotation somebody put on `POINTER` deliberately.
 */
export function planLower(items: readonly RaisableItem[]): LayerChange[] {
  const changes: LayerChange[] = [];
  for (const item of items) {
    if (!isRaised(item)) continue;
    changes.push({
      id: item.id,
      layer: originalLayer(item.metadata[RAISED_FROM]),
      raisedFrom: undefined,
    });
  }
  return changes;
}

/**
 * Read a remembered layer back, refusing anything that would not actually bring the item down.
 *
 * `POINTER` is rejected as well as the unrecognisable. It is a valid `Layer`, so a check that only
 * asked "is this a layer?" would accept it and hand back an item that is still above the fog after
 * being told to come down — the failure would look exactly like the button not working. `planRaise`
 * cannot write it, so reaching this means the metadata was edited or written by something else.
 */
function originalLayer(stored: unknown): Layer {
  if (typeof stored !== "string") return FALLBACK_LAYER;
  if (stored === RAISED_LAYER) return FALLBACK_LAYER;
  return LAYERS.includes(stored as Layer) ? (stored as Layer) : FALLBACK_LAYER;
}
