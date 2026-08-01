import { describe, expect, it } from "vitest";

import {
  batchBounds,
  batchPieces,
  buildUniforms,
  parseHexColor,
  sdfSource,
  sentinelFor,
  toPieces,
  type Bounds,
  type Piece,
  type SdfStyle,
} from "./sdf";
import type { TracedSegment } from "../trace/chop";

const STYLE: SdfStyle = {
  halfWidth: 6,
  feather: 2,
  ink: { x: 0.38, y: 0.25, z: 0.13 },
};

function segment(...points: { x: number; y: number }[]): TracedSegment {
  return {
    points,
    midpoint: points[Math.floor(points.length / 2)]!,
    length: 0,
  };
}

function piece(ax: number, ay: number, bx: number, by: number): Piece {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

/** Every world point a batch's occupied slots touch — what the bounds must contain. */
function corners(pieces: readonly Piece[]): { x: number; y: number }[] {
  return pieces.flatMap(({ a, b }) => [a, b]);
}

function inside(bounds: Bounds, p: { x: number; y: number }): boolean {
  return (
    p.x >= bounds.min.x &&
    p.x <= bounds.max.x &&
    p.y >= bounds.min.y &&
    p.y <= bounds.max.y
  );
}

describe("toPieces", () => {
  it("yields one piece fewer than points, per segment, in order", () => {
    const pieces = toPieces([
      segment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }),
      segment({ x: 50, y: 50 }, { x: 60, y: 50 }),
    ]);

    expect(pieces).toHaveLength(3);
    expect(pieces[0]).toEqual(piece(0, 0, 10, 0));
    expect(pieces[1]).toEqual(piece(10, 0, 10, 10));
    expect(pieces[2]).toEqual(piece(50, 50, 60, 50));
  });

  it("shares the joining point between consecutive pieces", () => {
    // The reason strokes inside a batch merge seamlessly: the minimum-distance chain sees one
    // continuous run, not two marks that happen to abut. A flattening that dropped or duplicated
    // the join with any drift would show as a notch at every subdivision point.
    const pieces = toPieces([
      segment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }),
    ]);

    expect(pieces[0]!.b).toEqual(pieces[1]!.a);
  });

  it("drops degenerate segments rather than emitting a zero-length piece", () => {
    expect(toPieces([segment({ x: 1, y: 1 })])).toHaveLength(0);
    expect(toPieces([])).toHaveLength(0);
  });
});

