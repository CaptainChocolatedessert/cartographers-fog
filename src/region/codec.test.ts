import { describe, expect, it } from "vitest";
import { decodeRegion, encodeRegion } from "./codec";
import { SUBDIVISIONS, createCellGrid, sameGrid, type Bounds } from "./cellGrid";
import {
  countSet,
  createMask,
  isSet,
  rasterizePolygon,
  setCell,
} from "./regionMask";
import type { Vector2 } from "../geometry/vector";

// Non-square on purpose — see the note in regionMask.test.ts.
const BOUNDS: Bounds = { min: { x: 0, y: 0 }, max: { x: 1000, y: 600 } };

/** Keeps cells exactly 50 world units — a 20x12 grid — whatever SUBDIVISIONS is set to. */
const DPI = 50 * SUBDIVISIONS;

/**
 * `minCellSize` pins the cell at 50 units against `MIN_CELLS_PER_AXIS`, which would otherwise
 * refine this fixture to a 200-cell axis. These suites test mask arithmetic, not grid sizing.
 */
function grid() {
  return createCellGrid(BOUNDS, DPI, { minCellSize: 50 });
}

function rect(x0: number, y0: number, x1: number, y1: number): Vector2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

describe("round trip", () => {
  it("preserves an empty region", () => {
    const decoded = decodeRegion(encodeRegion(createMask(grid())));

    expect(decoded).not.toBeNull();
    expect(countSet(decoded!)).toBe(0);
  });

  it("preserves a single cell", () => {
    const mask = createMask(grid());
    setCell(mask, 7, 11);

    const decoded = decodeRegion(encodeRegion(mask))!;
    expect(isSet(decoded, 7, 11)).toBe(true);
    expect(countSet(decoded)).toBe(1);
  });

  it("preserves a cell in the very first and very last position", () => {
    const mask = createMask(grid());
    setCell(mask, 0, 0);
    setCell(mask, mask.grid.columns - 1, mask.grid.rows - 1);

    const decoded = decodeRegion(encodeRegion(mask))!;
    expect(isSet(decoded, 0, 0)).toBe(true);
    expect(isSet(decoded, mask.grid.columns - 1, mask.grid.rows - 1)).toBe(true);
    expect(countSet(decoded)).toBe(2);
  });

  it("preserves a fully set region", () => {
    const mask = createMask(grid());
    mask.cells.fill(1);

    const decoded = decodeRegion(encodeRegion(mask))!;
    expect(countSet(decoded)).toBe(mask.cells.length);
  });

  it("preserves an irregular region exactly, cell for cell", () => {
    const mask = createMask(grid());
    rasterizePolygon(mask, rect(100, 100, 400, 350));
    rasterizePolygon(mask, rect(600, 400, 900, 550));
    setCell(mask, 0, 11);

    const decoded = decodeRegion(encodeRegion(mask))!;
    expect(decoded.cells).toEqual(mask.cells);
  });

  it("preserves the grid, so a mismatch can be detected later", () => {
    const mask = createMask(grid());
    const decoded = decodeRegion(encodeRegion(mask))!;

    expect(sameGrid(decoded.grid, mask.grid)).toBe(true);
  });

  it("preserves a non-integer origin and cell size", () => {
    const odd = createCellGrid(
      { min: { x: -12.5, y: 33.25 }, max: { x: 287.5, y: 233.25 } },
      75,
    );
    const mask = createMask(odd);
    setCell(mask, 2, 3);

    const decoded = decodeRegion(encodeRegion(mask))!;
    expect(sameGrid(decoded.grid, odd)).toBe(true);
    expect(isSet(decoded, 2, 3)).toBe(true);
  });
});

describe("rejecting bad input", () => {
  it("rejects non-strings", () => {
    expect(decodeRegion(undefined)).toBeNull();
    expect(decodeRegion(null)).toBeNull();
    expect(decodeRegion(42)).toBeNull();
    expect(decodeRegion({})).toBeNull();
  });

  it("rejects malformed text", () => {
    expect(decodeRegion("")).toBeNull();
    expect(decodeRegion("nonsense")).toBeNull();
    expect(decodeRegion("v1|20|20")).toBeNull();
  });

  it("rejects an unknown version rather than guessing", () => {
    const encoded = encodeRegion(createMask(grid()));
    expect(decodeRegion(encoded.replace("v1|", "v2|"))).toBeNull();
  });

  it("rejects nonsensical grid dimensions", () => {
    const encoded = encodeRegion(createMask(grid()));
    const parts = encoded.split("|");

    expect(decodeRegion(["v1", "0", ...parts.slice(2)].join("|"))).toBeNull();
    expect(decodeRegion(["v1", "-5", ...parts.slice(2)].join("|"))).toBeNull();
    expect(decodeRegion(["v1", "abc", ...parts.slice(2)].join("|"))).toBeNull();
  });

  it("rejects a payload whose run lengths do not fill the grid", () => {
    const mask = createMask(grid());
    const parts = encodeRegion(mask).split("|");
    // Same payload, but claim a larger grid than the runs account for.
    parts[2] = String(Number(parts[2]) + 1);

    expect(decodeRegion(parts.join("|"))).toBeNull();
  });

  it("rejects corrupt base64 without throwing", () => {
    const parts = encodeRegion(createMask(grid())).split("|");
    parts[6] = "!!!not base64!!!";

    expect(() => decodeRegion(parts.join("|"))).not.toThrow();
    expect(decodeRegion(parts.join("|"))).toBeNull();
  });
});

describe("size against the 16KB scene metadata cap", () => {
  const CAP = 16 * 1024;

  it("keeps a realistic explored region far under the cap", () => {
    // A 200x200 cell grid — a large map at half-grid-square resolution.
    const large = createCellGrid(
      { min: { x: 0, y: 0 }, max: { x: 10_000, y: 10_000 } },
      50 * SUBDIVISIONS,
    );
    const mask = createMask(large);

    // Explore a rambling set of rooms and corridors.
    rasterizePolygon(mask, rect(500, 500, 3000, 2500));
    rasterizePolygon(mask, rect(3000, 1200, 6000, 1800));
    rasterizePolygon(mask, rect(6000, 500, 8500, 4000));
    rasterizePolygon(mask, rect(1000, 4000, 2000, 9000));

    const encoded = encodeRegion(mask);
    expect(encoded.length).toBeLessThan(CAP / 4);
    expect(decodeRegion(encoded)!.cells).toEqual(mask.cells);
  });

  it("stays under the cap even in the pathological worst case", () => {
    // Alternating cells defeat run-length encoding entirely — the worst input possible.
    const large = createCellGrid(
      { min: { x: 0, y: 0 }, max: { x: 10_000, y: 10_000 } },
      50 * SUBDIVISIONS,
    );
    const mask = createMask(large);
    for (let i = 0; i < mask.cells.length; i += 2) mask.cells[i] = 1;

    // Recorded rather than asserted as acceptable: this is the number that would force
    // bit-packing or a smaller MAX_CELLS if a real region ever approached it.
    const encoded = encodeRegion(mask);
    expect(encoded.length).toBeGreaterThan(CAP);
    expect(decodeRegion(encoded)!.cells).toEqual(mask.cells);
  });
});
