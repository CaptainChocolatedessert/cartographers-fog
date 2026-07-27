import { describe, expect, it } from "vitest";
import type { TracedSegment } from "./chop";
import {
  ITEM_COMMAND_LIMIT,
  SAFE_COMMAND_BUDGET,
  chunkSegments,
  commandCount,
} from "./strokeChunks";

function segment(points: number, id = 0): TracedSegment {
  return {
    points: Array.from({ length: points }, (_, i) => ({ x: id, y: i })),
    midpoint: { x: id, y: points / 2 },
    length: points,
  };
}

describe("commandCount", () => {
  it("counts a MOVE plus a LINE per remaining point", () => {
    expect(commandCount(segment(2))).toBe(2);
    expect(commandCount(segment(7))).toBe(7);
  });
});

describe("chunkSegments", () => {
  it("returns nothing for no segments", () => {
    expect(chunkSegments([])).toEqual([]);
  });

  it("keeps a small trace in one item", () => {
    expect(chunkSegments([segment(3), segment(4)])).toHaveLength(1);
  });

  it("never exceeds the budget, whatever the segment sizes", () => {
    const segments = Array.from({ length: 5_000 }, (_, i) =>
      segment(2 + (i % 9), i),
    );

    for (const chunk of chunkSegments(segments)) {
      const commands = chunk.reduce(
        (sum, piece) => sum + commandCount(piece),
        0,
      );
      expect(commands).toBeLessThanOrEqual(SAFE_COMMAND_BUDGET);
    }
  });

  it("packs by command count, not by segment count", () => {
    // Ten points each, so a hundred segments is a thousand commands.
    const chunks = chunkSegments(
      Array.from({ length: 100 }, (_, i) => segment(10, i)),
      100,
    );

    expect(chunks).toHaveLength(10);
    for (const chunk of chunks) expect(chunk).toHaveLength(10);
  });

  it("preserves every segment, in order", () => {
    const segments = Array.from({ length: 250 }, (_, i) => segment(5, i));
    const flattened = chunkSegments(segments, 37).flat();

    expect(flattened).toEqual(segments);
  });

  it("gives an over-budget segment its own item rather than dropping it", () => {
    const chunks = chunkSegments([segment(3), segment(500), segment(3)], 100);

    expect(chunks).toHaveLength(3);
    expect(chunks[1]![0]!.points).toHaveLength(500);
  });

  it("leaves headroom below the measured hard limit", () => {
    expect(SAFE_COMMAND_BUDGET).toBeLessThan(ITEM_COMMAND_LIMIT);
  });
});
