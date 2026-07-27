import { describe, expect, it } from "vitest";
import { countInk, maskAt, type BinaryMask } from "./binarize";
import { maskFromRows, maskToRows } from "./fixtures";
import { thin } from "./thin";

/** A 45° band `width` pixels across, running top-left to bottom-right. */
function diagonalBand(rows: number, columns: number, width: number): BinaryMask {
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < columns; x++) line += x >= y && x < y + width ? "#" : ".";
    lines.push(line);
  }
  return maskFromRows(lines);
}

/** Ink pixels per column, the quick check that a bar really is one pixel thick. */
function columnCounts(mask: BinaryMask): number[] {
  const counts: number[] = [];
  for (let x = 0; x < mask.width; x++) {
    let total = 0;
    for (let y = 0; y < mask.height; y++) total += maskAt(mask, x, y);
    counts.push(total);
  }
  return counts;
}

describe("thin", () => {
  it("reduces a thick bar to a single pixel line", () => {
    const bar = maskFromRows([
      "..............",
      "..##########..",
      "..##########..",
      "..##########..",
      "..##########..",
      "..##########..",
      "..............",
    ]);

    const skeleton = thin(bar);
    const counts = columnCounts(skeleton);

    // No column is thicker than one pixel, and the skeleton is one unbroken run.
    for (const count of counts) expect(count).toBeLessThanOrEqual(1);

    const first = counts.findIndex((count) => count === 1);
    const last = counts.length - 1 - [...counts].reverse().findIndex((c) => c === 1);
    expect(first).toBeGreaterThan(-1);
    for (let x = first; x <= last; x++) expect(counts[x]).toBe(1);

    expect(countInk(skeleton)).toBeLessThan(countInk(bar) / 3);
  });

  it("erodes the ends of a stroke by about half its thickness", () => {
    // Worth pinning because it is a real, permanent property of thinning rather than a
    // tuning artifact: a skeleton is shorter than the ink it came from, by roughly the
    // stroke's half-width at each end. Harmless on walls hundreds of pixels long; it is why
    // very short thick marks can vanish entirely.
    const bar = maskFromRows([
      "..............",
      "..##########..",
      "..##########..",
      "..##########..",
      "..##########..",
      "..##########..",
      "..............",
    ]);

    const counts = columnCounts(thin(bar));
    const inked = counts.filter((count) => count > 0).length;

    expect(inked).toBeLessThan(10);
    expect(inked).toBeGreaterThan(2);
  });

  it("keeps the skeleton connected end to end", () => {
    const bar = maskFromRows([
      "................",
      "..############..",
      "..############..",
      "..############..",
      "................",
    ]);

    const rows = maskToRows(thin(bar)).join("\n");
    expect(rows).toMatch(/#/);

    // One connected run: no column between the first and last inked column is empty.
    const counts = columnCounts(thin(bar));
    const first = counts.findIndex((count) => count > 0);
    const last = counts.length - 1 - [...counts].reverse().findIndex((c) => c > 0);
    for (let x = first; x <= last; x++) expect(counts[x]).toBeGreaterThan(0);
  });

  it("leaves an already-thin line alone", () => {
    const line = maskFromRows([
      "........",
      ".######.",
      "........",
    ]);

    expect(maskToRows(thin(line))).toEqual(maskToRows(line));
  });

  it("is stable — thinning a skeleton again changes nothing", () => {
    const blob = maskFromRows([
      "..........",
      "..######..",
      ".########.",
      ".########.",
      "..######..",
      "..........",
    ]);

    const once = thin(blob);
    expect(maskToRows(thin(once))).toEqual(maskToRows(once));
  });

  it("preserves a two-pixel-wide line rather than erasing it", () => {
    const line = maskFromRows([
      "..........",
      ".########.",
      ".########.",
      "..........",
    ]);

    expect(countInk(thin(line))).toBeGreaterThan(4);
  });

  it("erases an isolated 2×2 block — a known Zhang–Suen behaviour", () => {
    // Documented rather than fixed. All four pixels satisfy the deletion conditions in the
    // same sub-iteration, so the block vanishes; Guo–Hall preserves it. Harmless here, where
    // a 2×2 dot is a speck, but it is the reason not to trust this on tiny features.
    const dot = maskFromRows(["....", ".##.", ".##.", "...."]);
    expect(countInk(thin(dot))).toBe(0);
  });

  it("keeps a single isolated pixel", () => {
    const speck = maskFromRows(["...", ".#.", "..."]);
    expect(countInk(thin(speck))).toBe(1);
  });

  it("does not sever a stroke by deleting both sides at once", () => {
    // The reason the algorithm alternates sub-iterations and marks before deleting: two
    // pixels can each be individually removable while the pair is not. A diagonal band is
    // the case that shows it, because every pixel has neighbours on both flanks.
    const skeleton = thin(diagonalBand(20, 26, 5));

    // A clean one-pixel diagonal running nearly the full height.
    expect(countInk(skeleton)).toBeGreaterThan(15);
    for (let y = 0; y < 20; y++) {
      let inRow = 0;
      for (let x = 0; x < 26; x++) inRow += maskAt(skeleton, x, y);
      expect(inRow).toBeLessThanOrEqual(2);
    }
  });

  it("erodes a two-pixel diagonal away, where a one-pixel one survives", () => {
    // A real limit, and the reason not to trace at a resolution where linework is hairline:
    // a diagonal band two pixels wide measures about 1.4px across, which is thin enough that
    // end erosion consumes the whole stroke before it can stabilise. One-pixel lines are
    // safe because their ends have a single neighbour and are protected outright.
    expect(countInk(thin(diagonalBand(12, 16, 2)))).toBeLessThan(4);
    expect(countInk(thin(diagonalBand(12, 16, 1)))).toBe(12);
  });

  it("copies rather than mutating its input", () => {
    const bar = maskFromRows(["....", ".##.", ".##.", "...."]);
    const before = maskToRows(bar);

    thin(bar);
    expect(maskToRows(bar)).toEqual(before);
  });
});
