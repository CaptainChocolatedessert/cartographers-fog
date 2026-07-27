import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAUVOLA,
  countInk,
  globalBinarize,
  maskAt,
  sauvolaBinarize,
} from "./binarize";
import { field } from "./fixtures";

const TEXTURE_WIDTH = 96;
const TEXTURE_HEIGHT = 24;
const LINE_ROW = 12;

/**
 * A line drawn *across* a light-to-dark background — the parchment problem in its honest
 * form.
 *
 * The line runs the full width, so it is pale where the paper is pale and dark where the
 * paper is dark. That is what defeats a global cutoff: the line's lightest pixel (0.7) is
 * lighter than the background's darkest (0.4), so no single level separates them. A line
 * confined to one column would not show this, because there the background under it never
 * varies.
 */
function inkOnTexture() {
  return field(TEXTURE_WIDTH, TEXTURE_HEIGHT, (x, y) => {
    const background =
      0.9 - (0.5 * x) / TEXTURE_WIDTH + (x % 2 === y % 2 ? 0.03 : 0);
    const onLine = y >= LINE_ROW - 1 && y <= LINE_ROW + 1;
    return onLine ? background - 0.2 : background;
  });
}

describe("globalBinarize", () => {
  it("marks anything darker than the level as ink", () => {
    const mask = globalBinarize(
      field(3, 1, (x) => [0.2, 0.5, 0.8][x]!),
      0.5,
    );

    expect(Array.from(mask.data)).toEqual([1, 0, 0]);
  });
});

describe("sauvolaBinarize", () => {
  it("finds nothing in a uniform field", () => {
    expect(countInk(sauvolaBinarize(field(20, 20, () => 0.5)))).toBe(0);
    expect(countInk(sauvolaBinarize(field(20, 20, () => 0.05)))).toBe(0);
  });

  it("finds a dark line on a light background", () => {
    const mask = sauvolaBinarize(
      field(40, 12, (x) => (x >= 18 && x <= 20 ? 0.15 : 0.9)),
      { radius: 8, k: 0.34 },
    );

    for (let y = 2; y < 10; y++) {
      expect(maskAt(mask, 19, y)).toBe(1);
      expect(maskAt(mask, 5, y)).toBe(0);
      expect(maskAt(mask, 35, y)).toBe(0);
    }
  });

  it("survives a background a global threshold cannot", () => {
    // The reason Sauvola is here at all, stated as a comparison rather than an assertion
    // about Sauvola alone: every global level either misses the pale end of the line or
    // floods the dark end of the paper.
    const textured = inkOnTexture();
    const pixels = TEXTURE_WIDTH * TEXTURE_HEIGHT;

    const alongLine = (mask: ReturnType<typeof sauvolaBinarize>) => {
      let hits = 0;
      for (let x = 0; x < TEXTURE_WIDTH; x++) {
        if (maskAt(mask, x, LINE_ROW) === 1) hits++;
      }
      return hits;
    };

    const sauvola = sauvolaBinarize(textured, { radius: 8, k: 0.2 });
    expect(alongLine(sauvola)).toBeGreaterThan(TEXTURE_WIDTH * 0.9);
    expect(countInk(sauvola)).toBeLessThan(pixels * 0.15);

    for (let level = 0.25; level <= 0.95; level += 0.05) {
      const global = globalBinarize(textured, level);
      const foundTheLine = alongLine(global) > TEXTURE_WIDTH * 0.9;
      const stayedClean = countInk(global) < pixels * 0.15;
      expect(foundTheLine && stayedClean).toBe(false);
    }
  });

  it("keeps ink whose stroke is much thinner than the window", () => {
    const mask = sauvolaBinarize(
      field(60, 60, (x, y) => (x === 30 || y === 30 ? 0.1 : 0.95)),
      { radius: 20, k: 0.34 },
    );

    expect(maskAt(mask, 30, 10)).toBe(1);
    expect(maskAt(mask, 10, 30)).toBe(1);
    expect(maskAt(mask, 10, 10)).toBe(0);
  });

  it("does not produce NaN thresholds on a perfectly flat window", () => {
    // Cancellation in the variance can go fractionally negative, and Math.sqrt of that is
    // NaN — which compares false against everything and silently marks the whole map blank.
    const mask = sauvolaBinarize(field(16, 16, () => 0.3));
    expect(Array.from(mask.data).every((value) => value === 0 || value === 1)).toBe(
      true,
    );
  });

  it("handles an empty field", () => {
    expect(countInk(sauvolaBinarize(field(0, 0, () => 0)))).toBe(0);
  });

  it("defaults to the radius and k from the paper's working range", () => {
    expect(DEFAULT_SAUVOLA.k).toBeGreaterThan(0.2);
    expect(DEFAULT_SAUVOLA.k).toBeLessThan(0.5);
    expect(DEFAULT_SAUVOLA.radius).toBeGreaterThan(1);
  });
});
