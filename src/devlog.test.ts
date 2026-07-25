import { describe, expect, it } from "vitest";
import { serializeArgs } from "./devlog";

describe("serializeArgs", () => {
  it("passes strings through unchanged", () => {
    expect(serializeArgs(["hello", "world"])).toEqual(["hello", "world"]);
  });

  it("keeps an Error's name, message and stack", () => {
    const [out] = serializeArgs([new TypeError("bad wall")]);
    expect(out).toContain("TypeError: bad wall");
    expect(out).toContain("devlog.test");
  });

  it("survives circular structures", () => {
    const item: Record<string, unknown> = { id: "wall-1" };
    item.self = item;
    expect(serializeArgs([item])).toEqual(['{"id":"wall-1","self":"[Circular]"}']);
  });

  it("renders primitives that JSON.stringify handles badly", () => {
    expect(serializeArgs([undefined, null, NaN, 10n])).toEqual([
      "undefined",
      "null",
      "NaN",
      "10n",
    ]);
  });

  it("does not throw on values JSON cannot represent", () => {
    expect(() => serializeArgs([() => {}, Symbol("s"), new WeakMap()])).not.toThrow();
  });
});
