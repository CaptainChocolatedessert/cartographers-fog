/**
 * The right-click entry that brings an annotation above the fog, and the way back down.
 *
 * The layer bookkeeping lives in `raise.ts` and is pure; this half is the SDK — registering the
 * menu, and writing the changes it decides on.
 *
 * ## One entry, two faces
 *
 * A `ContextMenuItem` may carry several icons, each with its own filter, and Owlbear shows the
 * first whose filter the selection matches. So this is one menu entry that reads "Bring above the
 * fog" or "Send back below the fog" according to what is selected, rather than two entries that
 * are each wrong half the time. The right-click menu already carries three from this extension;
 * a fourth and fifth would be crowding it.
 *
 * Both filters key off the metadata marker rather than the layer, because the layer cannot answer
 * the question that matters: an item may sit on `POINTER` without this extension having put it
 * there, and that item must be offered neither face — raising it would claim it, and lowering it
 * would move something nobody moved.
 *
 * ## The way back must not depend on selecting the item
 *
 * Whether an item on `POINTER` can still be clicked and right-clicked is not something the SDK
 * types answer, and if it cannot, a per-item toggle would strand every annotation it ever raised.
 * This project has met that shape before: the "Clear sketch" entry deliberately does not require
 * the map to be selected, because a locked map cannot be clicked at all. So `lowerEveryRaised` is
 * exported for the panel to call — it needs no selection, finds raised items by their marker, and
 * therefore cannot leave anything up there whatever Owlbear allows. The toggle is the convenient
 * path; that button is the guarantee.
 */

import OBR, { type Item } from "@owlbear-rodeo/sdk";

import { RAISED_FROM, planLower, planRaise, type LayerChange } from "./raise";
import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";

/**
 * Paths, not data URIs: Owlbear concatenates the extension's origin onto the string, so a data URI
 * is rejected as an invalid uri. Built from `BASE_URL` rather than hardcoding the Pages subpath.
 */
const RAISE_ICON = `${import.meta.env.BASE_URL}raise-above-fog.svg`;
const LOWER_ICON = `${import.meta.env.BASE_URL}lower-below-fog.svg`;

export async function installRaiseMenu(): Promise<void> {
  try {
    await OBR.contextMenu.create({
      id: `${NAMESPACE}/raise-above-fog`,
      icons: [
        {
          icon: LOWER_ICON,
          label: "Send back below the fog",
          // First, because it is the narrower case: anything carrying the marker is ours and has
          // exactly one sensible action. Listing it second would never match, since the raise
          // filter below would already have claimed the selection.
          filter: {
            roles: ["GM"],
            every: [
              { key: ["metadata", RAISED_FROM], value: undefined, operator: "!=" },
            ],
          },
        },
        {
          icon: RAISE_ICON,
          label: "Bring above the fog",
          filter: {
            // GM-only. Raising is shared scene state and it decides what every player sees through
            // the fog, which is not a player's call to make.
            roles: ["GM"],
            every: [
              { key: ["metadata", RAISED_FROM], value: undefined },
              // Already up there for its own reasons — see the module header.
              { key: "layer", value: "POINTER", operator: "!=" },
            ],
          },
        },
      ],
      onClick: (context) => {
        void toggle(context.items);
      },
    });
  } catch (error) {
    devLog("error", "annotations: raise menu could not be registered", error);
  }
}

/**
 * Which way to move is read off the selection, not off which icon was clicked.
 *
 * `onClick` does not say which of the icons was shown, so the decision is made again here from the
 * same fact the filters used. A selection holding anything raised goes down: lowering is the
 * recoverable direction, so it is the right way for a mixed selection to resolve.
 */
async function toggle(items: readonly Item[]): Promise<void> {
  const lowering = items.some((item) => item.metadata[RAISED_FROM] !== undefined);
  const changes = lowering ? planLower(items) : planRaise(items);

  if (changes.length === 0) {
    // Reported rather than passed over in silence: a click that does nothing is indistinguishable
    // from a broken menu, and the reasons this happens are all ordinary.
    await notify("Nothing to move — those items are already where they belong", "INFO");
    return;
  }

  try {
    await apply(changes);
    await notify(
      lowering
        ? `${counted(changes.length)} back below the fog`
        : `${counted(changes.length)} above the fog`,
      "SUCCESS",
    );
  } catch (error) {
    devLog("error", "annotations: could not change the layer", error);
    await notify("Could not move that", "ERROR");
  }
}

/**
 * Send every annotation this extension raised back where it came from, with nothing selected.
 *
 * The escape hatch described in the module header, and the panel's button. Reads the whole scene
 * rather than a selection precisely because the items it is looking for may be the ones that can
 * no longer be selected.
 *
 * @returns how many were moved, so the caller can say something true about a run that found none.
 */
export async function lowerEveryRaised(): Promise<number> {
  const items = await OBR.scene.items.getItems(
    (item) => item.metadata[RAISED_FROM] !== undefined,
  );
  const changes = planLower(items);
  if (changes.length === 0) return 0;

  await apply(changes);
  return changes.length;
}

async function apply(changes: readonly LayerChange[]): Promise<void> {
  const byId = new Map(changes.map((change) => [change.id, change]));

  await OBR.scene.items.updateItems([...byId.keys()], (drafts) => {
    for (const draft of drafts) {
      const change = byId.get(draft.id);
      if (!change) continue;

      draft.layer = change.layer;
      // Erased rather than set to `undefined`: a key present and holding nothing still reads as
      // present to the context menu filter, so the entry would keep offering to send an item back
      // that is already down.
      if (change.raisedFrom === undefined) delete draft.metadata[RAISED_FROM];
      else draft.metadata[RAISED_FROM] = change.raisedFrom;
    }
  });
}

const counted = (n: number): string =>
  n === 1 ? "1 annotation" : `${n} annotations`;

/** A failed notification must not become the error, so this swallows its own. */
async function notify(
  message: string,
  variant: "INFO" | "SUCCESS" | "ERROR",
): Promise<void> {
  await OBR.notification.show(message, variant).catch(() => {});
}
