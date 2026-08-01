/**
 * Room metadata access for the sketch's appearance — the SDK half of `appearance.ts`.
 *
 * Split out for the reason DESIGN.md records under the visibility layering: importing
 * `@owlbear-rodeo/sdk` anywhere makes a module untestable headlessly, because the SDK's index
 * calls `getDetails()` at load and reads `window.location.search`. All the rules — validation,
 * clamping, per-field fallback, and which change forces a re-trace — therefore live next door in
 * a file with no SDK import, and this one is a thin shell over `OBR.room`.
 *
 * **Room, not scene.** An aesthetic preference follows the GM between scenes; the discovered
 * region and the map nomination cannot. `OBR.room.onMetadataChange` fires on every client, which
 * is what makes a GM's choice reach players with no broadcast and no late-joiner handling.
 */

import OBR from "@owlbear-rodeo/sdk";

import {
  APPEARANCE_KEY,
  fromRoomMetadata,
  type Appearance,
} from "./appearance";

export async function readAppearance(): Promise<Appearance> {
  const metadata = (await OBR.room.getMetadata()) as Record<string, unknown>;
  return fromRoomMetadata(metadata);
}

/**
 * Write some fields, leaving the rest as they are.
 *
 * Read-modify-write rather than blind overwrite. DESIGN.md is explicit that the `Permission` enum
 * governs item operations and says nothing about metadata, so *any* client can write here — GM-only
 * UI is a convention, not a boundary. Composing with a concurrent write costs one extra read and
 * removes a whole class of "my setting reverted" reports.
 *
 * @returns the appearance as written, so a caller can update its own view without a round trip.
 */
export async function writeAppearance(
  changes: Partial<Appearance>,
): Promise<Appearance> {
  const current = await readAppearance();
  const next: Appearance = { ...current, ...changes };
  await OBR.room.setMetadata({ [APPEARANCE_KEY]: next });
  return next;
}

/**
 * Remove the appearance key entirely, so every client falls back to `DEFAULT_APPEARANCE`.
 *
 * **Room-wide, not scene-scoped.** Room metadata follows the GM across every scene in the room, so
 * this is not "reset this scene's look" and must not be offered as though it were. It is a separate
 * action from erasing a scene's data for exactly that reason.
 *
 * Note this is a blind write rather than the read-modify-write `writeAppearance` uses. That guard
 * exists to avoid clobbering a concurrent partial change; here clobbering the whole key *is* the
 * operation, so composing with a concurrent write would only preserve part of what is being erased.
 */
export async function eraseAppearance(): Promise<void> {
  await OBR.room.setMetadata({ [APPEARANCE_KEY]: undefined });
}

export function onAppearanceChange(
  callback: (appearance: Appearance) => void,
): () => void {
  return OBR.room.onMetadataChange((metadata) => {
    callback(fromRoomMetadata(metadata as Record<string, unknown>));
  });
}
