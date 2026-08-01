/**
 * Does an `Effect`'s `blendMode` composite against *other items*, or only within its own drawing?
 *
 * This one question decides how the sketch gets a pencil texture and variable stroke width.
 *
 * The wanted answer is that it does. Then the sketch stays vector — crisp at any zoom, masked per
 * segment, wall margin and item counts untouched — and the texture is one extra item running a
 * procedural noise shader with `DST_IN`, eroding the strokes' alpha. Variable width comes free with
 * it, since thinning a stroke's edges *is* varying its width, and continuously rather than in the
 * buckets the user rejected.
 *
 * If the answer is no, texture means going raster, and that is a much larger change: an `Image` has
 * no style at all — no opacity, no tint, no clipping — so revealing it live means either tile
 * toggling at a granularity far coarser than today's masking, or re-compositing a boundary ring on
 * every move. See DESIGN.md, "Rendering modes for `sketch_region`", and `dataUrlProbe.ts`, which
 * answers the question that route depends on.
 *
 * ## Three bars, because a blank result has two causes
 *
 * The obvious probe draws one path, puts a `DST_IN` effect over it, and looks. But if nothing
 * happens, that reads identically whether the blend was ignored *or* the shader never drew at all —
 * a wrong SkSL string, an unsupported uniform, an effect sized to nothing. This project has paid
 * for that mistake before: DESIGN.md's storage probe invented a finding because it could not tell
 * its failure modes apart.
 *
 * So three bars sit side by side, identical except for what is laid over them:
 *
 *   A — path alone.            Proves paths draw here at all.
 *   B — path + SRC_OVER.       Proves the *shader* draws, and shows the stripe pattern.
 *   C — path + DST_IN.         The actual question.
 *
 * Reading them:
 *
 *   B striped, C striped   -> blend modes reach other items. Take the vector route.
 *   B striped, C solid     -> the shader runs but blending is scoped to the effect. Raster route.
 *   B blank                -> the probe is broken, not the SDK. Fix it before concluding anything.
 *
 * Development only. Items are **local**, so nothing is networked and nothing touches the GM's
 * scene, and everything is removed on the next run or by `clearBlendProbe`.
 */

import OBR, {
  Command,
  buildEffect,
  buildPath,
  type Item,
  type PathCommand,
} from "@owlbear-rodeo/sdk";

import { devLog } from "../devlog";

const NAMESPACE = "io.github.captainchocolatedessert.cartographers-fog";
const PROBE_KEY = `${NAMESPACE}/blend-probe`;

/**
 * Horizontal stripes, alternating fully opaque and fully transparent.
 *
 * Deliberately hard-edged rather than a smooth gradient: the question is whether blending happens
 * at all, and a binary pattern answers it at a glance where a soft one invites "is that slightly
 * darker?". `size` is a built-in uniform, so nothing here depends on custom uniforms working —
 * which matters, since `Uniform.value` admits only numbers, vectors and matrices, and a shader
 * that needed a texture could not be expressed at all.
 *
 * Returns premultiplied white: rgb and a move together, so the SRC_OVER bar shows white stripes
 * and the DST_IN bar has the alpha channel the blend needs.
 */
const STRIPES_SKSL = `
uniform float2 size;

half4 main(float2 coord) {
  float stripe = step(0.5, fract(coord.y / size.y * 8.0));
  return half4(stripe);
}
`;

/**
 * Cell J: the shader draws the stroke itself, from geometry passed as uniforms.
 *
 * This is the inversion the stencil approach invites. If the shader knows where the line is, it
 * needs no parent to clip it — `STANDALONE` effects respect their own alpha (bars B and F), so it
 * can paint the mark and return nothing elsewhere. And unlike a clipped stencil, it *can* soften
 * its own edges, because here it knows where they are.
 *
 * Four unknowns are tested at once, which is the point of spending a cell on it:
 *
 *   1. Do custom uniforms work at all? Seven are passed; `Uniform.value` admits vectors.
 *   2. Do constant-bound `for` loops compile? The polyline needs one.
 *   3. Can `coord` be mapped to stable WORLD space? Done by normalising against the built-in
 *      `size` and interpolating across a world rect passed in — so it holds however `coord` and
 *      `size` are scaled, which matters because a texture keyed to the view would swim on every
 *      pan. §6 rejects time-seeded wobble for making the map breathe; view-seeded is worse.
 *   4. Does an SDF give genuinely soft edges and continuous width?
 *
 * **The faint blue wash over the whole rectangle is deliberate.** A shader that fails to compile
 * draws nothing, and so does a shader whose distance maths is wrong — the wash separates them. If
 * the cell is entirely empty the shader did not compile; if the wash is there but no stroke, it
 * compiled and the geometry is wrong. Same discipline as the cyan patches.
 */
