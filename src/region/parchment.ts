/**
 * The parchment overlay — mottled tone over everything the party cannot currently see.
 *
 * The sketch draws *remembered* ground. This covers the rest of the sheet: discovered and
 * undiscovered alike, everywhere except the area currently lit. The effect is that the whole screen
 * reads as a hand-drawn map on parchment, with a hole cut in it where the party is standing and the
 * real map shows through.
 *
 * ## The stencil is a rectangle with holes, at full polygon precision
 *
 * A `Path` carries a `fillRule`, so the overlay's shape is one path: the scene's extent as an outer
 * ring, each visible polygon as an inner ring, and `evenodd` to make the inner rings holes. That
 * matters more than it sounds. The obvious alternative was the cell grid the region already uses —
 * but its cells are tens of world units across, and DESIGN.md is explicit that the *visible*
 * boundary is the one that moves with the party and gets looked at directly. Quantising it would
 * stair-step exactly the edge nobody can avoid staring at. Holes cost nothing extra and are exact.
 *
 * A clipped shader cannot soften its own edge — it never learns where the clip is (DESIGN.md, cell
 * J) — so the precision of this outline is the only lever on how the cut-out reads.
 *
 * ## The colour comes from the fog, not from here
 *
 * The shader paints a *translucent mottle* rather than an opaque sheet: the fog underneath supplies
 * the base tone and this varies it. So the tint is a small adjustment chosen to sit against whatever
 * the fog already looks like, and the opacity is expected to be low.
 *
 * **Pure: no SDK, no DOM.** `parchmentOverlay.ts` is the half that builds items.
 */

import { SAFE_COMMAND_BUDGET } from "./pathChunks";
import { simplifyPolyline } from "../trace/simplify";
import type { Bounds } from "./cellGrid";
import type { Vector2 } from "../geometry/vector";

/**
 * Rings of an even-odd path: the outer boundary first, then any holes.
 *
 * Deliberately not `PathCommand[]`. `Command` is a runtime enum from `@owlbear-rodeo/sdk`, and
 * importing the SDK anywhere in this file would make every test die on `window is not defined` —
 * the constraint DESIGN.md records under "Testing strategy". The SDK half turns rings into commands.
 */
export interface StencilRings {
  readonly rings: readonly (readonly Vector2[])[];
  /** How many path commands the rings will cost, so the caller can log what it built. */
  readonly commands: number;
  /** Tolerance the holes were simplified at, in world units — raised if the budget demanded it. */
  readonly tolerance: number;
  /** Holes dropped because even the coarsest simplification would not fit. Normally zero. */
  readonly dropped: number;
}

/** How many times the tolerance may double before holes start being dropped. */
const MAX_RELAXATIONS = 8;

/**
 * Build the overlay's outline: the extent, minus the visible polygons.
 *
 * **The holes are simplified, and they have to be.** A single light's visibility polygon runs to
 * roughly 2,750 vertices — DESIGN.md measured 2,755 — because the sweep samples arcs finely. Three
 * lit tokens would blow straight past the 8,000-command budget for one item, and unlike the wash
 * this path *cannot* be chunked: split the extent into tiles and each tile's path would still be
 * filled wherever another tile's hole overlapped it, because even-odd counts crossings over the
 * whole path rather than within a tile.
 *
 * So the vertex count is reduced instead. `tolerance` is a world-space distance, and the arcs are
 * smooth, so a tolerance well under a pixel at play zoom removes the overwhelming majority of
 * points while leaving the outline visually identical. If the result still does not fit, the
 * tolerance doubles and it tries again — which always converges, because a coarse enough tolerance
 * reduces any polygon to a triangle.
 */
export function stencilRings(
  extent: Bounds,
  visible: readonly (readonly Vector2[])[],
  tolerance: number,
): StencilRings {
  const outer: Vector2[] = [
    { x: extent.min.x, y: extent.min.y },
    { x: extent.max.x, y: extent.min.y },
    { x: extent.max.x, y: extent.max.y },
    { x: extent.min.x, y: extent.max.y },
  ];

  // A ring of n points costs a MOVE, n-1 LINEs and a CLOSE.
  const cost = (ring: readonly Vector2[]) => ring.length + 1;

  let working = Math.max(tolerance, 1e-6);
  for (let attempt = 0; attempt <= MAX_RELAXATIONS; attempt++) {
    const holes = visible
      .map((polygon) => simplifyPolyline(polygon, working))
      // Two points enclose no area, so such a hole would punch nothing and cost commands anyway.
      .filter((ring) => ring.length >= 3);

    const total = holes.reduce((sum, ring) => sum + cost(ring), cost(outer));
    if (total <= SAFE_COMMAND_BUDGET) {
      return {
        rings: [outer, ...holes],
        commands: total,
        tolerance: working,
        dropped: visible.length - holes.length,
      };
    }
    working *= 2;
  }

  // Past every relaxation. Keep the largest holes, since a missing hole leaves parchment over
  // ground the party is looking at — conspicuous — and the largest ones cover the most of it.
  const ranked = visible
    .map((polygon) => simplifyPolyline(polygon, working))
    .filter((ring) => ring.length >= 3)
    .sort((a, b) => ringArea(b) - ringArea(a));

  const kept: Vector2[][] = [];
  let used = cost(outer);
  for (const ring of ranked) {
    if (used + cost(ring) > SAFE_COMMAND_BUDGET) break;
    kept.push(ring);
    used += cost(ring);
  }

  return {
    rings: [outer, ...kept],
    commands: used,
    tolerance: working,
    dropped: visible.length - kept.length,
  };
}