describe("batchPieces", () => {
  it("places every piece in exactly one batch", () => {
    const pieces: Piece[] = [];
    for (let i = 0; i < 200; i++) {
      pieces.push(piece(i * 3, (i % 17) * 5, i * 3 + 2, (i % 17) * 5 + 2));
    }

    const flattened = batchPieces(pieces, 16).flat();

    expect(flattened).toHaveLength(pieces.length);
    // Identity, so a batching that duplicated a piece and dropped another cannot pass on count.
    expect(new Set(flattened).size).toBe(pieces.length);
    for (const p of pieces) expect(flattened).toContain(p);
  });

  it("never exceeds the batch size, even when one cell holds far more", () => {
    // Every piece on the same point, so the grid puts them all in one bucket and the only thing
    // that can keep batches legal is the split. A bucketing that trusted its cell size would
    // return a single 100-piece batch here and overflow the declared slots at render time.
    const pieces = Array.from({ length: 100 }, () => piece(0, 0, 1, 1));

    for (const batch of batchPieces(pieces, 16)) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(16);
    }
  });

  it("groups by locality rather than by input order", () => {
    // Interleaved: two distant clusters, alternating. Order-based batching would put one piece
    // from each cluster in every batch, and each effect would then have to shade a rectangle
    // spanning the whole gap — mostly empty pixels, which is the cost this exists to avoid.
    const pieces: Piece[] = [];
    for (let i = 0; i < 8; i++) {
      pieces.push(piece(i, 0, i + 1, 0));
      pieces.push(piece(1000 + i, 1000, 1001 + i, 1000));
    }

    const batches = batchPieces(pieces, 8, 100);

    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      const span = batchBounds(batch, 0);
      expect(span.max.x - span.min.x).toBeLessThan(100);
    }
  });

  it("is deterministic across runs", () => {
    // The deferred incremental-update phase keeps the batch *set* stable across redraws and varies
    // only which slots are parked. An ordering that shifted run to run would quietly close that
    // door — and the symptom would be a performance regression, not a wrong picture.
    const pieces = Array.from({ length: 60 }, (_, i) =>
      piece((i * 37) % 400, (i * 61) % 400, ((i * 37) % 400) + 3, ((i * 61) % 400) + 3),
    );

    expect(batchPieces(pieces, 16)).toEqual(batchPieces(pieces, 16));
  });

  it("orders cells numerically, not as strings", () => {
    // `"10,0"` sorts before `"9,0"` lexically. Only reachable past ten cells on an axis, which a
    // small fixture would never cross.
    const pieces = Array.from({ length: 15 }, (_, i) => piece(i * 100, 0, i * 100 + 1, 0));
    const batches = batchPieces(pieces, 1, 100);

    const xs = batches.map((batch) => batch[0]!.a.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("returns nothing for no pieces, and rejects a batch size below one", () => {
    expect(batchPieces([], 16)).toEqual([]);
    expect(() => batchPieces([piece(0, 0, 1, 1)], 0)).toThrow();
  });
});

describe("batchBounds", () => {
  it("contains every endpoint, expanded by the margin", () => {
    const pieces = [piece(10, 20, 30, 5), piece(-4, 40, 12, 12)];

    const bounds = batchBounds(pieces, 3);

    expect(bounds).toEqual({ min: { x: -7, y: 2 }, max: { x: 33, y: 43 } });
    for (const point of corners(pieces)) expect(inside(bounds, point)).toBe(true);
  });

  it("leaves room for the ink either side of a piece running along the edge", () => {
    // An `Effect` cannot draw outside its own rectangle, so bounds tight around the centrelines
    // would slice the mark off flat along that edge. The margin is `halfWidth + feather` — the
    // furthest the shader's alpha ramp still returns something.
    const pieces = [piece(0, 0, 100, 0)];
    const margin = STYLE.halfWidth + STYLE.feather;

    const bounds = batchBounds(pieces, margin);

    expect(bounds.min.y).toBeLessThanOrEqual(-margin);
    expect(bounds.max.y).toBeGreaterThanOrEqual(margin);
  });
});

describe("buildUniforms", () => {
  const pieces = [piece(0, 0, 50, 0), piece(50, 0, 50, 50)];
  const bounds = batchBounds(pieces, 8);

  it("always returns exactly batchSize slots, however few are occupied", () => {
    for (const batchSize of [2, 8, 64]) {
      const uniforms = buildUniforms(pieces, bounds, STYLE, batchSize);
      const slots = uniforms.filter((u) => /^p\d+[ab]$/.test(u.name));

      expect(slots).toHaveLength(batchSize * 2);
      // Padding is the mechanism, not tidiness: the source declares a fixed number of slots, so a
      // short list would leave uniforms undeclared.
      expect(new Set(slots.map((u) => u.name)).size).toBe(batchSize * 2);
    }
  });

  it("names a slot pair for every index the source declares", () => {
    const batchSize = 8;
    const source = sdfSource(batchSize);

    for (const uniform of buildUniforms(pieces, bounds, STYLE, batchSize)) {
      expect(source).toContain(`uniform ${uniformType(uniform.value)} ${uniform.name};`);
    }
  });

  it("puts the occupied slots first, unchanged", () => {
    const uniforms = buildUniforms(pieces, bounds, STYLE, 8);

    expect(named(uniforms, "p0a")).toEqual({ x: 0, y: 0 });
    expect(named(uniforms, "p0b")).toEqual({ x: 50, y: 0 });
    expect(named(uniforms, "p1a")).toEqual({ x: 50, y: 0 });
    expect(named(uniforms, "p1b")).toEqual({ x: 50, y: 50 });
  });

  it("parks unused slots outside the bounds", () => {
    // The property the whole padding scheme rests on. A sentinel inside the rectangle would draw a
    // spurious mark; one merely *at* the edge could still win the minimum near a corner.
    const uniforms = buildUniforms(pieces, bounds, STYLE, 8);

    for (const name of ["p2a", "p2b", "p7a", "p7b"]) {
      expect(inside(bounds, named(uniforms, name))).toBe(false);
    }
  });

  it("parks far enough that a sentinel cannot win the minimum anywhere inside", () => {
    const uniforms = buildUniforms(pieces, bounds, STYLE, 8);
    const parked = named(uniforms, "p7a");

    // Furthest a real pixel can be from real ink here, against the nearest a parked slot can be.
    const diagonal = Math.hypot(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
    );
    const nearest = Math.min(
      ...corners([piece(bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y)]).map(
        (corner) => Math.hypot(corner.x - parked.x, corner.y - parked.y),
      ),
    );

    expect(nearest).toBeGreaterThan(diagonal);
  });

  it("keeps a degenerate batch's sentinel outside and its span non-zero", () => {
    // One axis-aligned piece: zero height. The shader divides by `worldSpan`, and a sentinel scaled
    // by a zero span would land on the bounds themselves.
    const flat = [piece(0, 0, 100, 0)];
    const flatBounds = batchBounds(flat, 0);
    const uniforms = buildUniforms(flat, flatBounds, STYLE, 4);
    const span = named(uniforms, "worldSpan");

    expect(span.x).not.toBe(0);
    expect(span.y).not.toBe(0);
    expect(inside(flatBounds, named(uniforms, "p3a"))).toBe(false);
  });

  it("carries the world rect and the style through", () => {
    const uniforms = buildUniforms(pieces, bounds, STYLE, 4);

    expect(named(uniforms, "worldMin")).toEqual(bounds.min);
    expect(scalar(uniforms, "halfWidth")).toBe(STYLE.halfWidth);
    expect(scalar(uniforms, "feather")).toBe(STYLE.feather);
    expect(named(uniforms, "ink")).toEqual(STYLE.ink);
  });

  it("refuses a batch larger than the slot count", () => {
    // Silently truncating would drop linework, and the missing strokes would look like a masking
    // bug rather than a batching one.
    expect(() => buildUniforms(pieces, bounds, STYLE, 1)).toThrow(/exceeds/);
  });
});

describe("sentinelFor", () => {
  it("scales with the batch, so it is remote for a small one too", () => {
    const small = { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } };
    const large = { min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } };

    expect(sentinelFor(small, { x: 1, y: 1 }).x).toBeLessThan(small.min.x);
    expect(sentinelFor(large, { x: 1000, y: 1000 }).x).toBeLessThan(large.min.x);
    // Far enough out to lose, near enough that the squared terms in the distance maths stay a long
    // way from the edge of float range — a 1e30 sentinel would overflow `dot(ba, ba)`.
    expect(Math.abs(sentinelFor(large, { x: 1000, y: 1000 }).x)).toBeLessThan(1e6);
  });
});

