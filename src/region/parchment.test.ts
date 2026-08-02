import { describe, expect, it } from "vitest";

import {
  PARCHMENT_SKSL,
  parchmentUniforms,
  stencilRings,
  type ParchmentStyle,
} from "./parchment";
import { SAFE_COMMAND_BUDGET } from "./pathChunks";
import type { Bounds } from "./cellGrid";
import type { Vector2 } from "../geometry/vector";

const EXTENT: Bounds = { min: { x: 0, y: 0 }, max: { x: 1000, y: 800 } };

const STYLE: ParchmentStyle = {
  tint: { x: 0.85, y: 0.77, z: 0.6 },
  opacity: 0.16,
  scale: 50,
  contrast: 0.7,
};

/** A many-vertex circle, standing in for a visibility polygon's finely sampled arcs. */
function circle(cx: number, cy: number, r: number, points: number): Vector2[] {
  return Array.from({ length: points }, (_, i) => {
    const t = (i / points) * Math.PI * 2;
    return { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r };
  });
}

/** MOVE + (n-1) LINE + CLOSE, matching what the SDK half emits. */
const commandCost = (rings: readonly (readonly Vector2[])[]) =>
  rings.reduce((sum, ring) => sum + ring.length + 1, 0);

describe("stencilRings", () => {
  it("puts the extent first and every hole after it", () => {
    const result = stencilRings(EXTENT, [circle(500, 400, 90, 40)], 1);

    expect(result.rings).toHaveLength(2);
    expect(result.rings[0]).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 800 },
      { x: 0, y: 800 },
    ]);
    expect(result.dropped).toBe(0);
  });

  it("covers the whole extent when nothing is visible", () => {
    // Before any light exists the sheet is unbroken. A version that needed at least one hole would
    // draw nothing on a scene with no lit tokens, which is precisely the starting state.
    const result = stencilRings(EXTENT, [], 1);

    expect(result.rings).toHaveLength(1);
    expect(result.commands).toBe(5);
  });

  it("simplifies the holes hard, and reports what it cost", () => {
    // The reason this exists. One real visibility polygon runs to ~2,750 vertices, so three lit
    // tokens would blow past the budget for a path that cannot be chunked.
    const dense = [circle(300, 400, 200, 2750), circle(700, 400, 200, 2750)];

    const result = stencilRings(EXTENT, dense, 2);

    expect(result.commands).toBeLessThanOrEqual(SAFE_COMMAND_BUDGET);
    expect(result.rings[1]!.length).toBeLessThan(400);
    expect(result.dropped).toBe(0);
  });

  it("keeps the simplified hole close to the original outline", () => {
    // Simplification is only acceptable because it is invisible. Every kept vertex is on the
    // original ring, so the outline can only cut corners — and at this tolerance, barely.
    const original = circle(500, 400, 200, 2000);
    const [, hole] = stencilRings(EXTENT, [original], 2).rings;

    for (const point of hole!) {
      const radius = Math.hypot(point.x - 500, point.y - 400);
      expect(Math.abs(radius - 200)).toBeLessThan(1e-6);
    }
  });

  it("never exceeds the command budget, however many polygons arrive", () => {
    // Convergence: the tolerance doubles until it fits, and a coarse enough tolerance reduces any
    // polygon to a triangle — so there is always an answer.
    const crowd = Array.from({ length: 40 }, (_, i) =>
      circle(100 + (i % 8) * 100, 100 + Math.floor(i / 8) * 150, 120, 2750),
    );

    const result = stencilRings(EXTENT, crowd, 1);

    expect(result.commands).toBeLessThanOrEqual(SAFE_COMMAND_BUDGET);
    expect(commandCost(result.rings)).toBe(result.commands);
  });

  it("raises the tolerance rather than dropping holes", () => {
    // A dropped hole leaves parchment over ground the party is looking at, which is conspicuous.
    // Coarsening the outline is far less visible, so it is always tried first.
    //
    // **The fixture has to genuinely overflow, which takes some doing.** At a sane tolerance a
    // 900-unit arc simplifies to well under a hundred points, so a dozen ordinary lights fit
    // easily — an earlier version of this test used exactly that and passed without the relaxation
    // ever running. A sub-pixel tolerance is what forces the first attempt over the budget.
    const crowd = Array.from({ length: 13 }, (_, i) =>
      circle(100 + i * 70, 400, 900, 2750),
    );

    const result = stencilRings(EXTENT, crowd, 0.01);

    expect(result.dropped).toBe(0);
    expect(result.tolerance).toBeGreaterThan(0.01);
    expect(result.commands).toBeLessThanOrEqual(SAFE_COMMAND_BUDGET);
  });

  it("discards a hole too small to enclose anything", () => {
    // Fewer than three points bounds no area, so such a ring punches nothing while still costing
    // commands. Reported as dropped rather than silently skipped.
    const result = stencilRings(EXTENT, [[{ x: 1, y: 1 }, { x: 2, y: 2 }]], 1);

    expect(result.rings).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });

  it("survives a zero tolerance", () => {
    const result = stencilRings(EXTENT, [circle(500, 400, 90, 40)], 0);

    expect(result.commands).toBeLessThanOrEqual(SAFE_COMMAND_BUDGET);
    expect(result.rings).toHaveLength(2);
  });
});