const SDF_SKSL = `
uniform float2 size;
uniform float2 worldMin;
uniform float2 worldSpan;
uniform float2 p0;
uniform float2 p1;
uniform float2 p2;
uniform float2 p3;
uniform float halfWidth;

float sdSeg(float2 p, float2 a, float2 b) {
  float2 pa = p - a;
  float2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h);
}

half4 main(float2 coord) {
  float2 w = worldMin + (coord / size) * worldSpan;

  float d = 1000000.0;
  for (int i = 0; i < 3; i++) {
    float2 a = i == 0 ? p0 : (i == 1 ? p1 : p2);
    float2 b = i == 0 ? p1 : (i == 1 ? p2 : p3);
    d = min(d, sdSeg(w, a, b));
  }

  float t = clamp((w.x - worldMin.x) / max(worldSpan.x, 0.0001), 0.0, 1.0);
  float hw = halfWidth * (1.0 - 0.7 * t);
  float edge = max(hw * 0.4, 0.0001);
  float a = 1.0 - smoothstep(hw - edge, hw + edge, d);

  float grain = 0.7 + 0.3 * sin(w.x * 0.31) * sin(w.y * 0.37);
  a = a * grain;

  float3 ink = float3(0.38, 0.25, 0.13);
  half4 stroke = half4(ink.x * a, ink.y * a, ink.z * a, a);
  half4 wash = half4(0.0, 0.03, 0.04, 0.09);
  return stroke + wash * (1.0 - a);
}
`;

