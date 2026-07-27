import { describe, expect, it } from "vitest";
import {
  COMMANDS_PER_RUN,
  ITEM_COMMAND_LIMIT,
  SAFE_COMMAND_BUDGET,
  chunkRuns,
  maxRunsPerItem,
} from "./pathChunks";
import type { Bounds } from "./cellGrid";

function runs(count: number): Bounds[] {
  return Array.from({ length: count }, (_, i) => ({
    min: { x: i, y: 0 },
    max: { x: i + 1, y: 1 },
  }));
}

describe("maxRunsPerItem", () => {
  it("stays within the measured item limit once expanded to commands", () => {
    expect(maxRunsPerItem() * COMMANDS_PER_RUN).toBeLessThanOrEqual(ITEM_COMMAND_LIMIT);
  });

  it("leaves headroom below the hard limit", () => {
    expect(SAFE_COMMAND_BUDGET).toBeLessThan(ITEM_COMMAND_LIMIT);
  });

  it("never returns zero, however small the budget", () => {
    expect(maxRunsPerItem(0)).toBe(1);
    expect(maxRunsPerItem(1)).toBe(1);
  });
});

describe("chunkRuns", () => {
  it("returns nothing for no runs, rather than an empty batch", () => {
    expect(chunkRuns([])).toEqual([]);
  });

  it("keeps a small region in a single batch", () => {
    const chunks = chunkRuns(runs(10));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(10);
  });

  it("splits a region that exceeds one item", () => {
    const perItem = maxRunsPerItem();
    const chunks = chunkRuns(runs(perItem * 2 + 3));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(perItem);
    expect(chunks[1]).toHaveLength(perItem);
    expect(chunks[2]).toHaveLength(3);
  });

  it("preserves every run, in order", () => {
    const source = runs(25);
    const flattened = chunkRuns(source, 7).flat();

    expect(flattened).toHaveLength(25);
    expect(flattened).toEqual(source);
  });

  it("never emits a batch that would exceed the command budget", () => {
    for (const count of [1, 100, 1_600, 5_000, 20_000]) {
      for (const chunk of chunkRuns(runs(count))) {
        expect(chunk.length * COMMANDS_PER_RUN).toBeLessThanOrEqual(SAFE_COMMAND_BUDGET);
      }
    }
  });

  it("handles a realistic fragmented region needing several items", () => {
    // ~1,800 runs is what a fragmented region measures at current cell resolution.
    const chunks = chunkRuns(runs(1_800));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(1_800);
  });
});
