import { describe, expect, it } from "vitest";
import {
  blur,
  fieldAt,
  luminanceField,
  sobelMagnitude,
  type PixelImage,
} from "./field";
import { field, greyImage } from "./fixtures";

function rgbaImage(
  pixels: readonly (readonly [number, number, number, number])[],
): PixelImage {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((pixel, i) => data.set(pixel, i * 4));
  return { width: pixels.length, height: 1, data };
}

describe("luminanceField", () => {
  it("maps black to 0 and white to 1", () => {
    const image = rgbaImage([
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
    const luminance = luminanceField(image);

    expect(fieldAt(luminance, 0, 0)).toBeCloseTo(0, 6);
    expect(fieldAt(luminance, 1, 0)).toBeCloseTo(1, 6);
  });

  it("weights green far above blue, as Rec. 709 does", () => {
    const image = rgbaImage([
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
    const luminance = luminanceField(image);

    expect(fieldAt(luminance, 0, 0)).toBeCloseTo(0.7152, 4);
    expect(fieldAt(luminance, 1, 0)).toBeCloseTo(0.0722, 4);
  });

  it("composites transparency over white, so a transparent margin is not a black feature", () => {
    const image = rgbaImage([
      [0, 0, 0, 0],
      [0, 0, 0, 128],
    ]);
    const luminance = luminanceField(image);

    expect(fieldAt(luminance, 0, 0)).toBeCloseTo(1, 6);
    expect(fieldAt(luminance, 1, 0)).toBeCloseTo(1 - 128 / 255, 4);
  });
});

describe("blur", () => {
  it("copies rather than aliases when there is nothing to do", () => {
    const source = field(3, 3, () => 0.25);
    const result = blur(source, 0);

    expect(result.data).not.toBe(source.data);
    expect(Array.from(result.data)).toEqual(Array.from(source.data));
  });

  it("leaves a uniform field uniform, including at the border", () => {
    // Clamped edge sampling is what makes this hold. Zero-padding would darken the border,
    // and the darkened frame would then trace as a rectangle around the whole map.
    const result = blur(field(9, 9, () => 0.6), 2);

    for (const value of result.data) expect(value).toBeCloseTo(0.6, 5);
  });

  it("spreads a single bright pixel while conserving its total", () => {
    const source = field(21, 21, (x, y) => (x === 10 && y === 10 ? 1 : 0));
    const result = blur(source, 2);

    const total = result.data.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(fieldAt(result, 10, 10)).toBeLessThan(0.1);
    expect(fieldAt(result, 11, 10)).toBeGreaterThan(0);
  });

  it("softens a step edge into a ramp", () => {
    const source = field(21, 1, (x) => (x < 10 ? 0 : 1));
    const result = blur(source, 2);

    expect(fieldAt(result, 9, 0)).toBeGreaterThan(0.1);
    expect(fieldAt(result, 10, 0)).toBeLessThan(0.9);
    expect(fieldAt(result, 9, 0)).toBeLessThan(fieldAt(result, 10, 0));
  });
});

describe("sobelMagnitude", () => {
  it("reports nothing on a flat field, borders included", () => {
    const result = sobelMagnitude(field(5, 5, () => 0.4));
    for (const value of result.data) expect(value).toBeCloseTo(0, 6);
  });

  it("scales a full-contrast step edge to about 1", () => {
    const result = sobelMagnitude(field(9, 9, (x) => (x < 4 ? 0 : 1)));
    expect(fieldAt(result, 4, 4)).toBeCloseTo(1, 5);
  });

  it("is polarity-agnostic — the same edge reversed reads the same", () => {
    const rising = sobelMagnitude(field(9, 9, (x) => (x < 4 ? 0 : 1)));
    const falling = sobelMagnitude(field(9, 9, (x) => (x < 4 ? 1 : 0)));

    expect(fieldAt(falling, 4, 4)).toBeCloseTo(fieldAt(rising, 4, 4), 6);
  });

  it("responds to a horizontal edge as strongly as a vertical one", () => {
    const vertical = sobelMagnitude(field(9, 9, (x) => (x < 4 ? 0 : 1)));
    const horizontal = sobelMagnitude(field(9, 9, (_x, y) => (y < 4 ? 0 : 1)));

    expect(fieldAt(horizontal, 4, 4)).toBeCloseTo(fieldAt(vertical, 4, 4), 6);
  });

  it("works on an image straight from the luminance stage", () => {
    const image = greyImage(9, 9, (x) => (x < 4 ? 0 : 1));
    const result = sobelMagnitude(luminanceField(image));

    expect(fieldAt(result, 4, 4)).toBeGreaterThan(0.9);
    expect(fieldAt(result, 0, 4)).toBeCloseTo(0, 5);
  });
});
