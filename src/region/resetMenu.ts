/**
 * Resetting a scene's explored area, from inside the room.
 *
 * **This ships.** It began as a development aid — verifying discovery needs unexplored ground,
 * and a scene runs out of it after a few drags, at which point every sweep reports `+0 cells`
 * and the log can no longer tell "working" from "broken". But the discovered region is
 * persistent and only ever grows, so without this a GM who has explored a scene has **no way
 * back**: the party's map of it is permanent. Starting a session fresh on ground the party has
 * already walked is an ordinary thing to want, and gating this to development builds made it
 * impossible.
 *
 * A context menu rather than a toolbar action: `OBR.tool.createAction` attaches to a tool by id,
 * and the built-in ids are not in the SDK types, so a wrong guess produces a button that
 * silently never appears. A context menu needs no such guess. The cost is that something must be
 * selected for it to show — right-click any item.
 *
 * **Known sharp edge: there is no confirmation.** One click wipes the scene's exploration, and
 * `OBR.notification` can only report it afterwards. A real "are you sure?" needs `OBR.modal` or
 * a context-menu `embed`, both of which want an HTML page — the settings UI this project has so
 * far deferred. Judged proportionate for now: it is GM-only, needs a deliberate right-click on a
 * selected item, and the worst case is re-walking a map rather than losing anything
 * unrecoverable. Revisit when there is a UI to hang a confirmation on.
 */

import OBR from "@owlbear-rodeo/sdk";

import { clearDiscoveredRegion } from "./tracker";
import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";

/**
 * Must be a path, not a data URI.
 *
 * Owlbear concatenates the extension's origin onto whatever this string is, so a data URI comes
 * back as `http://localhost:5173data:image/svg+xml,...` and is rejected with
 * `ValidationError: "icons[0].icon" must be a valid uri`. Built from `BASE_URL` rather than
 * hardcoding `/cartographers-fog/`, which CLAUDE.md already tracks in three other places.
 */
const ICON = `${import.meta.env.BASE_URL}clear-region.svg`;

export async function installResetMenu(): Promise<void> {
  try {
    await OBR.contextMenu.create({
      id: `${NAMESPACE}/reset-region`,
      icons: [
        {
          icon: ICON,
          label: "Reset explored area",
          // The GM owns the write, and a player clicking this would be told no by the tracker
          // anyway. Better not to offer it.
          filter: { roles: ["GM"] },
        },
      ],
      onClick: () => {
        void reset();
      },
    });
  } catch (error) {
    devLog("error", "region: reset menu could not be registered", error);
  }
}

/**
 * Reported through a notification because the result is otherwise invisible on a scene the party
 * has not explored much — the sketch thins out, and nothing says whether that was the reset or a
 * failure. Not a confirmation; see the module header.
 */
async function reset(): Promise<void> {
  try {
    await clearDiscoveredRegion();
    await OBR.notification.show("Explored area reset", "SUCCESS");
  } catch (error) {
    devLog("error", "region: reset failed", error);
    await OBR.notification
      .show("Could not reset the explored area", "ERROR")
      .catch(() => {});
  }
}
