import { describe, expect, it } from "vitest";

import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  MAX_PENCIL_PASSES,
  MAX_PENCIL_SCATTER_SQUARES,
  MIN_PENCIL_OPACITY,
  MAX_WIDTH_SQUARES,
  MAX_WOBBLE_SQUARES,
  MAX_WOBBLE_WAVELENGTH_SQUARES,
  MIN_WIDTH_SQUARES,
  MIN_WOBBLE_WAVELENGTH_SQUARES,
  MAX_GRAIN_SCALE_SQUARES,
  MIN_GRAIN_SCALE_SQUARES,
  BRUSHES,
  differs,
  fromRoomMetadata,
  invalidatesTrace,
} from "./appearance";

const wrap = (value: unknown) => ({ [APPEARANCE_KEY]: value });

describe("fromRoomMetadata", () => {
  it("returns the shipped look when the room has never been written", () => {
    // The property that matters most here: an untouched room must render exactly as it did
    // before the settings panel existed. If this ever fails, every existing table's map changes
    // appearance on its next reload.
    expect(fromRoomMetadata({})).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE.strokeColor).toBe("#603F21");
    expect(DEFAULT_APPEARANCE.strokeWidthSquares).toBe(1 / 12);
    expect(DEFAULT_APPEARANCE.wobbleSquares).toBe(0.02);
    expect(DEFAULT_APPEARANCE.wobbleWavelengthSquares).toBe(0.35);
  });

  it("reads a full stored object back", () => {
    expect(
      fromRoomMetadata(
        wrap({
          strokeColor: "#123abc",
          strokeWidthSquares: 0.05,
          wobbleSquares: 0.1,
          wobbleWavelengthSquares: 0.8,
          pencilPasses: 3,
          pencilOpacity: 0.5,
          pencilScatterSquares: 0.03,
          renderer: "shader",
          brush: "charcoal",
          brushes: {
            liner: {
              featherFraction: 0.4,
              grainScaleSquares: 0.05,
              grainDepth: 0,
              edgeRoughness: 0,
            },
            charcoal: {
              featherFraction: 0.5,
              grainScaleSquares: 0.06,
              grainDepth: 0.4,
              edgeRoughness: 0.7,
            },
          },
        }),
      ),
    ).toEqual({
      strokeColor: "#123abc",
      strokeWidthSquares: 0.05,
      wobbleSquares: 0.1,
      wobbleWavelengthSquares: 0.8,
      pencilPasses: 3,
      pencilOpacity: 0.5,
      pencilScatterSquares: 0.03,
      renderer: "shader",
      brush: "charcoal",
      brushes: {
        liner: {
          featherFraction: 0.4,
          grainScaleSquares: 0.05,
          grainDepth: 0,
          edgeRoughness: 0,
        },
        charcoal: {
          featherFraction: 0.5,
          grainScaleSquares: 0.06,
          grainDepth: 0.4,
          edgeRoughness: 0.7,
        },
      },
    });
  });

  it("defaults the pencil to off", () => {
    // The texture is new and unjudged, so an untouched room must render as it did before it
    // existed: one pass, fully opaque, no scatter.
    const defaults = fromRoomMetadata({});
    expect(defaults.pencilPasses).toBe(1);
    expect(defaults.pencilOpacity).toBe(1);
    expect(defaults.pencilScatterSquares).toBe(0);
  });

  it("clamps the pencil settings and rounds the pass count", () => {
    const read = (v: Record<string, unknown>) => fromRoomMetadata(wrap(v));

    expect(read({ pencilPasses: 99 }).pencilPasses).toBe(MAX_PENCIL_PASSES);
    expect(read({ pencilPasses: 0 }).pencilPasses).toBe(1);
    expect(read({ pencilPasses: 2.6 }).pencilPasses).toBe(3);
    expect(read({ pencilOpacity: 0 }).pencilOpacity).toBe(MIN_PENCIL_OPACITY);
    expect(read({ pencilOpacity: 9 }).pencilOpacity).toBe(1);
    expect(read({ pencilScatterSquares: -1 }).pencilScatterSquares).toBe(0);
    expect(read({ pencilScatterSquares: 9 }).pencilScatterSquares).toBe(
      MAX_PENCIL_SCATTER_SQUARES,
    );
  });

  it("falls back per field, not wholesale", () => {
    // A client meeting a partially-written or partly-unrecognised object keeps what it can use.
    // Reverting every field because one is wrong is the failure this is written against.
    const partial = fromRoomMetadata(
      wrap({ strokeColor: "#aabbcc", wobbleSquares: "a lot" }),
    );

    expect(partial.strokeColor).toBe("#aabbcc");
    expect(partial.wobbleSquares).toBe(DEFAULT_APPEARANCE.wobbleSquares);
    expect(partial.strokeWidthSquares).toBe(
      DEFAULT_APPEARANCE.strokeWidthSquares,
    );
  });

  it("keeps known fields when an unknown one is present", () => {
    // Forwards compatibility: a newer build writing a field this one has never heard of must not
    // cost the older build the settings it does understand.
    const withFuture = fromRoomMetadata(
      wrap({ strokeColor: "#010203", parchmentGrain: 0.4 }),
    );
    expect(withFuture.strokeColor).toBe("#010203");
  });

  it("rejects a colour that is not a six-digit hex", () => {
    for (const bad of ["red", "#abc", "#12345g", "603F21", "", 42, null]) {
      expect(fromRoomMetadata(wrap({ strokeColor: bad })).strokeColor).toBe(
        DEFAULT_APPEARANCE.strokeColor,
      );
    }
  });

  it("accepts either case of hex digit", () => {
    expect(fromRoomMetadata(wrap({ strokeColor: "#ABCDEF" })).strokeColor).toBe(
      "#ABCDEF",
    );
  });

  it("clamps a width rather than discarding it", () => {
    // An out-of-range number is a choice someone made; the nearest legal value is what they
    // meant. Only a non-number is meaningless enough to throw away.
    expect(fromRoomMetadata(wrap({ strokeWidthSquares: 10 })).strokeWidthSquares).toBe(
      MAX_WIDTH_SQUARES,
    );
    expect(
      fromRoomMetadata(wrap({ strokeWidthSquares: 0.0001 })).strokeWidthSquares,
    ).toBe(MIN_WIDTH_SQUARES);
  });

  it("discards a width that is not a finite number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "0.05", null]) {
      expect(
        fromRoomMetadata(wrap({ strokeWidthSquares: bad })).strokeWidthSquares,
      ).toBe(DEFAULT_APPEARANCE.strokeWidthSquares);
    }
  });

  it("ignores a stored value that is not an object", () => {
    for (const bad of ["#603F21", 5, true, null, undefined]) {
      expect(fromRoomMetadata(wrap(bad))).toEqual(DEFAULT_APPEARANCE);
    }
  });
});

