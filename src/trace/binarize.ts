/**
 * Separating ink from background.
 *
 * Centerline tracing starts from a binary mask, and on the maps this project targets — line
 * art printed over fake parchment, cross-hatching, coffee stains — **a global threshold does
 * not work**. Parchment texture and the ink share a luminance range, so any single cutoff
 * either loses pale linework in the light areas or swallows the texture in the dark ones.
 *
 * Sauvola's local threshold is the standard answer, out of document binarisation, where the
 * problem is literally "ink on aged paper":
 *
 *     T(x,y) = mean * (1 + k * (deviation / R - 1))
 *
 * A pixel is ink when it is darker than `T`. In a *flat* neighbourhood the deviation term
 * drives `T` well below the mean, so an evenly textured patch of parchment produces no ink at
 * all; near real linework the deviation is high and `T` rises towards the mean, so the stroke
 * is kept. That asymmetry is the whole point, and it is why this beats a plain local mean.
 *
 * Computed over summed-area tables, so the window statistics cost the same whatever the window
 * size — the radius can be tuned freely without watching the clock.
 *
 * Pure: no DOM, no SDK.
 */

import type { ScalarField } from "./field";

export interface BinaryMask {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, row-major: 1 is ink, 0 is background. */
  readonly data: Uint8Array;
}

export function maskAt(mask: BinaryMask, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
  return mask.data[y * mask.width + x]!;
}

export function countInk(mask: BinaryMask): number {
  let total = 0;
  for (const value of mask.data) total += value;
  return total;
}

export function emptyMask(width: number, height: number): BinaryMask {
  return { width, height, data: new Uint8Array(width * height) };
}

/**
 * Half the field's dynamic range, the `R` term above. Fields here are 0..1, so 0.5 — the
 * equivalent of Sauvola's 128 for 8-bit input.
 */
const DYNAMIC_RANGE = 0.5;

export interface SauvolaOptions {
  /**
   * Window radius in pixels. Wants to be comfortably larger than the linework is thick, so a
   * stroke never fills its own window and become "the background" locally.
   */
  readonly radius: number;
  /**
   * Sensitivity. Higher pulls the threshold further below the local mean, keeping less; the
   * usual working range is 0.2–0.5, and 0.34 is the value Sauvola's paper settles on.
   */
  readonly k: number;
}

export const DEFAULT_SAUVOLA: SauvolaOptions = { radius: 12, k: 0.34 };

/** Ink is darker than the local threshold. */
export function sauvolaBinarize(
  field: ScalarField,
  options: SauvolaOptions = DEFAULT_SAUVOLA,
): BinaryMask {
  const { width, height } = field;
  const mask = new Uint8Array(width * height);
  if (width === 0 || height === 0) return { width, height, data: mask };

  const sum = integral(field, false);
  const squares = integral(field, true);
  const radius = Math.max(1, Math.round(options.radius));
  const stride = width + 1;

  const windowTotal = (
    table: Float64Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) =>
    table[y1 * stride + x1]! -
    table[y0 * stride + x1]! -
    table[y1 * stride + x0]! +
    table[y0 * stride + x0]!;

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);

    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const count = (x1 - x0) * (y1 - y0);

      const total = windowTotal(sum, x0, y0, x1, y1);
      const totalSquares = windowTotal(squares, x0, y0, x1, y1);
      const mean = total / count;
      // Clamped because floating-point cancellation can leave this fractionally negative on a
      // perfectly uniform window, and Math.sqrt of that is NaN — which would silently mark
      // every pixel as background.
      const variance = Math.max(0, totalSquares / count - mean * mean);
      const deviation = Math.sqrt(variance);

      const threshold =
        mean * (1 + options.k * (deviation / DYNAMIC_RANGE - 1));
      mask[y * width + x] = field.data[y * width + x]! < threshold ? 1 : 0;
    }
  }

  return { width, height, data: mask };
}

/**
 * Plain global cutoff — ink is anything darker than `level`.
 *
 * Kept as the comparison case: on clean line art over flat white it is equivalent to Sauvola
 * and much easier to reason about, and having both in the harness is what shows whether a
 * given map actually needs the local threshold.
 */
export function globalBinarize(field: ScalarField, level: number): BinaryMask {
  const { width, height } = field;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = field.data[i]! < level ? 1 : 0;
  }
  return { width, height, data: mask };
}

/** Summed-area table with a zero row and column, so window sums need no bounds tests. */
function integral(field: ScalarField, square: boolean): Float64Array {
  const { width, height } = field;
  const stride = width + 1;
  const table = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowTotal = 0;
    for (let x = 0; x < width; x++) {
      const value = field.data[y * width + x]!;
      rowTotal += square ? value * value : value;
      table[(y + 1) * stride + (x + 1)] = table[y * stride + (x + 1)]! + rowTotal;
    }
  }

  return table;
}
