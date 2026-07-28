import { describe, expect, it } from "vitest";

import { selectMapCandidates, type MapCandidate } from "./mapCandidates";

/** The test scene: an 816x1056 map and a one-square token that landed on the MAP layer. */
const map: MapCandidate = { id: "map", name: "Burial Mound", area: 816 * 1056 };
const token: MapCandidate = { id: "token", name: "Monk", area: 150 * 150 };

describe("selectMapCandidates", () => {
  it("drops a token-sized image beside a map", () => {
    expect(selectMapCandidates([map, token])).toEqual([map]);
  });

  it("keeps two comparable images so the caller still refuses", () => {
    // The case the whole safety rule exists for: a GM overlay is the same size as the map it
    // covers, so area cannot say which one players may see. Both survive, and the caller asks.
    const overlay: MapCandidate = { id: "gm", name: "GM layer", area: 816 * 1056 };
    expect(selectMapCandidates([map, overlay])).toEqual([map, overlay]);
  });

  it("keeps an image just above the threshold", () => {
    const quarter: MapCandidate = { id: "q", name: "quarter", area: map.area * 0.25 };
    expect(selectMapCandidates([map, quarter])).toEqual([map, quarter]);
  });

  it("drops one just below it", () => {
    const under: MapCandidate = { id: "u", name: "under", area: map.area * 0.24 };
    expect(selectMapCandidates([map, under])).toEqual([map]);
  });

  it("passes a lone image through untouched", () => {
    // Even a tiny one. With nothing to compare against there is no basis to reject it, and the
    // caller's single-map rule is what applies.
    expect(selectMapCandidates([token])).toEqual([token]);
  });

  it("returns nothing for no input", () => {
    expect(selectMapCandidates([])).toEqual([]);
  });

  it("keeps everything when every area is degenerate", () => {
    // No ranking is possible, so discarding any of them would be arbitrary. The caller refuses,
    // which is the safe outcome.
    const flat = [
      { id: "a", name: "a", area: 0 },
      { id: "b", name: "b", area: 0 },
    ];
    expect(selectMapCandidates(flat)).toEqual(flat);
  });

  it("preserves input order", () => {
    expect(selectMapCandidates([token, map])).toEqual([map]);
    const big: MapCandidate = { id: "big", name: "big", area: map.area };
    expect(selectMapCandidates([big, token, map])).toEqual([big, map]);
  });
});
