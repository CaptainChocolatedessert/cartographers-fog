/**
 * Grouping traced segments into item-sized batches.
 *
 * Same constraint as the region wash — a scene item takes at most 8192 command entries — but
 * the arithmetic differs: a run is a fixed five commands, while a segment costs one MOVE plus
 * a LINE per remaining point, and that varies with how much simplification kept.
 *
 * Like `region/pathChunks`, this returns grouped segments rather than built commands, so it
 * stays free of the SDK and testable headlessly.
 */

import { SAFE_COMMAND_BUDGET } from "../region/pathChunks";
import type { TracedSegment } from "./chop";

export { ITEM_COMMAND_LIMIT, SAFE_COMMAND_BUDGET } from "../region/pathChunks";

/** MOVE to the first point, then a LINE to each of the rest. */
export function commandCount(segment: TracedSegment): number {
  return segment.points.length;
}

/**
 * Group segments into batches that each fit inside one item's command array.
 *
 * A single segment larger than the budget still gets its own batch — the alternative is
 * dropping geometry, and a segment that long means `segmentLength` is misconfigured, which is
 * better seen as a rejected write than as silently missing linework.
 */
export function chunkSegments(
  segments: readonly TracedSegment[],
  budget = SAFE_COMMAND_BUDGET,
): TracedSegment[][] {
  const chunks: TracedSegment[][] = [];
  let current: TracedSegment[] = [];
  let used = 0;

  for (const segment of segments) {
    const cost = commandCount(segment);
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(segment);
    used += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
