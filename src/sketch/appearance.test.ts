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
