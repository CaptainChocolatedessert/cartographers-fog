/**
 * Pencil texture — the same stroke drawn several times, faintly, each along a slightly different
 * path.
 *
 * This is how a pencil actually behaves: nobody draws a line once. The repeated passes cross and
 * diverge, darkening where they coincide and fraying where they do not, and that variation is what
 * reads as graphite rather than as ink.
 *
 * ## Why passes rather than varying the width or opacity along one stroke
 *
 * `PathStyle` is per *item* — one `strokeWidth`, one `strokeOpacity` for a whole `Path`, however
 * many subpaths it holds, and no per-command styling exists. Varying either along a stroke
 * therefore means cutting it into pieces and bucketing them by style, which quantises a continuous
 * quantity: the eye finds the steps at every bucket boundary (user, 2026-08-01). Multiple passes
 * sidestep the whole problem — each pass is uniform, so it is legal, and the *variation* comes from
 * where the passes fall relative to each other rather than from any one of them changing.
 *
 * ## Reusing the wobble field, deliberately
 *
 * A pass is just another displacement of the same polyline, so this is `wobbleSegments` again with
 * a smaller amplitude and a different seed. That reuse is not laziness, it inherits three properties
 * that are hard to get right:
 *
 * - **Shared points stay shared.** DESIGN.md's argument for a vector field over a per-normal offset
 *   applies unchanged — displacement depends on position alone, so a `chop.ts` cut that two
 *   segments share still lands in the same place in every pass.
 * - **It is static.** Position-seeded, never time-seeded (§6), so the texture does not crawl.
 * - **It is sampled correctly.** The subdivision step is derived from the wavelength
 *   (`traceSettings.ts`), so the noise is resolved at whatever period the GM chooses. A scatter
 *   field with its own, finer period would need its own finer step or it would alias into white
 *   noise — so the passes share the wobble's period rather than inventing one.
 *
 * ## Every pass is displaced, including the first
 *
 * Leaving one pass on the true path would make it read as *the* line with ghosts around it, which
 * looks like a rendering fault rather than a drawing. Symmetric scatter has no privileged stroke.
 *
 * Pure: no DOM, no SDK.
 */

import { wobbleSegments, type WobbleOptions } from "./wobble";
import type { TracedSegment } from "../trace/chop";

export interface PencilOptions {
  /** How many times each stroke is drawn. One means no texture at all. */
  readonly passes: number;
  /** How far a pass strays from the true path, in world units. Zero means no texture. */
  readonly scatter: number;
  /** Shared with the wobble, so the noise stays correctly sampled — see the module header. */
  readonly wavelength: number;
  readonly step: number;
  readonly seed: number;
}

/**
 * Spreads the per-pass seeds apart.
 *
 * The golden-ratio constant is the usual choice for scattering integers across the word: adjacent
 * passes must land in unrelated parts of the noise field, and `seed ^ passIndex` would leave them
 * differing in one low bit — correlated fields, so the passes would track each other and draw one
 * slightly thick line instead of several thin ones. It also has to avoid colliding with
 * `wobble.ts`'s own y-channel offset, which is derived from the same constant, hence the multiply
 * rather than a bare xor.
 */
const PASS_SEED_STRIDE = 0x9e3779b9;

/**
 * The geometry to draw, one entry per pass.
 *
 * Every entry is index-aligned with `segments`, which the caller depends on: masking runs once
 * against the base segments and then selects the same indices from each pass. Masking each pass
 * separately would let passes appear and disappear independently at the region boundary, and the
 * texture would shimmer as tokens moved.
 *
 * Returns the input as a single pass when there is nothing to do, so the default settings allocate
 * nothing and produce byte-identical output to a build without this feature.
 */
export function pencilPasses(
  segments: readonly TracedSegment[],
  options: PencilOptions,
): readonly (readonly TracedSegment[])[] {
  const passes = Math.max(1, Math.floor(options.passes));
  if (passes === 1 || !(options.scatter > 0)) return [segments];

  const result: (readonly TracedSegment[])[] = [];
  for (let pass = 0; pass < passes; pass++) {
    const wobble: WobbleOptions = {
      amplitude: options.scatter,
      wavelength: options.wavelength,
      step: options.step,
      seed: (options.seed ^ Math.imul(pass + 1, PASS_SEED_STRIDE)) >>> 0,
    };
    result.push(wobbleSegments(segments, wobble));
  }

  return result;
}

/**
 * How opaque the sketch reads once the passes are stacked.
 *
 * Reported rather than used, because it is the number that explains a surprise: three passes at
 * 0.5 do not read as half-strength ink, they read as 0.875. Raising the pass count therefore
 * darkens the sketch unless the per-pass opacity comes down, and the two controls otherwise look
 * like they are fighting each other.
 */
export function effectiveOpacity(passes: number, passOpacity: number): number {
  const count = Math.max(1, Math.floor(passes));
  const alpha = Math.min(1, Math.max(0, passOpacity));
  return 1 - Math.pow(1 - alpha, count);
}
