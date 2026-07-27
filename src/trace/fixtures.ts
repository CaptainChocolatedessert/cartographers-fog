/**
 * Test-only image and field builders.
 *
 * Imported by the trace tests, never by anything that ships — kept out of a `.test.ts` file
 * because importing one test file from another registers its cases twice.
 */

import type { BinaryMask } from "./binarize";
import type { PixelImage, ScalarField } from "./field";

/** Ink mask from ASCII art — `#` is ink, anything else is background. */
export function maskFromRows(rows: readonly string[]): BinaryMask {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new Uint8Array(width * height);

  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = row[x] === "#" ? 1 : 0;
    }
  });

  return { width, height, data };
}

/** The inverse of `maskFromRows`, so a failure prints as a picture. */
export function maskToRows(mask: BinaryMask): string[] {
  const rows: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = "";
    for (let x = 0; x < mask.width; x++) {
      row += mask.data[y * mask.width + x] === 1 ? "#" : ".";
    }
    rows.push(row);
  }
  return rows;
}

/** Build an RGBA image from a greyscale function returning 0..1. Alpha is opaque. */
export function greyImage(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const level = Math.round(255 * clamp01(value(x, y)));
      const p = (y * width + x) * 4;
      data[p] = level;
      data[p + 1] = level;
      data[p + 2] = level;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** A white image with a solid black axis-aligned rectangle in it. */
export function blackRectangleOnWhite(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
): PixelImage {
  return greyImage(width, height, (x, y) =>
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
      ? 0
      : 1,
  );
}

export function field(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
): ScalarField {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = value(x, y);
    }
  }
  return { width, height, data };
}

/** Build a field from rows of numbers, so small cases read as a picture in the test. */
export function fieldFromRows(rows: readonly (readonly number[])[]): ScalarField {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  return field(width, height, (x, y) => rows[y]![x]!);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