/** Twice the signed area, unsigned — only used to rank holes by size. */
function ringArea(ring: readonly Vector2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum);
}

export interface ParchmentStyle {
  /** Tint as linear 0–1 components. */
  readonly tint: { readonly x: number; readonly y: number; readonly z: number };
  /** Peak alpha. Low — the fog supplies the base tone and this only varies it. */
  readonly opacity: number;
  /** World size of one mottle cell. */
  readonly scale: number;
  /** How much the mottle varies, 0–1. Zero is a flat wash. */
  readonly contrast: number;
}

export function parchmentUniforms(
  bounds: Bounds,
  style: ParchmentStyle,
): { name: string; value: number | Vector2 | { x: number; y: number; z: number } }[] {
  return [
    { name: "pmWorldMin", value: { x: bounds.min.x, y: bounds.min.y } },
    {
      name: "pmWorldSpan",
      value: {
        x: nonZero(bounds.max.x - bounds.min.x),
        y: nonZero(bounds.max.y - bounds.min.y),
      },
    },
    { name: "pmTint", value: { ...style.tint } },
    { name: "pmOpacity", value: style.opacity },
    // Guarded because the shader divides world position by it.
    { name: "pmCell", value: nonZero(style.scale) },
    { name: "pmVariation", value: style.contrast },
  ];
}

function nonZero(value: number): number {
  return Math.abs(value) > 1e-6 ? value : 1e-6;
}

/**
 * Three octaves, against charcoal's two.
 *
 * Parchment covers a whole viewport where the sketch's effects cover thin strips near linework, so
 * this is the shader most exposed to per-pixel cost in the project — and octave count is the first
 * lever if it proves expensive. Three rather than two because a large flat area shows banding that
 * a stroke's width hides: the coarse octave gives the sheet its blotches, the middle one its
 * unevenness, and the fine one keeps it from looking airbrushed.
 *
 * Keyed to **world** position, never to `coord`, so the sheet stays put when the GM pans — §6's
 * rule, and far more conspicuous here than on a stroke because the area is so large.
 */
/**
 * **Every custom uniform is prefixed `pm`, and that is load-bearing.**
 *
 * The overlay first rendered solid black, and the cause was a name collision: an `ATTACHMENT`
 * effect is handed built-ins describing its parent, which include generic names like `scale` and
 * `opacity` — two of the names this shader originally used. The collision does not report an error;
 * the effect simply renders black. Bisected in a room 2026-08-02, and the rung with renamed
 * uniforms drew while the rung with the original names did not.
 *
 * The sketch's shaders never hit this because they are `STANDALONE` and have no parent, so nothing
 * is injected to collide with. **Any future attached effect needs the same precaution.**
 */
export const PARCHMENT_SKSL = `uniform float2 size;
uniform float2 pmWorldMin;
uniform float2 pmWorldSpan;
uniform float3 pmTint;
uniform float pmOpacity;
uniform float pmCell;
uniform float pmVariation;

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

float fbm3(float2 p) {
  return 0.55 * vnoise(p)
       + 0.30 * vnoise(p * 2.13 + 7.7)
       + 0.15 * vnoise(p * 4.31 + 19.3);
}

half4 main(float2 coord) {
  float2 w = pmWorldMin + (coord / size) * pmWorldSpan;
  float m = fbm3(w / pmCell);

  float a = clamp(pmOpacity * (1.0 + pmVariation * (m - 0.5) * 2.0), 0.0, 1.0);
  return half4(pmTint.x * a, pmTint.y * a, pmTint.z * a, a);
}
`;

/**
 * **`pmOpacity` is the mean alpha and `pmVariation` is the swing around it — they do not interact.**
 *
 * The mottle was originally `pmOpacity × mix(1 - pmVariation, 1, m)`, which made opacity the *peak*
 * rather than the average: since the noise averages about a half, the mean alpha came out at
 * `pmOpacity × (1 - pmVariation / 2)`. Raising variation therefore deepened the texture *and*
 * lightened the sheet at the same time, and the two controls fought (user, 2026-08-02: "high
 * variation was necessary to see the effect, but maybe that interacts with strength" — it did).
 *
 * Centring the swing on the mean fixes it: variation now changes only how far the mottle strays
 * from `pmOpacity`, in both directions, leaving the average darkness alone. The clamp matters
 * because at high variation the upper excursion would otherwise pass 1.
 *
 * **This was not a neutral change**, which is why the shipped strength moved with it. For a given
 * pair of values the new distribution has roughly twice the spread, so the default was re-based on
 * the *mean* the judged settings produced — 0.1 peak at 0.9 variation averaged 0.055, and that is
 * now the strength.
 */
