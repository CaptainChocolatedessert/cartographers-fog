/**
 * How the sketch looks — the GM's aesthetic choices, shared with the table.
 *
 * **Room metadata, not scene metadata**, which is the split DESIGN.md sets out: the discovered
 * region and the map nomination are necessarily per-scene, but a preference for how ink looks
 * sensibly follows a GM from one scene to the next. `OBR.room.onMetadataChange` fires on every
 * client, so a GM moving a control reaches players with no broadcast to design and no late-joiner
 * problem.
 *
 * These are shared rather than per-player deliberately. The sketch is a table aesthetic, not a
 * personal display setting — `OBR.player.setMetadata` is the natural home if a personal override
 * is ever wanted (an accessibility palette, or turning the sketch down because it distracts), and
 * nothing here forecloses that.
 *
 * ## The one asymmetry that matters
 *
 * **Colour and width are free to change; wobble is not.** Colour and width are `PathStyle` fields
 * on the emitted items, so changing them is a redraw of geometry that already exists. Wobble is
 * baked into the geometry at trace time and cached — §6 requires the displacement to be a pure
 * function of world position, computed once — so changing it means tracing the map again, a few
 * hundred milliseconds.
 *
 * `invalidatesTrace` is where that distinction lives, and a caller that ignores it gets one of two
 * bugs: a full re-trace on every nudge of a colour picker, or a wobble toggle that appears to do
 * nothing until the scene is reloaded.
 *
 * **Pure: no SDK, no DOM.** Reading and writing room metadata lives in `appearanceStore.ts`, for
 * the reason DESIGN.md gives under "SDK facts" — `@owlbear-rodeo/sdk` calls `getDetails()` at
 * module load, which reads `window.location.search`, so importing it anywhere in this file would
 * make every test below die with `ReferenceError: window is not defined`. The split is what keeps
 * the validation and the trace-invalidation rule testable, and those are the parts with rules in
 * them worth pinning.
 */

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";

/**
 * One key holding one object, rather than a key per setting.
 *
 * DESIGN.md notes that metadata is writable by any client and that the `Permission` enum does not
 * govern it, so the GM's client read-modify-writes rather than blind-overwriting. Keeping the
 * settings in a single key of our own namespace means that read-modify-write touches nothing
 * another extension owns.
 */
export const APPEARANCE_KEY = `${NAMESPACE}/appearance`;

export interface Appearance {
  /** Stroke colour as `#rrggbb`. */
  readonly strokeColor: string;
  /** Stroke width as a fraction of a grid square, so it reads the same at any scene scale. */
  readonly strokeWidthSquares: number;
  /**
   * How far the pen strays, as a fraction of a grid square. **Zero is off.**
   *
   * A magnitude rather than the boolean this started as. The boolean's problem was that the only
   * "on" value it could offer was the shipped 0.02 — three world units on a 150-unit grid, against
   * strokes 12.5 units wide — so the line moved by less than its own width and toggling it was
   * imperceptible (user, 2026-07-31). A switch between two states nobody can tell apart is not a
   * control, and the fix is a range rather than a better default.
   *
   * Baked in at trace time, so changing it costs a re-trace. See `invalidatesTrace`.
   */
  readonly wobbleSquares: number;
  /**
   * How far the pen travels between strays, as a fraction of a grid square.
   *
   * Amplitude is how far the line moves; this is how often. Short is a tremor, long is a slow bow,
   * and the two knobs together are most of what separates "shaky" from "drawn by hand".
   *
   * Also baked in at trace time, and — unlike amplitude — it changes the *point count*, because the
   * subdivision step is derived from it (`traceSettings.ts`).
   */
  readonly wobbleWavelengthSquares: number;
  /**
   * How many times each stroke is drawn. **One is off** — no texture, and the geometry is the
   * wobbled line exactly as it was before this existed.
   *
   * Multiple faint passes along slightly different paths is how a pencil reads: they cross and
   * diverge, darkening where they coincide. Chosen over varying width or opacity *along* a stroke
   * because `PathStyle` is per-item, so that route means bucketing a continuous quantity and the
   * eye finds the steps at every boundary.
   */
  readonly pencilPasses: number;
  /**
   * Opacity of each individual pass.
   *
   * Note these compound: three passes at 0.5 read as 0.875, not as 0.5. Raising the pass count
   * darkens the sketch unless this comes down — see `effectiveOpacity` in `pencil.ts`, which the
   * panel shows so the two controls do not appear to fight.
   */
  readonly pencilOpacity: number;
  /**
   * How far each pass strays from the true path, as a fraction of a grid square. **Zero is off.**
   *
   * The texture lives here. With zero scatter the passes lie exactly on top of one another and
   * only darken the line; the fraying is entirely a product of them landing in different places.
   */
  readonly pencilScatterSquares: number;
  /**
   * Which renderer draws the strokes. **`"shader"` is the default as of 2026-08-01.**
   *
   * `"shader"` emits `Effect` items that draw the marks from geometry passed as uniforms, which buys
   * a genuinely soft edge — something a `Path` cannot have at any setting. `"strokes"` emits `Path`
   * items and is what shipped before; it is kept because it is far cheaper to render (a handful of
   * items against a couple of hundred effects) and remains the fallback if the shader route ever
   * misbehaves on a scene.
   *
   * Both have now been judged in a room, which is what moved the default. Note this is in `differs`
   * but **not** in `invalidatesTrace`: both consume the identical wobbled geometry, so switching is
   * a redraw. That is deliberate, and it is what makes the two directly comparable.
   */
  readonly renderer: Renderer;
  /**
   * How far the ink fades out at a stroke's edge, as a fraction of its half-width. **Shader
   * renderer only** — a `Path` has a hard silhouette at every setting, which is the whole reason
   * the shader renderer exists.
   *
   * Zero is a hard edge, and reproduces what a `Path` looks like. At one the ramp runs from the
   * centreline out to twice the half-width, so the stroke has no solid core left and reads as a
   * smudge. The useful range is well below that.
   *
   * A uniform, so this is a redraw — deliberately absent from `invalidatesTrace`. It is the one
   * genuinely new control the shader route introduces, and the thing most worth tuning by eye.
   */
  readonly featherFraction: number;
}

