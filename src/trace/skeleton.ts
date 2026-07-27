/**
 * Turning a thinned skeleton into strokes.
 *
 * Adapted from the author's own `VTT_Maps` (MIT, and GPLv3-compatible), which worked this out
 * against exactly the maps this project targets. Four things come straight from there, each
 * because the obvious version is wrong:
 *
 * - **Stub pruning only removes a dead end that terminates at a junction.** A short chain
 *   ending in free space is a real short stroke; a short chain hanging off a junction is an
 *   artifact of stroke-width variation during thinning.
 * - **Pruning has to iterate** — removing one stub can turn its junction into a new dead end.
 * - **Junction clusters must be collapsed.** Thinning leaves junction pixels one or two apart,
 *   and the sub-pixel chains between them survive everything else: stub pruning refuses them
 *   because both ends are junctions, and collinear merging refuses them because they are not
 *   degree-2. Welding endpoints within a small radius is what removes them.
 * - **Hough transforms are a dead end here**, recorded there with the measurement: hand-drawn
 *   strokes wander ±5–15px, so each locally straight run votes for a different bin and the
 *   output is dozens of disjoint fragments.
 *
 * The one deliberate divergence: that project emits **segment pairs**, because `.uvtt` walls
 * are pairs. This emits **polylines**, because a stroke drawn as one line has to *wobble* as
 * one line in build order step 6, and because the rest of this pipeline already speaks
 * `Contour`.
 *
 * Pure: no DOM, no SDK.
 */

import type { Vector2 } from "../geometry/vector";
import { maskAt, type BinaryMask } from "./binarize";
import { polylineLength } from "./chop";
import type { Contour } from "./marchingSquares";
import { thin } from "./thin";

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Count of ink neighbours — the pixel's degree in the skeleton graph.
 *
 * A raw 8-neighbour count, not the crossing number. The crossing number is more principled
 * about staircase pixels, but the raw count is what `VTT_Maps` tuned its constants against,
 * and the artifacts it does produce are the adjacent-junction clusters that `weldChains`
 * exists to clean up.
 */
export function degree(mask: BinaryMask, x: number, y: number): number {
  let total = 0;
  for (const [dx, dy] of NEIGHBOURS) total += maskAt(mask, x + dx, y + dy);
  return total;
}

function neighbours(mask: BinaryMask, x: number, y: number): Vector2[] {
  const found: Vector2[] = [];
  for (const [dx, dy] of NEIGHBOURS) {
    if (maskAt(mask, x + dx, y + dy) === 1) found.push({ x: x + dx, y: y + dy });
  }
  return found;
}

/**
 * Remove dead-end branches shorter than `minLength` pixels.
 *
 * Candidates are processed from a work list rather than by rescanning the grid after every
 * removal, which would be O(stubs × pixels). Order does not affect the result: degrees only
 * fall and chains only lengthen, so a branch that fails the test can never later pass it.
 */
export function pruneStubs(mask: BinaryMask, minLength: number): BinaryMask {
  const { width, height } = mask;
  const data = Uint8Array.from(mask.data);
  const working: BinaryMask = { width, height, data };
  if (!(minLength > 0)) return working;

  const pending: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] === 1 && degree(working, x, y) === 1) {
        pending.push(y * width + x);
      }
    }
  }

  while (pending.length > 0) {
    const index = pending.pop()!;
    const x = index % width;
    const y = (index - x) / width;

    // Stale entry: the pixel may have been removed, or gained company, since it was queued.
    if (data[index] !== 1 || degree(working, x, y) !== 1) continue;

    const chain: Vector2[] = [{ x, y }];
    let previous: Vector2 | null = null;
    let current: Vector2 = { x, y };

    for (;;) {
      const next = neighbours(working, current.x, current.y).find(
        (candidate) =>
          !previous ||
          candidate.x !== previous.x ||
          candidate.y !== previous.y,
      );
      if (!next) break;

      chain.push(next);
      if (degree(working, next.x, next.y) !== 2) break;
      previous = current;
      current = next;
    }

    const terminal = chain[chain.length - 1]!;
    if (chain.length < 2 || degree(working, terminal.x, terminal.y) < 3) continue;

    let length = 0;
    for (let i = 1; i < chain.length; i++) {
      length += Math.hypot(
        chain[i]!.x - chain[i - 1]!.x,
        chain[i]!.y - chain[i - 1]!.y,
      );
    }
    if (length >= minLength) continue;

    // Everything but the junction itself, which other branches still need.
    for (let i = 0; i < chain.length - 1; i++) {
      data[chain[i]!.y * width + chain[i]!.x] = 0;
    }
    pending.push(terminal.y * width + terminal.x);
  }

  return working;
}

