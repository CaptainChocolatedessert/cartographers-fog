/**
 * Phase 0 of the shader renderer — DESIGN.md, "Build plan: a `shader` renderer alongside the
 * existing one".
 *
 * **The batch size decides everything downstream and it is unknown.** How many named uniforms one
 * `Effect` will take sets how many effects the sketch costs, and the plan carries a stop condition:
 * if the workable batch is under about 32, the whole approach is reconsidered rather than built.
 * This probe answers that, plus the two questions that ride along with it.
 *
 * ## What it draws, and how to read it
 *
 * ```
 * row 1   ladder   16 / 32 / 64 / 128 / 256 slots, each FULL of real geometry
 * row 2   parking  256 slots, only 6 occupied — the padding scheme, on its own
 * row 3   cost     one batch over ten grid squares — pan and zoom, watch the frame rate
 * row 4   seam     one stroke split across two abutting effects
 * row 5   whole    the same stroke in ONE effect, directly below, for comparison
 * ```
 *
 * Every cell carries a **cyan outline and a striped bar** drawn in a separate, earlier `addItems`
 * call. Those are the fate-and-position markers: the stripes use `STRIPES_SKSL`, which has no custom
 * uniforms and is already proven to run, so a cell showing its outline and its stripes but no stroke
 * is a real finding about that slot count, while a cell showing nothing at all is a probe that
 * landed somewhere unexpected. This project has twice read a blank cell as an answer when it was a
 * bug in the diagnostic, and once destroyed the markers by batching them into the call that hung.
 *
 * ## Reading the log rather than the screen
 *
 * `addItems` accepting a payload is not the same as the shader compiling, and neither is the same as
 * the message bus surviving it — `dataUrlProbe.ts` found a payload that hung `addItems` without
 * resolving or rejecting, so a probe that cannot tell "refused" from "never returned" will report
 * the wrong thing. Each rung is its own timed call and logs one of `accepted`, `REJECTED` or
 * `NEVER RETURNED`. Combine with the screen:
 *
 * ```
 * accepted        + stroke drawn   -> this slot count works
 * accepted        + no stroke      -> the shader did not compile at this slot count
 * REJECTED                         -> the item was refused; the ceiling is below this
 * NEVER RETURNED                   -> the payload broke the bus; STOP, reload the room
 * ```
 *
 * Dev-only and **not installed** — see `background.ts`. Install it, take the numbers, record them in
 * DESIGN.md, and take it back out. It draws over the map.
 */

