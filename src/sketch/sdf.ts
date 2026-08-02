/**
 * The shader renderer's geometry half — DESIGN.md, "Build plan: a `shader` renderer alongside the
 * existing one", phase 1.
 *
 * Today's renderer hands Owlbear a shape and Owlbear decides the pixels. An `Effect` inverts that:
 * we hand it a world-space rectangle and a per-pixel program, and pass the stroke geometry in as
 * numeric uniforms. For each pixel the program converts its position to world coordinates, measures
 * the distance to the nearest line piece, and turns that distance into ink — solid near the
 * centreline, fading over a narrow band, transparent beyond. Soft edges, width varying along a
 * stroke, and grain *within* a single mark all follow from that last step being ours, which is the
 * thing the multi-pass pencil could not do (`pencil.ts`, judged and left off).
 *
 * One effect carries a *batch* of pieces and takes the minimum distance across them, so strokes
 * inside a batch merge seamlessly rather than compositing as separate marks.
 *
 * ## The one decision everything else follows from
 *
 * **The batch size is fixed and unused slots are padded**, rather than generating source containing
 * only the pieces currently visible. The program declares N slots; which geometry occupies a slot
 * is a uniform, and hiding a stroke means parking its slot far outside the batch's bounds so its
 * distance never wins the minimum. That is what keeps the SkSL string constant — a source that
 * changed per redraw would recompile a shader every time a token moved, which is almost certainly
 * fatal, and it is also what makes the deferred incremental-update phase nearly free.
 *
 * The cost is that empty slots are not free: every pixel runs the whole unrolled chain regardless
 * of occupancy, so a batch holding four pieces costs what a full one does. Keep batches reasonably
 * full, and do not pick a batch size far above typical occupancy.
 *
 * **Uniforms are individually named and the loop is unrolled**, generated as a string. Whether the
 * SDK supports uniform *arrays* is untested and `Uniform.value` admits only a single number, vector
 * or matrix — generating `p0a, p0b, … pNa, pNb` sidesteps the question rather than betting on it.
 *
 * **Pure: no SDK, no DOM.** The SDK half is `shaderStrokes.ts`, split for the reason DESIGN.md gives
 * under "Testing strategy" — `@owlbear-rodeo/sdk` reads `window.location.search` at module load, so
 * importing it here would kill every test in `sdf.test.ts` with `ReferenceError: window is not
 * defined`. Hit twice already on this project.
 */

import type { BrushId } from "./appearance";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

/** One straight piece of a polyline. The unit a uniform slot holds. */
export interface Piece {
  readonly a: Vector2;
  readonly b: Vector2;
  /**
   * Half-width at each end, for brushes whose mark is not one thickness.
   *
   * Absent for the liner and charcoal, which use the single `halfWidth` uniform. When present the
   * shader interpolates between the two along the piece, using the projection parameter it already
   * computes to measure distance — so continuous width costs one `mix` and nothing else.
   */
  readonly wa?: number;
  readonly wb?: number;
}

/** A world-space axis-aligned box. The rectangle an `Effect` is given to shade. */
export interface Bounds {
  readonly min: Vector2;
  readonly max: Vector2;
}

/**
 * Structurally the SDK's `Uniform`, minus the import.
 *
 * `Uniform.value` admits `number | Vector2 | Vector3 | Matrix` and nothing else — there is no
 * texture or image uniform type, which is why every pattern this renderer draws has to be computed
 * rather than sampled. See DESIGN.md, "Raster rendering is not available".
 */
export interface ShaderUniform {
  readonly name: string;
  readonly value: number | Vector2 | { x: number; y: number; z: number };
}

