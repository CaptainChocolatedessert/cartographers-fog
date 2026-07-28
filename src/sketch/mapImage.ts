/**
 * Getting map pixels out of the scene, at the resolution the trace wants.
 *
 * Two jobs: decide *which* image to trace (see `mapChoice.ts` — never a guess when more than
 * one is present), and turn it into a `PixelImage` plus the placement that puts the result back
 * where the map is.
 *
 * Reading the pixels is safe: Owlbear's CDN sends `Access-Control-Allow-Origin: *`
 * unconditionally, verified against the real `image.url` through the SDK (DESIGN.md, "Map pixel
 * access"). `crossOrigin = "anonymous"` is still required — without it the canvas is tainted
 * whatever the server sends. A `SecurityError` here means that result has changed, so it is
 * reported rather than swallowed.
 */

// Aliased: the SDK's `Image` item type would otherwise shadow the DOM `Image` constructor that
// `loadImage` needs, and a type-only binding cannot be called.
import OBR, { isImage, type Image as ImageItem } from "@owlbear-rodeo/sdk";

import { readMapChoice } from "./mapChoice";
import { selectMapCandidates } from "./mapCandidates";
import {
  aspectMismatch,
  chooseTraceWidth,
  createPlacement,
  pixelsPerGridSquare,
  rasterHeightFor,
  type TracePlacement,
} from "./placement";
import { effectivePixelsPerGrid, TRACE_WIDTH } from "./traceSettings";
import { devLog } from "../devlog";
import type { PixelImage } from "../trace/field";

/**
 * Beyond this the bounds are not a scaled copy of the image and a uniform placement is wrong.
 * One percent absorbs rounding in the raster height without admitting a real rotation.
 */
const MAX_ASPECT_MISMATCH = 0.01;

export interface MapRaster {
  readonly mapId: string;
  /** Identifies what was traced, so a cache can tell a re-trace from a redraw. */
  readonly url: string;
  readonly pixels: PixelImage;
  readonly placement: TracePlacement;
  /** The harness's effective pixels-per-grid figure — what the length settings scale by. */
  readonly pixelsPerGrid: number;
  /** The scene's true density. Reported, never tuned from — see `traceSettings.ts`. */
  readonly scenePixelsPerGrid: number;
}

/**
 * The map image to trace, or `null` when that cannot be decided safely.
 *
 * Refusing is the right outcome for an ambiguous scene: no sketch and a log line naming the
 * candidates is recoverable in one right-click, where tracing the wrong image is not.
 */
export async function resolveSketchMap(): Promise<ImageItem | null> {
  const maps = await OBR.scene.items.getItems<ImageItem>(
    (item) => isImage(item) && item.layer === "MAP",
  );

  if (maps.length === 0) {
    devLog("info", "sketch: no MAP image in this scene, nothing to trace");
    return null;
  }

  const chosenId = await readMapChoice();
  if (chosenId) {
    const chosen = maps.find((map) => map.id === chosenId);
    if (chosen) return chosen;

    // The nominated image is gone — deleted, or the choice was made in another scene. Fall
    // through to the single-map rule rather than tracing something nobody picked.
    devLog(
      "warn",
      `sketch: the nominated map ${chosenId.slice(0, 8)} is not in this scene`,
    );
  }

  if (maps.length === 1) return maps[0]!;

  // More than one MAP-layer image, which usually means a stray rather than a second map — a
  // token dropped on the wrong layer. Rank by world-space area and discard anything far too
  // small to be showing the same ground; see `mapCandidates.ts` on why this is not the
  // largest-wins heuristic that was rejected.
  const measured = await Promise.all(
    maps.map(async (map) => ({
      map,
      bounds: await OBR.scene.items.getItemBounds([map.id]),
    })),
  );

  const candidates = selectMapCandidates(
    measured.map(({ map, bounds }) => ({
      id: map.id,
      name: map.name || "unnamed",
      area: Math.max(0, bounds.width) * Math.max(0, bounds.height),
    })),
  );

  if (candidates.length === 1) {
    const only = maps.find((map) => map.id === candidates[0]!.id);
    if (only) {
      devLog(
        "info",
        `sketch: tracing "${only.name || "map"}" — the other ${maps.length - 1} MAP ` +
          `image${maps.length === 2 ? " is" : "s are"} too small to be a map ` +
          `(${describe(measured, candidates)})`,
      );
      return only;
    }
  }

  // Genuinely ambiguous: two images big enough to be showing the same ground. `locked` and
  // `visible` are reported because the context menu needs an item *selected*, and a locked map
  // cannot be selected by clicking — which is exactly how this refusal becomes a dead end.
  devLog(
    "warn",
    `sketch: ${candidates.length} comparable MAP images and no choice made, so nothing is ` +
      `traced — one may be a GM overlay, and tracing it would draw GM linework on player ` +
      `screens. Pick one with "Sketch from this map"; a locked map must be unlocked first to ` +
      `be selectable. Candidates: ` +
      measured
        .filter(({ map }) => candidates.some((c) => c.id === map.id))
        .map(
          ({ map, bounds }) =>
            `${map.name || "unnamed"} (${map.id.slice(0, 8)}, ` +
            `${Math.round(bounds.width)}x${Math.round(bounds.height)}, ` +
            `${map.locked ? "locked" : "unlocked"}, ` +
            `${map.visible ? "visible" : "hidden"})`,
        )
        .join("; "),
  );
  return null;
}

