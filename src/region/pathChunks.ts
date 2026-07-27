/**
 * Splitting the region's runs into item-sized batches.
 *
 * A scene item accepts at most **8192** entries in its `commands` array — measured exactly,
 * see DESIGN.md "Items cap at exactly 8192 array entries". This is not a distant scaling
 * concern: a fragmented region at current cell resolution produces roughly 1,800 runs, about
 * 9,000 commands, so the wash exceeds one item's capacity today.
 *
 * Kept free of SDK imports so it stays testable headlessly — this returns grouped runs, and
 * the caller turns them into path commands.
 */

import type { Bounds } from "./cellGrid";

/** MOVE, three LINEs, CLOSE — the fourth edge is implied by CLOSE. */
export const COMMANDS_PER_RUN = 5;

/** Measured hard limit on a single item's command array. */
export const ITEM_COMMAND_LIMIT = 8192;

/**
 * Deliberately under the hard limit. The limit itself is exact, so this margin covers only
 * our own arithmetic drifting — if the emitted shape per run ever changes, an off-by-a-few
 * mistake degrades into an extra chunk rather than a rejected write.
 */
export const SAFE_COMMAND_BUDGET = 8000;

export function maxRunsPerItem(budget = SAFE_COMMAND_BUDGET): number {
  return Math.max(1, Math.floor(budget / COMMANDS_PER_RUN));
}

/**
 * Group runs into batches that each fit one item.
 *
 * @returns one array of runs per item to emit. Empty input yields no batches, so callers do
 * not create an empty item.
 */
export function chunkRuns(
  runs: readonly Bounds[],
  perItem = maxRunsPerItem(),
): Bounds[][] {
  if (runs.length === 0) return [];

  const size = Math.max(1, perItem);
  const chunks: Bounds[][] = [];
  for (let start = 0; start < runs.length; start += size) {
    chunks.push(runs.slice(start, start + size));
  }
  return chunks;
}