/** What the shader needs to know about ink, in world units and linear colour. */
export interface SdfStyle {
  /** Half the stroke's width. The distance at which the fade is centred. */
  readonly halfWidth: number;
  /**
   * Half-width of the fade band, in world units.
   *
   * The whole reason for this renderer. A `Path` has a hard silhouette; here the alpha ramps from
   * one to zero across `2 × feather` centred on `halfWidth`, so the mark has an edge like a pen on
   * paper rather than like a vector outline.
   */
  readonly feather: number;
  /** Ink colour as linear 0–1 components — `parseHexColor` converts from the stored `#rrggbb`. */
  readonly ink: { readonly x: number; readonly y: number; readonly z: number };
  /** Grain, for brushes that have it. Ignored by `liner`, required by `charcoal`. */
  readonly grain?: SdfGrain;
}

/**
 * Procedural grain, in world units and 0–1 strengths.
 *
 * **Procedural because there is no alternative.** The usual way to draw charcoal is to stamp a
 * scanned grain bitmap along the path, and `Uniform.value` admits only numbers, vectors and
 * matrices — no texture can ever reach the shader (DESIGN.md, "Raster rendering is not available").
 * So the tooth is computed from world position. That suits charcoal better than it would suit a wet
 * brush: granularity genuinely *is* what the medium looks like, rather than a texture standing in
 * for one.
 */
export interface SdfGrain {
  /** World size of one grain cell. Larger is coarser paper. */
  readonly scale: number;
  /** How much the grain eats into density, 0–1. Zero leaves a flat mark. */
  readonly depth: number;
  /**
   * How ragged the silhouette is, as a fraction of the half-width.
   *
   * The single most important term for reading as a dry medium, and the cheapest. Rather than
   * fading a smooth edge, it *displaces the threshold* per pixel — so the outline itself breaks up
   * the way a stick of charcoal skips over paper, instead of merely blurring.
   */
  readonly roughness: number;
}

/**
 * Flatten polylines into straight pieces, in order.
 *
 * A `TracedSegment` is a short polyline rather than a two-point piece (`chop.ts`), and the shader
 * measures distance to straight pieces, so this is where the two representations meet. Order is
 * preserved because the caller masks by index — see `mask.ts`, `SketchSelection.indices`.
 */
export function toPieces(
  segments: readonly TracedSegment[],
  widths?: readonly (readonly number[])[],
): Piece[] {
  const pieces: Piece[] = [];
  segments.forEach((segment, index) => {
    const points = segment.points;
    // Index-aligned with `segments`, exactly as `SketchSelection.indices` is. A widths array that
    // is short or misaligned would silently draw part of the sketch at the wrong thickness, so a
    // missing entry falls back to the constant width rather than to zero.
    const perPoint = widths?.[index];
    for (let i = 0; i + 1 < points.length; i++) {
      const wa = perPoint?.[i];
      const wb = perPoint?.[i + 1];
      pieces.push(
        wa !== undefined && wb !== undefined
          ? { a: points[i]!, b: points[i + 1]!, wa, wb }
          : { a: points[i]!, b: points[i + 1]! },
      );
    }
  });
  return pieces;
}

/**
 * Group pieces into batches of at most `batchSize`, **spatially**.
 *
 * Spatially, not by input order, and the reason is the cost model: an effect shades every pixel of
 * its rectangle, so a batch of pieces scattered across the map pays for a rectangle that is almost
 * entirely empty. Bucketing by a uniform world grid on each piece's midpoint keeps a batch's
 * rectangle tight around the ink it actually holds.
 *
 * Buckets over `batchSize` are split rather than being allowed to overflow, so the returned batches
 * are all valid slot sets by construction.
 *
 * Deterministic: buckets are emitted in a stable key order and pieces keep their relative order
 * within one. The deferred incremental-update phase depends on the batch *set* being reproducible
 * across redraws, so an ordering that varied run to run would quietly close that door.
 *
 * @param cellSize world-space grid pitch. Defaults to a pitch aiming at roughly `batchSize` pieces
 * per cell, which is what keeps batches full enough that padded slots are not most of the cost.
 */