import OBR, {
  Command,
  buildEffect,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import {
  batchBounds,
  buildUniforms,
  parseHexColor,
  sdfSource,
  toPieces,
  type Piece,
  type SdfStyle,
} from "../sketch/sdf";
import { devLog } from "../devlog";
import type { Uniform } from "@owlbear-rodeo/sdk";
import type { ShaderUniform } from "../sketch/sdf";
import type { TracedSegment } from "../trace/chop";
import type { Vector2 } from "../geometry/vector";

/**
 * `sdf.ts` declares its own `ShaderUniform` because it must not import the SDK — see its header.
 * This is the guard that keeps the two in step: if Owlbear ever widens or narrows `Uniform`, the
 * build fails *here*, in the one file that imports both, rather than at a cast somewhere.
 *
 * Same pattern as `WallSatisfiesWallLike` in `visibility/walls.ts`, and for the same reason.
 */
type SdfUniformMatchesSdk = ShaderUniform extends Uniform ? true : never;
const _uniformShapeChecked: SdfUniformMatchesSdk = true;
void _uniformShapeChecked;

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const PROBE_KEY = `${NAMESPACE}/uniform-probe`;

/** `CONTROL`, matching `sketch/strokes.ts` — the layer the real renderer would use. */
const PROBE_LAYER = "CONTROL" as const;

/**
 * The ladder. Doubling, because the answer is wanted as an order of magnitude and a linear sweep
 * would cost five times the calls to say the same thing.
 *
 * 256 is included expecting it to fail. A ladder whose top rung passes has not found a ceiling, and
 * "at least 256" is a weaker answer than a bracket.
 */
const LADDER = [16, 32, 64, 128, 256];

/** The plan's stop condition. Below this, reconsider the approach rather than building it. */
const VIABLE_BATCH = 32;

/** Slot count for the cost and seam cells. Set to the largest rung the ladder accepted, then re-run. */
const COST_BATCH = 64;

/**
 * How long to wait before calling a call hung.
 *
 * Generous on purpose. A slow accept misreported as a hang would send the ceiling to a false floor,
 * which is exactly the mistake `storageProbe.ts` made when it could not tell rate limiting from size
 * rejection and bisected to 7825 and 8041 on a boundary that never moved.
 */
const CALL_TIMEOUT_MS = 8000;

/** Sepia, matching the shipped look, so the marks read as sketch strokes rather than as a test. */
const INK = parseHexColor("#603F21");

export async function runUniformProbe(): Promise<void> {
  if (!(await OBR.scene.isReady())) {
    devLog("warn", "uniform probe: no scene open");
    return;
  }

  await clearUniformProbe();

  const dpi = (await OBR.scene.grid.getDpi()) || 150;
  const origin = await viewCentre(dpi);

  const style: SdfStyle = {
    // The shipped stroke width, 1/12 of a square, so the feather is judged against a real line
    // rather than against a fat test bar.
    halfWidth: (dpi / 12) / 2,
    // A quarter of the half-width. Arbitrary starting point — tuning this by eye is phase 4's job,
    // not this probe's.
    feather: (dpi / 12) / 8,
    ink: INK,
  };

  const cells = layOutCells(origin, dpi);

  // ---- Pass one: every marker, in a single call, BEFORE any payload that might hang. --------
  //
  // Not an optimisation. The last shader session batched the reference outlines into the same call
  // as the payload, so when that call hung it took the markers with it and there was nothing left on
  // screen to diagnose the hang against.
  const markers: Item[] = [];
  for (const cell of cells) {
    markers.push(outline(cell));
    markers.push(stripeBar(cell));
  }

  try {
    await OBR.scene.local.addItems(markers);
    devLog("info", `uniform probe: ${cells.length} cell markers drawn at the view centre`);
  } catch (error) {
    devLog("error", "uniform probe: could not draw the markers — stopping", error);
    return;
  }

  devLog(
    "info",
    `uniform probe: ladder ${LADDER.join("/")} slots, cost+seam at ${COST_BATCH}, ` +
      `stop condition is a workable batch below ${VIABLE_BATCH}`,
  );

  // ---- Pass two: one call per cell, each timed, each reported whatever happens. -------------
  //
  // Separate calls because a rejection has to name its rung. One call carrying all five would fail
  // as a unit and say only that something in it was too big.
  let largestAccepted = 0;
  for (const cell of cells) {
    const outcome = await addCell(cell, style);
    if (outcome === "accepted" && cell.kind === "ladder") {
      largestAccepted = Math.max(largestAccepted, cell.batchSize);
    }
    if (outcome === "hung") {
      devLog(
        "error",
        `uniform probe: ${cell.label} NEVER RETURNED after ${CALL_TIMEOUT_MS}ms — the payload ` +
          `broke the message bus. Stop here, reload the room, and treat every later cell as ` +
          `unmeasured. Same failure as the 1.37MB data: URL.`,
      );
      break;
    }
  }

  // Logged unconditionally, including the discouraging cases. A diagnostic gated on the good outcome
  // reports silence when it matters most — the mistake that hid the stalled accumulator for two
  // sessions.
  if (largestAccepted === 0) {
    devLog(
      "error",
      "uniform probe: NO ladder rung was accepted. Either the effect build is wrong or custom " +
        "uniforms are unavailable — check the smallest rung's cell against its stripe bar before " +
        "concluding anything about the SDK.",
    );
  } else if (largestAccepted < VIABLE_BATCH) {
    devLog(
      "warn",
      `uniform probe: largest ACCEPTED rung is ${largestAccepted}, below the ${VIABLE_BATCH} ` +
        `stop condition. Per the build plan, reconsider the shader renderer rather than building ` +
        `it — at this batch size the item count is worse than the Path renderer it replaces.`,
    );
  } else {
    devLog(
      "info",
      `uniform probe: largest ACCEPTED rung is ${largestAccepted} slots. Now READ THE SCREEN — ` +
        `acceptance is not compilation. Each rung should show a REGULAR LATTICE of small diagonal ` +
        `ticks, one per slot. A hole in the lattice, a crooked tick or a blank cell means that ` +
        `slot count does not work, and the real ceiling is the rung below it. A cell showing its ` +
        `cyan outline and stripe bar but nothing else compiled to nothing.`,
    );
  }

  devLog(
    "info",
    "uniform probe: then (2) pan and zoom over the cost cell watching for frame-rate loss, and " +
      "(3) look along the seam cell's join for a dark or light line, comparing against the whole " +
      "stroke directly below it. Record all three in DESIGN.md and uninstall the probe.",
  );
}

export async function clearUniformProbe(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => PROBE_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

interface Cell {
  readonly label: string;
  readonly kind: "ladder" | "parking" | "cost" | "seam" | "whole";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly batchSize: number;
  /** Real geometry for this cell, in world space. Never more than `batchSize` pieces. */
  readonly pieces: readonly Piece[];
  /**
   * Bounds the effect covers, when they must not be derived from the pieces.
   *
   * The seam cells need this: their whole point is two effects meeting on an exact shared edge, and
   * bounds fitted to each half's geometry would leave a gap between them and answer a different
   * question.
   */
  readonly forcedBounds?: { min: Vector2; max: Vector2 };
  /**
   * Ink width for this cell, when the shipped width would not fit the geometry.
   *
   * The ladder needs it. Its first run drew every rung above 16 as a solid brown slab, because the
   * marks were packed closer than a stroke is wide — and a slab proves the shader *ran* while
   * hiding whether the individual slots are right, which is the actual question. A cell that packs
   * more marks has to draw them thinner. Width costs no uniforms, so nothing about the measurement
   * changes; only whether the answer is legible.
   */
  readonly style?: SdfStyle;
}

/**
 * Five rows, laid out downward from the view centre and **never overlapping**.
 *
 * Non-overlap is not cosmetic. Two probe cells centred on the same point last session made both
 * unreadable, and the plan's three questions are independent — a cost cell drawn over a ladder rung
 * would answer neither.
 */
function layOutCells(origin: Vector2, dpi: number): Cell[] {
  const cells: Cell[] = [];
  const gap = dpi * 0.5;

  // --- Row 1: the ladder, full occupancy. ---
  //
  // A grid of separate ticks, not one long serpentine. The first run used a serpentine and every
  // rung above 16 came back as a solid brown slab — the rows were packed closer than a stroke is
  // wide. A slab is not a null result, but it is not the result wanted either: it says the shader
  // compiled while saying nothing about whether the individual slots hold the right geometry, which
  // is the whole question at 128 and 256. Separate ticks make a dropped or misplaced slot show up as
  // a hole in a regular lattice, which is about the most legible failure a cell can have.
  const rungWidth = dpi * 3.2;
  const rungHeight = dpi * 2.4;
  const rowSpan = LADDER.length * rungWidth + (LADDER.length - 1) * gap;
  let y = origin.y - dpi * 6;

  LADDER.forEach((batchSize, index) => {
    const x = origin.x - rowSpan / 2 + index * (rungWidth + gap);
    const ticks = tickGrid(x, y, rungWidth, rungHeight, batchSize, dpi * 0.15);
    cells.push({
      label: `ladder ${batchSize}`,
      kind: "ladder",
      x,
      y,
      width: rungWidth,
      height: rungHeight,
      batchSize,
      // Exactly `batchSize` pieces, so the rung tests a FULL batch. A half-empty one would pass at a
      // slot count the real renderer could not use.
      pieces: ticks.pieces,
      style: ticks.style,
    });
  });

  // --- Row 2: parking, on its own. ---
  y += rungHeight + gap * 2;
  const parkWidth = dpi * 3;
  cells.push({
    label: `parking ${COST_BATCH} slots, 6 occupied`,
    kind: "parking",
    x: origin.x - parkWidth / 2,
    y,
    width: parkWidth,
    height: rungHeight,
    batchSize: COST_BATCH,
    // Six real pieces against a full slot count. If the padding is wrong the cell fills with ink or
    // shows marks running off toward the sentinel; if it is right, six clean strokes and nothing
    // else. This is the one mechanism the whole renderer rests on.
    //
    // **Answered on the first run: six clean ticks, no stray ink.** Kept because it is the cheapest
    // possible regression check on the sentinel, and it costs one item.
    pieces: serpentine(
      origin.x - parkWidth / 2,
      y,
      parkWidth,
      rungHeight,
      6,
      dpi * 0.2,
    ),
  });

  // --- Row 3: cost, over about ten grid squares. ---
  y += rungHeight + gap * 2;
  const costWidth = dpi * 10;
  const costHeight = dpi * 4;
  cells.push({
    label: `cost ${COST_BATCH} slots over 10 squares`,
    kind: "cost",
    x: origin.x - costWidth / 2,
    y,
    width: costWidth,
    height: costHeight,
    batchSize: COST_BATCH,
    pieces: serpentine(
      origin.x - costWidth / 2,
      y,
      costWidth,
      costHeight,
      COST_BATCH,
      dpi * 0.3,
    ),
  });

  // --- Rows 4 and 5: the seam, and the same stroke whole. ---
  //
  // A matched pair differing in exactly one thing — whether the stroke is split across two effects.
  // Same geometry, same slot count, same style, drawn one above the other at the same x so the eye
  // can flick between them. Every wrong conclusion in the last shader session came from changing two
  // variables at once.
  y += costHeight + gap * 2;
  const seamWidth = dpi * 6;
  const seamHeight = dpi * 1.6;
  const seamX = origin.x - seamWidth / 2;
  const seamMid = seamX + seamWidth / 2;
  const stroke = diagonalPieces(seamX, y, seamWidth, seamHeight, 24);

  cells.push({
    label: "seam left half",
    kind: "seam",
    x: seamX,
    y,
    width: seamWidth / 2,
    height: seamHeight,
    batchSize: COST_BATCH,
    pieces: stroke.filter((p) => (p.a.x + p.b.x) / 2 < seamMid),
    forcedBounds: {
      min: { x: seamX, y },
      max: { x: seamMid, y: y + seamHeight },
    },
  });
  cells.push({
    label: "seam right half",
    kind: "seam",
    x: seamMid,
    y,
    width: seamWidth / 2,
    height: seamHeight,
    batchSize: COST_BATCH,
    pieces: stroke.filter((p) => (p.a.x + p.b.x) / 2 >= seamMid),
    forcedBounds: {
      min: { x: seamMid, y },
      max: { x: seamX + seamWidth, y: y + seamHeight },
    },
  });

  y += seamHeight + gap;
  cells.push({
    label: "same stroke, ONE effect",
    kind: "whole",
    x: seamX,
    y,
    width: seamWidth,
    height: seamHeight,
    batchSize: COST_BATCH,
    pieces: diagonalPieces(seamX, y, seamWidth, seamHeight, 24),
    forcedBounds: {
      min: { x: seamX, y },
      max: { x: seamX + seamWidth, y: y + seamHeight },
    },
  });

  return cells;
}

/**
 * Add one cell's effect, on its own, and say what happened.
 *
 * @returns `accepted`, `rejected` or `hung` — three outcomes, never collapsed into two. A probe that
 * catches every exception as one thing invents findings; that is how "the item ceiling moves" got
 * recorded as a fact when the ceiling had never moved.
 */
async function addCell(
  cell: Cell,
  defaultStyle: SdfStyle,
): Promise<"accepted" | "rejected" | "hung"> {
  const style = cell.style ?? defaultStyle;
  const margin = style.halfWidth + style.feather;
  const bounds = cell.forcedBounds
    ? {
        // Expanded outward on three sides only would skew the seam; the seam cells want their shared
        // edge exact, so a forced box is used verbatim. The stroke is kept clear of it by geometry.
        min: cell.forcedBounds.min,
        max: cell.forcedBounds.max,
      }
    : batchBounds(cell.pieces, margin);

  let uniforms;
  try {
    uniforms = buildUniforms(cell.pieces, bounds, style, cell.batchSize);
  } catch (error) {
    // A throw here is a probe bug, not a finding about the SDK, and saying so saves a session.
    devLog("error", `uniform probe: ${cell.label} — could not build uniforms`, error);
    return "rejected";
  }

  const effect = buildEffect()
    .width(bounds.max.x - bounds.min.x)
    .height(bounds.max.y - bounds.min.y)
    .position({ x: bounds.min.x, y: bounds.min.y })
    .sksl(sdfSource(cell.batchSize))
    // Spread, not a cast. `ShaderUniform` is structurally the SDK's `Uniform` and the only
    // mismatch is the readonly array, so copying it is enough — and it means a future divergence
    // in the *shape* fails the build here instead of being silenced. `SdfUniformMatchesSdk` below
    // is the assertion that pins it.
    .uniforms([...uniforms])
    // No parent. A `STANDALONE` effect respects its own alpha and is not clipped — bars B and F —
    // which is the whole reason the shader can draw the mark instead of merely texturing a stencil.
    .effectType("STANDALONE")
    .blendMode("SRC_OVER")
    .zIndex(2)
    .disableAutoZIndex(true)
    .layer(PROBE_LAYER)
    .locked(true)
    .disableHit(true)
    .name(`uniform probe ${cell.label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();

  const started = performance.now();
  let settled = false;

  const outcome = await Promise.race([
    OBR.scene.local
      .addItems([effect])
      .then(() => {
        settled = true;
        return "accepted" as const;
      })
      .catch((error: unknown) => {
        settled = true;
        devLog(
          "warn",
          `uniform probe: ${cell.label} (${cell.batchSize} slots, ` +
            `${uniforms.length} uniforms) REJECTED`,
          error,
        );
        return "rejected" as const;
      }),
    new Promise<"hung">((resolve) =>
      setTimeout(() => resolve("hung"), CALL_TIMEOUT_MS),
    ),
  ]);

  if (outcome === "accepted") {
    devLog(
      "info",
      `uniform probe: ${cell.label} (${cell.batchSize} slots, ${uniforms.length} uniforms, ` +
        `${cell.pieces.length} occupied) accepted in ${(performance.now() - started).toFixed(0)}ms` +
        ` — acceptance is not compilation, check the cell`,
    );
  } else if (outcome === "hung" && !settled) {
    // Deliberately not awaited any further. The point of the timeout is that this call may never
    // settle, and awaiting it would hang the probe exactly as it hung the bus.
  }

  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * `count` separate short ticks in a regular lattice, with an ink width that fits the spacing.
 *
 * The point is that **every slot gets its own visible mark**. A serpentine merges into one shape, so
 * a slot holding wrong geometry is invisible inside it; a lattice of separate ticks turns the same
 * fault into a missing or crooked tick against a regular pattern, which the eye finds instantly even
 * at 256 of them.
 *
 * Ticks are diagonal rather than axis-aligned so that a slot whose two endpoints were swapped or
 * crossed still reads as wrong. The width is derived from the spacing rather than taken from the
 * shipped look, because a rung that packs more marks must draw them thinner or it saturates — which
 * is exactly what went wrong the first time. Width costs no uniforms, so this changes nothing about
 * what is being measured.
 */
function tickGrid(
  x: number,
  y: number,
  width: number,
  height: number,
  count: number,
  inset: number,
): { pieces: Piece[]; style: SdfStyle } {
  const left = x + inset;
  const top = y + inset;
  const usableWidth = width - inset * 2;
  const usableHeight = height - inset * 2;

  // A lattice with roughly the cell's aspect ratio, so the ticks are evenly spread rather than
  // crowded on one axis.
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt((count * usableWidth) / Math.max(usableHeight, 1))),
  );
  const rows = Math.max(1, Math.ceil(count / columns));
  const pitchX = usableWidth / columns;
  const pitchY = usableHeight / rows;
  const pitch = Math.min(pitchX, pitchY);

  // A third of the pitch, so neighbouring ticks stay clearly separated even where the lattice is
  // tightest. At 256 in this cell that is a very small mark — which is fine, and incidentally
  // demonstrates the resolution independence: zoom in and it stays smooth.
  const halfWidth = pitch / 6;
  const reach = pitch * 0.3;

  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const cx = left + (Math.floor(i % columns) + 0.5) * pitchX;
    const cy = top + (Math.floor(i / columns) + 0.5) * pitchY;
    pieces.push({
      a: { x: cx - reach, y: cy - reach },
      b: { x: cx + reach, y: cy + reach },
    });
  }

  return {
    pieces,
    style: { halfWidth, feather: halfWidth / 3, ink: INK },
  };
}

/**
 * A boustrophedon filling the cell with exactly `count` pieces.
 *
 * Built through `toPieces` rather than assembled by hand, so the probe exercises the same flattening
 * the renderer will. Inset from the cell edge so a full-occupancy rung cannot be mistaken for ink
 * spilling out of its rectangle.
 */
function serpentine(
  x: number,
  y: number,
  width: number,
  height: number,
  count: number,
  inset: number,
): Piece[] {
  const left = x + inset;
  const right = x + width - inset;
  const top = y + inset;
  const bottom = y + height - inset;

  // Each row costs two pieces — one run across, one step down — so this is the row count that lands
  // on `count` pieces or just over. The tail is trimmed below.
  const rows = Math.max(2, Math.ceil((count + 1) / 2));
  const step = (bottom - top) / Math.max(1, rows - 1);

  const points: Vector2[] = [];
  for (let row = 0; row < rows; row++) {
    const rowY = top + row * step;
    const [from, to] = row % 2 === 0 ? [left, right] : [right, left];
    points.push({ x: from, y: rowY });
    points.push({ x: to, y: rowY });
  }

  return toPieces([asSegment(points)]).slice(0, count);
}

/** A gently kinked diagonal, subdivided — the shape a real traced stroke has after the wobble. */
function diagonalPieces(
  x: number,
  y: number,
  width: number,
  height: number,
  count: number,
): Piece[] {
  const points: Vector2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push({
      x: x + width * t,
      // A shallow sine, so the stroke crosses the seam at an angle rather than perpendicular —
      // a perpendicular crossing is the easiest case and would understate any join artefact.
      y: y + height * (0.5 + 0.28 * Math.sin(t * Math.PI * 2.2)),
    });
  }
  return toPieces([asSegment(points)]);
}

function asSegment(points: readonly Vector2[]): TracedSegment {
  return {
    points,
    midpoint: points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 },
    length: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Markers — drawn first, in their own call, so they survive whatever the payloads do
// ---------------------------------------------------------------------------------------------

/**
 * A cyan outline round each cell.
 *
 * Cyan because nothing on a map is cyan, so its presence cannot be mistaken for map showing through
 * and its absence cannot be mistaken for anything else. On `POINTER`, one layer below the effects,
 * so it cannot hide a mark it is meant to frame.
 */
function outline(cell: Cell): Item {
  const { x, y, width, height } = cell;
  const commands: PathCommand[] = [
    [Command.MOVE, x, y],
    [Command.LINE, x + width, y],
    [Command.LINE, x + width, y + height],
    [Command.LINE, x, y + height],
    [Command.CLOSE],
  ];

  return buildPath()
    .commands(commands)
    .position({ x: 0, y: 0 })
    .strokeColor("#00e5ff")
    .strokeOpacity(1)
    .strokeWidth(2)
    .fillOpacity(0)
    .zIndex(0)
    .disableAutoZIndex(true)
    .layer("POINTER")
    .locked(true)
    .disableHit(true)
    .name(`uniform probe outline — ${cell.label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();
}

/**
 * A striped bar along the bottom of each cell, from a shader with **no custom uniforms**.
 *
 * The control. `STRIPES_SKSL` is the shader bars B and F already proved runs, so this bar appearing
 * says the layer, the position and the effect plumbing are all sound — which means an empty cell
 * above it is a fact about that slot count rather than about the probe. Without it, "nothing drew"
 * has two explanations and the ladder cannot be read at all.
 */
function stripeBar(cell: Cell): Item {
  const height = Math.max(4, cell.height * 0.08);
  const y = cell.y + cell.height - height;

  return buildEffect()
    .width(cell.width)
    .height(height)
    .position({ x: cell.x, y })
    .sksl(STRIPES_SKSL)
    .uniforms([])
    .effectType("STANDALONE")
    .blendMode("SRC_OVER")
    .zIndex(1)
    .disableAutoZIndex(true)
    .layer(PROBE_LAYER)
    .locked(true)
    .disableHit(true)
    .name(`uniform probe control bar — ${cell.label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();
}

/** Verbatim from `blendProbe.ts`, where it was measured to run. Built-in `size`, nothing custom. */
const STRIPES_SKSL = `
uniform float2 size;

half4 main(float2 coord) {
  float stripe = step(0.5, fract(coord.x / size.x * 16.0));
  return half4(stripe);
}
`;

/** Centre of what the user is currently looking at, so the probe cannot land off-screen. */
async function viewCentre(dpi: number): Promise<Vector2> {
  try {
    const [width, height] = await Promise.all([
      OBR.viewport.getWidth(),
      OBR.viewport.getHeight(),
    ]);
    return await OBR.viewport.inverseTransformPoint({
      x: width / 2,
      y: height / 2,
    });
  } catch {
    devLog("warn", "uniform probe: viewport unavailable, drawing near the origin");
    return { x: dpi, y: dpi };
  }
}