/** Areas of what was kept and dropped, so a surprising exclusion can be checked. */
function describe(
  measured: readonly { map: ImageItem; bounds: { width: number; height: number } }[],
  candidates: readonly { id: string }[],
): string {
  return measured
    .map(
      ({ map, bounds }) =>
        `${map.name || "unnamed"} ${Math.round(bounds.width)}x${Math.round(bounds.height)}` +
        (candidates.some((candidate) => candidate.id === map.id) ? "" : " dropped"),
    )
    .join(", ");
}

/**
 * Load the map and downscale it to the trace resolution.
 *
 * @returns `null` if the image cannot be loaded or its pixels cannot be read — both are
 * reported, since either would otherwise show up as a sketch that simply never appears.
 */
export async function loadMapRaster(map: ImageItem): Promise<MapRaster | null> {
  const [bounds, dpi] = await Promise.all([
    OBR.scene.items.getItemBounds([map.id]),
    OBR.scene.grid.getDpi(),
  ]);

  const worldWidth = bounds.max.x - bounds.min.x;

  let source: HTMLImageElement;
  try {
    source = await loadImage(map.image.url);
  } catch (error) {
    devLog("error", `sketch: could not load the map image ${map.image.url}`, error);
    return null;
  }

  const rasterWidth = chooseTraceWidth(source.naturalWidth, TRACE_WIDTH);
  const rasterHeight = rasterHeightFor(
    source.naturalWidth,
    source.naturalHeight,
    rasterWidth,
  );

  const mismatch = aspectMismatch({ min: bounds.min, max: bounds.max }, rasterWidth, rasterHeight);
  if (mismatch > MAX_ASPECT_MISMATCH) {
    // Almost certainly rotation: an axis-aligned box round a rotated image has a different
    // aspect from the image itself. Said plainly, because the symptom otherwise is strokes
    // landing in the wrong place with no indication why.
    devLog(
      "warn",
      `sketch: the map's world bounds are ${(mismatch * 100).toFixed(0)}% off the image's ` +
        `aspect ratio, which usually means it is rotated. Strokes will be misplaced — ` +
        `rotation is not handled yet.`,
    );
  }

  let pixels: PixelImage;
  try {
    pixels = drawToPixels(source, rasterWidth, rasterHeight);
  } catch (error) {
    // The one failure that is about the platform rather than the map. Through console.error so
    // it survives into a production build, where devLog compiles away.
    console.error(
      "Cartographer's Fog: map pixels are unreadable — the asset did not send " +
        "Access-Control-Allow-Origin. The sketch cannot be traced.",
      error,
    );
    return null;
  }

  const perGrid = effectivePixelsPerGrid(rasterWidth, source.naturalWidth);
  const sceneDensity = pixelsPerGridSquare(rasterWidth, worldWidth, dpi);

  // Both densities, deliberately. The settings run on the harness's nominal figure, while the
  // scene's real one is what a grid-relative calibration would have to use — and the two
  // diverging by several times is the sort of thing that should be visible in a log rather than
  // discovered later as a mystery in the output.
  devLog(
    "info",
    `sketch: ${map.name || "map"} ${source.naturalWidth}x${source.naturalHeight} -> raster ` +
      `${rasterWidth}x${rasterHeight}, lengths at ${perGrid.toFixed(1)} px/square (harness ` +
      `nominal); scene is really ${sceneDensity.toFixed(1)} px/square over ` +
      `${(dpi > 0 ? worldWidth / dpi : 0).toFixed(1)} grid squares, dpi ${dpi}`,
  );

  // Logged so the same map can be pasted straight into the trace harness's URL field, where
  // tuning takes seconds instead of a room reload — and where the URL also exercises the real
  // cross-origin path rather than a local file.
  devLog("info", `sketch: source ${map.image.url}`);

  return {
    mapId: map.id,
    url: map.image.url,
    pixels,
    placement: createPlacement({ min: bounds.min, max: bounds.max }, rasterWidth),
    pixelsPerGrid: perGrid,
    scenePixelsPerGrid: sceneDensity,
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Required regardless of what the server sends: without it the canvas is tainted and
    // getImageData throws even for a fully permissive CDN.
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          "image failed to load (a cross-origin image needs CORS headers even to load)",
        ),
      );
    image.src = url;
  });
}

function drawToPixels(
  source: HTMLImageElement,
  width: number,
  height: number,
): PixelImage {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d canvas context");

  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}
