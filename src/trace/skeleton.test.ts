import { describe, expect, it } from "vitest";
import { countInk } from "./binarize";
import { maskFromRows, maskToRows } from "./fixtures";
import type { Contour } from "./marchingSquares";
import {
  DEFAULT_WELD,
  degree,
  pruneStubs,
  skeletonize,
  traceSkeleton,
  weldChains,
} from "./skeleton";

function longest(contours: readonly Contour[]): Contour {
  return contours.reduce((best, contour) =>
    contour.points.length > best.points.length ? contour : best,
  );
}

describe("degree", () => {
  it("counts ink neighbours in all eight directions, diagonals included", () => {
    const cross = maskFromRows([".#.", "###", ".#."]);

    expect(degree(cross, 1, 1)).toBe(4);
    // Three, not one: the arm pixel is diagonally adjacent to both ends of the bar. Every
    // pixel beside a junction is itself high-degree, which is why junctions arrive as
    // clusters and `weldChains` has to exist.
    expect(degree(cross, 1, 0)).toBe(3);
  });

  it("counts nothing around an isolated pixel", () => {
    expect(degree(maskFromRows(["...", ".#.", "..."]), 1, 1)).toBe(0);
  });
});

describe("pruneStubs", () => {
  it("removes a short dead end, down to the pixel the junction needs", () => {
    // The branch goes, but the pixel it hung from stays: other branches still connect
    // through it, so pruning cannot know it is now redundant. `skeletonize` re-thins
    // afterwards, which is what finally removes the bump.
    const spur = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    expect(maskToRows(pruneStubs(spur, 4))).toEqual([
      "...............",
      "...............",
      ".......#.......",
      "###############",
    ]);
  });

  it("keeps a branch longer than the threshold", () => {
    const branch = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    expect(countInk(pruneStubs(branch, 2))).toBe(countInk(branch));
  });

  it("leaves a short line that ends in free space", () => {
    // The distinction that matters: a stub off a junction is a thinning artifact, a short
    // free-standing line is a short stroke somebody drew.
    const short = maskFromRows(["......", ".###..", "......"]);
    expect(countInk(pruneStubs(short, 20))).toBe(3);
  });

  it("iterates — removing one stub exposes the chain behind it", () => {
    // A forked branch. Neither fork is prunable as far as the line on its own: each ends at
    // the fork, not at the line. Once the first goes, the fork becomes an ordinary
    // pass-through pixel and the second fork's chain runs all the way down to the line and
    // qualifies. A single pass leaves the stem dangling.
    const forked = maskFromRows([
      "......#...#....",
      ".......#.#.....",
      "........#......",
      "........#......",
      "###############",
    ]);

    expect(maskToRows(pruneStubs(forked, 4))).toEqual([
      "...............",
      "...............",
      "...............",
      "........#......",
      "###############",
    ]);
  });

  it("does not eat the line it is pruning from", () => {
    // The rule cuts both ways: a line end near a junction is itself a short chain
    // terminating at a junction. The threshold has to stay well under real feature length —
    // `VTT_Maps` keys it to a fifth of a grid square for exactly this reason.
    const branch = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    const pruned = pruneStubs(branch, 4);
    expect(maskToRows(pruned)[3]).toBe("###############");
  });

  it("does nothing when the threshold is zero", () => {
    const spur = maskFromRows(["..#....", "#######"]);
    expect(countInk(pruneStubs(spur, 0))).toBe(countInk(spur));
  });

  it("copies rather than mutating its input", () => {
    const spur = maskFromRows(["..#....", "#######"]);
    const before = maskToRows(spur);

    pruneStubs(spur, 5);
    expect(maskToRows(spur)).toEqual(before);
  });
});

