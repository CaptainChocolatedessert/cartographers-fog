/**
 * Drawing the sketch as shaders — the alternative to `strokes.ts`, phase 2 of the build plan.
 *
 * Deliberately the same shape as `strokes.ts`: `renderShaderStrokes` / `clearShaderStrokes`, local
 * items on `CONTROL`, `locked`, `disableHit`. What differs is what an item *is*. There, a `Path`
 * hands Owlbear a shape and Owlbear decides the pixels; here an `Effect` carries a world rectangle
 * and a per-pixel program, and the geometry arrives as numeric uniforms. The mark's edge is then
 * ours to shape — which is the whole point, because a `Path` has a hard silhouette and no amount of
 * styling softens it.
 *
 * ## Its own metadata key, and why that matters
 *
 * `SHADER_KEY` is not `strokes.ts`'s `SKETCH_KEY`. Each renderer finds and clears only its own
 * items, so switching between them cannot half-delete the other's output — and `sketch.ts` clears
 * *both* before drawing, since otherwise switching leaves the old sketch on screen underneath the
 * new one and the comparison the switch exists for is impossible to make.
 *
 * ## What phase 0 measured, and what it did not
 *
 * An effect takes at least 256 named slots (517 uniforms) with no ceiling found, padded slots draw
 * nothing, and one 64-slot effect spanning ten grid squares costs no visible frame rate. What was
 * *not* measured is the cost of the hundred-odd effects a whole sketch needs — that is this file
 * being run for the first time. If it is slow, `BATCH_SIZE` is the lever, and DESIGN.md's phase 0
 * notes explain why the answer is likely to be a *smaller* number rather than a larger one.
 */

import OBR, { buildEffect, type Item } from "@owlbear-rodeo/sdk";

import {
  batchBounds,
  batchPieces,
  brushFeatures,
  buildUniforms,
  parseHexColor,
  sdfSource,
  toPieces,
  type SdfStyle,
} from "./sdf";
import { inkWidths, nibWidths } from "./brushWidths";
import {
  BRUSHES,
  type Appearance,
  type BrushId,
  type BrushSettings,
} from "./appearance";
import type { TracedSegment } from "../trace/chop";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const SHADER_KEY = `${NAMESPACE}/sketch-shader`;

/** Same layer as `strokes.ts` — see its note, which is the one that matters. */
const SKETCH_LAYER = "CONTROL" as const;

/**
 * Slots per effect. **Small, and measured — the uniform ceiling is irrelevant here.**
 *
 * Phase 0 proved an effect takes at least 256 slots, and taking it was catastrophic. Measured in a
 * room 2026-08-01:
 *
 * ```
 *  64 slots, ~120 effects   usable; choppy only with the whole map on screen
 * 256 slots,  ~30 effects   unusably choppy at every reasonable zoom
 * ```
 *
 * **Per-pixel cost dominates, and it grows about quadratically with this number.** Every pixel runs
 * the whole unrolled distance chain, so doubling the slots doubles the chain — and it also roughly
 * doubles the area a batch's bounding box covers, because the box grows to hold twice the geometry.
 * Four times the work per batch against half as many batches is about double the total shading per
 * doubling, and the 4× jump from 64 to 256 landed exactly where that predicts.
 *
 * A fixed per-effect cost exists too — it is why zooming in helps at a *constant* slot count, since
 * fewer effects then intersect the viewport — but the 256 result puts it firmly second. Do not
 * optimise for item count.
 *
 * The other half of the cost is **overdraw**: an effect shades its whole rectangle, and traced
 * linework is sparse, so most of every box is empty. Smaller batches shrink the boxes as well as the
 * chain, which is why moving down helps twice over. If 32 is still not enough, tightening the
 * batching so boxes hug their geometry attacks the same term without costing more items.
 */
const BATCH_SIZE = 32;

/**
 * One compiled source per brush, built once and reused.
 *
 * **The source may depend on the brush but on nothing else.** A brush is a different program —
 * charcoal declares grain uniforms and runs noise the liner does not have — so it genuinely needs
 * its own string. What it must never depend on is anything that changes as play proceeds: a source
 * varying per redraw would recompile every effect each time a token moved, which is the failure the
 * whole padded-slot design exists to avoid. Colour, width, feather, grain, geometry and which slots
 * are occupied all travel as uniforms instead.
 *
 * Built eagerly for every brush rather than lazily, so switching brushes costs no string work on a
 * redraw and the set is small and fixed.
 */
const SOURCES: Record<BrushId, string> = Object.fromEntries(
  BRUSHES.map((id) => [id, sdfSource(BATCH_SIZE, id)]),
) as Record<BrushId, string>;

/**
 * Replace the sketch with these segments.
 *
 * Delete-and-replace, matching `strokes.ts`. The plan's phase 5 makes this incremental — keep the
 * batch *set* fixed and vary only which slots are parked, so a token moving rewrites uniforms on a
 * handful of effects instead of rebuilding everything. That would beat the `Path` renderer outright.
 * It is deliberately not done here: correctness and a judgment by eye come first.
 *
 * @param passes one entry per pencil pass, mirroring `renderStrokes`. **Only the first is drawn** —
 * see below.
 * @returns how many items were drawn.
 */
