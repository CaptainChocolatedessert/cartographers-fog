/**
 * Turning map pixels into the scalar field that gets contoured.
 *
 * DESIGN.md §2 specifies Sobel, and `sobelMagnitude` is that. But a map's *luminance* is
 * also directly contourable and is the better field for the common case (dark linework on a
 * lighter floor), so both are here and the choice is a pipeline option. The difference is
 * real, not cosmetic:
 *
 * - **Luminance** contours the boundary between dark and light. One threshold, and the
 *   contour lands exactly on the visible edge of a stroke. It assumes a polarity — features
 *   darker than their surroundings — and a map with pale walls on a dark floor inverts it.
 * - **Sobel** contours the *gradient ridge*, so it is polarity-agnostic and finds an edge
 *   whichever way the contrast runs. The cost is that a ridge has two flanks, so a single
 *   painted line yields a contour down each side of it.
 *
 * Neither is "the right one" — that is a judgment about how the sketch looks, which is why
 * the harness exposes both rather than this file picking.
 *
 * There is deliberately no `invert`. Contouring a field and contouring its inverse produce the
 * *same curves* — inversion only maps level `L` to `1 - L` — so a polarity switch would be a
 * second control for something the level already does, and at the usual level of 0.5 it would
 * do nothing at all.
 *
 * Pure: no DOM, no SDK. `PixelImage` is structural so tests can hand it a plain object, and
 * so `ImageData` satisfies it without an import.
 */

/** The layout `CanvasRenderingContext2D.getImageData()` returns: RGBA, row-major. */
export interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array | readonly number[];
}

export interface ScalarField {
  readonly width: number;
  readonly height: number;
  /** Row-major, `width * height` entries. Nominally 0..1, though blur/Sobel may not clamp. */
  readonly data: Float32Array;
}

export function fieldAt(field: ScalarField, x: number, y: number): number {
  return field.data[y * field.width + x]!;
}

/**
 * Rec. 709 luminance, 0 (black) to 1 (white).
 *
 * Transparent pixels are composited over **white**, so a map with a transparent margin reads
 * as background rather than as a solid black feature with a hard rectangular edge around it.
 * That is the right default for maps; it would be wrong for a token cut out on alpha, where
 * the alpha edge *is* the outline.
 */
export function luminanceField(image: PixelImage): ScalarField {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p]! / 255;
    const g = data[p + 1]! / 255;
    const b = data[p + 2]! / 255;
    const a = data[p + 3]! / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i] = a * luma + (1 - a) * 1;
  }

  return { width, height, data: out };
}

/**
 * Separable Gaussian blur, edges clamped.
 *
 * This is not optional polish. Sobel on an unblurred JPEG finds every compression artifact and
 * every speck of floor texture, and the contour tracer faithfully turns each into its own tiny
 * closed loop. Blur is the main control over how much of a map becomes linework.
 *
 * `sigma <= 0` returns a copy, so callers can treat "no blur" as a normal setting.
 */
export function blur(field: ScalarField, sigma: number): ScalarField {
  if (!(sigma > 0)) {
    return { ...field, data: Float32Array.from(field.data) };
  }

  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = gaussianKernel(sigma, radius);
  const { width, height } = field;

  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = clamp(x + k, 0, width - 1);
        sum += field.data[row + sx]! * kernel[k + radius]!;
      }
      horizontal[row + x] = sum;
    }
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = clamp(y + k, 0, height - 1);
        sum += horizontal[sy * width + x]! * kernel[k + radius]!;
      }
      out[y * width + x] = sum;
    }
  }

  return { width, height, data: out };
}

function gaussianKernel(sigma: number, radius: number): Float32Array {
  const kernel = new Float32Array(radius * 2 + 1);
  const denominator = 2 * sigma * sigma;
  let total = 0;
  for (let k = -radius; k <= radius; k++) {
    const weight = Math.exp(-(k * k) / denominator);
    kernel[k + radius] = weight;
    total += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= total;
  return kernel;
}

/**
 * 3×3 Sobel gradient magnitude, scaled so that an ideal full-contrast step edge reads ~1.0.
 *
 * The scale matters because the threshold is a user-facing knob: without it the useful range
 * would depend on the operator's kernel weights, which is not something anyone tuning a map
 * should have to know. Sampling clamps at the border, so the frame of the image is not itself
 * an edge.
 */
export function sobelMagnitude(field: ScalarField): ScalarField {
  const { width, height } = field;
  const out = new Float32Array(width * height);

  const sample = (x: number, y: number) =>
    field.data[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)]!;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = sample(x - 1, y - 1);
      const tc = sample(x, y - 1);
      const tr = sample(x + 1, y - 1);
      const ml = sample(x - 1, y);
      const mr = sample(x + 1, y);
      const bl = sample(x - 1, y + 1);
      const bc = sample(x, y + 1);
      const br = sample(x + 1, y + 1);

      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);

      // |gx| and |gy| each reach 4 for a unit step, so 4 normalises a clean edge to ~1.
      out[y * width + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  }

  return { width, height, data: out };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
