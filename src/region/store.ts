/**
 * Reading and writing the discovered region in scene metadata.
 *
 * Metadata rather than scene items: measured, it holds far more than we need (no limit found
 * below 512KB per key, against a fragmented region costing under 4KB), it reaches player
 * clients byte-identical, and unlike items it leaves nothing behind in the GM's scene to be
 * accidentally selected, deleted, or inherited by their undo history. See DESIGN.md,
 * "Storage limits".
 */

import OBR from "@owlbear-rodeo/sdk";

import { decodeRegion, encodeRegion } from "./codec";
import { sameGrid, type CellGrid } from "./cellGrid";
import type { RegionMask } from "./regionMask";
import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
export const REGION_KEY = `${NAMESPACE}/discovered`;

/** Rate-limit retries. Owlbear refuses rapid writes with `RateLimitHit`. */
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns the stored region if it is present, decodable, and recorded against `grid`;
 * otherwise `null`. A region from a different grid is discarded rather than reinterpreted —
 * its cells refer to different ground.
 */
export async function readRegion(grid: CellGrid): Promise<RegionMask | null> {
  const metadata = (await OBR.scene.getMetadata()) as Record<string, unknown>;
  const raw = metadata[REGION_KEY];
  if (raw === undefined) return null;

  const decoded = decodeRegion(raw);
  if (!decoded) {
    devLog("warn", "region: stored value could not be decoded, ignoring it");
    return null;
  }

  if (!sameGrid(decoded.grid, grid)) {
    devLog(
      "info",
      `region: stored region is for a ${decoded.grid.columns}x${decoded.grid.rows} grid but ` +
        `this scene needs ${grid.columns}x${grid.rows} — discarding. The map or grid changed.`,
    );
    return null;
  }

  return decoded;
}

/**
 * Persist the region, retrying through rate limits.
 *
 * Only the GM should call this — see DESIGN.md §5 on single-writer. A validation failure is
 * not retried, since repeating an oversized write cannot succeed; a throttle is, since giving
 * up on one loses discovered ground.
 */
export async function writeRegion(mask: RegionMask): Promise<boolean> {
  const encoded = encodeRegion(mask);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await OBR.scene.setMetadata({ [REGION_KEY]: encoded });
      return true;
    } catch (error) {
      if (!isRateLimit(error)) {
        devLog("error", `region: write rejected (${encoded.length} bytes)`, error);
        return false;
      }

      const backoff = BASE_BACKOFF_MS * 2 ** attempt;
      await sleep(backoff);
    }
  }

  devLog(
    "error",
    `region: write still rate limited after ${MAX_ATTEMPTS} attempts — discovered ground ` +
      `may be lost. Increase the persistence debounce.`,
  );
  return false;
}

/**
 * Remove the stored region entirely.
 *
 * Setting the key to `undefined` deletes it rather than storing an empty region, so a scene that
 * has been cleared is indistinguishable from one never explored — which is what makes this useful
 * for testing. Note that clearing storage is only half the job: every client also holds the
 * region in memory, and the GM would re-persist its copy on the next move. Go through
 * `clearDiscoveredRegion` in the tracker, not this.
 */
export async function clearRegion(): Promise<void> {
  await OBR.scene.setMetadata({ [REGION_KEY]: undefined });
}

/** Subscribe to region changes made by whichever client owns the writes. */
export function onRegionChange(
  grid: CellGrid,
  callback: (region: RegionMask | null) => void,
): () => void {
  return OBR.scene.onMetadataChange((metadata) => {
    const raw = (metadata as Record<string, unknown>)[REGION_KEY];

    // Every `null` below means "drop the discovered region", which is destructive and irreversible.
    // Three quite different things reach it — the key being absent from this event, a value that
    // will not decode, and a region recorded against another grid — and they were previously
    // indistinguishable at the call site. Naming which one fired is the difference between "the GM
    // cleared it" and "we threw away an hour of exploration for no reason".
    if (raw === undefined) {
      devLog("info", "region: change event carried no region key");
      callback(null);
      return;
    }

    const decoded = decodeRegion(raw);
    if (!decoded) {
      devLog("warn", "region: change event carried a value that would not decode");
      callback(null);
      return;
    }

    if (!sameGrid(decoded.grid, grid)) {
      devLog(
        "info",
        `region: change event is for a ${decoded.grid.columns}x${decoded.grid.rows} grid, ` +
          `this scene uses ${grid.columns}x${grid.rows}`,
      );
      callback(null);
      return;
    }

    callback(decoded);
  });
}

function isRateLimit(error: unknown): boolean {
  const name =
    (error as { error?: { name?: string }; name?: string })?.error?.name ??
    (error as { name?: string })?.name;
  return name === "RateLimitHit";
}