describe("wobble", () => {
  it("clamps to the range and allows zero as off", () => {
    expect(fromRoomMetadata(wrap({ wobbleSquares: 0 })).wobbleSquares).toBe(0);
    expect(fromRoomMetadata(wrap({ wobbleSquares: 5 })).wobbleSquares).toBe(
      MAX_WOBBLE_SQUARES,
    );
    expect(fromRoomMetadata(wrap({ wobbleSquares: -1 })).wobbleSquares).toBe(0);
  });

  it("migrates the boolean this field used to be", () => {
    // A room written by the previous build must keep meaning what it meant. `false` was genuinely
    // off; `true` was the shipped amplitude. Without this, a table that had turned wobble off
    // would find it back on after a reload, which reads as a rendering bug rather than a schema
    // change.
    expect(fromRoomMetadata(wrap({ wobble: false })).wobbleSquares).toBe(0);
    expect(fromRoomMetadata(wrap({ wobble: true })).wobbleSquares).toBe(
      DEFAULT_APPEARANCE.wobbleSquares,
    );
  });

  it("prefers the new field when both are present", () => {
    expect(
      fromRoomMetadata(wrap({ wobble: false, wobbleSquares: 0.08 })).wobbleSquares,
    ).toBe(0.08);
  });

  it("clamps the period into its range", () => {
    const read = (v: unknown) =>
      fromRoomMetadata(wrap({ wobbleWavelengthSquares: v }))
        .wobbleWavelengthSquares;

    expect(read(0.6)).toBe(0.6);
    expect(read(0)).toBe(MIN_WOBBLE_WAVELENGTH_SQUARES);
    expect(read(99)).toBe(MAX_WOBBLE_WAVELENGTH_SQUARES);
    expect(read("slow")).toBe(DEFAULT_APPEARANCE.wobbleWavelengthSquares);
  });

  it("never clamps the period to zero", () => {
    // A zero wavelength would make `fbm` return 0 and silently disable the wobble however high
    // the amplitude — a control appearing to do nothing because a *different* control is at its
    // floor. The floor is well above zero for reasons of its own, and this pins the consequence.
    expect(MIN_WOBBLE_WAVELENGTH_SQUARES).toBeGreaterThan(0);
    expect(
      fromRoomMetadata(wrap({ wobbleWavelengthSquares: -5 }))
        .wobbleWavelengthSquares,
    ).toBeGreaterThan(0);
  });
});

