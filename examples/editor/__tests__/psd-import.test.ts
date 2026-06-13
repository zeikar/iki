import { describe, expect, it } from "vitest";
import {
  compositeLayerPixels,
  parsePsdHeader,
  validatePsdHeader,
  MAX_PSD_MEGAPIXELS,
  selectImportableLayers,
  type PsdLayerLike,
} from "../src/psd-import";

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

// ---------------------------------------------------------------------------
// Helper: build a minimal valid 26-byte PSD header buffer
// ---------------------------------------------------------------------------
function buildPsdHeaderBuffer({
  version = 1,
  channels = 3,
  height = 100,
  width = 100,
  bitsPerChannel = 8,
  colorMode = 3,
  signature = "8BPS",
}: {
  version?: number;
  channels?: number;
  height?: number;
  width?: number;
  bitsPerChannel?: number;
  colorMode?: number;
  signature?: string;
} = {}): ArrayBuffer {
  const buf = new ArrayBuffer(26);
  const view = new DataView(buf);
  // Signature (4 bytes, ASCII)
  for (let i = 0; i < 4; i++) {
    view.setUint8(i, signature.charCodeAt(i));
  }
  view.setUint16(4, version, false);
  // bytes 6–11: reserved, left as 0
  view.setUint16(12, channels, false);
  view.setUint32(14, height, false);
  view.setUint32(18, width, false);
  view.setUint16(22, bitsPerChannel, false);
  view.setUint16(24, colorMode, false);
  return buf;
}

describe("parsePsdHeader", () => {
  it("round-trips all fields from a hand-built 26-byte buffer", () => {
    const buf = buildPsdHeaderBuffer({
      version: 1,
      channels: 4,
      height: 800,
      width: 600,
      bitsPerChannel: 8,
      colorMode: 3,
    });
    const h = parsePsdHeader(buf);
    expect(h.version).toBe(1);
    expect(h.channels).toBe(4);
    expect(h.height).toBe(800);
    expect(h.width).toBe(600);
    expect(h.bitsPerChannel).toBe(8);
    expect(h.colorMode).toBe(3);
  });

  it("throws on buffer smaller than 26 bytes", () => {
    const buf = new ArrayBuffer(10);
    expect(() => parsePsdHeader(buf)).toThrow(
      /psd import: file too small to be a valid PSD \(10 bytes, need >= 26\)/,
    );
  });

  it("throws on bad signature", () => {
    const buf = buildPsdHeaderBuffer({ signature: "FAKE" });
    expect(() => parsePsdHeader(buf)).toThrow(
      /psd import: not a PSD file \(bad signature "FAKE"\)/,
    );
  });
});

