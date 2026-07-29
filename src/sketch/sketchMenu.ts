/**
 * The GM's controls for the sketch, as context menu entries.
 *
 * Not development aids — these ship. A scene with more than one MAP image traces nothing until a
 * map is nominated (see `sketchSettings.ts` for why that cannot be inferred), and a scene whose
 * map traces badly needs a way to be rid of the sketch without uninstalling anything.
 *
 * Context menus rather than toolbar actions, for the reason `region/resetMenu.ts` also records:
 * `OBR.tool.createAction` attaches to a tool by id, and the built-in ids are not in the SDK
 * types, so a wrong guess yields a button that silently never appears. The cost is that a context
 * menu needs something *selected* — and a locked item cannot be selected by clicking, which is
 * why nominating a map means unlocking it first.
 *
 * These are the stand-in for a settings UI, not a substitute for one. A real panel would carry
 * the map picker, the style controls DESIGN.md describes, and a confirmation before anything
 * destructive.
 */

import OBR from "@owlbear-rodeo/sdk";

import { clearSketch, writeMapChoice } from "./sketchSettings";
import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";

/**
 * Must be a path, not a data URI: Owlbear concatenates the extension's origin onto this string,
 * so a data URI is rejected as an invalid uri. Built from `BASE_URL` rather than hardcoding the
 * Pages subpath, which is already tracked in three other places.
 */
const MAP_ICON = `${import.meta.env.BASE_URL}sketch-map.svg`;
const CLEAR_ICON = `${import.meta.env.BASE_URL}sketch-clear.svg`;

export async function installSketchMenus(): Promise<void> {
  await Promise.all([installChooseMap(), installClear()]);
}

async function installChooseMap(): Promise<void> {
  try {
    await OBR.contextMenu.create({
      id: `${NAMESPACE}/choose-map`,
      icons: [
        {
          icon: MAP_ICON,
          label: "Sketch from this map",
          filter: {
            // The nomination is shared scene state, and its whole point is that the GM decides
            // which map players may see traced. Offering it to a player would defeat that.
            roles: ["GM"],
            max: 1,
            every: [
              { key: "layer", value: "MAP" },
              { key: "type", value: "IMAGE" },
            ],
          },
        },
      ],
      onClick: (context) => {
        const item = context.items[0];
        if (!item) return;
        void chooseMap(item.id, item.name);
      },
    });
  } catch (error) {
    devLog("error", "sketch: choose-map menu could not be registered", error);
  }
}

async function installClear(): Promise<void> {
  try {
    await OBR.contextMenu.create({
      id: `${NAMESPACE}/clear-sketch`,
      icons: [
        {
          icon: CLEAR_ICON,
          label: "Clear sketch",
          // Deliberately not restricted to map images: clearing has nothing to do with which
          // item happens to be selected, and requiring the map would mean unlocking it first
          // for no reason.
          filter: { roles: ["GM"] },
        },
      ],
      onClick: () => {
        void clear();
      },
    });
  } catch (error) {
    devLog("error", "sketch: clear menu could not be registered", error);
  }
}

/**
 * Writing the choice is all this does. Every client — including this one — picks the change up
 * through the scene metadata subscription and re-traces, so there is no separate local path to
 * keep in step.
 */
async function chooseMap(itemId: string, name?: string): Promise<void> {
  try {
    await writeMapChoice(itemId);
    await OBR.notification.show(`Sketching from "${name || "map"}"`, "SUCCESS");
    devLog("info", `sketch: tracing from "${name || "map"}" (${itemId.slice(0, 8)})`);
  } catch (error) {
    devLog("error", "sketch: could not record the map choice", error);
  }
}

/**
 * Delete the sketch, one way.
 *
 * Deliberately not a toggle. Nothing is lost by deleting — the linework is derived from the map
 * and can be traced again whenever the GM wants it — so the reversible-toggle machinery would be
 * ceremony around an action that is already free to undo.
 *
 * The notification carries the way back, because there is otherwise nothing on screen to suggest
 * one exists. That matters more than usual here: the recreation path runs through the *map's*
 * context menu, and a locked map has to be unlocked before it can be right-clicked at all.
 */
async function clear(): Promise<void> {
  try {
    await clearSketch();
    await OBR.notification.show(
      'Sketch cleared — right-click the map and choose "Sketch from this map" to redraw it',
      "INFO",
    );
    devLog("info", "sketch: cleared for this scene");
  } catch (error) {
    devLog("error", "sketch: could not clear", error);
    await OBR.notification
      .show("Could not clear the sketch", "ERROR")
      .catch(() => {});
  }
}