export function batchPieces(
  pieces: readonly Piece[],
  batchSize: number,
  cellSize = defaultCellSize(pieces, batchSize),
): Piece[][] {
  if (batchSize < 1) throw new Error(`batchSize must be at least 1, got ${batchSize}`);
  if (pieces.length === 0) return [];

  const pitch = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : 1;
  const buckets = new Map<string, Piece[]>();

  for (const piece of pieces) {
    const mx = (piece.a.x + piece.b.x) / 2;
    const my = (piece.a.y + piece.b.y) / 2;
    const key = `${Math.floor(mx / pitch)},${Math.floor(my / pitch)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(piece);
    else buckets.set(key, [piece]);
  }

  const batches: Piece[][] = [];
  for (const key of [...buckets.keys()].sort(compareCellKeys)) {
    const bucket = buckets.get(key)!;
    for (let i = 0; i < bucket.length; i += batchSize) {
      batches.push(bucket.slice(i, i + batchSize));
    }
  }
  return batches;
}

/**
 * A pitch aiming at roughly `batchSize` pieces per cell, derived from the overall extent.
 *
 * `sqrt(area × batchSize / count)` is the pitch at which a uniformly-scattered set would average
 * `batchSize` per cell. Traced linework is nothing like uniformly scattered — it clusters on walls —
 * so real buckets run under that and get split when they run over. It is a starting pitch, not a
 * guarantee, which is why `batchPieces` splits rather than trusting it.
 */
function defaultCellSize(pieces: readonly Piece[], batchSize: number): number {
  if (pieces.length === 0) return 1;
  const bounds = batchBounds(pieces, 0);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  const area = width * height;
  if (!(area > 0)) return Math.max(width, height, 1);
  return Math.sqrt((area * batchSize) / pieces.length);
}

/** Numeric ordering on the `"cx,cy"` keys, so `10` does not sort before `9`. */
function compareCellKeys(left: string, right: string): number {
  const [lx, ly] = left.split(",").map(Number) as [number, number];
  const [rx, ry] = right.split(",").map(Number) as [number, number];
  return lx - rx || ly - ry;
}

/**
 * The world rectangle an effect must cover, expanded by `margin`.
 *
 * **The margin is not optional.** The shader paints out to `halfWidth + feather` either side of a
 * centreline, but an `Effect` cannot draw outside its own rectangle — so a box drawn tight around
 * the centrelines would slice the ink off flat wherever a piece runs along the edge. Pass
 * `halfWidth + feather` at minimum.
 */
export function batchBounds(pieces: readonly Piece[], margin: number): Bounds {
  if (pieces.length === 0) {
    return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const { a, b } of pieces) {
    minX = Math.min(minX, a.x, b.x);
    minY = Math.min(minY, a.y, b.y);
    maxX = Math.max(maxX, a.x, b.x);
    maxY = Math.max(maxY, a.y, b.y);
  }

  return {
    min: { x: minX - margin, y: minY - margin },
    max: { x: maxX + margin, y: maxY + margin },
  };
}

/**
 * How far outside its bounds a parked slot sits, as a multiple of the batch's span.
 *
 * Ten is chosen from both ends. Far enough that a parked piece can never win the minimum distance
 * against a real one anywhere inside the rectangle, and near enough that the squared terms in the
 * distance maths stay a very long way from the edge of float range — a sentinel at 1e30 would
 * overflow `dot(ba, ba)` and could return a NaN that poisons the `min` chain.
 */
const SENTINEL_SPANS = 10;

/**
 * Build the full uniform list for one batch — **always exactly `batchSize` slots**.
 *
 * Padding is the whole mechanism, not tidiness: the SkSL source declares a fixed number of slots,
 * so a short list would leave uniforms undeclared and the count is what keeps one compiled source
 * usable for every batch and every redraw.
 *
 * @param pieces the batch's occupied slots. Must not exceed `batchSize`.
 * @param bounds the rectangle the effect covers — already margin-expanded by the caller, since the
 * sentinel is placed relative to it and must land outside whatever the effect actually shades.
 */
export function buildUniforms(
  pieces: readonly Piece[],
  bounds: Bounds,
  style: SdfStyle,
  batchSize: number,
  brush: BrushId = "liner",
): ShaderUniform[] {
  if (pieces.length > batchSize) {
    throw new Error(`batch of ${pieces.length} exceeds batchSize ${batchSize}`);
  }

  const span = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
  };
  const parked = sentinelFor(bounds, span);

  const uniforms: ShaderUniform[] = [
    { name: "worldMin", value: { x: bounds.min.x, y: bounds.min.y } },
    // Guarded against zero: the shader divides by this to map `coord` into world space, and a
    // degenerate batch — one piece, perfectly axis-aligned — has a zero span on one axis.
    {
      name: "worldSpan",
      value: { x: nonZero(span.x), y: nonZero(span.y) },
    },
    { name: "halfWidth", value: style.halfWidth },
    { name: "feather", value: style.feather },
    { name: "ink", value: { x: style.ink.x, y: style.ink.y, z: style.ink.z } },
  ];

  // Only when the brush has grain, and the source must agree — a uniform the shader does not
  // declare, or a declared one never supplied, is a mismatch the SDK reports as nothing rendering.
  // `uniformsMatchSource` in the tests pins the two together.
  if (style.grain) {
    uniforms.push(
      // Guarded for the same reason as the span: the shader divides world position by this.
      { name: "grainScale", value: nonZero(style.grain.scale) },
      { name: "grainDepth", value: style.grain.depth },
      { name: "edgeRoughness", value: style.grain.roughness },
    );
  }

  const { varyingWidth } = brushFeatures(brush);

  for (let i = 0; i < batchSize; i++) {
    const piece = pieces[i];
    uniforms.push({ name: `p${i}a`, value: piece ? { ...piece.a } : parked });
    uniforms.push({ name: `p${i}b`, value: piece ? { ...piece.b } : parked });
    if (varyingWidth) {
      // A parked slot's width is irrelevant — it can never win the minimum — but it must be a
      // finite number, since a NaN would poison the whole `min` chain for every pixel.
      uniforms.push({
        name: `w${i}`,
        value: { x: piece?.wa ?? style.halfWidth, y: piece?.wb ?? style.halfWidth },
      });
    }
  }

  return uniforms;
}

/**
 * Where a parked slot goes.
 *
 * Offset on both axes so it cannot accidentally line up with a real piece's row or column, and
 * scaled by the span so it is far outside a small batch as well as a large one. A degenerate span
 * would put the sentinel *inside* the bounds, hence the floor.
 */
export function sentinelFor(bounds: Bounds, span: Vector2): Vector2 {
  const reach = SENTINEL_SPANS * Math.max(nonZero(span.x), nonZero(span.y));
  return { x: bounds.min.x - reach, y: bounds.min.y - reach };
}

function nonZero(value: number): number {
  return Math.abs(value) > 1e-6 ? value : 1e-6;
}

/**
 * Generate the SkSL for a given batch size. **One source, compiled once, reused by every batch.**
 *
 * Three things here are load-bearing and were each proven in a room rather than assumed
 * (DESIGN.md, "the shader can draw the stroke itself"):
 *
 * - **World mapping.** `coord` is normalised against the built-in `size` and interpolated across the
 *   world rect passed in, so it holds however `coord` and `size` are scaled. This is what makes the
 *   texture stable under pan and zoom — `model`/`modelView` are not needed. It matters more than it
 *   looks: DESIGN.md §6 rejects time-seeded wobble for making the map appear to breathe, and a
 *   view-seeded texture would be worse.
 * - **The unrolled chain.** Constant-bound `for` loops do compile, but individually-named uniforms
 *   cannot be indexed by a loop variable in SkSL, so the minimum is taken over an unrolled chain.
 *   That is the same shape the probe measured and costs nothing extra.
 * - **Premultiplied output, written componentwise.** `half4(ink.x * a, …, a)` is the form cell J
 *   compiled; a `half4(half3(ink) * a, a)` constructor is untested here and there is no reason to
 *   spend a room test finding out.
 *
 * The alpha ramp is the point of the whole exercise: `smoothstep` across `halfWidth ± feather`
 * gives a genuinely soft edge, re-evaluated per screen pixel at the current zoom, so it stays smooth
 * however far in the view goes. Nothing is stored as a bitmap.
 */
/**
 * What a brush needs from the shader — **the single source of truth for both halves.**
 *
 * `sdfSource` decides what the program declares and `buildUniforms` decides what it is given, and
 * a disagreement between them fails silently in both directions: an undeclared uniform is ignored,
 * and a declared one never supplied leaves the effect drawing nothing. Neither throws. Deriving
 * both from this one function is what makes them impossible to drift apart, and a test asserts the
 * two sets are equal for every brush.
 *
 * The two features are independent by construction rather than by enumeration, so a future brush
 * wanting grain *and* varying width — a dry-brush ink, say — costs nothing to express.
 */
export function brushFeatures(brush: BrushId): {
  readonly grain: boolean;
  readonly varyingWidth: boolean;
} {
  return {
    grain: brush === "charcoal",
    varyingWidth: brush === "nib" || brush === "ink",
  };
}

export function sdfSource(batchSize: number, brush: BrushId = "liner"): string {
  if (batchSize < 1) throw new Error(`batchSize must be at least 1, got ${batchSize}`);

  const { grain, varyingWidth } = brushFeatures(brush);

  const declarations: string[] = [];
  const chain: string[] = [];
  for (let i = 0; i < batchSize; i++) {
    declarations.push(
      `uniform float2 p${i}a;\nuniform float2 p${i}b;` +
        (varyingWidth ? `\nuniform float2 w${i};` : ""),
    );
    chain.push(
      varyingWidth
        ? `  sd = min(sd, sdCone(w, p${i}a, p${i}b, w${i}));`
        : `  sd = min(sd, sdSeg(w, p${i}a, p${i}b));`,
    );
  }

  return `uniform float2 size;
uniform float2 worldMin;
uniform float2 worldSpan;
uniform float halfWidth;
uniform float feather;
uniform float3 ink;
${grain ? GRAIN_UNIFORMS : ""}${declarations.join("\n")}

${varyingWidth ? CONE_DISTANCE : SEGMENT_DISTANCE}${grain ? NOISE_FUNCTIONS : ""}
half4 main(float2 coord) {
  float2 w = worldMin + (coord / size) * worldSpan;

  float sd = 1000000.0;
${chain.join("\n")}
${varyingWidth ? "" : "  sd -= halfWidth;\n"}
  float e = max(feather, 0.0001);
${grain ? CHARCOAL_BODY : PLAIN_BODY}

  return half4(ink.x * a, ink.y * a, ink.z * a, a);
}
`;
}

/**
 * Distance to a straight piece of constant width.
 *
 * `halfWidth` is subtracted once in `main` rather than inside the chain, so the loop body stays as
 * short as it can be — it runs `batchSize` times per pixel and is the dominant cost of the whole
 * renderer.
 */
const SEGMENT_DISTANCE = `float sdSeg(float2 p, float2 a, float2 b) {
  float2 pa = p - a;
  float2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h);
}
`;

/**
 * Signed distance to a piece whose half-width runs from `r.x` to `r.y` along it.
 *
 * The projection parameter `h` is computed anyway to measure distance, so interpolating the radius
 * by it is very nearly free — one `mix` and one subtraction. That is what makes continuous width
 * affordable at all here.
 *
 * **This is the cheap approximation, not the exact round-cone field.** A true varying-radius SDF
 * accounts for the slope of the radius change, which tilts the surface near a rapid taper; this
 * treats the radius as constant *at* the sample's projection. The error scales with how fast the
 * radius changes along one piece — and pieces here are short, because `chop.ts` cuts for masking
 * and `wobble.ts` subdivides again, so the width barely moves across any single one. Exactness
 * would cost several more operations in the hottest loop in the project to fix an error nothing
 * can see.
 */
const CONE_DISTANCE = `float sdCone(float2 p, float2 a, float2 b, float2 r) {
  float2 pa = p - a;
  float2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h) - mix(r.x, r.y, h);
}
`;

const GRAIN_UNIFORMS = `uniform float grainScale;
uniform float grainDepth;
uniform float edgeRoughness;
`;

/**
 * Value noise and a two-octave fBm, in world space.
 *
 * **Two octaves rather than the usual four or five, and that is a cost decision.** All of this runs
 * once per pixel *after* the distance chain rather than inside it, so it is paid once instead of
 * `batchSize` times — but per-pixel cost is already what limits this renderer, so octave count is
 * the first place grain would get expensive. Two is enough for paper tooth: a coarse octave for
 * patchy density and a fine one for the grit.
 *
 * `hash21` is the standard integer-lattice hash. It needs no state and no texture, which is the
 * entire requirement — see `SdfGrain` for why a texture is not an option.
 */
const NOISE_FUNCTIONS = `
float hash21(float2 p) {
  float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  // Smoothstep interpolation, so the field has no visible lattice creases. A linear blend shows
  // the grid as diagonal seams, which on a map reads as a rendering fault rather than as paper.
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + float2(1.0, 0.0)), u.x),
    mix(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), u.x),
    u.y);
}

