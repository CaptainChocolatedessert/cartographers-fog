/**
 * How the GM says which map the sketch is traced from.
 *
 * Not a development aid — this ships. A scene with more than one MAP image traces nothing until
 * a choice is made, because one of those images may be a GM overlay and every client draws its
 * own strokes; see `mapChoice.ts` for why that cannot be inferred instead.
 *
 * A context menu rather than a toolbar action, for the reason `debug/clearRegionMenu.ts`
 * records: `OBR.tool.createAction` attaches to a tool by id and the built-in ids are not in the
 * SDK types, so a wrong guess yields a button that silently never appears. The filter restricts
 * this to a single MAP-layer image, so it cannot be applied to a token or to a multi-selection.
 *
 * A proper picker belongs with the settings UI when one exists — at which point this stays as
 * the fast path, since right-clicking the map is more direct than finding it in a list.
 */

import OBR from "@owlbear-rodeo/sdk";

import { writeMapChoice } from "./mapChoice";
import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";

/**
 * Must be a path, not a data URI: Owlbear concatenates the extension's origin onto this string,
 * so a data URI is rejected as an invalid uri. Built from `BASE_URL` rather than hardcoding the
 * Pages subpath, which is already tracked in three other places.
 */
const ICON = `${import.meta.env.BASE_URL}sketch-map.svg`;

export async function installChooseMapMenu(): Promise<void> {
  try {
    await OBR.contextMenu.create({
      id: `${NAMESPACE}/choose-map`,
      icons: [
        {
          icon: ICON,
          label: "Sketch from this map",
          filter: {
            // The nomination is shared scene state, and the point of it is that the GM decides
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
        void choose(item.id, item.name);
      },
    });
  } catch (error) {
    devLog("error", "sketch: choose-map menu could not be registered", error);
  }
}

/**
 * Writing the choice is all this does. Every client — including this one — picks the change up
 * through the scene metadata subscription and re-traces, so there is no separate local path to
 * keep in step.
 */
async function choose(itemId: string, name?: string): Promise<void> {
  try {
    await writeMapChoice(itemId);
    devLog("info", `sketch: tracing from "${name || "map"}" (${itemId.slice(0, 8)})`);
  } catch (error) {
    devLog("error", "sketch: could not record the map choice", error);
  }
}
