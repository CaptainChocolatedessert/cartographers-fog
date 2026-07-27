/**
 * Building the cell grid from the current scene.
 *
 * Bounds come from `OBR.scene.items.getItemBounds`, which reports world-space extents
 * directly. Deriving them by hand from `image.width`, `grid.dpi`, `grid.offset`, `scale` and
 * `rotation` would be several undocumented conventions strung together — exactly the kind of
 * guess this project has been burned by. Let the SDK answer it.
 */

import OBR, { isImage, type Image } from "@owlbear-rodeo/sdk";

import { createCellGrid, type CellGrid } from "./cellGrid";
import { devLog } from "../devlog";

/**
 * @returns a grid covering every MAP-layer image, or `null` when the scene has no map — in
 * which case there is nothing to track a discovered region against.
 */
export async function buildSceneGrid(): Promise<CellGrid | null> {
  const maps = await OBR.scene.items.getItems<Image>(
    (item) => isImage(item) && item.layer === "MAP",
  );

  if (maps.length === 0) {
    devLog("info", "region: no MAP image, cannot build a cell grid");
    return null;
  }

  const bounds = await OBR.scene.items.getItemBounds(maps.map((map) => map.id));
  const dpi = await OBR.scene.grid.getDpi();

  const grid = createCellGrid(
    { min: bounds.min, max: bounds.max },
    dpi,
  );

  devLog(
    "info",
    `region: grid ${grid.columns}x${grid.rows}, cell ${grid.cellSize.toFixed(1)} units ` +
      `(dpi ${dpi}), covering ${Math.round(bounds.width)}x${Math.round(bounds.height)} from ` +
      `${maps.length} map image${maps.length === 1 ? "" : "s"}`,
  );

  return grid;
}