describe("renderer", () => {
  it("defaults to the shader renderer", () => {
    // Judged in a room and preferred, 2026-08-01. Deliberately reaches existing rooms: a stored
    // appearance predating this field has no value for it, so the per-field fallback applies and
    // the room moves to soft edges on reload.
    expect(DEFAULT_APPEARANCE.renderer).toBe("shader");
    expect(fromRoomMetadata({}).renderer).toBe("shader");
    expect(
      fromRoomMetadata(wrap({ strokeColor: "#123abc" })).renderer,
    ).toBe("shader");
  });

  it("keeps an explicit choice of the Path renderer", () => {
    // The escape hatch the default change relies on. A GM who prefers hard edges picks Lines, and
    // that has to survive — otherwise the default is not a default, it is a removal.
    expect(fromRoomMetadata(wrap({ renderer: "strokes" })).renderer).toBe("strokes");
  });

  it("falls back on a name it does not know", () => {
    // The skew case: a room whose GM picked a renderer a later build adds, read by a client running
    // the older build. Rendering the look it does understand beats rendering nothing.
    expect(fromRoomMetadata(wrap({ renderer: "holographic" })).renderer).toBe("shader");
    expect(fromRoomMetadata(wrap({ renderer: 7 })).renderer).toBe("shader");
    expect(fromRoomMetadata(wrap({ renderer: null })).renderer).toBe("shader");
  });

  it("is a redraw, not a re-trace", () => {
    // The property that makes the two renderers comparable at all: they consume identical wobbled
    // geometry, so switching may not cost a few hundred milliseconds of tracing. If this ever flips
    // to true, the switch stops being a fair A/B and starts being a rebuild.
    // Switching *away* from the default, so this keeps testing a real change rather than silently
    // comparing the default against itself — which is what it started doing when the default moved.
    const before = DEFAULT_APPEARANCE;
    const after = { ...DEFAULT_APPEARANCE, renderer: "strokes" as const };

    expect(before.renderer).not.toBe(after.renderer);
    expect(invalidatesTrace(before, after)).toBe(false);
    // But it must still be *noticed*, or moving the control would do nothing at all.
    expect(differs(before, after)).toBe(true);
  });
});