/**
 * Ink mask to pruned skeleton: thin, prune, and thin again.
 *
 * The second thinning is not belt and braces. Pruning deliberately keeps the junction pixel a
 * branch hung off, because other branches may still need it — but once the branch is gone that
 * pixel is usually a one-pixel bump on an otherwise straight line, and a bump is a degree-3
 * node that splits the line into two strokes for no reason. Thinning removes it.
 *
 * Repeated until the ink stops changing, because pruning can expose a stub that only becomes
 * prunable after the re-thin. It converges in two or three rounds; the cap is a guard, not a
 * working limit.
 */
export function skeletonize(mask: BinaryMask, stubLength: number): BinaryMask {
  let current = thin(mask);
  let ink = countInkPixels(current);

  for (let round = 0; round < 4; round++) {
    const next = thin(pruneStubs(current, stubLength));
    const remaining = countInkPixels(next);
    current = next;
    if (remaining === ink) break;
    ink = remaining;
  }

  return current;
}

function countInkPixels(mask: BinaryMask): number {
  let total = 0;
  for (const value of mask.data) total += value;
  return total;
}

/**
 * Walk the skeleton into polylines.
 *
 * Chains run between *nodes* — pixels whose degree is not 2 — and interior pixels are marked
 * as they are consumed so a chain is not traced again from its far end. Node pixels are never
 * marked, because several chains legitimately share one.
 */
export function traceSkeleton(mask: BinaryMask): Contour[] {
  const { width, height } = mask;
  const visited = new Uint8Array(width * height);
  const contours: Contour[] = [];

  const isVisited = (point: Vector2) => visited[point.y * width + point.x] === 1;
  const markVisited = (point: Vector2) => {
    visited[point.y * width + point.x] = 1;
  };

  const traceEdge = (from: Vector2, into: Vector2): Vector2[] => {
    const path: Vector2[] = [from];
    let previous = from;
    let current = into;

    for (;;) {
      if (degree(mask, current.x, current.y) !== 2 || isVisited(current)) {
        path.push(current);
        break;
      }
      markVisited(current);
      path.push(current);

      const next = neighbours(mask, current.x, current.y).find(
        (candidate) =>
          candidate.x !== previous.x || candidate.y !== previous.y,
      );
      if (!next) break;
      previous = current;
      current = next;
    }

    return path;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask.data[y * width + x] !== 1) continue;
      if (degree(mask, x, y) === 2) continue;

      for (const neighbour of neighbours(mask, x, y)) {
        if (isVisited(neighbour)) continue;

        if (degree(mask, neighbour.x, neighbour.y) !== 2) {
          // Two nodes touching directly. Emitted once, by position, so the pass over the
          // other node does not repeat it.
          if (y < neighbour.y || (y === neighbour.y && x < neighbour.x)) {
            contours.push({
              points: [{ x, y }, neighbour],
              closed: false,
            });
          }
          continue;
        }

        const path = traceEdge({ x, y }, neighbour);
        if (path.length >= 2) contours.push({ points: path, closed: false });
      }
    }
  }

  // Anything left is a loop with no nodes at all — every pixel degree 2.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = { x, y };
      if (mask.data[y * width + x] !== 1 || isVisited(start)) continue;
      // Starting only at degree-2 pixels keeps this pass off chains the first one already
      // emitted: node pixels are deliberately never marked visited, so a two-pixel component
      // would otherwise be emitted twice.
      if (degree(mask, x, y) !== 2) continue;

      const path: Vector2[] = [start];
      markVisited(start);
      let current = start;

      for (;;) {
        const next = neighbours(mask, current.x, current.y).find(
          (candidate) => !isVisited(candidate),
        );
        if (!next) break;
        markVisited(next);
        path.push(next);
        current = next;
      }

      if (path.length >= 2) contours.push({ points: path, closed: true });
    }
  }

  return contours;
}

