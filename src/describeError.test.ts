import { describe, expect, it } from "vitest";

import { describeError } from "./describeError";

describe("describeError", () => {
  it("describes the SDK's own rejection shape", () => {
    // The real payload, copied from the console of a deployed panel that would not start. This is
    // the case the function exists for: the panel reported nothing for two days because the value
    // is not an `Error` and the reporter tested for one.
    expect(
      describeError({
        error: { name: "MissingDataError", message: "No scene found" },
      }),
    ).toBe("MissingDataError: No scene found");
  });

  it("keeps an error's name, not only its message", () => {
    expect(describeError(new TypeError("nope"))).toBe("TypeError: nope");
  });

  it("passes a string through", () => {
    expect(describeError("rate limited")).toBe("rate limited");
  });

  it("reads an error-shaped object that is not an Error", () => {
    // A structured clone across a frame boundary lands as a plain object, so this is the ordinary
    // case rather than the exotic one.
    expect(describeError({ name: "RateLimitHit", message: "Too many requests" })).toBe(
      "RateLimitHit: Too many requests",
    );
  });

  it("falls back to either half when only one is present", () => {
    expect(describeError({ message: "No scene found" })).toBe("No scene found");
    expect(describeError({ name: "MissingDataError" })).toBe("MissingDataError");
  });

  it("serialises an object it cannot otherwise name", () => {
    expect(describeError({ status: 429, retryAfter: 5 })).toBe(
      '{"status":429,"retryAfter":5}',
    );
  });

  /**
   * The point of the whole function, stated as a test.
   *
   * A description that reads the same whether it found a cause or found none cannot distinguish its
   * outcomes, and will be believed anyway — so an empty result has to announce itself rather than
   * come back as something that looks like an answer.
   */
  it("says so when there is nothing to describe", () => {
    expect(describeError(undefined)).toBe("no detail on undefined");
    expect(describeError(null)).toBe("no detail on null");
    expect(describeError({})).toBe("no detail on [object Object]");
  });

  it("survives a payload that refers to itself", () => {
    const cyclic: { error?: unknown } = {};
    cyclic.error = cyclic;
    expect(() => describeError(cyclic)).not.toThrow();

    const selfReferential: { detail?: unknown } = {};
    selfReferential.detail = selfReferential;
    expect(describeError(selfReferential)).toBe("no detail on [object Object]");
  });

  it("survives an object with no prototype", () => {
    // `String()` throws on one of these. A reporter that dies while reporting leaves the same
    // silence as no reporter at all.
    const bare = Object.create(null) as Record<string, unknown>;
    expect(describeError(bare)).toBe("no detail on [object Object]");
  });

  it("does not mistake a nested envelope for an infinite one", () => {
    // Two levels is inside the bound and must still resolve, or the guard against cycles would be
    // discarding real detail to buy safety it can get more cheaply.
    expect(
      describeError({ error: { error: { message: "No scene found" } } }),
    ).toBe("No scene found");
  });
});