describe("brushes", () => {
  const liner = (metadata: Record<string, unknown>) =>
    fromRoomMetadata(metadata).brushes.liner;

  it("defaults to the liner, so choosing Brushes cannot lose the judged look", () => {
    // The clean soft edge is what was judged in a room and made the default renderer. Charcoal is
    // new and unjudged, so landing on it by default would change every table's map unasked.
    expect(DEFAULT_APPEARANCE.brush).toBe("liner");
    expect(fromRoomMetadata({}).brush).toBe("liner");
    expect(fromRoomMetadata(wrap({ brush: "airbrush" })).brush).toBe("liner");
  });

  it("ships charcoal at the values judged in a room", () => {
    // Tuned by eye 2026-08-01 and accepted. Pinned for the same reason the ink colour and stroke
    // width are: changing a judged default changes what every table sees on its next reload, so it
    // should be a deliberate edit that breaks a test rather than a quiet one that does not.
    expect(DEFAULT_APPEARANCE.brushes.charcoal).toEqual({
      featherFraction: 0.5,
      grainScaleSquares: 0.09,
      grainDepth: 0.6,
      edgeRoughness: 0.85,
    });
  });

  it("gives every brush a full settings block", () => {
    // A uniform shape across brushes, even where a brush ignores fields. Anything reading
    // `brushes[id]` must never find a hole, whichever brush is selected.
    for (const id of BRUSHES) {
      const settings = fromRoomMetadata({}).brushes[id];
      expect(Number.isFinite(settings.featherFraction)).toBe(true);
      expect(Number.isFinite(settings.grainScaleSquares)).toBe(true);
      expect(Number.isFinite(settings.grainDepth)).toBe(true);
      expect(Number.isFinite(settings.edgeRoughness)).toBe(true);
    }
  });

  it("keeps each brush's settings independent", () => {
    // The reason they are stored per brush at all: tuning charcoal must not disturb the liner, so
    // switching back and forth compares two tuned looks rather than one tuned and one trampled.
    const read = fromRoomMetadata(
      wrap({
        brushes: {
          liner: { featherFraction: 0.1 },
          charcoal: { featherFraction: 0.9, edgeRoughness: 0.2 },
        },
      }),
    );

    expect(read.brushes.liner.featherFraction).toBeCloseTo(0.1, 6);
    expect(read.brushes.charcoal.featherFraction).toBeCloseTo(0.9, 6);
    expect(read.brushes.charcoal.edgeRoughness).toBeCloseTo(0.2, 6);
    // Untouched fields fall back rather than inheriting from the other brush.
    expect(read.brushes.liner.edgeRoughness).toBe(
      DEFAULT_APPEARANCE.brushes.liner.edgeRoughness,
    );
  });

  it("migrates the old top-level featherFraction onto the liner only", () => {
    // That key was the one edge that existed before brushes did, so a room that tuned it keeps the
    // value. Applying it to charcoal too would import a number chosen for a different medium.
    const read = fromRoomMetadata(wrap({ featherFraction: 0.12 }));

    expect(read.brushes.liner.featherFraction).toBeCloseTo(0.12, 6);
    expect(read.brushes.charcoal.featherFraction).toBe(
      DEFAULT_APPEARANCE.brushes.charcoal.featherFraction,
    );
  });

  it("prefers a stored brush block over the legacy key", () => {
    expect(
      liner(wrap({ featherFraction: 0.12, brushes: { liner: { featherFraction: 0.4 } } }))
        .featherFraction,
    ).toBeCloseTo(0.4, 6);
  });

  it("clamps and falls back per field", () => {
    expect(liner(wrap({ brushes: { liner: { featherFraction: 5 } } })).featherFraction).toBe(1);
    expect(liner(wrap({ brushes: { liner: { featherFraction: -2 } } })).featherFraction).toBe(0);
    expect(
      liner(wrap({ brushes: { liner: { featherFraction: "soft" } } })).featherFraction,
    ).toBe(DEFAULT_APPEARANCE.brushes.liner.featherFraction);
    expect(
      liner(wrap({ brushes: { liner: { grainScaleSquares: 99 } } })).grainScaleSquares,
    ).toBe(MAX_GRAIN_SCALE_SQUARES);
    expect(
      liner(wrap({ brushes: { liner: { grainScaleSquares: 0 } } })).grainScaleSquares,
    ).toBe(MIN_GRAIN_SCALE_SQUARES);
  });

  it("keeps a zero feather rather than treating it as unset", () => {
    // Zero is a real setting — a hard edge, the same silhouette Lines gives — so a falsy check
    // would spring it back to the default and the control would appear to have a floor.
    expect(liner(wrap({ brushes: { liner: { featherFraction: 0 } } })).featherFraction).toBe(0);
  });

  it("survives a brushes value that is not an object", () => {
    for (const nonsense of [null, 7, "charcoal", []]) {
      expect(() => fromRoomMetadata(wrap({ brushes: nonsense }))).not.toThrow();
      expect(fromRoomMetadata(wrap({ brushes: nonsense })).brushes.charcoal).toEqual(
        DEFAULT_APPEARANCE.brushes.charcoal,
      );
    }
  });

  it("notices a brush change and a brush setting change, without re-tracing", () => {
    // `differs` compares a nested record here, so a shallow compare would leave every grain slider
    // apparently dead. And none of it is geometry, so a re-trace would be several hundred
    // milliseconds per nudge on controls meant to be dragged.
    const before = DEFAULT_APPEARANCE;
    const switched = { ...before, brush: "charcoal" as const };
    const tuned = {
      ...before,
      brushes: {
        ...before.brushes,
        charcoal: { ...before.brushes.charcoal, edgeRoughness: 0.2 },
      },
    };

    expect(differs(before, switched)).toBe(true);
    expect(differs(before, tuned)).toBe(true);
    expect(invalidatesTrace(before, switched)).toBe(false);
    expect(invalidatesTrace(before, tuned)).toBe(false);
  });
});