export interface WeldOptions {
  /** Endpoints within this many pixels are treated as the same node. */
  readonly radius: number;
  /**
   * Also carry strokes *through* junctions of three or more branches, pairing the branches
   * that continue each other most nearly straight. Off by default: it is the one step here
   * with no precedent in `VTT_Maps`, and a crossroads is exactly where a wrong guess joins
   * two strokes that were never one.
   */
  readonly joinThroughJunctions: boolean;
  /** Maximum bend, in degrees, that still counts as one stroke continuing. */
  readonly maxTurnDegrees: number;
}

export const DEFAULT_WELD: WeldOptions = {
  radius: 3,
  joinThroughJunctions: false,
  maxTurnDegrees: 40,
};

/**
 * Weld chain ends that meet, then walk the result back out as long strokes.
 *
 * Two jobs that are really one: endpoints within `radius` collapse to a shared node (killing
 * the adjacent-junction clusters thinning leaves behind), and a node where exactly two chain
 * ends meet is not a junction at all, so the two chains are one stroke and get concatenated.
 * The second is what turns a skeleton full of arbitrary node-to-node splits back into the
 * lines somebody drew.
 */
export function weldChains(
  contours: readonly Contour[],
  options: WeldOptions = DEFAULT_WELD,
): Contour[] {
  const open = contours.filter((contour) => !contour.closed);
  const closed = contours.filter((contour) => contour.closed);
  if (open.length === 0) return [...closed];

  const endPositions: Vector2[] = [];
  for (const contour of open) {
    endPositions.push(contour.points[0]!);
    endPositions.push(contour.points[contour.points.length - 1]!);
  }

  const node = clusterEnds(endPositions, options.radius);

  const points = open.map((contour, edge) => {
    const moved = [...contour.points];
    moved[0] = node.centroid[node.of[edge * 2]!]!;
    moved[moved.length - 1] = node.centroid[node.of[edge * 2 + 1]!]!;
    return moved;
  });

  // Chains that begin and end inside the same welded node are the junction cluster itself,
  // not geometry: thinning leaves several junction pixels a pixel or two apart, and the
  // connectors between them collapse to nothing once the cluster becomes one point. Dropping
  // them is what stops a junction from exploding into a fistful of zero-length strokes — and
  // it has to happen before pairing, or those stubs inflate the node's degree and prevent the
  // real strokes from joining through it.
  const dropped = points.map(
    (chain, edge) =>
      node.of[edge * 2] === node.of[edge * 2 + 1] &&
      polylineLength(chain) <= options.radius,
  );

  const atNode = new Map<number, number[]>();
  points.forEach((_, edge) => {
    if (dropped[edge]) return;
    for (const end of [0, 1] as const) {
      const index = edge * 2 + end;
      const key = node.of[index]!;
      const list = atNode.get(key);
      if (list) list.push(index);
      else atNode.set(key, [index]);
    }
  });

  const partner = pairEnds(atNode, points, options);
  return [...walkChains(points, partner, dropped), ...closed];
}