export async function renderShaderStrokes(
  passes: readonly (readonly TracedSegment[])[],
  dpi: number,
  appearance: Appearance,
): Promise<number> {
  // The multi-pass pencil is not carried over, and that is a decision rather than an omission.
  // Passes exist because `PathStyle` is per-item, so the only way to vary a `Path`'s texture was to
  // overlay faint displaced copies — and the user judged the result gestural underdrawing rather
  // than graphite. A shader varies ink *within* one mark, which is the thing passes were a
  // workaround for. Drawing them here would multiply the item count to imitate a technique this
  // renderer supersedes.
  const strokes = passes[0] ?? [];

  const brush = appearance.brush;
  const settings = appearance.brushes[brush];
  const halfWidth = Math.max(0.5, dpi * appearance.strokeWidthSquares) / 2;
  const style: SdfStyle = {
    halfWidth,
    // A fraction of the half-width rather than an absolute distance, so the softness holds its
    // proportion when the stroke width changes. An absolute feather would make a thin line all
    // fade and a thick one look hard-edged, and the two controls would appear to fight.
    feather: halfWidth * settings.featherFraction,
    ink: parseHexColor(appearance.strokeColor),
    // Only for brushes whose source declares the grain uniforms. Supplying them to the liner would
    // be a uniform it never declares; withholding them from charcoal would be one it declares and
    // never receives. Both are silent failures, so the condition matches `sdfSource` exactly.
    ...(brush === "charcoal"
      ? {
          grain: {
            // In grid squares, so paper tooth keeps its scale on a map of any density.
            scale: dpi * settings.grainScaleSquares,
            depth: settings.grainDepth,
            roughness: settings.edgeRoughness,
          },
        }
      : {}),
  };

  // Expanded by the full reach of the ink. An effect cannot draw outside its own rectangle, so
  // bounds fitted to the centrelines would slice the mark flat wherever a piece runs along an edge.
  const margin = style.halfWidth + style.feather;

  const items: Item[] = [];
  for (const batch of batchPieces(
    toPieces(strokes, brushWidthsFor(brush, settings, halfWidth, strokes)),
    BATCH_SIZE,
  )) {
    const bounds = batchBounds(batch, margin);
    items.push(
      buildEffect()
        .width(bounds.max.x - bounds.min.x)
        .height(bounds.max.y - bounds.min.y)
        .position({ x: bounds.min.x, y: bounds.min.y })
        .sksl(SOURCES[brush])
        .uniforms([...buildUniforms(batch, bounds, style, BATCH_SIZE, brush)])
        // `STANDALONE`, with no parent. An *attached* effect is clipped to its parent's fill and
        // never learns where that clip is, so it cannot soften its own edge — which is the one
        // thing this renderer exists to do. Standalone effects respect their own alpha, so the
        // shader paints the mark and returns nothing elsewhere.
        .effectType("STANDALONE")
        .blendMode("SRC_OVER")
        .layer(SKETCH_LAYER)
        .locked(true)
        // Same reasoning as `strokes.ts`: without this, a hundred effects over the map would
        // intercept every click meant for a token.
        .disableHit(true)
        .name("Cartographer's Fog sketch")
        .metadata({ [SHADER_KEY]: true })
        .build(),
    );
  }

  await clearShaderStrokes();
  if (items.length > 0) await OBR.scene.local.addItems(items);

  return items.length;
}

/**
 * Per-point half-widths, or `undefined` for a brush that draws at one thickness.
 *
 * `undefined` rather than an array of the constant width: that is what makes `toPieces` omit the
 * slot's width uniform entirely, so the liner and charcoal keep the shorter shader and the shorter
 * uniform list. Paying for varying width on a brush that does not vary would be a cost in the
 * hottest loop in the project for no visible difference.
 *
 * The bound on `brushFeatures` is deliberate: this must return widths for exactly the brushes whose
 * source declares the uniforms, and reading that from the same predicate the generator uses is what
 * keeps the two from drifting.
 */
function brushWidthsFor(
  brush: BrushId,
  settings: BrushSettings,
  halfWidth: number,
  strokes: readonly TracedSegment[],
): readonly (readonly number[])[] | undefined {
  if (!brushFeatures(brush).varyingWidth) return undefined;

  if (brush === "nib") {
    return nibWidths(strokes, {
      halfWidth,
      angle: (settings.nibAngleDegrees * Math.PI) / 180,
      contrast: settings.nibContrast,
    });
  }

  return inkWidths(strokes, {
    halfWidth,
    taperFraction: settings.taperFraction,
    entryBulge: settings.entryBulge,
    tailWidth: settings.tailWidth,
    pressure: settings.pressure,
    // Fixed, so the same map redraws identically — §6 again. A seed drawn from the clock would make
    // every stroke change thickness on every token move, which is the map breathing by another
    // route.
    seed: INK_SEED,
  });
}

const INK_SEED = 0x5eed0117;

export async function clearShaderStrokes(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => SHADER_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}