describe("validatePsdHeader", () => {
  const validHeader = {
    version: 1,
    colorMode: 3,
    bitsPerChannel: 8,
    width: 512,
    height: 512,
  };

  it("passes for a valid RGB 8-bit document", () => {
    expect(() => validatePsdHeader(validHeader)).not.toThrow();
  });

  it("rejects PSB (version 2)", () => {
    expect(() => validatePsdHeader({ ...validHeader, version: 2 })).toThrow(
      /psd import: document: unsupported PSD version 2; PSB \(version 2\) is not supported/,
    );
  });

  it("rejects CMYK (colorMode 4)", () => {
    expect(() => validatePsdHeader({ ...validHeader, colorMode: 4 })).toThrow(
      /psd import: document: unsupported color mode CMYK \(4\); only RGB is supported/,
    );
  });

  it("rejects Lab (colorMode 9)", () => {
    expect(() => validatePsdHeader({ ...validHeader, colorMode: 9 })).toThrow(
      /psd import: document: unsupported color mode Lab \(9\); only RGB is supported/,
    );
  });

  it("rejects 16-bit depth", () => {
    expect(() => validatePsdHeader({ ...validHeader, bitsPerChannel: 16 })).toThrow(
      /psd import: document: unsupported bit depth 16; only 8-bit is supported/,
    );
  });

  it(`rejects documents exceeding ${MAX_PSD_MEGAPIXELS} MP (9000×9000)`, () => {
    expect(() =>
      validatePsdHeader({ ...validHeader, width: 9000, height: 9000 }),
    ).toThrow(
      /psd import: document: 9000x9000 exceeds the 64 megapixel limit/,
    );
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal valid raster PsdLayerLike
// ---------------------------------------------------------------------------
function rasterLayer(name: string, overrides: Partial<PsdLayerLike> = {}): PsdLayerLike {
  return {
    name,
    imageData: { data: new Uint8ClampedArray(4), width: 1, height: 1 },
    ...overrides,
  };
}

describe("selectImportableLayers", () => {
  it("throws on a group layer (children present)", () => {
    const layer: PsdLayerLike = { name: "group", children: [] };
    expect(() => selectImportableLayers([layer])).toThrow(
      /layer "group": groups\/folders are not supported/,
    );
  });

  it("throws on a hidden layer", () => {
    expect(() => selectImportableLayers([rasterLayer("bg", { hidden: true })])).toThrow(
      /layer "bg": hidden layers are not supported/,
    );
  });

  it("throws on a clipping layer", () => {
    expect(() => selectImportableLayers([rasterLayer("clip", { clipping: true })])).toThrow(
      /layer "clip": clipping layers are not supported/,
    );
  });

  it("throws on blend mode other than normal", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("multiply", { blendMode: "multiply" })]),
    ).toThrow(/unsupported blend mode "multiply"; only normal is supported/);
  });

  it("throws on 'pass through' blend mode", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("pt", { blendMode: "pass through" })]),
    ).toThrow(/unsupported blend mode "pass through"; only normal is supported/);
  });

  it("throws on partial opacity (0.5)", () => {
    expect(() => selectImportableLayers([rasterLayer("semi", { opacity: 0.5 })])).toThrow(
      /unsupported opacity 0\.5; only fully-opaque layers are supported/,
    );
  });

  it("throws on a text layer", () => {
    // Text layer WITH cached imageData must still be rejected via the text marker
    expect(() =>
      selectImportableLayers([rasterLayer("label", { text: { text: "Hello" } })]),
    ).toThrow(/layer "label": text layers are not supported/);
  });

  it("throws on a smart-object (placedLayer)", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("smart", { placedLayer: {} })]),
    ).toThrow(/layer "smart": smart-object layers are not supported/);
  });

  it("throws on vectorFill", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("vf", { vectorFill: {} })]),
    ).toThrow(/layer "vf": vector\/shape layers are not supported/);
  });

  it("throws on vectorMask", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("vm", { vectorMask: {} })]),
    ).toThrow(/layer "vm": vector\/shape layers are not supported/);
  });

  it("throws on an adjustment layer", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("adj", { adjustment: {} })]),
    ).toThrow(/layer "adj": adjustment layers are not supported/);
  });

  it("throws on a layer with effects", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("fx", { effects: {} })]),
    ).toThrow(/layer "fx": layer effects are not supported/);
  });

  it("throws on sectionDivider", () => {
    expect(() =>
      selectImportableLayers([rasterLayer("div", { sectionDivider: {} })]),
    ).toThrow(/layer "div": groups\/folders are not supported/);
  });

  it("throws on an empty raster (no imageData)", () => {
    const layer: PsdLayerLike = { name: "empty" };
    expect(() => selectImportableLayers([layer])).toThrow(
      /layer "empty": is not a raster layer \(no pixel data\)/,
    );
  });

  it("throws on zero-width imageData", () => {
    const layer: PsdLayerLike = {
      name: "thin",
      imageData: { data: new Uint8ClampedArray(0), width: 0, height: 4 },
    };
    expect(() => selectImportableLayers([layer])).toThrow(
      /layer "thin": is not a raster layer \(no pixel data\)/,
    );
  });

  it("passes a layer with opacity explicitly set to 1", () => {
    const result = selectImportableLayers([rasterLayer("face", { opacity: 1 })]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("face");
  });

  it("passes a layer with opacity omitted (undefined)", () => {
    const result = selectImportableLayers([rasterLayer("face")]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("face");
  });

  it("does NOT dedupe duplicate top-level layer names", () => {
    const layers = [rasterLayer("eye"), rasterLayer("eye"), rasterLayer("mouth")];
    const result = selectImportableLayers(layers);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("eye");
    expect(result[1].name).toBe("eye");
    expect(result[2].name).toBe("mouth");
  });

  it("returns 4 entries for a clean face/eye_L/eye_R/mouth set", () => {
    const layers = [
      rasterLayer("face"),
      rasterLayer("eye_L"),
      rasterLayer("eye_R"),
      rasterLayer("mouth"),
    ];
    const result = selectImportableLayers(layers);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.name)).toEqual(["face", "eye_L", "eye_R", "mouth"]);
  });

  it("passes with blendMode explicitly set to 'normal'", () => {
    const result = selectImportableLayers([rasterLayer("face", { blendMode: "normal" })]);
    expect(result).toHaveLength(1);
  });
});
