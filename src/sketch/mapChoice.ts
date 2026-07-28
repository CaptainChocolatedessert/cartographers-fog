/**
 * Which map image the sketch is traced from.
 *
 * ## Why this is a choice and not a heuristic
 *
 * A scene can hold more than one MAP-layer image, and one of them may be a GM's overlay laid on
 * top of the players' map — secret doors, notes, the real layout behind an illusion. Every
 * client traces locally and draws its own strokes (DESIGN.md §5), so a player client tracing
 * that overlay would draw GM-only linework onto a player's screen. That is a spoiled session,
 * not a cosmetic bug.
 *
 * Nothing in the SDK lets this be detected. `Item` carries a plain `visible: boolean` and no
 * role dimension at all, so there is no field marking an image as GM-only, and whether a player
 * client's `getItems` even returns one is untested. Any rule invented here — largest image,
 * lowest z-index, first in the list — would fail silently in exactly the case that matters.
 *
 * So the GM nominates the map explicitly, and the nomination lives in **scene metadata** so
 * every client traces the same one. Where no choice has been made, `mapImage.ts` uses a lone
 * map image and otherwise refuses to guess.
 *
 * Per-scene rather than per-room: a different scene is a different map. This is unlike the
 * display settings in DESIGN.md, which follow the GM between scenes and belong in room metadata.
 */

import OBR from "@owlbear-rodeo/sdk";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
export const MAP_CHOICE_KEY = `${NAMESPACE}/sketch-map`;

/** @returns the nominated map image's id, or `undefined` if the GM has not chosen one. */
export async function readMapChoice(): Promise<string | undefined> {
  const metadata = (await OBR.scene.getMetadata()) as Record<string, unknown>;
  return asId(metadata[MAP_CHOICE_KEY]);
}

export async function writeMapChoice(itemId: string): Promise<void> {
  await OBR.scene.setMetadata({ [MAP_CHOICE_KEY]: itemId });
}

/** Setting the key to `undefined` removes it, restoring the "no choice made" state. */
export async function clearMapChoice(): Promise<void> {
  await OBR.scene.setMetadata({ [MAP_CHOICE_KEY]: undefined });
}

export function onMapChoiceChange(
  callback: (itemId: string | undefined) => void,
): () => void {
  return OBR.scene.onMetadataChange((metadata) => {
    callback(asId((metadata as Record<string, unknown>)[MAP_CHOICE_KEY]));
  });
}

/**
 * Anything that is not a non-empty string is treated as no choice at all.
 *
 * Metadata is shared and writable by any client (DESIGN.md notes the `Permission` enum does not
 * govern it), and a future build could store a different shape here. Falling back to "unchosen"
 * costs a log line and a GM right-click; trusting a stray value could point the trace at
 * something arbitrary.
 */
function asId(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
