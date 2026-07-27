/**
 * A way to wipe the discovered region from inside a room, for testing.
 *
 * Verifying discovery needs unexplored ground, and a scene runs out of it quickly — after a few
 * drags every sweep reports `+0 cells` and the log stops being able to tell "working" from
 * "broken". This puts the reset one right-click away.
 *
 * A context menu rather than a toolbar action: `OBR.tool.createAction` attaches to a tool by id,
 * and the built-in tool ids are not in the SDK types, so a wrong guess would produce a button
 * that silently never appears. A context menu needs no such guess. The cost is that something
 * must be selected for it to show — right-click any item.
 *
 * Development only. This deletes a scene's exploration history with one click and no
 * confirmation, which is right for testing and wrong for anything else.
 */

import OBR from "@owlbear-rodeo/sdk";

import { clearDiscoveredRegion } from "../region/tracker";
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

export async function installClearRegionMenu(): Promise<void> {
  if (!import.meta.env.DEV) return;

  try {
    await OBR.contextMenu.create({
      id: `${NAMESPACE}/clear-region`,
      icons: [
        {
          icon: ICON,
          label: "Clear explored region (dev)",
          // The GM owns the write, and a player clicking this would be told no by the tracker
          // anyway. Better not to offer it.
          filter: { roles: ["GM"] },
        },
      ],
      onClick: () => {
        void clearDiscoveredRegion();
      },
    });
  } catch (error) {
    devLog("error", "clear-region menu could not be registered", error);
  }
}