interface Bar {
  readonly label: string;
  readonly blend: "SRC_OVER" | "DST_IN" | null;
  /**
   * `diagonal` draws a thin stroked line instead of a filled block.
   *
   * Bar E needs it, and its absence is a hole in bars C and D: those attach an effect to a
   * rectangle *the same size as the effect*, so an effect clipped to its parent would look
   * identical to one that was not — there is nothing outside the parent to clip away. A shape
   * much smaller than its bounding box is what makes clipping observable at all.
   */
  readonly shape?: "rect" | "diagonal" | "quad" | "none";
  /** Cell J supplies its own shader; everything else uses the stripes. */
  readonly sksl?: string;
  /** Custom uniforms, built from the cell's world rect. Cell J only. */
  readonly uniformsFor?: (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => { name: string; value: number | { x: number; y: number } }[];
  /**
   * Fill opacity of the parent shape. Defaults to 1.
   *
   * Zero is the interesting case: if an attached effect still clips to an *invisible* fill, then
   * the parent is only a clip region and the shader can paint the whole visible mark — soft edges,
   * grain, fading to nothing — with no need for a subtractive blend at all.
   */
  readonly parentFillOpacity?: number;
  /**
   * `STANDALONE` sits in the layer and composites into it. `ATTACHMENT` binds to a parent item,
   * which is the reason bar D exists: an attached effect may composite *with* its parent rather
   * than into the layer, and that is a different mechanism rather than a rerun of the same one.
   */
  readonly effectType?: "STANDALONE" | "ATTACHMENT";
}

const BARS: Bar[] = [
  { label: "A reference (path only)", blend: null },
  { label: "B shader visible (SRC_OVER)", blend: "SRC_OVER", effectType: "STANDALONE" },
  { label: "C standalone (DST_IN)", blend: "DST_IN", effectType: "STANDALONE" },
  { label: "D attached (DST_IN)", blend: "DST_IN", effectType: "ATTACHMENT" },
  // E and F are a matched pair, and the pairing is the point. The first attempt at E changed the
  // shader *and* the shape at once, so a blank cell could not be told from a shader that failed to
  // compile. These differ in exactly one thing — whether the effect is attached — and both run the
  // striped shader that bars B and D already proved works.
  {
    label: "E attached to a line (SRC_OVER)",
    blend: "SRC_OVER",
    effectType: "ATTACHMENT",
    shape: "diagonal",
  },
  {
    label: "F same line, NOT attached (SRC_OVER)",
    blend: "SRC_OVER",
    effectType: "STANDALONE",
    shape: "diagonal",
  },
  // G tests the rule that D, E and F together imply: an attached effect is clipped to its
  // parent's *fill*. Same diagonal, same shader, same attachment as E — the only change is that
  // the stroke is drawn as a closed filled quad rather than a stroked centerline.
  //
  // This is the cell that decides whether the aesthetic goal is reachable. A filled outline is
  // exactly what a calligraphic nib produces anyway, so if clipping follows fill then one change
  // to how strokes are emitted buys continuous variable width *and* texture confined to the ink.
  {
    label: "G attached to a filled quad (SRC_OVER)",
    blend: "SRC_OVER",
    effectType: "ATTACHMENT",
    shape: "quad",
  },
  // H is the one that would matter most. If an attached effect clips to an *invisible* fill, the
  // parent stops being the drawing and becomes only a clip region — and the shader paints the whole
  // visible mark, with arbitrary alpha. Soft edges, grain and a stroke fading to nothing all come
  // for free, and none of it needs the subtractive blend that C and D showed is unavailable.
  {
    label: "H attached to an INVISIBLE quad (SRC_OVER)",
    blend: "SRC_OVER",
    effectType: "ATTACHMENT",
    shape: "quad",
    parentFillOpacity: 0,
  },
  // I re-asks the erosion question on the geometry that actually clips. D answered it on a filled
  // *rectangle* the same size as its effect, which is a different enough situation to be worth one
  // cell rather than an assumption.
  {
    label: "I attached quad, DST_IN (erosion)",
    blend: "DST_IN",
    effectType: "ATTACHMENT",
    shape: "quad",
  },
  // J has no parent at all — the shader is the drawing. See SDF_SKSL.
  {
    label: "J shader draws the stroke (SDF, no parent)",
    blend: "SRC_OVER",
    effectType: "STANDALONE",
    shape: "none",
    sksl: SDF_SKSL,
    uniformsFor: (x, y, width, height) => [
      { name: "worldMin", value: { x, y } },
      { name: "worldSpan", value: { x: width, y: height } },
      // A gentle zigzag, so the loop has three real segments and the joins are visible.
      { name: "p0", value: { x: x + width * 0.1, y: y + height * 0.75 } },
      { name: "p1", value: { x: x + width * 0.35, y: y + height * 0.3 } },
      { name: "p2", value: { x: x + width * 0.65, y: y + height * 0.7 } },
      { name: "p3", value: { x: x + width * 0.9, y: y + height * 0.25 } },
      { name: "halfWidth", value: height / 14 },
    ],
  },
];

export async function runBlendProbe(): Promise<void> {
  if (!(await OBR.scene.isReady())) {
    devLog("warn", "blend probe: no scene open");
    return;
  }

  await clearBlendProbe();

  try {
    const dpi = (await OBR.scene.grid.getDpi()) || 150;
    const origin = await viewCentre(dpi);

    const barWidth = dpi * 2;
    const barHeight = dpi;
    const gap = dpi * 0.6;
    const items: Item[] = [];

    const span = BARS.length * barWidth + (BARS.length - 1) * gap;

    BARS.forEach((bar, index) => {
      const x = origin.x + index * (barWidth + gap) - span / 2;
      const y = origin.y - barHeight / 2;

      // A bright patch behind the bar, on a *lower layer*.
      //
      // Last run turned on distinguishing "the bar was cut away" from "the effect painted black",
      // and against dark fog those look identical — it took manually checking where a bar
      // overlapped the map. This removes the ambiguity: if the blend reaches the bar, the stripe
      // gaps show CYAN; if the effect merely painted itself, they show BLACK.
      //
      // `POINTER` because it is above `FOG` (so the patch is not hidden) but below `CONTROL` (so a
      // `DST_IN` composited into `CONTROL` should not erase it — layer isolation is the assumption,
      // and DESIGN.md is clear that layer order is a hint rather than a contract). The test is
      // self-diagnosing: the patch extends past the bar, so if no cyan border is visible at all
      // then this assumption failed and the gap colour proves nothing — fall back to checking
      // where a bar overlaps the map.
      items.push(
        backdrop(
          x - barWidth * 0.06,
          y - barHeight * 0.12,
          barWidth * 1.12,
          barHeight * 1.24,
          bar.label,
        ),
      );

      // Built first and kept, because an attached effect needs its parent's id — which only
      // exists once the item is built.
      // `none` means the shader is the whole drawing and there is nothing to attach to.
      const path =
        bar.shape === "none"
          ? null
          : bar.shape === "diagonal"
            ? diagonalStroke(x, y, barWidth, barHeight, bar.label)
            : bar.shape === "quad"
              ? diagonalQuad(
                  x,
                  y,
                  barWidth,
                  barHeight,
                  bar.label,
                  bar.parentFillOpacity ?? 1,
                )
              : rectangle(x, y, barWidth, barHeight, bar.label);
      if (path) items.push(path);

      if (!bar.blend) return;

      let effect = buildEffect()
        .width(barWidth)
        .height(barHeight)
        .position({ x, y })
        .sksl(bar.sksl ?? STRIPES_SKSL)
        .uniforms(bar.uniformsFor?.(x, y, barWidth, barHeight) ?? [])
        .effectType(bar.effectType ?? "STANDALONE")
        .blendMode(bar.blend)
        // Above the bar it is meant to act on, and pinned: auto z-index would decide this
        // for us, and the whole test is about what happens when one draws over the other.
        .zIndex(2)
        .disableAutoZIndex(true)
        .layer(SKETCH_LAYER)
        .locked(true)
        .disableHit(true)
        .name(`blend probe ${bar.label}`)
        .metadata({ [PROBE_KEY]: true });

      if (bar.effectType === "ATTACHMENT" && path) {
        effect = effect.attachedTo(path.id);
      }

      items.push(effect.build());
    });

    await OBR.scene.local.addItems(items);

    devLog(
      "info",
      "blend probe: ten cells at the centre of your view, each on a CYAN patch. " +
        "J is the new one and the important one: NO parent item at all — the shader draws the " +
        "stroke itself from four points passed as uniforms. Expect a tapered, soft-edged, " +
        "slightly mottled zigzag over a faint blue wash. " +
        "SOFT TAPERED ZIGZAG => custom uniforms work, loops compile, and an SDF gives real soft " +
        "edges and continuous width. THEN PAN AND ZOOM: it must stay locked to the map. If it " +
        "swims or the mottling crawls, coord cannot be mapped to stable world space and the whole " +
        "approach is out. " +
        "WASH BUT NO ZIGZAG => the shader compiled and the distance maths is wrong (my bug). " +
        "COMPLETELY EMPTY CELL => the shader did not compile — uniforms or the for-loop. " +
        "--- " +
        "H and I are the new ones, both attached to the same filled quad shape as G. " +
        "H's quad is INVISIBLE (fillOpacity 0). STRIPES VISIBLE IN H => the clip does not need a " +
        "visible fill, so the parent is only a clip region and the SHADER CAN PAINT THE WHOLE " +
        "MARK — soft edges, grain and a stroke fading to nothing, with no subtractive blend " +
        "needed. NOTHING IN H => the clip needs real fill, so the parent must be drawn and the " +
        "shader can only add to it. " +
        "I is DST_IN on the quad, re-asking whether a shader can erode a fill's alpha now that we " +
        "know clipping works. STRIPES OF CYAN THROUGH THE QUAD => yes, erosion is available. " +
        "BLACK BANDS => no, same as C and D. " +
        "--- earlier cells: " +
        "A path only. B SRC_OVER stripes. C STANDALONE DST_IN. D ATTACHMENT DST_IN. " +
        "E and F are both a thin diagonal STROKE under the SAME striped SRC_OVER shader as B — " +
        "E attached to the line, F not attached. They differ in one thing only, so comparing them " +
        "is the whole test. " +
        "F STRIPED, E BLANK => an attached effect is clipped, and clipped to the parent's FILL, " +
        "which an open stroked line does not have. Texture cannot be confined to linework this way. " +
        "F STRIPED, E STRIPED ONLY ALONG THE LINE => clipping follows the drawn stroke, and " +
        "procedural texture on the sketch is possible after all. " +
        "F STRIPED, E STRIPED ACROSS THE CELL => attachment does not clip; an effect always paints " +
        "its rectangle, so grain would land on empty fog as much as on ink. " +
        "BOTH BLANK => something about this cell is wrong, not the SDK; fix the probe first.",
    );
  } catch (error) {
    // A validation failure here is itself a finding — it would mean the effect was rejected
    // outright rather than rendered and ignored, which is a different answer.
    devLog("error", "blend probe: could not draw the probe", error);
  }
}

export async function clearBlendProbe(): Promise<void> {
  const existing = await OBR.scene.local.getItems(
    (item) => PROBE_KEY in item.metadata,
  );
  if (existing.length > 0) {
    await OBR.scene.local.deleteItems(existing.map((item) => item.id));
  }
}

/**
 * `CONTROL`, matching `sketch/strokes.ts`.
 *
 * Not incidental: a blend mode composites against whatever shares its layer, so a probe run on a
 * different layer from the sketch would answer a question about a situation that never arises.
 * Being above `FOG` also means the bars are visible wherever the view happens to be.
 */
const SKETCH_LAYER = "CONTROL" as const;

/**
 * Bright reference patch on `POINTER`, one layer below the bars — see the call site.
 *
 * Cyan because nothing on a map is cyan, so a cyan stripe cannot be mistaken for map showing
 * through, and its absence cannot be mistaken for anything else either.
 */
function backdrop(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
): Item {
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
    .fillColor("#00e5ff")
    .fillOpacity(1)
    .strokeOpacity(0)
    .strokeWidth(0)
    .zIndex(0)
    .disableAutoZIndex(true)
    .layer("POINTER")
    .locked(true)
    .disableHit(true)
    .name(`blend probe backdrop ${label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();
}

/**
 * A thin stroked diagonal — a stand-in for a sketch stroke, and the shape bar E needs.
 *
 * Deliberately much smaller than the cell it sits in. That is the whole point: if an attached
 * effect is clipped to its parent, the green appears only along this line; if it is not, the green
 * covers the entire cell. Bars C and D could not show that, because their parent filled the cell.
 */
function diagonalStroke(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
): Item {
  const commands: PathCommand[] = [
    [Command.MOVE, x + width * 0.1, y + height * 0.85],
    [Command.LINE, x + width * 0.9, y + height * 0.15],
  ];

  return buildPath()
    .commands(commands)
    .position({ x: 0, y: 0 })
    .strokeColor("#603F21")
    .strokeOpacity(1)
    // About the weight of a real sketch stroke relative to its surroundings, so the answer here
    // transfers to the linework this is standing in for.
    .strokeWidth(Math.max(2, height / 8))
    .fillOpacity(0)
    .zIndex(1)
    .disableAutoZIndex(true)
    .layer(SKETCH_LAYER)
    .locked(true)
    .disableHit(true)
    .name(`blend probe ${label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();
}

/**
 * The same diagonal as `diagonalStroke`, but as a closed **filled** quad — a stroke whose width is
 * carried by its geometry rather than by `strokeWidth`.
 *
 * This is a miniature of what a nib-rendered sketch would emit: offset the centerline to either
 * side by a half-width and close the loop. Here the half-width is constant; a real nib would vary
 * it with the stroke's direction. Same shape either way, which is why this cell answers a question
 * about the nib as well as one about shaders.
 */
function diagonalQuad(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  fillOpacity: number,
): Item {
  const from = { x: x + width * 0.1, y: y + height * 0.85 };
  const to = { x: x + width * 0.9, y: y + height * 0.15 };

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  // Perpendicular, at the same visual weight as `diagonalStroke`'s line so the two cells are
  // comparable by eye — half of that stroke's width to each side.
  const half = Math.max(1, height / 16);
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;

  const commands: PathCommand[] = [
    [Command.MOVE, from.x + nx, from.y + ny],
    [Command.LINE, to.x + nx, to.y + ny],
    [Command.LINE, to.x - nx, to.y - ny],
    [Command.LINE, from.x - nx, from.y - ny],
    [Command.CLOSE],
  ];

  return buildPath()
    .commands(commands)
    .position({ x: 0, y: 0 })
    .fillColor("#603F21")
    .fillOpacity(fillOpacity)
    .strokeOpacity(0)
    .strokeWidth(0)
    .zIndex(1)
    .disableAutoZIndex(true)
    .layer(SKETCH_LAYER)
    .locked(true)
    .disableHit(true)
    .name(`blend probe ${label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();
}

function rectangle(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
): Item {
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
    // Filled, not stroked. A stroked outline gives the shader almost no area to act on, and
    // "did the blend work" would come down to squinting at a 2px line.
    .fillColor("#603F21")
    .fillOpacity(1)
    .strokeOpacity(0)
    .strokeWidth(0)
    .zIndex(1)
    .disableAutoZIndex(true)
    .layer(SKETCH_LAYER)
    .locked(true)
    .disableHit(true)
    .name(`blend probe ${label}`)
    .metadata({ [PROBE_KEY]: true })
    .build();
}

/** Centre of what the user is currently looking at, so the probe cannot land off-screen. */
async function viewCentre(dpi: number): Promise<{ x: number; y: number }> {
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
    // Better to draw somewhere than nowhere; one grid square in from the origin is at least
    // findable, and the log says where to look.
    devLog("warn", `blend probe: viewport unavailable, drawing near the origin`);
    return { x: dpi, y: dpi };
  }
}