describe("skeletonize", () => {
  it("removes a spur completely, bump included", () => {
    // What `pruneStubs` alone cannot do: the re-thin takes the leftover attachment pixel,
    // so the line comes back straight instead of carrying a degree-3 node that would split
    // it into two strokes.
    const spur = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    expect(maskToRows(skeletonize(spur, 4))).toEqual([
      "...............",
      "...............",
      "...............",
      "###############",
    ]);
  });

  it("leaves a clean skeleton alone", () => {
    const line = maskFromRows(["..........", ".########.", ".........."]);
    expect(maskToRows(skeletonize(line, 5))).toEqual(maskToRows(line));
  });

  it("thins as well as prunes", () => {
    const bar = maskFromRows([
      "..........",
      ".########.",
      ".########.",
      ".########.",
      "..........",
    ]);

    expect(countInk(skeletonize(bar, 2))).toBeLessThan(countInk(bar) / 2);
  });
});

describe("traceSkeleton", () => {
  it("returns one polyline for one line, not a loop around it", () => {
    // The whole point of centerline tracing: a drawn stroke comes back as a stroke.
    const line = maskFromRows(["..........", ".########.", ".........."]);
    const contours = traceSkeleton(line);

    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(false);
    expect(contours[0]!.points).toHaveLength(8);
    for (const point of contours[0]!.points) expect(point.y).toBe(1);
  });

  it("follows a diagonal through its eight-connected neighbours", () => {
    const diagonal = maskFromRows([
      "#....",
      ".#...",
      "..#..",
      "...#.",
      "....#",
    ]);

    const contours = traceSkeleton(diagonal);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.points).toHaveLength(5);
  });

  it("fragments a junction into more chains than there are branches", () => {
    // Documenting the raw behaviour, because it is the thing `weldChains` cleans up. A tee
    // has three branches but every pixel beside the junction is itself degree 3+, so the
    // walk emits a cluster of node-to-node stubs around it.
    const tee = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    expect(traceSkeleton(tee).length).toBeGreaterThan(3);
  });

  it("emits a two-pixel component once, not twice", () => {
    // Both pixels are nodes, so neither is marked visited by the chain pass; the loop pass
    // has to know not to pick it up again.
    const pair = maskFromRows(["....", ".##.", "...."]);
    expect(traceSkeleton(pair)).toHaveLength(1);
  });

  it("ignores an isolated pixel", () => {
    expect(traceSkeleton(maskFromRows(["...", ".#.", "..."]))).toEqual([]);
  });

  it("keeps separate strokes separate", () => {
    const two = maskFromRows([
      ".####.",
      "......",
      ".####.",
    ]);

    expect(traceSkeleton(two)).toHaveLength(2);
  });
});