export type Renderer = "strokes" | "shader";

const RENDERERS: readonly Renderer[] = ["strokes", "shader"];

/**
 * The values judged in a room — ink and geometry on 2026-07-28, the renderer on 2026-08-01.
 *
 * **Changing anything here changes what every existing table sees on its next reload**, because
 * `fromRoomMetadata` falls back per *field*: a room that has never been written takes all of these,
 * and a room written before a field existed takes that field's default while keeping its own values
 * for the rest. That per-field fallback is what makes a default change reach existing rooms at all,
 * so it is never merely tidiness.
 *
 * The `renderer` default was moved deliberately on that basis — see its note below.
 */
export const DEFAULT_APPEARANCE: Appearance = {
  strokeColor: "#603F21",
  strokeWidthSquares: 1 / 12,
  wobbleSquares: 0.02,
  wobbleWavelengthSquares: 0.35,
  // Off. The pencil texture is new and unjudged, so the shipped look is unchanged until someone
  // moves a slider — one pass at full opacity with no scatter is exactly the previous renderer.
  pencilPasses: 1,
  pencilOpacity: 1,
  pencilScatterSquares: 0,
  // The shader renderer, judged in a room 2026-08-01 and preferred (user's decision). This is a
  // deliberate change to what existing rooms see: a room whose stored appearance predates the
  // `renderer` field has no value for it, so the per-field fallback gives it this one and the room
  // switches to soft edges on its next reload. That is the intent, not a side effect — a room that
  // wants the old look can pick Lines in the panel, and the choice then persists.
  renderer: "shader",
  // A third of the half-width — the value the shader probe was judged at by eye, not a measured
  // optimum. It has no effect under the default `strokes` renderer, so it changes nothing for an
  // existing table.
  featherFraction: 1 / 3,
};

/**
 * Feather ceiling.
 *
 * One means the fade begins at the centreline and ends at twice the half-width, so nothing of the
 * stroke is at full strength anywhere. That is past useful rather than at the edge of it — but it
 * is the point where the control stops meaning anything, which is the right place for a ceiling,
 * and the alternative is guessing where "too soft" is before anyone has looked at it.
 */
export const MAX_FEATHER_FRACTION = 1;

/**
 * Width bounds, in grid squares.
 *
 * The floor is not cosmetic: below roughly a sixtieth of a square the line reads as a technical
 * drawing rather than a pen, which is the judgment that moved the shipped value up from 1/30 to
 * 1/12 in the first place. The ceiling stops a mis-typed value painting a quarter-square band over
 * the map, which on a scene with a few hundred strokes is indistinguishable from a broken build.
 */
