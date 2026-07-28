/**
 * Telling a map apart from something that merely landed on the MAP layer.
 *
 * The layer alone is not enough. The test scene holds two MAP-layer images: the map, and a
 * character token called "Monk" that ended up there — 816x1056 world units against roughly one
 * grid square. Refusing to trace anything until the GM disambiguates *that* is the safety rule
 * firing on a case it was never meant to catch, and it left a scene with no sketch and no
 * obvious way forward.
 *
 * ## Why relative area, and why this is not the heuristic that was rejected
 *
 * Choosing the *largest* MAP image and tracing it was rejected, and stays rejected: a GM's
 * overlay is typically the same size as the map it covers, so size cannot say which of two
 * comparable images the players are allowed to see.
 *
 * This is a narrower claim — that an image a small fraction of the largest one's area is not
 * another version of the same map. It only ever *removes* images from consideration, so it
 * cannot cause a GM-only image to be traced that would not have been traced anyway, and two
 * comparable images still produce a refusal. A small GM annotation dropped on the MAP layer is
 * excluded rather than traced, which is also the outcome wanted.
 *
 * Pure: no DOM, no SDK.
 */

export interface MapCandidate {
  readonly id: string;
  readonly name: string;
  /** World-space area of the item's bounds. */
  readonly area: number;
}

/**
 * Share of the largest image's area below which something is not a map.
 *
 * A quarter is deliberately loose. The gap it has to separate is enormous — a token is under a
 * hundredth of a map's area — so nothing is gained by tuning it finer, and a generous threshold
 * keeps a genuinely small map or an odd aspect ratio from being discarded.
 */
export const MIN_AREA_SHARE = 0.25;

/**
 * The images plausibly showing the same ground as the largest of them.
 *
 * @returns candidates in input order. Fewer than two inputs are returned unchanged: with one
 * image there is nothing to compare against, and the caller's single-map rule applies.
 */
export function selectMapCandidates(
  candidates: readonly MapCandidate[],
  minShare = MIN_AREA_SHARE,
): MapCandidate[] {
  if (candidates.length < 2) return [...candidates];

  let largest = 0;
  for (const candidate of candidates) {
    if (candidate.area > largest) largest = candidate.area;
  }

  // Degenerate bounds all round — nothing to rank by, so discard nothing and let the caller
  // refuse. Filtering on a zero threshold would silently keep everything anyway.
  if (!(largest > 0)) return [...candidates];

  return candidates.filter(
    (candidate) => candidate.area >= largest * minShare,
  );
}