describe("sdfSource", () => {
  it("declares and uses exactly batchSize slot pairs", () => {
    const batchSize = 12;
    const source = sdfSource(batchSize);

    for (let i = 0; i < batchSize; i++) {
      expect(source).toContain(`uniform float2 p${i}a;`);
      expect(source).toContain(`uniform float2 p${i}b;`);
      // Declared but never read is the failure that draws nothing while compiling fine.
      expect(source).toContain(`sdSeg(w, p${i}a, p${i}b)`);
    }
    expect(source).not.toContain(`p${batchSize}a`);
    expect(count(source, "uniform float2 p")).toBe(batchSize * 2);
    expect(count(source, "d = min(d,")).toBe(batchSize);
  });

  it("is identical for the same batch size", () => {
    // One source compiled once is the point. If this varied — field order, a timestamp — every
    // batch would compile its own shader and every redraw would recompile them all.
    expect(sdfSource(8)).toBe(sdfSource(8));
  });

  it("maps coord to world through size and the world rect", () => {
    // What makes the mark stable under pan and zoom, proven in a room. Normalising against the
    // built-in `size` holds however `coord` and `size` are scaled; anything keyed to the view would
    // swim on every pan, which §6 rejects for the wobble and would be worse here.
    expect(sdfSource(4)).toContain("worldMin + (coord / size) * worldSpan");
  });

  it("returns premultiplied alpha componentwise", () => {
    // `half4(ink.x * a, …, a)` is the form cell J actually compiled. A `half3` constructor is
    // untested and there is no reason to spend a room test finding out.
    expect(sdfSource(4)).toContain("half4(ink.x * a, ink.y * a, ink.z * a, a)");
  });

  it("feathers the edge rather than cutting it", () => {
    // The entire reason this renderer exists — a `Path` has a hard silhouette and cannot soften it.
    expect(sdfSource(4)).toContain("smoothstep(halfWidth - e, halfWidth + e, d)");
  });

  it("rejects a batch size below one", () => {
    expect(() => sdfSource(0)).toThrow();
  });
});

describe("parseHexColor", () => {
  it("converts the shipped sepia to 0–1 components", () => {
    const ink = parseHexColor("#603F21");

    expect(ink.x).toBeCloseTo(0x60 / 255, 6);
    expect(ink.y).toBeCloseTo(0x3f / 255, 6);
    expect(ink.z).toBeCloseTo(0x21 / 255, 6);
  });

  it("falls back to black on anything unparseable", () => {
    expect(parseHexColor("nonsense")).toEqual({ x: 0, y: 0, z: 0 });
    expect(parseHexColor("#abc")).toEqual({ x: 0, y: 0, z: 0 });
  });
});

function named(
  uniforms: readonly { name: string; value: unknown }[],
  name: string,
): { x: number; y: number; z?: number } {
  const found = uniforms.find((u) => u.name === name);
  if (!found) throw new Error(`no uniform named ${name}`);
  return found.value as { x: number; y: number };
}

function scalar(
  uniforms: readonly { name: string; value: unknown }[],
  name: string,
): number {
  const found = uniforms.find((u) => u.name === name);
  if (!found) throw new Error(`no uniform named ${name}`);
  return found.value as number;
}

function uniformType(value: unknown): string {
  if (typeof value === "number") return "float";
  return value !== null && typeof value === "object" && "z" in value
    ? "float3"
    : "float2";
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