export const MIN_WIDTH_SQUARES = 1 / 60;
export const MAX_WIDTH_SQUARES = 1 / 4;

/**
 * Wobble ceiling, a quarter of a grid square (user's choice, 2026-07-31).
 *
 * Worth knowing what the top of this range means, because it is a long way past "a shaky hand".
 * At 0.25 on a 150-unit grid the pen strays **37.5 world units**, which is more than the ~30-unit
 * width of the wall linework it is drawn from — so strokes visibly leave their walls. That is
 * larger than the placement drift diagnosed and fixed earlier the same day.
 *
 * It is not the same *kind* of error, and that is why a high ceiling is fine: the placement bug was
 * a systematic slide in one direction that grew down the map, where this is a smooth field varying
 * with position, so the line reads as drawn by hand rather than as misaligned. But the top of the
 * range is a stylistic statement, not a subtle one, and the useful settings are likely well below
 * it. Note also that the wavelength is 0.35 squares, so amplitudes approaching that stop reading as
 * a wobble at all and start rearranging the drawing.
 */
export const MAX_WOBBLE_SQUARES = 0.25;

/**
 * Wobble period bounds, in grid squares.
 *
 * The floor is where this gets interesting. `wobble.ts` layers a second octave at a *third* of the
 * wavelength, and the subdivision step has to resolve that finer one — below roughly two samples
 * per fine cycle the tremor stops being a tremor and becomes aliasing, which looks like random
 * jitter rather than a hand. The shipped configuration sits almost exactly on that limit already
 * (0.35 wavelength, 0.117 fine, 0.06 step), which is why `traceSettings.ts` now derives the step
 * *from* the wavelength rather than holding it constant. Sampling density is then the same at any
 * period, and this floor is about cost rather than quality: a shorter period means a finer step,
 * and point count — which is what the 8192-command item budget is spent on — scales inversely.
 *
 * At the floor the sketch carries roughly 3.5× the points it does at the default. Measured against
 * ~19k points and a handful of items, that is affordable; an order of magnitude lower would not be.
 */
export const MIN_WOBBLE_WAVELENGTH_SQUARES = 0.1;
export const MAX_WOBBLE_WAVELENGTH_SQUARES = 1.5;

/**
 * Pencil bounds.
 *
 * The pass ceiling is a cost limit, and a fairly generous one: every pass is a full copy of the
 * drawn geometry, so four passes means four times the path commands and four times the items. The
 * sketch runs ~19k points and a handful of items today, so four is affordable and eight would start
 * arguing with the 8192-command budget for nothing — beyond three or four passes the additional
 * ones fall on ground already covered.
 *
 * The scatter ceiling is roughly the stroke width itself (1/12 of a square at the default). Below
 * that the passes overlap into one furred line; near it they separate into visibly distinct
 * strokes, which is the sketchy-underdrawing look. Past it they would stop reading as one line at
 * all, which the wobble amplitude already does better.
 */
export const MAX_PENCIL_PASSES = 4;
export const MAX_PENCIL_SCATTER_SQUARES = 0.08;
export const MIN_PENCIL_OPACITY = 0.15;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Read an appearance out of room metadata, falling back per *field* rather than wholesale.
 *
 * Per-field matters for the case DESIGN.md flags: every client runs the same deployed build, so
 * skew happens only when a deploy lands mid-session and some clients have not reloaded. An older
 * client meeting a key it does not know should keep the settings it *does* understand rather than
 * reverting the lot to defaults, and a newer client meeting a partial object should fill the gaps.
 * Either way the failure mode is "player sees a slightly different style", never a crash.
 */
export function fromRoomMetadata(
  metadata: Record<string, unknown>,
): Appearance {
  const raw = metadata[APPEARANCE_KEY];
  if (typeof raw !== "object" || raw === null) return DEFAULT_APPEARANCE;

  const stored = raw as Record<string, unknown>;

  return {
    strokeColor: readColor(stored.strokeColor),
    strokeWidthSquares: readWidth(stored.strokeWidthSquares),
    wobbleSquares: readWobble(stored.wobbleSquares, stored.wobble),
    wobbleWavelengthSquares: readClamped(
      stored.wobbleWavelengthSquares,
      MIN_WOBBLE_WAVELENGTH_SQUARES,
      MAX_WOBBLE_WAVELENGTH_SQUARES,
      DEFAULT_APPEARANCE.wobbleWavelengthSquares,
    ),
    pencilPasses: Math.round(
      readClamped(stored.pencilPasses, 1, MAX_PENCIL_PASSES, DEFAULT_APPEARANCE.pencilPasses),
    ),
    pencilOpacity: readClamped(
      stored.pencilOpacity,
      MIN_PENCIL_OPACITY,
      1,
      DEFAULT_APPEARANCE.pencilOpacity,
    ),
    pencilScatterSquares: readClamped(
      stored.pencilScatterSquares,
      0,
      MAX_PENCIL_SCATTER_SQUARES,
      DEFAULT_APPEARANCE.pencilScatterSquares,
    ),
    renderer: readRenderer(stored.renderer),
    featherFraction: readClamped(
      stored.featherFraction,
      0,
      MAX_FEATHER_FRACTION,
      DEFAULT_APPEARANCE.featherFraction,
    ),
  };
}

