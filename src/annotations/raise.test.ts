import { describe, expect, it } from "vitest";

import {
  FALLBACK_LAYER,
  RAISED_FROM,
  RAISED_LAYER,
  isRaised,
  planLower,
  planRaise,
  type RaisableItem,
} from "./raise";

const item = (
  id: string,
  layer: RaisableItem["layer"],
  metadata: Record<string, unknown> = {},
): RaisableItem => ({ id, layer, metadata });

const raised = (id: string, from: string): RaisableItem =>
  item(id, RAISED_LAYER, { [RAISED_FROM]: from });

describe("planRaise", () => {
  it("moves an annotation above the fog and remembers where it was", () => {
    expect(planRaise([item("a", "DRAWING")])).toEqual([
      { id: "a", layer: RAISED_LAYER, raisedFrom: "DRAWING" },
    ]);
  });

  it("remembers each item's own layer rather than one for the selection", () => {
    // A mixed selection is the ordinary case — an arrow and its label are on different layers —
    // and getting this wrong would only show on the way back down, long after the mistake.
    expect(planRaise([item("a", "DRAWING"), item("b", "TEXT")])).toEqual([
      { id: "a", layer: RAISED_LAYER, raisedFrom: "DRAWING" },
      { id: "b", layer: RAISED_LAYER, raisedFrom: "TEXT" },
    ]);
  });

  it("does not raise something it has already raised", () => {
    // Raising twice would overwrite the remembered layer with POINTER, and the way back would then
    // lead nowhere.
    expect(planRaise([raised("a", "DRAWING")])).toEqual([]);
  });

  it("leaves an item that was already on the pointer layer alone", () => {
    // Not ours. Claiming it would mean "sending it back" moves something that was never moved.
    expect(planRaise([item("a", RAISED_LAYER)])).toEqual([]);
  });

  it("still raises the rest of a selection that is partly raised already", () => {
    expect(planRaise([raised("a", "TEXT"), item("b", "PROP")])).toEqual([
      { id: "b", layer: RAISED_LAYER, raisedFrom: "PROP" },
    ]);
  });
});

describe("planLower", () => {
  it("puts an annotation back on the layer it came from and erases the marker", () => {
    expect(planLower([raised("a", "TEXT")])).toEqual([
      { id: "a", layer: "TEXT", raisedFrom: undefined },
    ]);
  });

  it("ignores an item this extension did not raise", () => {
    expect(planLower([item("a", RAISED_LAYER)])).toEqual([]);
    expect(planLower([item("a", "DRAWING")])).toEqual([]);
  });

  /**
   * The case that stranded annotations if it were got wrong.
   *
   * `POINTER` is a perfectly valid layer, so a check that only asked "is this a layer?" would
   * accept it and hand back an item still sitting above the fog after being told to come down.
   * That failure is indistinguishable from the button doing nothing.
   */
  it("refuses a remembered layer that would leave the item above the fog", () => {
    expect(planLower([raised("a", RAISED_LAYER)])).toEqual([
      { id: "a", layer: FALLBACK_LAYER, raisedFrom: undefined },
    ]);
  });

  it("falls back rather than stranding an item when the metadata is unusable", () => {
    const cases: unknown[] = ["NOT_A_LAYER", "", 7, null, {}, ["DRAWING"], true];
    for (const stored of cases) {
      expect(
        planLower([item("a", RAISED_LAYER, { [RAISED_FROM]: stored })]),
      ).toEqual([{ id: "a", layer: FALLBACK_LAYER, raisedFrom: undefined }]);
    }
  });

  it("round-trips every layer an item can be raised from", () => {
    // The pairing is the contract: whatever `planRaise` stores, `planLower` must give back
    // unchanged. Checked across all of them because a single hand-picked layer cannot show that
    // the fallback is not quietly swallowing the lot.
    const layers = [
      "MAP",
      "GRID",
      "DRAWING",
      "PROP",
      "MOUNT",
      "CHARACTER",
      "ATTACHMENT",
      "NOTE",
      "TEXT",
      "RULER",
      "FOG",
      "POST_PROCESS",
      "CONTROL",
      "POPOVER",
    ] as const;

    for (const layer of layers) {
      const [up] = planRaise([item("a", layer)]);
      expect(up?.raisedFrom).toBe(layer);

      const [down] = planLower([
        item("a", RAISED_LAYER, { [RAISED_FROM]: up?.raisedFrom }),
      ]);
      expect(down?.layer).toBe(layer);
    }
  });
});

describe("isRaised", () => {
  it("reads the marker rather than the layer", () => {
    // The layer alone cannot answer this: an item can sit on POINTER without this extension having
    // put it there, and that is exactly the item that must be left alone.
    expect(isRaised(item("a", RAISED_LAYER))).toBe(false);
    expect(isRaised(raised("a", "DRAWING"))).toBe(true);
  });
});