float fbm2(float2 p) {
  return 0.65 * vnoise(p) + 0.35 * vnoise(p * 2.17 + 11.3);
}
`;

/**
 * Plain edge — used by every brush without grain.
 *
 * Thresholded at zero because `sd` is already signed: negative inside the mark, positive outside.
 * That is what lets a constant-width brush and a varying-width one share one alpha ramp, and it is
 * exactly equivalent to the old `smoothstep(halfWidth - e, halfWidth + e, d)` — both reduce to
 * `(d - halfWidth + e) / 2e`, so nothing about the judged liner or charcoal look changes.
 */
const PLAIN_BODY = `  float a = 1.0 - smoothstep(-e, e, sd);`;

/**
 * Charcoal: displace the threshold, then mottle the density.
 *
 * The order matters and only one of these is optional. Displacing the *threshold* breaks the
 * silhouette up, so the outline skips the way a stick does over paper. Multiplying the result by a
 * second field then varies how heavily ink sits inside it. Doing only the second gives a
 * clean-edged shape with a dirty middle, which reads as a textured sticker rather than a drawn mark.
 *
 * Both fields are keyed to **world** position, so the grain belongs to the map and not to the view.
 * It must not swim when the GM pans — the same requirement DESIGN.md §6 places on the wobble, and
 * for the same reason: texture that moves with the camera makes the map appear to breathe.
 *
 * The second field is offset and rescaled so the two do not correlate. At matching frequencies the
 * mottle would line up with the edge breaks and beat against them visibly.
 */
const CHARCOAL_BODY = `  float bump = (fbm2(w / grainScale) - 0.5) * edgeRoughness * halfWidth;
  float a = 1.0 - smoothstep(-e + bump, e + bump, sd);
  a *= mix(1.0 - grainDepth, 1.0, fbm2(w / grainScale * 2.7 + 31.7));`;

/** `#rrggbb` to linear 0–1 components, for the `ink` uniform. Falls back to black on nonsense. */
export function parseHexColor(hex: string): { x: number; y: number; z: number } {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return { x: 0, y: 0, z: 0 };
  return {
    x: parseInt(match[1]!, 16) / 255,
    y: parseInt(match[2]!, 16) / 255,
    z: parseInt(match[3]!, 16) / 255,
  };
}