describe("weldChains", () => {
  const chain = (points: Array<[number, number]>): Contour => ({
    points: points.map(([x, y]) => ({ x, y })),
    closed: false,
  });

  it("joins two chains that meet at a shared end into one stroke", () => {
    const welded = weldChains(
      [
        chain([
          [0, 0],
          [5, 0],
          [10, 0],
        ]),
        chain([
          [10, 0],
          [15, 0],
          [20, 0],
        ]),
      ],
      DEFAULT_WELD,
    );

    expect(welded).toHaveLength(1);
    expect(welded[0]!.points[0]).toEqual({ x: 0, y: 0 });
    expect(welded[0]!.points[welded[0]!.points.length - 1]).toEqual({
      x: 20,
      y: 0,
    });
    // The shared point appears once.
    expect(welded[0]!.points).toHaveLength(5);
  });

  it("welds ends that are merely close, not identical", () => {
    // Thinning leaves junction pixels a pixel or two apart; this is what removes the
    // sub-pixel connectors between them.
    const welded = weldChains(
      [
        chain([
          [0, 0],
          [10, 0],
        ]),
        chain([
          [11, 1],
          [20, 0],
        ]),
      ],
      { ...DEFAULT_WELD, radius: 3 },
    );

    expect(welded).toHaveLength(1);
  });

  it("leaves ends further apart than the radius alone", () => {
    const welded = weldChains(
      [
        chain([
          [0, 0],
          [10, 0],
        ]),
        chain([
          [30, 0],
          [40, 0],
        ]),
      ],
      { ...DEFAULT_WELD, radius: 3 },
    );

    expect(welded).toHaveLength(2);
  });

  it("does not join three branches at a junction by default", () => {
    const welded = weldChains(
      [
        chain([
          [0, 0],
          [10, 0],
        ]),
        chain([
          [10, 0],
          [20, 0],
        ]),
        chain([
          [10, 0],
          [10, 10],
        ]),
      ],
      DEFAULT_WELD,
    );

    expect(welded).toHaveLength(3);
  });

  it("carries the straightest pair through a junction when asked", () => {
    const welded = weldChains(
      [
        chain([
          [0, 0],
          [10, 0],
        ]),
        chain([
          [10, 0],
          [20, 0],
        ]),
        chain([
          [10, 0],
          [10, 10],
        ]),
      ],
      { ...DEFAULT_WELD, joinThroughJunctions: true },
    );

    expect(welded).toHaveLength(2);
    const through = longest(welded);
    expect(through.points[0]).toEqual({ x: 0, y: 0 });
    expect(through.points[through.points.length - 1]).toEqual({ x: 20, y: 0 });
  });

  it("refuses a join that would bend more than the limit", () => {
    const welded = weldChains(
      [
        chain([
          [0, 0],
          [10, 0],
        ]),
        chain([
          [10, 0],
          [10, 10],
        ]),
        chain([
          [10, 0],
          [20, 10],
        ]),
      ],
      {
        ...DEFAULT_WELD,
        joinThroughJunctions: true,
        maxTurnDegrees: 10,
      },
    );

    expect(welded).toHaveLength(3);
  });

  it("closes a stroke that returns to where it started", () => {
    const welded = weldChains(
      [
        chain([
          [0, 0],
          [10, 0],
        ]),
        chain([
          [10, 0],
          [10, 10],
        ]),
        chain([
          [10, 10],
          [0, 0],
        ]),
      ],
      DEFAULT_WELD,
    );

    expect(welded).toHaveLength(1);
    expect(welded[0]!.closed).toBe(true);
    expect(welded[0]!.points).toHaveLength(3);
  });

  it("passes closed contours through untouched", () => {
    const ring: Contour = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: true,
    };

    expect(weldChains([ring], DEFAULT_WELD)).toEqual([ring]);
  });

  it("reduces a traced tee to one chain per branch", () => {
    // The counterpart to the fragmentation test above: the junction cluster's stubs are
    // dropped, and what is left is the three branches somebody drew.
    const tee = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    const traced = traceSkeleton(tee);
    const welded = weldChains(traced, DEFAULT_WELD);

    expect(traced.length).toBeGreaterThan(3);
    expect(welded).toHaveLength(3);
  });

  it("carries the crossbar through when joining is on", () => {
    const tee = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    const welded = weldChains(traceSkeleton(tee), {
      ...DEFAULT_WELD,
      joinThroughJunctions: true,
    });

    expect(welded).toHaveLength(2);
    expect(longest(welded).points.length).toBeGreaterThanOrEqual(7);
  });

  it("welds a traced ring back into one closed stroke", () => {
    const ring = maskFromRows([
      "..........",
      "...####...",
      "..#....#..",
      "..#....#..",
      "..#....#..",
      "...####...",
      "..........",
    ]);

    const welded = weldChains(traceSkeleton(ring), DEFAULT_WELD);

    expect(welded).toHaveLength(1);
    expect(welded[0]!.closed).toBe(true);
  });

  it("drops the zero-length connectors inside a welded junction", () => {
    // Thinning leaves several junction pixels a pixel apart. Once they collapse to one
    // point the chains between them have nowhere to go, and leaving them in would both
    // clutter the output and inflate the junction's degree enough to block real joins.
    const tee = maskFromRows([
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      ".......#.......",
      "###############",
    ]);

    for (const contour of weldChains(traceSkeleton(tee), DEFAULT_WELD)) {
      const first = contour.points[0]!;
      const last = contour.points[contour.points.length - 1]!;
      expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(1);
    }
  });
});
