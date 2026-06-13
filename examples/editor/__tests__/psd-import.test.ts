import { describe, expect, it } from "vitest";
import { compositeLayerPixels } from "../src/psd-import";

// Helper: build a flat RGBA buffer of size w*h where every pixel is (r,g,b,a).
function solidLayer(w: number, h: number, r: number, g: number, b: number, a: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4 + 0] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

// Helper: read one pixel from a flat RGBA buffer at (x, y) with given stride.
function px(buf: Uint8ClampedArray, stride: number, x: number, y: number): [number, number, number, number] {
  const i = (y * stride + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

describe("compositeLayerPixels", () => {
  it("places a 2×2 layer fully inside a 4×4 doc at (1,1)", () => {
    // Red 2×2 layer placed at doc position (1,1)
    const layer = solidLayer(2, 2, 255, 0, 0, 255);
    const out = compositeLayerPixels(layer, 2, 2, 1, 1, 4, 4);

    // Top-left doc pixel should be transparent
    expect(px(out, 4, 0, 0)).toEqual([0, 0, 0, 0]);
    // Layer pixels land at (1,1), (2,1), (1,2), (2,2)
    expect(px(out, 4, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(px(out, 4, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(px(out, 4, 1, 2)).toEqual([255, 0, 0, 255]);
    expect(px(out, 4, 2, 2)).toEqual([255, 0, 0, 255]);
    // Outside the layer should be transparent
    expect(px(out, 4, 3, 3)).toEqual([0, 0, 0, 0]);
    expect(px(out, 4, 0, 1)).toEqual([0, 0, 0, 0]);
  });

  it("clips correctly when layer has negative left and/or top", () => {
    // 4×4 blue layer placed at (-1,-1); only the 3×3 bottom-right quadrant is in doc
    const layer = solidLayer(4, 4, 0, 0, 255, 255);
    const out = compositeLayerPixels(layer, 4, 4, -1, -1, 3, 3);

    // Pixels (0,0)..(2,2) in doc should be blue
    expect(px(out, 3, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(px(out, 3, 2, 2)).toEqual([0, 0, 255, 255]);
    expect(out.length).toBe(3 * 3 * 4);
  });

  it("clips correctly when layer overflows right/bottom", () => {
    // 4×4 green layer placed at (2,2) inside a 4×4 doc — only top-left 2×2 of layer visible
    const layer = solidLayer(4, 4, 0, 255, 0, 255);
    const out = compositeLayerPixels(layer, 4, 4, 2, 2, 4, 4);

    expect(px(out, 4, 2, 2)).toEqual([0, 255, 0, 255]);
    expect(px(out, 4, 3, 3)).toEqual([0, 255, 0, 255]);
    // Beyond doc boundary — we only have 4×4
    expect(px(out, 4, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out, 4, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  it("copies fully when layer is exactly flush to doc edges", () => {
    // 4×4 layer at (0,0) inside 4×4 doc — entire layer should appear
    const layer = solidLayer(4, 4, 128, 64, 32, 200);
    const out = compositeLayerPixels(layer, 4, 4, 0, 0, 4, 4);

    expect(px(out, 4, 0, 0)).toEqual([128, 64, 32, 200]);
    expect(px(out, 4, 3, 3)).toEqual([128, 64, 32, 200]);
    expect(px(out, 4, 3, 0)).toEqual([128, 64, 32, 200]);
    expect(px(out, 4, 0, 3)).toEqual([128, 64, 32, 200]);
  });

  it("returns all-zero buffer when layer is fully outside the doc", () => {
    const layer = solidLayer(2, 2, 255, 255, 0, 255);
    // Place layer entirely to the right of the 4×4 doc
    const out = compositeLayerPixels(layer, 2, 2, 5, 0, 4, 4);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("returns all-zero buffer for zero-width layer", () => {
    const layer = new Uint8ClampedArray(0);
    const out = compositeLayerPixels(layer, 0, 4, 0, 0, 4, 4);
    expect(out.every((v) => v === 0)).toBe(true);
    expect(out.length).toBe(4 * 4 * 4);
  });

  it("returns all-zero buffer for zero-height layer", () => {
    const layer = new Uint8ClampedArray(0);
    const out = compositeLayerPixels(layer, 4, 0, 0, 0, 4, 4);
    expect(out.every((v) => v === 0)).toBe(true);
    expect(out.length).toBe(4 * 4 * 4);
  });

  it("accepts Uint8Array (not just Uint8ClampedArray) as input", () => {
    // ag-psd may produce a plain Uint8Array; ensure the union type works
    const layer = new Uint8Array(4 * 4); // 1×1 transparent layer
    layer[0] = 10;
    layer[1] = 20;
    layer[2] = 30;
    layer[3] = 40;
    const out = compositeLayerPixels(layer as Uint8Array, 1, 1, 0, 0, 2, 2);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(px(out, 2, 0, 0)).toEqual([10, 20, 30, 40]);
    expect(px(out, 2, 1, 0)).toEqual([0, 0, 0, 0]);
  });
});
