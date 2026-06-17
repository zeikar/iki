import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { packAtlas } from "@iki/editor-core";
import { AutoRigInputError } from "../src/limits";
import {
  decodePng,
  detectAlphaBbox,
  cropToBuffer,
  renderAtlasToDataUri,
  type AtlasCrop,
} from "../src/node-images";

/** Build a straight-alpha RGBA buffer; `paint` sets opaque pixels. */
function makeRgba(
  width: number,
  height: number,
  paint: (set: (x: number, y: number, rgb: [number, number, number]) => void) => void,
): Buffer {
  const buf = Buffer.alloc(width * height * 4); // all transparent (alpha 0)
  const set = (x: number, y: number, rgb: [number, number, number]) => {
    const i = (y * width + x) * 4;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = 255;
  };
  paint(set);
  return buf;
}

/** Decode a data URI / PNG buffer back to raw RGBA for pixel assertions. */
async function decodeDataUri(dataUri: string) {
  const base64 = dataUri.replace(/^data:image\/png;base64,/, "");
  const png = Buffer.from(base64, "base64");
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const px = (data: Buffer, width: number, x: number, y: number) => {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]] as const;
};

describe("detectAlphaBbox", () => {
  it("throws AutoRigInputError on a fully transparent layer", () => {
    const rgba = makeRgba(8, 8, () => {});
    expect(() => detectAlphaBbox(rgba, 8, 8)).toThrow(AutoRigInputError);
    expect(() => detectAlphaBbox(rgba, 8, 8)).toThrow(/empty after alpha threshold/);
  });

  it("expands a single interior opaque pixel by 1px each side", () => {
    const rgba = makeRgba(10, 10, (set) => set(5, 4, [255, 0, 0]));
    // minX=maxX=5, minY=maxY=4 → x=4,y=3,x2=6,y2=5 → w=3,h=3
    expect(detectAlphaBbox(rgba, 10, 10)).toEqual({ x: 4, y: 3, w: 3, h: 3 });
  });

  it("clamps the 1px expand at the top-left corner (no over-expand)", () => {
    const rgba = makeRgba(10, 10, (set) => set(0, 0, [0, 255, 0]));
    // minX=maxX=0 → x=0, x2=min(9,1)=1 → w=2; same for y
    expect(detectAlphaBbox(rgba, 10, 10)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });

  it("clamps the 1px expand at the bottom-right edge", () => {
    const rgba = makeRgba(10, 10, (set) => set(9, 9, [0, 0, 255]));
    // maxX=9 → x2=min(9,10)=9, x=max(0,8)=8 → w=2; same for y
    expect(detectAlphaBbox(rgba, 10, 10)).toEqual({ x: 8, y: 8, w: 2, h: 2 });
  });

  it("returns a tight bbox + 1px margin for an interior rect", () => {
    const rgba = makeRgba(20, 20, (set) => {
      for (let y = 5; y <= 8; y++) for (let x = 6; x <= 10; x++) set(x, y, [200, 100, 50]);
    });
    // x:6..10 → 5..11 (w=7); y:5..8 → 4..9 (h=6)
    expect(detectAlphaBbox(rgba, 20, 20)).toEqual({ x: 5, y: 4, w: 7, h: 6 });
  });
});

describe("decodePng", () => {
  it("decodes a PNG to RGBA bytes + dims and promotes RGB to RGBA", async () => {
    // An opaque-RGB (no alpha) PNG must still come back as stride-4 RGBA.
    const png = await sharp({
      create: { width: 6, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/iki-mcp-decode-${Date.now()}.png`;
    await sharp(png).toFile(tmp);
    const decoded = await decodePng(tmp);
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(4);
    expect(decoded.rgba.length).toBe(6 * 4 * 4);
    // First pixel: r=10,g=20,b=30, alpha promoted to 255.
    expect(Array.from(decoded.rgba.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it("throws AutoRigInputError (path-qualified) for a non-PNG file", async () => {
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/iki-mcp-decode-${Date.now()}.png`;
    await sharp(jpeg).jpeg().toFile(tmp);
    await expect(decodePng(tmp)).rejects.toThrow(AutoRigInputError);
    await expect(decodePng(tmp)).rejects.toThrow(/non-PNG/);
  });
});

describe("cropToBuffer", () => {
  it("crops the decoded RGBA to the bbox dimensions", async () => {
    const rgba = makeRgba(12, 12, (set) => {
      for (let y = 3; y < 7; y++) for (let x = 2; x < 9; x++) set(x, y, [9, 9, 9]);
    });
    const cropped = await cropToBuffer(rgba, 12, 12, { x: 2, y: 3, w: 7, h: 4 });
    const meta = await sharp(cropped).metadata();
    expect(meta.width).toBe(7);
    expect(meta.height).toBe(4);
    expect(meta.format).toBe("png");
  });
});

describe("renderAtlasToDataUri", () => {
  it("composites crops at packed placements with an edge-extruded gutter", async () => {
    // Two solid crops with distinct colors so the gutter (extruded edge) is
    // distinguishable from transparent background.
    const colorA: [number, number, number] = [220, 30, 30];
    const colorB: [number, number, number] = [30, 30, 220];
    const cropABuf = await sharp({
      create: { width: 5, height: 4, channels: 4, background: { r: colorA[0], g: colorA[1], b: colorA[2], alpha: 1 } },
    })
      .png()
      .toBuffer();
    const cropBBuf = await sharp({
      create: { width: 6, height: 3, channels: 4, background: { r: colorB[0], g: colorB[1], b: colorB[2], alpha: 1 } },
    })
      .png()
      .toBuffer();

    const layout = packAtlas([
      { id: "a", width: 5, height: 4 },
      { id: "b", width: 6, height: 3 },
    ]);
    expect(layout.padding).toBeGreaterThan(0);

    const crops: AtlasCrop[] = [
      { id: "a", buffer: cropABuf, width: 5, height: 4 },
      { id: "b", buffer: cropBBuf, width: 6, height: 3 },
    ];
    const dataUri = await renderAtlasToDataUri(crops, layout);
    expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);

    const { data, width, height } = await decodeDataUri(dataUri);
    expect(width).toBe(layout.pageWidth);
    expect(height).toBe(layout.pageHeight);

    const pad = layout.padding;
    for (const placement of layout.placements) {
      const color = placement.id === "a" ? colorA : colorB;
      const { x, y, width: w, height: h } = placement;
      // Interior edge pixel is the crop color.
      expect(px(data, width, x + w - 1, y)).toEqual([...color, 255]);
      // Right gutter pixel: extruded edge → same color, opaque (NOT transparent).
      expect(px(data, width, x + w, y)).toEqual([...color, 255]);
      // Bottom gutter pixel: extruded edge → same color, opaque.
      expect(px(data, width, x, y + h)).toEqual([...color, 255]);
      // Corner gutter pixel: extruded → same color, opaque.
      if (pad > 0) {
        expect(px(data, width, x + w, y + h)).toEqual([...color, 255]);
      }
    }
  });
});
