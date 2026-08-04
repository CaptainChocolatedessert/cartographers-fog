/**
 * Drawing the parchment overlay — the SDK half of `parchment.ts`.
 *
 * Two items: an invisible stencil and the shader that fills it.
 *
 * The stencil is a `Path` covering the scene's extent with every visible polygon punched out as a
 * hole, at `fillOpacity: 0`. The shader is an **`ATTACHMENT`** effect bound to it, which is what
 * confines the mottle to the stencil's shape — probe cells G and H established that an attached
 * effect is clipped to its parent's fill, and that the fill need not be visible for the clip to
 * work.
 *
 * **`fillOpacity: 0`, never `visible: false`.** Attachment behaviours include `VISIBLE`, so hiding
 * the parent would very likely take the effect with it. An invisible *fill* on a visible item is
 * the distinction that makes this work, and it is easy to tidy into a bug.
 *
 * Local items, like everything else this extension draws: every client derives its own overlay from
 * shared state rather than receiving geometry over the network (DESIGN.md §5).
 */

import OBR, {
  Command,
  buildEffect,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import {
  PARCHMENT_SKSL,
  parchmentUniforms,
  stencilRings,
  type ParchmentStyle,
} from "./parchment";
import { parseHexColor } from "../sketch/sdf";
import type { ParchmentSettings } from "../sketch/appearance";
import type { Bounds } from "./cellGrid";
import type { Vector2 } from "../geometry/vector";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const PARCHMENT_KEY = `${NAMESPACE}/parchment`;

/** Same layer as the sketch, ordered by z-index rather than by layer — see `PARCHMENT_Z`. */
const PARCHMENT_LAYER = "POINTER" as const;

/**
 * Below the sketch, and below anything anyone else puts on this layer.
 *
 * Auto z-index would decide the first of those from creation order, which is not something either
 * renderer controls — they are separate `addItems` calls made in whatever order a redraw happens
 * to make them. Parchment underneath ink is not a preference, it is the entire point, so it is
 * pinned. `SKETCH_Z` in `strokes.ts` and `shaderStrokes.ts` is the other half of the pair.
 *
 * **Deeply negative rather than zero, since 2026-08-04.** This layer is shared now: it is where
 * Outliner draws, and where this extension's own "bring above the fog" puts a GM's annotations.
 * Owlbear hands out *increasing positive* z-indexes to new items, so zero was only incidentally
 * below them — one item created with a lower number and the parchment would cover an annotation
 * that was raised specifically to be readable. A number nothing plausibly counts down to makes
 * "underneath everything" a property of the value rather than a coincidence of the order things
 * were made in.
 */
export const PARCHMENT_Z = -100000;

/**
 * Simplification tolerance for the cut-out holes, as a fraction of a grid square.
 *
 * A hundredth of a square is 1.5 world units on the shipped 150-unit grid — comfortably sub-pixel
 * at any zoom a table plays at, while removing the overwhelming majority of the ~2,750 vertices a
 * visibility polygon carries. `stencilRings` raises it if the command budget still demands it.
 */
const HOLE_TOLERANCE_SQUARES = 0.01;

/**
 * Kept, switched off, like the retired probes. Set it `true` to re-run the ladder below.
 *
 * ## What three rounds established, 2026-08-02
 *
 * The overlay first rendered solid black over the whole map. Three candidates explained that
 * equally well — the stencil's fill drawing despite `fillOpacity: 0`, the shader failing, or the
 * effect's rectangle being too large — and the symptom alone could not rank them.
 *
 * **Round one** drew a matched pair differing only in size, both running a constant shader with no
 * uniforms. The extent painted magenta, which cleared the stencil's fill, alpha, the clip and size
 * all at once.
 *
 * **Round two was the wrong shape of test.** It split the real shader into thirds across the map,
 * expecting to see which ingredient failed — but a shader that fails to compile fails *entirely*,
 * so all three thirds went black together and the split reported nothing. **A diagnostic that
 * cannot produce a partial result cannot localise anything**, which is the same lesson as the
 * probe ladder whose rungs saturated into a solid slab.
 *
 * **Round three** used separate effects with separate sources, and answered two things at once:
 *
 * 1. **An attached effect covers its parent's fill region — its own `width`/`height`/`position` do
 *    not confine it.** The five bands all painted over the whole map rather than tiling it. This
 *    also explains round one's "small" patch being indistinguishable: it was never small. A useful
 *    corollary is that attached effects **cannot be tiled** for performance; one per stencil.
 * 2. The rungs with **renamed** uniforms drew; the shader with the original names did not. An
 *    `ATTACHMENT` effect is handed built-ins describing its parent, and `scale` and `opacity` — two
 *    names the shader used — collide with them silently. See `PARCHMENT_SKSL`.
 */
const DIAGNOSE_BLACK: boolean = false;

/** Shared by the rungs that test noise. Byte-identical to charcoal's, which is known to compile. */
const NOISE_BODY = `
float hash21(float2 p) {
  float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + float2(1.0, 0.0)), u.x),
    mix(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), u.x),
    u.y);
}
`;

/**
 * Round three: a ladder of **separate effects**, each with its own complete source.
 *
 * Round two put the ingredients in one shader split across thirds, and that was the wrong shape of
 * test — a source that fails to compile fails *entirely*, so every third went black together and the
 * split reported nothing. Bisecting a compile failure needs separate programs, because only then can
 * one succeed while another fails. Same lesson as the saturated ladder rung: **a diagnostic has to
 * be able to produce a partial result, or it cannot localise anything.**
 *
 * Each rung is attached to the same stencil and covers one horizontal band of the map, so they are
 * read top to bottom. **The first rung is the known-good constant**, which makes the ladder
 * self-checking: if even that is black, the fault is that a parent cannot carry several attached
 * effects, and nothing below it means anything.
 *
 * The renamed rung is the interesting one. `scale`, `opacity` and `size` are exactly the sort of
 * generic names a host might already inject, and a collision would explain a shader that compiles
 * cleanly on its own and dies here.
 */
interface Rung {
  readonly label: string;
  readonly sksl: string;
  /** Uniform names this rung declares, so the supplied set can match it exactly. */
  readonly renamed: boolean;
  readonly needsUniforms: boolean;
}

const RUNGS: readonly Rung[] = [
  {
    label: "1 constant (control)",
    renamed: false,
    needsUniforms: false,
    sksl: `half4 main(float2 coord) { return half4(0.5, 0.0, 0.5, 0.5); }`,
  },
  {
    label: "2 uniforms, original names",
    renamed: false,
    needsUniforms: true,
    sksl: `uniform float2 size;
uniform float2 worldMin;
uniform float2 worldSpan;
uniform float3 tint;
uniform float opacity;
uniform float scale;
uniform float contrast;

half4 main(float2 coord) {
  return half4(tint.x, tint.y, tint.z, 1.0);
}`,
  },
  {
    label: "3 uniforms, renamed",
    renamed: true,
    needsUniforms: true,
    sksl: `uniform float2 size;
uniform float2 pmWorldMin;
uniform float2 pmWorldSpan;
uniform float3 pmTint;
uniform float pmOpacity;
uniform float pmCell;
uniform float pmVariation;

half4 main(float2 coord) {
  return half4(pmTint.x, pmTint.y, pmTint.z, 1.0);
}`,
  },
  {
    label: "4 renamed + noise",
    renamed: true,
    needsUniforms: true,
    sksl: `uniform float2 size;
uniform float2 pmWorldMin;
uniform float2 pmWorldSpan;
uniform float3 pmTint;
uniform float pmOpacity;
uniform float pmCell;
uniform float pmVariation;
${NOISE_BODY}
half4 main(float2 coord) {
  float2 w = pmWorldMin + (coord / size) * pmWorldSpan;
  float m = vnoise(w / pmCell);
  return half4(m, m, m, 1.0);
}`,
  },
  {
    label: "5 renamed, real output",
    renamed: true,
    needsUniforms: true,
    sksl: `uniform float2 size;
uniform float2 pmWorldMin;
uniform float2 pmWorldSpan;
uniform float3 pmTint;
uniform float pmOpacity;
uniform float pmCell;
uniform float pmVariation;
${NOISE_BODY}
float fbm3(float2 p) {
  return 0.55 * vnoise(p) + 0.30 * vnoise(p * 2.13 + 7.7) + 0.15 * vnoise(p * 4.31 + 19.3);
}

half4 main(float2 coord) {
  float2 w = pmWorldMin + (coord / size) * pmWorldSpan;
  float m = fbm3(w / pmCell);
  float a = pmOpacity * mix(1.0 - pmVariation, 1.0, m);
  return half4(pmTint.x * a, pmTint.y * a, pmTint.z * a, a);
}`,
  },
];

/** The same values under whichever names a rung declares. */
function rungUniforms(
  rung: Rung,
  bounds: Bounds,
  style: ParchmentStyle,
): ReturnType<typeof parchmentUniforms> {
  if (!rung.needsUniforms) return [];
  const base = parchmentUniforms(bounds, style);
  if (!rung.renamed) return base;

  const renames: Record<string, string> = {
    worldMin: "pmWorldMin",
    worldSpan: "pmWorldSpan",
    tint: "pmTint",
    opacity: "pmOpacity",
    scale: "pmCell",
    contrast: "pmVariation",
  };
  return base.map((u) => ({ ...u, name: renames[u.name] ?? u.name }));
}

export interface ParchmentRender {
  /** How many items were drawn: 0 when off, otherwise 2. */
  readonly drawn: number;
  /** Path commands in the stencil, and what it cost to get there. */
  readonly commands: number;
  readonly tolerance: number;
  /** Visible polygons that could not be punched out. Non-zero means parchment over lit ground. */
  readonly dropped: number;
  /** Milliseconds spent building the geometry, excluding the round trip to the scene. */
  readonly buildMs: number;
  /** Milliseconds spent in `deleteItems` + `addItems`. */
  readonly commitMs: number;
}

const NOTHING: ParchmentRender = {
  drawn: 0,
  commands: 0,
  tolerance: 0,
  dropped: 0,
  buildMs: 0,
  commitMs: 0,
};

/**
 * Replace the overlay.
 *
 * Delete-and-replace on every visibility change, matching the sketch. That is the cost this is
 * instrumented to expose: the overlay rebuilds a path whose holes follow the party, so it lands on
 * exactly the redraw that was already the slow half.
 */
export async function renderParchment(
  extent: Bounds | undefined,
  visible: readonly (readonly Vector2[])[],
  settings: ParchmentSettings,
  dpi: number,
): Promise<ParchmentRender> {
  if (!settings.enabled || !extent) {
    await clearParchment();
    return NOTHING;
  }

  const startedBuild = performance.now();

  const stencil = stencilRings(extent, visible, dpi * HOLE_TOLERANCE_SQUARES);
  const style: ParchmentStyle = {
    tint: parseHexColor(settings.color),
    opacity: settings.opacity,
    scale: dpi * settings.scaleSquares,
    contrast: settings.contrast,
  };

  const commands: PathCommand[] = [];
  for (const ring of stencil.rings) {
    const first = ring[0];
    if (!first) continue;
    commands.push([Command.MOVE, first.x, first.y]);
    for (let i = 1; i < ring.length; i++) {
      commands.push([Command.LINE, ring[i]!.x, ring[i]!.y]);
    }
    commands.push([Command.CLOSE]);
  }

  const path = buildPath()
    .commands(commands)
    .position({ x: 0, y: 0 })
    // The holes. Without `evenodd` the inner rings would fill rather than cut, and the overlay
    // would cover the very area it exists to leave clear.
    .fillRule("evenodd")
    // Cyan while diagnosing, so a fill that draws despite zero opacity is unmistakable rather than
    // being mistaken for the shader's output. Nothing on a map is cyan.
    .fillColor(DIAGNOSE_BLACK ? "#00e5ff" : "#000000")
    // Invisible, but present: the clip follows the fill, and the fill need not be seen.
    .fillOpacity(0)
    .strokeOpacity(0)
    .strokeWidth(0)
    .zIndex(PARCHMENT_Z)
    .disableAutoZIndex(true)
    .layer(PARCHMENT_LAYER)
    .locked(true)
    .disableHit(true)
    .name("Cartographer's Fog parchment")
    .metadata({ [PARCHMENT_KEY]: true })
    .build();

  /** One effect over a horizontal band of the extent. Bands are read top to bottom. */
  const band = (
    sksl: string,
    uniforms: ReturnType<typeof parchmentUniforms>,
    index: number,
    of: number,
  ) => {
    const height = (extent.max.y - extent.min.y) / of;
    return buildEffect()
      .width(extent.max.x - extent.min.x)
      .height(height)
      .position({ x: extent.min.x, y: extent.min.y + index * height })
      .sksl(sksl)
      .uniforms([...uniforms])
      // Attached, unlike the sketch's standalone effects. Here the shape *is* the point — a
      // standalone effect would paint its whole rectangle and cover the party.
      .effectType("ATTACHMENT")
      .attachedTo(path.id)
      .blendMode("SRC_OVER")
      .zIndex(PARCHMENT_Z)
      .disableAutoZIndex(true)
      .layer(PARCHMENT_LAYER)
      .locked(true)
      .disableHit(true)
      .name("Cartographer's Fog parchment")
      .metadata({ [PARCHMENT_KEY]: true })
      .build();
  };

  const effects = DIAGNOSE_BLACK
    ? RUNGS.map((rung, i) =>
        band(rung.sksl, rungUniforms(rung, extent, style), i, RUNGS.length),
      )
    : [band(PARCHMENT_SKSL, parchmentUniforms(extent, style), 0, 1)];

  const buildMs = performance.now() - startedBuild;

  const startedCommit = performance.now();
  await clearParchment();
  await OBR.scene.local.addItems([path, ...effects] as Item[]);
  const commitMs = performance.now() - startedCommit;

  return {
    drawn: 1 + effects.length,
    commands: stencil.commands,
    tolerance: stencil.tolerance,
    dropped: stencil.dropped,
    buildMs,
    commitMs,
  };
}

export async function clearParchment(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => PARCHMENT_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}