/**
 * An unknown renderer name falls back rather than being trusted.
 *
 * The skew case this guards is real: a room whose GM has selected a renderer a later build adds,
 * read by a client running the older build. Rendering with the look it does understand beats
 * rendering nothing, and matches how every other field here degrades.
 */
function readRenderer(value: unknown): Renderer {
  return typeof value === "string" && (RENDERERS as readonly string[]).includes(value)
    ? (value as Renderer)
    : DEFAULT_APPEARANCE.renderer;
}

/** Clamp a finite number into a range, or fall back. The shape most of these fields want. */
function readClamped(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Wobble, accepting the boolean this field used to be.
 *
 * The migration is two lines and buys a property worth having: a room written by the previous
 * build keeps meaning what it meant. `false` was genuinely off, so it maps to zero; `true` was the
 * shipped amplitude, which is the default. Without this, a room that had wobble deliberately turned
 * off would silently turn it back on at the next reload — the sort of regression that looks like a
 * bug in the renderer rather than a schema change.
 */
function readWobble(value: unknown, legacy: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(MAX_WOBBLE_SQUARES, Math.max(0, value));
  }
  if (typeof legacy === "boolean") {
    return legacy ? DEFAULT_APPEARANCE.wobbleSquares : 0;
  }
  return DEFAULT_APPEARANCE.wobbleSquares;
}

function readColor(value: unknown): string {
  return typeof value === "string" && HEX_COLOR.test(value)
    ? value
    : DEFAULT_APPEARANCE.strokeColor;
}

/**
 * Clamped rather than rejected. A width slightly outside the range is a value someone chose and
 * the nearest legal one is what they meant; only a non-number is meaningless enough to discard.
 */
function readWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPEARANCE.strokeWidthSquares;
  }
  return Math.min(MAX_WIDTH_SQUARES, Math.max(MIN_WIDTH_SQUARES, value));
}

/**
 * Whether moving from `before` to `after` requires tracing the map again.
 *
 * Only wobble does. See the module header — this is the whole reason this function exists rather
 * than callers comparing fields by hand and getting it subtly wrong.
 */
export function invalidatesTrace(
  before: Appearance,
  after: Appearance,
): boolean {
  return (
    before.wobbleSquares !== after.wobbleSquares ||
    before.wobbleWavelengthSquares !== after.wobbleWavelengthSquares ||
    // Both change *geometry* — the pass count decides how many displaced copies exist, and the
    // scatter decides where they go. `pencilOpacity` is deliberately absent: it is PathStyle on
    // items that already exist, so it is the one pencil control that costs only a redraw.
    before.pencilPasses !== after.pencilPasses ||
    before.pencilScatterSquares !== after.pencilScatterSquares
  );
}

/** Whether anything changed at all, so an unrelated room-metadata write costs nothing. */
export function differs(before: Appearance, after: Appearance): boolean {
  return (
    before.strokeColor !== after.strokeColor ||
    before.strokeWidthSquares !== after.strokeWidthSquares ||
    before.wobbleSquares !== after.wobbleSquares ||
    before.wobbleWavelengthSquares !== after.wobbleWavelengthSquares ||
    before.pencilPasses !== after.pencilPasses ||
    before.pencilOpacity !== after.pencilOpacity ||
    before.pencilScatterSquares !== after.pencilScatterSquares ||
    // In `differs` but pointedly not in `invalidatesTrace` — both renderers consume the same
    // wobbled geometry, so switching costs a redraw and nothing more.
    before.renderer !== after.renderer ||
    // Also a redraw, and for the same kind of reason: it travels as a uniform on effects that are
    // rebuilt anyway, so it never touches the trace.
    before.featherFraction !== after.featherFraction
  );
}
