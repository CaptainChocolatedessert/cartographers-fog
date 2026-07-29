/**
 * The sketch's shared per-scene settings: which map is traced, and whether to draw at all.
 *
 * Both live in **scene metadata** rather than on each client, because every client derives and
 * draws its own sketch (DESIGN.md §5) and they must agree about what to draw. A GM's choice
 * therefore reaches players with no broadcast to design and no late-joiner problem — a client
 * connecting later reads the same metadata.
 *
 * Per-scene rather than per-room: a different scene is a different map. That is unlike the
 * display *styling* options DESIGN.md describes, which sensibly follow a GM between scenes.
 * Turning the sketch off is a judgment about this map — usually that it traced badly — so it
 * belongs beside the map choice.
 *
 * ## Why the map is chosen and never inferred
 *
 * A scene can hold more than one MAP-layer image, and one may be a GM's overlay laid over the
 * players' map — secret doors, the real layout behind an illusion. Every client traces locally,
 * so a player client tracing that overlay would draw GM-only linework onto a player's screen.
 * That is a spoiled session, not a cosmetic bug.
 *
 * Nothing in the SDK lets it be detected. `Item` carries a plain `visible: boolean` and no role
 * dimension at all, so no field marks an image as GM-only, and whether a player client's
 * `getItems` even returns one is untested. Any rule invented here — largest image, lowest
 * z-index, first in the list — would fail silently in exactly the case that matters. So the GM
 * nominates, and where nothing is nominated `mapImage.ts` uses a lone map image and otherwise
 * refuses to guess.
 */

import OBR from "@owlbear-rodeo/sdk";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
export const MAP_CHOICE_KEY = `${NAMESPACE}/sketch-map`;
export const SKETCH_ENABLED_KEY = `${NAMESPACE}/sketch-enabled`;

export interface SketchSettings {
  /** The nominated map image's id, or `undefined` if the GM has not chosen one. */
  readonly mapId: string | undefined;
  /** Whether to trace and draw at all. Absent means yes — a scene that was never told. */
  readonly enabled: boolean;
}

export async function readSketchSettings(): Promise<SketchSettings> {
  const metadata = (await OBR.scene.getMetadata()) as Record<string, unknown>;
  return fromMetadata(metadata);
}

/**
 * Trace this map, and undo any previous clearing.
 *
 * Nominating a map is the only way back after `clearSketch`, so it necessarily re-enables. Both
 * keys go in one `setMetadata` call, so a client can never observe the half-applied state where
 * a map is chosen but the sketch is still suppressed.
 */
export async function writeMapChoice(itemId: string): Promise<void> {
  await OBR.scene.setMetadata({
    [MAP_CHOICE_KEY]: itemId,
    [SKETCH_ENABLED_KEY]: true,
  });
}

/**
 * Delete the sketch from this scene.
 *
 * Nothing durable is actually deleted — the strokes are local items derived from the map, and
 * the trace can be redone at any time. What this writes is the *suppression*, and that is the
 * part which needs storing: without it the next scene load would re-derive the sketch and undo
 * the deletion.
 *
 * Suppression is why an explicit `false` is needed rather than simply forgetting the map. On the
 * common one-map scene, an absent choice falls back to "trace the only map there is" — so
 * clearing the nomination alone would resurrect the sketch immediately. Both are cleared
 * together anyway, so a later nomination is a deliberate act rather than a resumption.
 */
export async function clearSketch(): Promise<void> {
  await OBR.scene.setMetadata({
    [MAP_CHOICE_KEY]: undefined,
    [SKETCH_ENABLED_KEY]: false,
  });
}

export function onSketchSettingsChange(
  callback: (settings: SketchSettings) => void,
): () => void {
  return OBR.scene.onMetadataChange((metadata) => {
    callback(fromMetadata(metadata as Record<string, unknown>));
  });
}

/**
 * Anything unexpected is treated as unset.
 *
 * Metadata is shared and writable by any client — DESIGN.md notes the `Permission` enum does not
 * govern it — and a future build could store a different shape here. Falling back costs a log
 * line and a GM right-click; trusting a stray value could point the trace at something arbitrary,
 * or blank the sketch with no explanation.
 */
export function fromMetadata(
  metadata: Record<string, unknown>,
): SketchSettings {
  const rawId = metadata[MAP_CHOICE_KEY];
  const rawEnabled = metadata[SKETCH_ENABLED_KEY];

  return {
    mapId: typeof rawId === "string" && rawId.length > 0 ? rawId : undefined,
    // Default on: a scene predating this setting should sketch, not sit blank.
    enabled: typeof rawEnabled === "boolean" ? rawEnabled : true,
  };
}