describe("invalidatesTrace", () => {
  it("separates the pencil's geometry from its style", () => {
    // Passes and scatter change where the ink goes, so the map is traced again. Pass opacity is
    // PathStyle on items that already exist. Collapsing the two would put a few hundred
    // milliseconds of tracing behind every nudge of an opacity slider.
    const from = DEFAULT_APPEARANCE;
    expect(invalidatesTrace(from, { ...from, pencilPasses: 3 })).toBe(true);
    expect(invalidatesTrace(from, { ...from, pencilScatterSquares: 0.03 })).toBe(
      true,
    );
    expect(invalidatesTrace(from, { ...from, pencilOpacity: 0.4 })).toBe(false);

    // ...but a style-only change is still a change, or the redraw never happens.
    expect(differs(from, { ...from, pencilOpacity: 0.4 })).toBe(true);
  });

  it("is true for the period as well as the amplitude", () => {
    expect(
      invalidatesTrace(DEFAULT_APPEARANCE, {
        ...DEFAULT_APPEARANCE,
        wobbleWavelengthSquares: 0.9,
      }),
    ).toBe(true);
  });

  it("is true only for wobble", () => {
    // The distinction this module exists to carry: wobble is baked into the geometry at trace
    // time (DESIGN.md §6, the displacement is a pure function of world position and computed
    // once), while colour and width are PathStyle on items that already exist.
    expect(
      invalidatesTrace(DEFAULT_APPEARANCE, {
        ...DEFAULT_APPEARANCE,
        wobbleSquares: 0,
      }),
    ).toBe(true);

    expect(
      invalidatesTrace(DEFAULT_APPEARANCE, {
        ...DEFAULT_APPEARANCE,
        strokeColor: "#000000",
        strokeWidthSquares: 0.2,
      }),
    ).toBe(false);
  });

  it("is false for an unchanged appearance", () => {
    expect(invalidatesTrace(DEFAULT_APPEARANCE, DEFAULT_APPEARANCE)).toBe(false);
  });
});

describe("differs", () => {
  it("detects a change in any field and none in none", () => {
    expect(differs(DEFAULT_APPEARANCE, DEFAULT_APPEARANCE)).toBe(false);
    expect(
      differs(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, strokeColor: "#000000" }),
    ).toBe(true);
    expect(
      differs(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, strokeWidthSquares: 0.1 }),
    ).toBe(true);
    expect(
      differs(DEFAULT_APPEARANCE, { ...DEFAULT_APPEARANCE, wobbleSquares: 0 }),
    ).toBe(true);
  });
});