/** Union endpoints within `radius`, via a hash grid so dense linework stays linear-ish. */
function clusterEnds(
  positions: readonly Vector2[],
  radius: number,
): { of: number[]; centroid: Vector2[] } {
  const parent = positions.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]!]!;
      root = parent[root]!;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  };

  if (radius > 0) {
    const cell = radius;
    const buckets = new Map<string, number[]>();
    const keyOf = (point: Vector2) =>
      `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;

    positions.forEach((point, index) => {
      const key = keyOf(point);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    });

    positions.forEach((point, index) => {
      const cx = Math.floor(point.x / cell);
      const cy = Math.floor(point.y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const other of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (other === index) continue;
            const distance = Math.hypot(
              point.x - positions[other]!.x,
              point.y - positions[other]!.y,
            );
            if (distance < radius) union(index, other);
          }
        }
      }
    });
  }

  const of = positions.map((_, index) => find(index));
  const totals = new Map<number, { x: number; y: number; count: number }>();
  positions.forEach((point, index) => {
    const root = of[index]!;
    const total = totals.get(root) ?? { x: 0, y: 0, count: 0 };
    total.x += point.x;
    total.y += point.y;
    total.count++;
    totals.set(root, total);
  });

  const centroid: Vector2[] = [];
  for (const [root, total] of totals) {
    centroid[root] = { x: total.x / total.count, y: total.y / total.count };
  }

  return { of, centroid };
}

/** Which chain end continues which, keyed by the flat end index (`edge * 2 + end`). */
function pairEnds(
  atNode: ReadonlyMap<number, readonly number[]>,
  points: readonly (readonly Vector2[])[],
  options: WeldOptions,
): Map<number, number> {
  const partner = new Map<number, number>();
  const cosLimit = -Math.cos((options.maxTurnDegrees * Math.PI) / 180);

  for (const ends of atNode.values()) {
    if (ends.length === 2) {
      partner.set(ends[0]!, ends[1]!);
      partner.set(ends[1]!, ends[0]!);
      continue;
    }

    if (!options.joinThroughJunctions || ends.length < 3) continue;

    // Straightest continuation first: two ends continue each other when their outgoing
    // directions are most nearly opposite.
    const candidates: Array<{ a: number; b: number; score: number }> = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i]!;
        const b = ends[j]!;
        const directionA = outgoing(points, a);
        const directionB = outgoing(points, b);
        const score = directionA.x * directionB.x + directionA.y * directionB.y;
        if (score < cosLimit) candidates.push({ a, b, score });
      }
    }

    candidates.sort((left, right) => left.score - right.score);
    for (const candidate of candidates) {
      if (partner.has(candidate.a) || partner.has(candidate.b)) continue;
      partner.set(candidate.a, candidate.b);
      partner.set(candidate.b, candidate.a);
    }
  }

  return partner;
}

/** Unit direction leading away from a chain end, measured a few pixels in. */
function outgoing(
  points: readonly (readonly Vector2[])[],
  endIndex: number,
): Vector2 {
  const edge = endIndex >> 1;
  const chain = points[edge]!;
  const fromStart = (endIndex & 1) === 0;

  const anchor = fromStart ? chain[0]! : chain[chain.length - 1]!;
  const span = Math.min(5, chain.length - 1);
  const target = fromStart ? chain[span]! : chain[chain.length - 1 - span]!;

  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  const length = Math.hypot(dx, dy);
  return length === 0 ? { x: 0, y: 0 } : { x: dx / length, y: dy / length };
}

/** Follow the pairings, concatenating chains into the longest strokes they support. */
function walkChains(
  points: readonly (readonly Vector2[])[],
  partner: ReadonlyMap<number, number>,
  dropped: readonly boolean[],
): Contour[] {
  const used = Uint8Array.from(dropped, (skip) => (skip ? 1 : 0));
  const contours: Contour[] = [];

  const oriented = (edge: number, entryEnd: 0 | 1): Vector2[] => {
    const chain = points[edge]!;
    return entryEnd === 0 ? [...chain] : [...chain].reverse();
  };

  const run = (startEdge: number, startEnd: 0 | 1): Contour => {
    const chain: Vector2[] = [];
    let edge = startEdge;
    let entry: 0 | 1 = startEnd;
    let closed = false;

    for (;;) {
      used[edge] = 1;
      const piece = oriented(edge, entry);
      // The shared node is one point, however many chains meet at it.
      chain.push(...(chain.length === 0 ? piece : piece.slice(1)));

      const exitEnd = (entry === 0 ? 1 : 0) as 0 | 1;
      const next = partner.get(edge * 2 + exitEnd);
      if (next === undefined) break;

      const nextEdge = next >> 1;
      if (used[nextEdge] === 1) {
        // Back where we started: the strokes form a loop.
        if (nextEdge === startEdge && (next & 1) === startEnd) closed = true;
        break;
      }

      edge = nextEdge;
      entry = (next & 1) as 0 | 1;
    }

    if (closed && chain.length > 1) chain.pop();
    return { points: chain, closed };
  };

  // Free ends first, so a stroke is entered at its end rather than in the middle.
  for (let edge = 0; edge < points.length; edge++) {
    for (const end of [0, 1] as const) {
      if (used[edge] === 1) continue;
      if (partner.has(edge * 2 + end)) continue;
      contours.push(run(edge, end));
    }
  }

  for (let edge = 0; edge < points.length; edge++) {
    if (used[edge] === 1) continue;
    contours.push(run(edge, 0));
  }

  return contours.filter((contour) => contour.points.length >= 2);
}
