/**
 * Zhang–Suen thinning — ink down to a one-pixel skeleton.
 *
 * This is the step that answers "where did the artist's pen go", as opposed to "where is the
 * edge of the ink". A stroke of any width collapses to a single line down its middle, so a
 * drawn wall yields one polyline rather than a loop around its silhouette.
 *
 * Two sub-iterations per pass, deleting from opposite sides in turn. The alternation is not
 * cosmetic: deleting from one side only would erode a stroke off-centre, and deleting from
 * both sides simultaneously would sever it — a pixel and its neighbour can each be
 * individually removable while the pair is not. Each sub-iteration therefore marks first and
 * deletes afterwards, so decisions within a sub-iteration cannot see each other.
 *
 * Guo–Hall is the usual alternative and leaves slightly fewer staircase artifacts at
 * diagonals; Zhang–Suen is here because it is the better-documented of the two and its
 * conditions are checkable by hand against the paper. Simplification downstream smooths the
 * staircases either way.
 *
 * Pure: no DOM, no SDK.
 */

import { maskAt, type BinaryMask } from "./binarize";

/** Guard against a pathological input spinning forever; a real skeleton converges quickly. */
const MAX_PASSES = 200;

export function thin(mask: BinaryMask): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  const working: BinaryMask = { width, height, data };

  const doomed: number[] = [];

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let removed = 0;
    for (const step of [0, 1] as const) {
      doomed.length = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[y * width + x] !== 1) continue;
          if (isRemovable(working, x, y, step)) doomed.push(y * width + x);
        }
      }

      for (const index of doomed) data[index] = 0;
      removed += doomed.length;
    }

    if (removed === 0) break;
  }

  return working;
}

/**
 * The four Zhang–Suen conditions, with the last two differing per sub-iteration.
 *
 * Neighbours are numbered clockwise from north as in the paper: P2 north, P3 north-east, and
 * so on round to P9 north-west.
 */
function isRemovable(
  mask: BinaryMask,
  x: number,
  y: number,
  step: 0 | 1,
): boolean {
  const p2 = maskAt(mask, x, y - 1);
  const p3 = maskAt(mask, x + 1, y - 1);
  const p4 = maskAt(mask, x + 1, y);
  const p5 = maskAt(mask, x + 1, y + 1);
  const p6 = maskAt(mask, x, y + 1);
  const p7 = maskAt(mask, x - 1, y + 1);
  const p8 = maskAt(mask, x - 1, y);
  const p9 = maskAt(mask, x - 1, y - 1);

  // B: how many neighbours are ink. Below 2 the pixel is an endpoint or isolated and must
  // survive; above 6 it is interior and removing it would pit the shape.
  const neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
  if (neighbours < 2 || neighbours > 6) return false;

  // A: transitions from background to ink going round the ring. Exactly one means the ink
  // neighbours form a single arc, so deleting this pixel cannot disconnect anything.
  const ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
  let transitions = 0;
  for (let i = 0; i < 8; i++) {
    if (ring[i] === 0 && ring[i + 1] === 1) transitions++;
  }
  if (transitions !== 1) return false;

  return step === 0
    ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0
    : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0;
}
