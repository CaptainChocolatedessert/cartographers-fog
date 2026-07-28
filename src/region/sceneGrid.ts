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

  const [bounds, dpi, perMap] = await Promise.all([
    OBR.scene.items.getItemBounds(maps.map((map) => map.id)),
    OBR.scene.grid.getDpi(),
    Promise.all(
      maps.map(async (map) => ({
        map,
        bounds: await OBR.scene.items.getItemBounds([map.id]),
      })),
    ),
  ]);

  const minCellSize = finestPixelSize(perMap);

  const grid = createCellGrid({ min: bounds.min, max: bounds.max }, dpi, {
    minCellSize,
  });

  devLog(
    "info",
    `region: grid ${grid.columns}x${grid.rows}, cell ${grid.cellSize.toFixed(2)} units ` +
      `(dpi ${dpi}, floor ${minCellSize.toFixed(2)} units = 1 map pixel), covering ` +
      `${Math.round(bounds.width)}x${Math.round(bounds.height)} from ${maps.length} map ` +
      `image${maps.length === 1 ? "" : "s"}`,
  );

  return grid;
}

/**
 * World units covered by one pixel of the highest-resolution map image.
 *
 * The lower bound on cell size: below this the region distinguishes ground the source image
 * cannot. Taken across all map images so a coarse backdrop cannot drag the floor up past a
 * detailed inset's resolution.
 *
 * @returns 0 when nothing can be measured, which leaves the cell size unconstrained.
 */
function finestPixelSize(
  measured: readonly { map: Image; bounds: { width: number } }[],
): number {
  let finest = Infinity;

  for (const { map, bounds } of measured) {
    const pixels = map.image.width;
    if (!(pixels > 0) || !(bounds.width > 0)) continue;
    finest = Math.min(finest, bounds.width / pixels);
  }

  return Number.isFinite(finest) ? finest : 0;
}