describe("parchmentUniforms", () => {
  it("supplies exactly the uniforms the source declares", () => {
    // Bidirectional, because both mismatches fail silently: an undeclared uniform is ignored, and
    // one declared but never supplied leaves the effect drawing nothing.
    const declared = new Set<string>();
    for (const match of PARCHMENT_SKSL.matchAll(/^uniform\s+\w+\s+(\w+);/gm)) {
      if (match[1] !== "size") declared.add(match[1]!);
    }

    const supplied = new Set(parchmentUniforms(EXTENT, STYLE).map((u) => u.name));

    expect(supplied).toEqual(declared);
  });

  it("guards the divisors the shader uses", () => {
    // `worldSpan` and `scale` are both denominators in the shader. A zero in either produces a
    // NaN across the whole overlay, which reads as the feature being broken rather than misset.
    const degenerate = parchmentUniforms(
      { min: { x: 5, y: 5 }, max: { x: 5, y: 5 } },
      { ...STYLE, scale: 0 },
    );
    const span = degenerate.find((u) => u.name === "pmWorldSpan")!.value as Vector2;

    expect(span.x).not.toBe(0);
    expect(span.y).not.toBe(0);
    expect(degenerate.find((u) => u.name === "pmCell")!.value).not.toBe(0);
  });
});

describe("PARCHMENT_SKSL", () => {
  it("keys the mottle to world position, so it cannot swim under panning", () => {
    // §6, and far more conspicuous here than on a stroke: this covers the whole screen, so a
    // view-keyed field would make the entire sheet crawl on every pan.
    expect(PARCHMENT_SKSL).toContain("float2 w = pmWorldMin + (coord / size) * pmWorldSpan");
    expect(PARCHMENT_SKSL).toContain("fbm3(w / pmCell)");
    expect(PARCHMENT_SKSL).not.toMatch(/fbm3\(\s*coord/);
  });

  it("returns premultiplied alpha, so the fog shows through", () => {
    // The overlay tints rather than covers — the fog underneath supplies the colour. An opaque
    // return would paint over the very thing it is meant to mottle.
    expect(PARCHMENT_SKSL).toContain("half4(pmTint.x * a, pmTint.y * a, pmTint.z * a, a)");
    expect(PARCHMENT_SKSL).toContain("clamp(pmOpacity * (1.0 + pmVariation * (m - 0.5) * 2.0)");
  });

  it("prefixes every custom uniform, avoiding the parent's built-ins", () => {
    // The overlay rendered solid black until this was fixed. An ATTACHMENT effect is handed
    // built-ins describing its parent, and `scale` and `opacity` — two names this shader used —
    // collide with them silently: no error, just black. Bisected in a room 2026-08-02.
    //
    // Pinned by prefix rather than by listing the two known-bad names, because the collision set is
    // undocumented and the next one will be some other ordinary word.
    for (const match of PARCHMENT_SKSL.matchAll(/^uniform\s+\w+\s+(\w+);/gm)) {
      if (match[1] === "size") continue;
      expect(match[1]).toMatch(/^pm[A-Z]/);
    }
  });

  it("uses three octaves", () => {
    // Recorded because octave count is the first lever if this proves expensive: it covers a whole
    // viewport where the sketch's effects cover thin strips.
    expect((PARCHMENT_SKSL.match(/vnoise\(/g) ?? []).length).toBe(4);
  });
});
