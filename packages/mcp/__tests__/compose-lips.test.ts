import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  columnRuns,
  createLayerSetMeasurer,
  mouthOpening,
  mouthRestShift,
  type LayerInput,
  type Opening,
} from "@ikijs/editor";
import { parseIkiModel } from "@ikijs/format";
import { autoRigFromLayers } from "../src/tools";
import {
  ORDER,
  composeLayersFromParts,
  type ComposeInput,
  type ComposeResult,
} from "../src/compose";
import { denseCoreOf } from "../src/measure-turn";
import {
  closedLips,
  keyBorderWhite,
  keyGreen,
  prepInterior,
  restShiftOf,
  splitLipSet,
} from "../src/compose-lips";
import { decodePng } from "../src/node-images";
import { luma as lumaOf } from "../src/trim";
import {
  CAVITY,
  LIP_RIM,
  TEETH,
  TONGUE,
  writeInterior,
  writeFullBodyParts,
  writeKeyedMouth,
  writeLipParts,
  writePartsSet,
  writeSoftNose,
} from "./helpers/parts";

type RGB = [number, number, number];

const FILL: RGB = [9, 245, 3];
const LINE: RGB = [67, 25, 17];
const PURE: RGB = [0, 255, 0];
const SKIN_TONE: RGB = [251, 183, 168];

const mix = (f: RGB, g: RGB, t: number): RGB =>
  f.map((v, i) => Math.round((1 - t) * v + t * g[i])) as RGB;

/** A W x H RGBA buffer painted by `paint(x, y)`; undefined stays transparent. */
function paint(
  W: number,
  H: number,
  at: (x: number, y: number) => RGB | [...RGB, number] | undefined,
): Buffer {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      if (c === undefined) continue;
      buf.set([c[0], c[1], c[2], c.length === 4 ? c[3] : 255], (y * W + x) * 4);
    }
  }
  return buf;
}

const px = (buf: Buffer, W: number, x: number, y: number) => [
  ...buf.subarray((y * W + x) * 4, (y * W + x) * 4 + 4),
];

/** A column of colours by row: `rows[y]` for every x. */
const bands = (rows: (RGB | [...RGB, number])[]) => (_x: number, y: number) =>
  rows[y];

const T_FILL = 0.1;
const ramp = (from: RGB, to: RGB) =>
  Array.from({ length: 8 }, (_, k) => mix(from, to, T_FILL * (k + 1)));

function isNear(rgba: Buffer, i: number, rgb: readonly number[], tol = 12) {
  return (
    rgba[i + 3] > 128 &&
    [0, 1, 2].every((c) => Math.abs(rgba[i + c] - rgb[c]) <= tol)
  );
}
function countNear(rgba: Buffer, rgb: readonly number[], tol = 12): number {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (isNear(rgba, i, rgb, tol)) n++;
  return n;
}

describe("keyGreen", () => {
  const W = 60;
  const H = 40;

  it("(a) reads each mixed pixel at its own alpha along bob's ramp", () => {
    const rows = [
      ...Array.from({ length: 8 }, () => LINE),
      ...ramp(LINE, FILL),
      ...Array.from({ length: 24 }, () => FILL),
    ];
    const src = paint(W, H, bands(rows));
    const rgba = keyGreen(src, W, H);
    for (let y = 16; y < H; y++) expect(rgba[(y * W + 5) * 4 + 3]).toBe(0);
    for (let y = 0; y < 8; y++)
      expect(px(rgba, W, 5, y)).toEqual([...LINE, 255]);
    for (let k = 0; k < 8; k++) {
      const p = px(rgba, W, 5, 8 + k);
      expect(p[3]).toBe([229, 204, 179, 153, 128, 102, 76, 51][k]);
      expect(p.slice(0, 3)).toEqual(LINE);
    }
  });

  it("(b) lands a half mix of a pale line and pure green at half alpha", () => {
    const line: RGB = [40, 29, 30];
    const rows = [
      ...Array.from({ length: 8 }, () => line),
      ...ramp(line, PURE),
      ...Array.from({ length: 24 }, () => PURE),
    ];
    const rgba = keyGreen(paint(W, H, bands(rows)), W, H);
    expect(px(rgba, W, 5, 12)).toEqual([40, 29, 30, 128]);
  });

  it("(c) reads a ramp against its own plateau, not the line beside it", () => {
    const skinRows = [
      ...Array.from({ length: 8 }, () => SKIN_TONE),
      ...ramp(SKIN_TONE, FILL),
    ];
    const lineRows = Array.from({ length: 16 }, () => LINE);
    const src = paint(W, H, (x, y) =>
      y >= 16 ? FILL : (x < 30 ? skinRows : lineRows)[y],
    );
    const rgba = keyGreen(src, W, H);
    for (let k = 0; k < 8; k++) {
      const p = px(rgba, W, 29, 8 + k);
      expect(p[3]).toBe([230, 204, 178, 153, 128, 102, 77, 51][k]);
      expect(p.slice(0, 3)).toEqual(SKIN_TONE);
    }
    for (let y = 8; y < 16; y++)
      expect(px(rgba, W, 31, y)).toEqual([...LINE, 255]);
  });

  it("(d) is limited by its reach: a ramp longer than it reads the plateau it can see", () => {
    const m20: RGB = [55, 69, 14];
    const m50: RGB = [38, 135, 10];
    const rows = [
      ...Array.from({ length: 6 }, () => LINE),
      ...Array.from({ length: 9 }, () => m20),
      m50,
      ...Array.from({ length: 24 }, () => FILL),
    ];
    const rgba = keyGreen(paint(W, H, bands(rows)), W, H);
    const last = px(rgba, W, 5, 15);
    expect(last.slice(0, 3)).toEqual(m20);
    expect(last[3]).toBe(159);
    for (let y = 8; y <= 13; y++) {
      const p = px(rgba, W, 5, y);
      expect(p[3]).toBe(204);
      expect(p.slice(0, 3)).toEqual(LINE);
    }
  });

  it("(e) leaves a stroke's own shading alone and keys the ramp past it", () => {
    const rows: (RGB | [...RGB, number])[] = [
      ...Array.from(
        { length: 10 },
        (_, y): RGB => (y % 2 === 0 ? [107, 44, 44] : [101, 37, 37]),
      ),
      LINE,
      LINE,
      ...[0.2, 0.4, 0.6, 0.8].map((t) => mix(LINE, FILL, t)),
      ...Array.from({ length: 24 }, () => FILL),
    ];
    const rgba = keyGreen(paint(W, H, bands(rows)), W, H);
    for (const y of [8, 9]) expect(px(rgba, W, 5, y)[3]).toBe(255);
    [204, 153, 102, 50].forEach((a, k) => {
      const p = px(rgba, W, 5, 12 + k);
      expect(p[3]).toBe(a);
      if (k < 3) expect(p.slice(0, 3)).toEqual(LINE);
    });
  });

  it("(f) ignores green under zero alpha", () => {
    expect(() =>
      keyGreen(
        paint(W, H, () => [...PURE, 0]),
        W,
        H,
      ),
    ).toThrow(/no green opening/);
    const src = paint(W, H, (x, y) =>
      y < 20 ? FILL : x < 20 ? [...PURE, 0] : SKIN_TONE,
    );
    const rgba = keyGreen(src, W, H);
    expect(px(rgba, W, 30, 21)).toEqual([...SKIN_TONE, 255]);
  });

  it("(g) refuses green outside the opening past 2 %, passes under it", () => {
    const bar = (len: number) =>
      paint(W, H, (x, y) =>
        y < 20 ? PURE : y === 30 && x < len ? PURE : SKIN_TONE,
      );
    expect(() => keyGreen(bar(60), W, H)).toThrow(/green outside the opening/);
    expect(() => keyGreen(bar(12), W, H)).not.toThrow();
  });

  it("(i) clears faint green with the fill, in reach of it or not", () => {
    const faint = [9, 245, 3, 100] as [...RGB, number];
    const rows = [
      ...Array.from({ length: 16 }, () => LINE),
      ...Array.from({ length: 24 }, () => FILL),
    ];
    const src = paint(W, H, (x, y) =>
      x === 5 && (y === 15 || y === 2) ? faint : rows[y],
    );
    const rgba = keyGreen(src, W, H);
    expect(px(rgba, W, 5, 15)[3]).toBe(0);
    expect(px(rgba, W, 5, 2)[3]).toBe(0);
    expect(px(rgba, W, 6, 15)).toEqual([...LINE, 255]);
  });

  it("(h) leaves a pixel out of reach of the fill untouched", () => {
    const odd: RGB = [200, 215, 120];
    const src = paint(W, H, (x, y) =>
      y < 10 ? FILL : x === 5 && y === 30 ? odd : SKIN_TONE,
    );
    const rgba = keyGreen(src, W, H);
    expect(px(rgba, W, 5, 30)).toEqual([...odd, 255]);
  });
});

describe("keyBorderWhite", () => {
  const W = 40;
  const H = 30;
  const ground = (g: RGB) =>
    paint(W, H, (x, y) =>
      x >= 10 && x < 30 && y >= 8 && y < 22 ? (y < 12 ? TEETH : CAVITY) : g,
    );

  it("keys the white corners and keeps the teeth", () => {
    const out = keyBorderWhite(ground([255, 255, 255]), W, H);
    expect(px(out, W, 0, 0)[3]).toBe(0);
    expect(px(out, W, 39, 29)[3]).toBe(0);
    expect(px(out, W, 15, 9)).toEqual([...TEETH, 255]);
    expect(px(out, W, 15, 15)).toEqual([...CAVITY, 255]);
  });

  it("keys only the corners of a drawing that runs off the image", () => {
    const oval = paint(W, H, (x, y) =>
      ((x + 0.5 - 20) / 26) ** 2 + ((y + 0.5 - 15) / 18) ** 2 <= 1
        ? CAVITY
        : [255, 255, 255],
    );
    const out = keyBorderWhite(oval, W, H);
    expect(px(out, W, 0, 0)[3]).toBe(0);
    expect(px(out, W, 20, 15)).toEqual([...CAVITY, 255]);
    expect(px(out, W, 20, 0)).toEqual([...CAVITY, 255]);
  });

  it("leaves a cavity that fills the image alone", () => {
    const full = paint(W, H, () => CAVITY);
    expect(keyBorderWhite(full, W, H)).toEqual(full);
  });

  it("refuses a checkerboard fake transparency", () => {
    for (const other of [204, 230, 238, 245]) {
      const checker = paint(W, H, (x, y) =>
        (x + y) % 2 === 0 ? [255, 255, 255] : [other, other, other],
      );
      expect(() => keyBorderWhite(checker, W, H)).toThrow(
        other >= 238 ? /too noisy or shaded/ : /came back opaque on a/,
      );
    }
  });

  it("keys a clean white ground that a drawing touches a third of the border of", () => {
    const strip = paint(W, H, (x) => (x < 6 ? CAVITY : [255, 255, 255]));
    const out = keyBorderWhite(strip, W, H);
    expect(px(out, W, 39, 29)[3]).toBe(0);
    expect(px(out, W, 2, 10)).toEqual([...CAVITY, 255]);
  });

  it("refuses a cream ground rather than stretching it into the opening", () => {
    expect(() => keyBorderWhite(ground([240, 228, 205]), W, H)).toThrow(
      /non-white ground/,
    );
  });

  it("refuses a ground too noisy to key", () => {
    // A white ground with a gradient along the border: the pixels within
    // ±4 of the border's median own under GROUND_BORDER_SHARE of it.
    const noisy = paint(W, H, (x) => {
      const v = 238 + Math.floor((17 * x) / (W - 1));
      return [v, v, v];
    });
    expect(() => keyBorderWhite(noisy, W, H)).toThrow(/too noisy or shaded/);
  });
});

describe("prepInterior", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lips-interior-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("removes the lip rim and keeps the cavity, teeth and tongue", async () => {
    await writeInterior(dir);
    const src = await decodePng(path.join(dir, "mouth_interior.png"));
    const prepared = await prepInterior(src.rgba, src.width, src.height);
    expect((await sharp(prepared.png).metadata()).height).toBe(src.height - 6);
    const out = await sharp(prepared.png).ensureAlpha().raw().toBuffer();
    expect(countNear(out, CAVITY)).toBeGreaterThan(0);
    expect(countNear(out, TEETH)).toBeGreaterThan(0);
    expect(countNear(out, TONGUE)).toBeGreaterThan(0);
    expect(countNear(out, LIP_RIM)).toBe(0);
    prepared.cavity.forEach((v, c) =>
      expect(Math.abs(v - CAVITY[c])).toBeLessThanOrEqual(8),
    );
  });

  it("refuses an interior that is all rim", async () => {
    await writeInterior(dir, { allRim: true });
    const src = await decodePng(path.join(dir, "mouth_interior.png"));
    await expect(prepInterior(src.rgba, src.width, src.height)).rejects.toThrow(
      /only lips\/skin|nothing but lips/,
    );
  });
});

describe("splitLipSet and closedLips", () => {
  const W = 76;
  let dir: string;
  let H: number;
  let frame: Buffer;
  let interior: Awaited<ReturnType<typeof prepInterior>>;
  let split: Awaited<ReturnType<typeof splitLipSet>>;

  /** A frame from the keyed fixture, keyed then resized as the composer does. */
  async function composedFrame(opts: Parameters<typeof writeKeyedMouth>[1]) {
    await writeKeyedMouth(dir, opts);
    const src = await decodePng(path.join(dir, "mouth_keyed.png"));
    const keyed = keyGreen(src.rgba, src.width, src.height);
    return sharp(keyed, {
      raw: { width: src.width, height: src.height, channels: 4 },
    })
      .resize(W, Math.round((src.height * W) / src.width), { fit: "fill" })
      .png()
      .toBuffer();
  }

  const rawOf = async (png: Buffer) =>
    (await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))
      .data;

  /** Per column, the first row of the enclosed hole (-1: none), by a flood
   *  from the border through transparent pixels, and the enclosed mask. */
  function holeTops(rgba: Buffer, w: number, h: number) {
    const outside = new Uint8Array(w * h);
    const stack: number[] = [];
    const seed = (p: number) => {
      if (!outside[p] && rgba[p * 4 + 3] < 128) {
        outside[p] = 1;
        stack.push(p);
      }
    };
    for (let x = 0; x < w; x++) (seed(x), seed((h - 1) * w + x));
    for (let y = 0; y < h; y++) (seed(y * w), seed(y * w + w - 1));
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % w;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (p >= w) seed(p - w);
      if (p < w * h - w) seed(p + w);
    }
    const tops = new Int32Array(w).fill(-1);
    const enclosed = new Uint8Array(w * h);
    for (let y = h - 1; y >= 0; y--)
      for (let x = 0; x < w; x++)
        if (rgba[(y * w + x) * 4 + 3] < 128 && !outside[y * w + x]) {
          tops[x] = y;
          enclosed[y * w + x] = 1;
        }
    return { tops, enclosed };
  }

  const measure = (layers: Record<string, Buffer>, h: number) => {
    const measurer = createLayerSetMeasurer({ width: W, height: h });
    const byRole = new Map<string, LayerInput>();
    for (const [role, rgba] of Object.entries(layers)) {
      byRole.set(role, measurer.add({ role, fileName: `${role}.png`, rgba })!);
    }
    return byRole;
  };

  let buffers: { inner: Buffer; lower: Buffer; upper: Buffer };
  let byRole: Map<string, LayerInput>;
  let opening: Opening;
  let tops: Int32Array;
  let enclosed: Uint8Array;
  let holeCols: [number, number];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lips-split-"));
    await writeInterior(dir);
    const src = await decodePng(path.join(dir, "mouth_interior.png"));
    interior = await prepInterior(src.rgba, src.width, src.height);
    const png = await composedFrame({});
    H = (await sharp(png).metadata()).height!;
    frame = await rawOf(png);
    split = await splitLipSet(png, W, H, interior);
    buffers = {
      inner: await rawOf(split.inner),
      lower: await rawOf(split.lower),
      upper: await rawOf(split.upper),
    };
    byRole = measure(
      {
        mouth_inner: buffers.inner,
        lip_lower: buffers.lower,
        lip_upper: buffers.upper,
      },
      H,
    );
    opening = mouthOpening(byRole);
    ({ tops, enclosed } = holeTops(frame, W, H));
    const cols = [...tops.keys()].filter((x) => tops[x] >= 0);
    holeCols = [cols[0], cols[cols.length - 1]];
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns three frame-sized buffers and the rig's own reading", () => {
    for (const b of Object.values(buffers)) expect(b.length).toBe(W * H * 4);
    expect(opening.w).toBeGreaterThanOrEqual(3);
    expect(split.opening.x0).toBe(opening.x0);
    expect(split.opening.x1).toBe(opening.x1);
    expect((opening.x1 - opening.x0 + 1) / W).toBeGreaterThanOrEqual(0.5);
  });

  it("meets the fold's contract on every column, grown ones included", () => {
    expect(opening.x0).toBe(holeCols[0] - 1);
    expect(opening.x1).toBe(holeCols[1] + 1);
    const lowerRuns = columnRuns(byRole.get("lip_lower")!);
    for (let x = opening.x0; x <= opening.x1; x++) {
      const c = opening.at(x);
      // The two grown columns too: the wall under the line's end folds with
      // the interior, so the line's bottom is the interior's top there.
      expect(c.Tu).toBe(c.T);
      expect(c.T).toBeLessThanOrEqual(c.lineTop);
      expect(c.lineH).toBeGreaterThan(0);
      if (lowerRuns.has(x)) expect(c.Bl).toBeGreaterThan(c.Bb);
      else expect(c.Bl).toBe(c.Bb);
    }
  });

  it("lays the interior under ink only and never above the hole's top", () => {
    const { inner } = buffers;
    for (let x = 0; x < W; x++) {
      // A grown column answers to its neighbouring hole's top.
      const top =
        tops[x] >= 0
          ? tops[x]
          : x === holeCols[0] - 1
            ? tops[holeCols[0]]
            : x === holeCols[1] + 1
              ? tops[holeCols[1]]
              : H;
      for (let y = 0; y < H; y++) {
        const a = inner[(y * W + x) * 4 + 3];
        if (a < 128) continue;
        expect(y).toBeGreaterThanOrEqual(top);
        if (tops[x] < 0)
          expect(frame[(y * W + x) * 4 + 3]).toBeGreaterThanOrEqual(128);
      }
    }
  });

  it("fills the hole with the interior, and keeps the rim and the green out", () => {
    const { inner, lower, upper } = buffers;
    // Only the hole's own pixels: the band and the skin row are not interior.
    const inHole = Buffer.alloc(inner.length);
    for (let p = 0; p < W * H; p++) {
      if (enclosed[p]) inner.copy(inHole, p * 4, p * 4, p * 4 + 4);
    }
    expect(countNear(inHole, TEETH)).toBeGreaterThan(0);
    expect(countNear(inHole, TONGUE)).toBeGreaterThan(0);
    expect(countNear(inner, LIP_RIM, 10)).toBe(0);
    for (let p = 0; p < W * H; p++)
      if (enclosed[p]) expect(inner[p * 4 + 3]).toBe(255);
    for (const b of [inner, lower, upper])
      for (let i = 0; i < b.length; i += 4)
        if (b[i + 3] >= 128)
          expect(b[i + 1] - Math.max(b[i], b[i + 2])).toBeLessThanOrEqual(8);
  });

  it("keeps the line and the hooks in lip_upper, nothing under the hole", () => {
    const { upper } = buffers;
    const centre = opening.centre;
    for (let y = tops[centre]; y < H; y++)
      expect(upper[(y * W + centre) * 4 + 3]).toBeLessThan(128);
    let hooks = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        // Past the ring's side walls, so only a hook stroke can be there.
        if (
          (x <= holeCols[0] - 4 || x >= holeCols[1] + 4) &&
          upper[(y * W + x) * 4 + 3] >= 128
        )
          hooks++;
    expect(hooks).toBeGreaterThan(0);
  });

  it("folds the side wall with the interior, not with the line", () => {
    const { inner, upper } = buffers;
    for (const x of [holeCols[0] - 1, holeCols[1] + 1]) {
      const near = x < holeCols[0] ? holeCols[0] : holeCols[1];
      let spans = 0;
      for (let y = 0; y < H; y++) {
        if (!enclosed[y * W + near]) continue;
        spans++;
        expect(upper[(y * W + x) * 4 + 3]).toBeLessThan(128);
        const i = (y * W + x) * 4;
        expect(inner[i + 3]).toBeGreaterThanOrEqual(128);
        // The wall's ink over the fill: the frame's own dark line.
        for (let c = 0; c < 3; c++)
          expect(Math.abs(inner[i + c] - frame[i + c])).toBeLessThanOrEqual(30);
      }
      expect(spans).toBeGreaterThan(0);
    }
  });

  it("keeps a side column's pixels in the line when no ink is above its wall", async () => {
    // The ring's ink beside the hole starts on the hole's top row: nothing
    // above it at that column.
    const hand = await sharp(
      paint(W, 40, (x, y) => {
        if (x < 6 || x > 69 || y < 8 || y > 34) return undefined;
        const hole = x >= 10 && x <= 65 && y >= 10 && y <= 26;
        if (hole) return undefined;
        // The skin under the opening.
        if (y > 30)
          return x >= 10 && x <= 65 ? ([240, 190, 170] as RGB) : undefined;
        // Above the hole the line spans only the hole's columns; the side
        // walls start on the hole's top row.
        if (y < 10 && (x < 10 || x > 65)) return undefined;
        return [20, 20, 30] as RGB;
      }),
      { raw: { width: W, height: 40, channels: 4 } },
    )
      .png()
      .toBuffer();
    const handFrame = await rawOf(hand);
    const result = await splitLipSet(hand, W, 40, interior);
    const upper = await rawOf(result.upper);
    const inner = await rawOf(result.inner);
    const x = result.opening.x0;
    const c = result.opening.at(x);
    expect(c.Tu).toBeLessThan(c.T);
    // The wall column still holds its ink in lip_upper.
    let kept = 0;
    for (let y = 0; y < 40; y++) {
      if (handFrame[(y * W + x) * 4 + 3] >= 128 && y >= 10 && y <= 26) {
        expect(upper[(y * W + x) * 4 + 3]).toBeGreaterThanOrEqual(128);
        kept++;
      }
    }
    expect(kept).toBeGreaterThan(0);
    expect(inner[(10 * W + x) * 4 + 3]).toBeGreaterThanOrEqual(128);
  });

  it("refuses the frames the rig could not fold", async () => {
    await expect(
      splitLipSet(await composedFrame({ broken: true }), W, H, interior),
    ).rejects.toThrow(/not closed/);

    const hand = (hole: (x: number, y: number) => boolean) =>
      sharp(
        paint(W, 36, (x, y) => {
          if (x < 6 || x > 69 || y < 6 || y > 30) return undefined;
          return hole(x, y) ? undefined : ([20, 20, 30] as RGB);
        }),
        { raw: { width: W, height: 36, channels: 4 } },
      )
        .png()
        .toBuffer();
    await expect(
      splitLipSet(
        await hand((x, y) => x >= 30 && x <= 44 && y >= 12 && y <= 22),
        W,
        36,
        interior,
      ),
    ).rejects.toThrow(/too small to fold/);
    await expect(
      splitLipSet(
        await hand(
          (x, y) =>
            y >= 10 &&
            y <= 26 &&
            ((x >= 10 && x <= 36) || (x >= 39 && x <= 65)),
        ),
        W,
        36,
        interior,
      ),
    ).rejects.toThrow(/not one connected region/);
    // An outline with nothing under it: no lower lip to fold.
    await expect(
      splitLipSet(
        await hand((x, y) => x >= 10 && x <= 65 && y >= 10 && y <= 26),
        W,
        36,
        interior,
      ),
    ).rejects.toThrow(/lip_lower/);
  });

  it("closes the lips onto the seam, hooks unmoved", async () => {
    // The mouth-sized split measured on its own frame: a unit test of the
    // shifting, not of the canvas geometry.
    const closed = await closedLips(
      split.upper,
      split.lower,
      await restShiftOf(
        {
          mouth_inner: split.inner,
          lip_lower: split.lower,
          lip_upper: split.upper,
        },
        W,
        H,
      ),
      0,
    );
    const upper = await rawOf(closed.upper);
    const lower = await rawOf(closed.lower);
    const c = opening.centre;
    const at = opening.at(c);
    const seamRow = H / 2 - at.seam;
    const lowestUpper = Math.max(
      ...Array.from({ length: H }, (_, y) => y).filter(
        (y) => upper[(y * W + c) * 4 + 3] >= 128,
      ),
    );
    expect(Math.abs(lowestUpper + 1 - Math.round(seamRow))).toBeLessThanOrEqual(
      1,
    );
    const firstLower = Math.min(
      ...Array.from({ length: H }, (_, y) => y).filter(
        (y) => lower[(y * W + c) * 4 + 3] >= 128,
      ),
    );
    expect(
      Math.abs(firstLower - (Math.round(seamRow) - at.overlap)),
    ).toBeLessThanOrEqual(1);
    // A hook column (outside the opening) is byte-for-byte where it was.
    const hook = Math.max(0, opening.x0 - 3);
    for (let y = 0; y < H; y++)
      expect(
        upper.subarray((y * W + hook) * 4, (y * W + hook) * 4 + 4),
      ).toEqual(
        buffers.upper.subarray((y * W + hook) * 4, (y * W + hook) * 4 + 4),
      );
  });
});

describe("closedLips: a sub-pixel shift", () => {
  it("moves a straight line smoothly, no one-row steps, alpha kept", async () => {
    const W = 20;
    const H = 40;
    const row0 = 20;
    const step = 0.2;
    const buf = Buffer.alloc(W * H * 4);
    for (let x = 0; x < W; x++)
      for (const y of [row0, row0 + 1])
        buf.set([200, 90, 80, 255], (y * W + x) * 4);
    const png = await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer();
    // The upper lip's dy is a column-dependent, non-integer rise.
    const { upper } = await closedLips(png, png, (_role, x) => 8 + step * x, 0);
    const out = (
      await sharp(upper)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    ).data;
    const centres: number[] = [];
    for (let x = 0; x < W; x++) {
      let sum = 0;
      let moment = 0;
      for (let y = 0; y < H; y++) {
        const a = out[(y * W + x) * 4 + 3];
        sum += a;
        moment += a * (y + 0.5);
        // Straight alpha: the colour stays the line's wherever it is drawn.
        if (a > 0) expect(out[(y * W + x) * 4]).toBe(200);
      }
      expect(Math.abs(sum - 2 * 255)).toBeLessThanOrEqual(2);
      centres.push(moment / sum);
      expect(moment / sum).toBeCloseTo(row0 + 1 - (8 + step * x), 1);
    }
    for (let x = 1; x < W; x++)
      expect(Math.abs(centres[x] - centres[x - 1] + step)).toBeLessThan(0.05);
  });
});

describe("composeLayersFromParts: the lip set", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const parts = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-lips-parts-"));
    dirs.push(d);
    return d;
  };
  /** Output resolves under cwd; node_modules is gitignored. */
  const out = (): string => {
    const d = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules", ".iki-mcp-lips-"),
    );
    dirs.push(d);
    return d;
  };
  type Ok = Extract<ComposeResult, { ok: true }>;
  const ok = async (input: ComposeInput): Promise<Ok> => {
    const r = await composeLayersFromParts(input);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r;
  };
  const err = async (input: ComposeInput): Promise<string> => {
    const r = await composeLayersFromParts(input);
    if (r.ok) throw new Error("expected a failure, got ok");
    return r.error;
  };
  const digest = (dir: string) =>
    fs
      .readdirSync(dir)
      .sort()
      .map(
        (f) =>
          `${f}:${crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(dir, f)))
            .digest("hex")}`,
      );
  const lipParts = async (opts?: Parameters<typeof writeLipParts>[1]) => {
    const d = parts();
    await writeLipParts(d, opts);
    return d;
  };
  const layerOf = (r: Ok, role: string) =>
    r.layers.find((l) => l.role === role)!;
  const LIPS = ["mouth_inner", "lip_lower", "lip_upper"] as const;

  let result: Ok;
  let outDir: string;
  beforeAll(async () => {
    outDir = out();
    result = await ok({ partsDir: await lipParts(), outDir });
  });

  it("writes the three layers on one frame, in draw order, and no legacy mouth", () => {
    const [inner, lower, upper] = LIPS.map((r) => layerOf(result, r));
    for (const l of [lower, upper]) {
      expect([l.width, l.height, l.left, l.top]).toEqual([
        inner.width,
        inner.height,
        inner.left,
        inner.top,
      ]);
    }
    expect(inner.left).toBe(Math.round(550 - inner.width / 2));
    expect(inner.top).toBe(Math.round(596 - inner.height / 2));
    const roles = result.layers.map((l) => l.role);
    const at = (r: string) => roles.indexOf(r as never);
    expect(at("mouth_inner")).toBe(at("nose") + 1);
    expect(at("lip_lower")).toBe(at("mouth_inner") + 1);
    expect(at("lip_upper")).toBe(at("lip_lower") + 1);
    expect(at("eye_L")).toBe(at("lip_upper") + 1);
    expect(roles).not.toContain("mouth");
    expect(roles).not.toContain("mouth_open");
    expect(fs.existsSync(path.join(outDir, "mouth.png"))).toBe(false);
    for (const r of [...LIPS, "mouth", "mouth_open"])
      expect(result.skipped).not.toContain(r);
    // ORDER keeps the lip roles after mouth_open.
    expect(ORDER.indexOf("lip_upper")).toBe(ORDER.indexOf("mouth_open") + 3);
  });

  async function openingOf(dir: string) {
    const measurer = createLayerSetMeasurer({ width: 1100, height: 1100 });
    const byRole = new Map<string, LayerInput>();
    for (const role of LIPS) {
      const { rgba } = await decodePng(path.join(dir, `${role}.png`));
      byRole.set(role, measurer.add({ role, fileName: `${role}.png`, rgba })!);
    }
    return { byRole, opening: mouthOpening(byRole) };
  }

  it("meets the rig's contract on the canvas, and the report has no lip warning", async () => {
    const { byRole, opening } = await openingOf(outDir);
    const lowerRuns = columnRuns(byRole.get("lip_lower")!);
    expect(opening.w).toBeGreaterThanOrEqual(3);
    for (let x = opening.x0; x <= opening.x1; x++) {
      const c = opening.at(x);
      expect(c.Tu).toBeLessThanOrEqual(c.T);
      expect(c.T).toBeLessThanOrEqual(c.lineTop);
      expect(c.lineH).toBeGreaterThan(0);
      if (lowerRuns.has(x)) expect(c.Bl).toBeGreaterThan(c.Bb);
    }
    const lipLines = result.measure.warnings.filter((w) =>
      /^(mouth_inner|lip_lower|lip_upper)/.test(w),
    );
    expect(lipLines).toEqual([]);
    expect(result.measure.lips?.opening.width).toBe(
      opening.x1 - opening.x0 + 1,
    );
  });

  it("previews the set closed: the line on the seam, no interior", async () => {
    // The fixture's hair_front blob covers the mouth by default.
    const dir = out();
    const shown = await ok({
      partsDir: await lipParts(),
      outDir: dir,
      layout: { hair_front: { cy: 150, w: 200 } },
    });
    const { opening } = await openingOf(dir);
    const preview = await decodePng(shown.preview);
    const seamRow = Math.round(550 - opening.at(opening.centre).seam);
    const dark = (y: number) =>
      lumaOf(preview.rgba, (y * preview.width + opening.centre) * 4) < 60;
    expect([seamRow - 2, seamRow - 1, seamRow].some(dark)).toBe(true);
    // The canvas geometry: the line's bottom is where the rig stores it for
    // these very files, the centre and the opening's two end columns.
    const { byRole } = await openingOf(dir);
    const shift = mouthRestShift(byRole);
    for (const col of [opening.x0, opening.centre, opening.x1]) {
      const c = opening.at(col);
      const near = Math.round(550 - c.Tu);
      let last = -1;
      for (let y = near - 10; y <= near + 10; y++) {
        if (lumaOf(preview.rgba, (y * preview.width + col) * 4) < 60) last = y;
      }
      expect(last).toBeGreaterThan(-1);
      expect(
        Math.abs(last + 1 - Math.round(550 - (c.Tu + shift("lip_upper", col)))),
      ).toBeLessThanOrEqual(1);
    }
    // Inside the frame: the fixture's eye whites antialias into the ground
    // elsewhere on the canvas, near TEETH's colour.
    const frame = shown.layers.find((l) => l.role === "mouth_inner")!;
    const inFrame = await sharp(shown.preview)
      .extract({
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height,
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(countNear(inFrame, TEETH, 3)).toBe(0);
    expect(countNear(inFrame, TONGUE, 12)).toBe(0);
  });

  it("moves the three together on one layout key", async () => {
    const moved = await ok({
      partsDir: await lipParts(),
      outDir: out(),
      layout: { mouth_inner: { cx: 500 } },
    });
    for (const r of LIPS) {
      const l = layerOf(moved, r);
      expect(l.left).toBe(Math.round(500 - l.width / 2));
    }
    expect(layerOf(moved, "lip_upper").left).toBe(
      layerOf(moved, "mouth_inner").left,
    );
  });

  it("has no key for the lip layers, and scales with the face", async () => {
    expect(
      await err({
        partsDir: await lipParts(),
        outDir: out(),
        layout: { lip_upper: {} } as never,
      }),
    ).toMatch(/unknown role/);
    const wide = await ok({
      partsDir: await lipParts(),
      outDir: out(),
      layout: { face: { w: 800 } },
    });
    expect(
      Math.abs(layerOf(wide, "mouth_inner").width - 152),
    ).toBeLessThanOrEqual(1);
  });

  it("places the nose's tip by layout.mouth_inner.cy", async () => {
    const d = parts();
    await writePartsSet(d, {
      omit: ["mouth.png", "mouth_open.png", "nose.png"],
    });
    await writeKeyedMouth(d);
    await writeInterior(d);
    await writeSoftNose(d);
    const dir = out();
    await ok({
      partsDir: d,
      outDir: dir,
      layout: { mouth_inner: { cy: 633 } },
    });
    const nose = await decodePng(path.join(dir, "nose.png"));
    const core = denseCoreOf(nose.rgba, nose.width, nose.height)!;
    // 475 + 0.66 * (633 - 475) = 579.28.
    expect(core.y + core.h - 1).toBe(579);
  });

  /** Overwrite a part with its pixels after `paint` has had its way. */
  async function repaint(
    file: string,
    paint: (set: (x: number, y: number, rgb: RGB) => void, w: number) => void,
  ) {
    const { data, info } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    paint(
      (x, y, rgb) => data.set([...rgb, 255], (y * info.width + x) * 4),
      info.width,
    );
    await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toFile(`${file}.tmp`);
    fs.renameSync(`${file}.tmp`, file);
  }
  /** The mean column of a layer's pixels near `rgb`, as a share of the canvas
   *  frame it was composed on. */
  async function meanX(
    file: string,
    near: (rgba: Buffer, i: number) => boolean,
  ) {
    const { rgba } = await decodePng(file);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (!near(rgba, i)) continue;
      sum += (i / 4) % 1100;
      n++;
    }
    return sum / n;
  }

  it("flips the interior under mirrorParts", async () => {
    const d = await lipParts();
    // A tongue patch on the drawing's left only.
    await repaint(path.join(d, "mouth_interior.png"), (set, w) => {
      for (let y = 15; y < 35; y++)
        for (let x = 30; x < 45; x++) set(x, y, TONGUE);
      void w;
    });
    const tongue = (rgba: Buffer, i: number) => isNear(rgba, i, TONGUE, 6);
    const plain = out();
    await ok({ partsDir: d, outDir: plain });
    const flipped = out();
    await ok({
      partsDir: d,
      outDir: flipped,
      mirrorParts: ["mouth_interior.png"],
    });
    const a = await meanX(path.join(plain, "mouth_inner.png"), tongue);
    const b = await meanX(path.join(flipped, "mouth_inner.png"), tongue);
    expect(a).toBeLessThan(550 - 3);
    expect(b).toBeGreaterThan(550 + 3);
  });

  it("flips the keyed mouth under mirrorParts", async () => {
    const d = await lipParts();
    // A dark patch past the left end of the outline: a corner pixel set that
    // the split hands to lip_upper whole.
    await repaint(path.join(d, "mouth_keyed.png"), (set) => {
      for (let y = 15; y < 25; y++)
        for (let x = 0; x < 10; x++) set(x, y, [20, 20, 30]);
    });
    const dark = (rgba: Buffer, i: number) => isNear(rgba, i, [20, 20, 30], 6);
    const plain = out();
    await ok({ partsDir: d, outDir: plain });
    const flipped = out();
    await ok({
      partsDir: d,
      outDir: flipped,
      mirrorParts: ["mouth_keyed.png"],
    });
    const a = await meanX(path.join(plain, "lip_upper.png"), dark);
    const b = await meanX(path.join(flipped, "lip_upper.png"), dark);
    expect(a).toBeLessThan(550 - 1);
    expect(b).toBeGreaterThan(550 + 1);
  });

  it("keeps the teeth of an interior drawn opaque on white", async () => {
    const d = await lipParts();
    const file = path.join(d, "mouth_interior.png");
    await sharp(file)
      .flatten({ background: "#ffffff" })
      .removeAlpha()
      .png()
      .toFile(`${file}.opaque`);
    fs.renameSync(`${file}.opaque`, file);
    expect((await sharp(file).metadata()).hasAlpha).toBe(false);
    const dir = out();
    await ok({ partsDir: d, outDir: dir });
    const inner = await decodePng(path.join(dir, "mouth_inner.png"));
    expect(countNear(inner.rgba, TEETH, 12)).toBeGreaterThan(0);
    expect(countNear(inner.rgba, TONGUE, 12)).toBeGreaterThan(0);
    // The oval's white corners were keyed: no more near-white than the same
    // interior drawn on transparency (the teeth's resampling overshoot).
    const clean = out();
    await ok({ partsDir: await lipParts(), outDir: clean });
    const reference = await decodePng(path.join(clean, "mouth_inner.png"));
    const white = (b: Buffer) => countNear(b, [255, 255, 255], 3);
    expect(white(inner.rgba)).toBeLessThanOrEqual(white(reference.rgba) + 5);
  });

  it("refuses an interior opaque on a non-white ground", async () => {
    const d = await lipParts();
    const file = path.join(d, "mouth_interior.png");
    await sharp(file)
      .flatten({ background: "#f0e4cd" })
      .removeAlpha()
      .png()
      .toFile(`${file}.opaque`);
    fs.renameSync(`${file}.opaque`, file);
    expect(await err({ partsDir: d, outDir: out() })).toMatch(
      /opaque on a non-white ground/,
    );
  });

  it("composes an interior that fills the image or runs off its edges", async () => {
    const opaque = async (
      paintAt: (x: number, y: number) => RGB,
    ): Promise<string> => {
      const d = await lipParts();
      const buf = Buffer.alloc(100 * 50 * 3);
      for (let y = 0; y < 50; y++)
        for (let x = 0; x < 100; x++) buf.set(paintAt(x, y), (y * 100 + x) * 3);
      await sharp(buf, { raw: { width: 100, height: 50, channels: 3 } })
        .png()
        .toFile(path.join(d, "mouth_interior.png"));
      return d;
    };
    const full = await opaque(() => CAVITY);
    await ok({ partsDir: full, outDir: out() });
    const oval = await opaque((x, y) =>
      ((x + 0.5 - 50) / 60) ** 2 + ((y + 0.5 - 25) / 32) ** 2 <= 1
        ? CAVITY
        : [255, 255, 255],
    );
    await ok({ partsDir: oval, outDir: out() });
  });

  it("shows the lip set closed in preview-pose.png too", async () => {
    const d = parts();
    await writeFullBodyParts(d, { pose: true });
    fs.rmSync(path.join(d, "mouth.png"));
    fs.rmSync(path.join(d, "mouth_open.png"));
    await writeKeyedMouth(d);
    await writeInterior(d);
    const shown = await ok({
      partsDir: d,
      outDir: out(),
      canvasHeight: 3650,
      layout: {
        body: { w: 600, cy: 1585 },
        hair_front: { cy: 150, w: 200 },
      },
    });
    expect(shown.previewPose).toBeDefined();
    const frame = layerOf(shown, "mouth_inner");
    const inFrame = await sharp(shown.previewPose!)
      .extract({
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height,
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(countNear(inFrame, TEETH, 3)).toBe(0);
    expect(countNear(inFrame, TONGUE, 12)).toBe(0);
    expect(countNear(inFrame, [240, 205, 180], 12)).toBeGreaterThan(0);
  });

  it("refuses what the lip set cannot be cut from, naming the file", async () => {
    const without = async (...extra: ((d: string) => Promise<void>)[]) => {
      const d = parts();
      await writePartsSet(d, { omit: ["mouth.png", "mouth_open.png"] });
      for (const w of extra) await w(d);
      return d;
    };
    const run = async (d: string) => err({ partsDir: d, outDir: out() });
    expect(await run(await without((d) => writeKeyedMouth(d)))).toMatch(
      /mouth_interior\.png/,
    );
    expect(await run(await without((d) => writeInterior(d)))).toMatch(
      /mouth_keyed\.png/,
    );
    const mixed = parts();
    await writePartsSet(mixed, { omit: ["mouth_open.png"] });
    await writeKeyedMouth(mixed);
    await writeInterior(mixed);
    const mixedError = await run(mixed);
    expect(mixedError).toMatch(/cannot be composed beside/);
    expect(mixedError).toMatch(/remove mouth\.png$/);
    expect(await run(await lipParts({ keyed: { noGreen: true } }))).toMatch(
      /no green opening/,
    );
    expect(await run(await lipParts({ keyed: { broken: true } }))).toMatch(
      /not closed/,
    );
    expect(await run(await lipParts({ keyed: { twoRegions: true } }))).toMatch(
      /green outside the opening/,
    );
    expect(await run(await lipParts({ keyed: { spill: true } }))).toMatch(
      /green outside the opening/,
    );
    expect(await run(await lipParts({ interior: { allRim: true } }))).toMatch(
      /nothing but lips/,
    );
    expect(await run(await without())).toMatch(
      /mouth_keyed\.png \+ mouth_interior\.png/,
    );
  });

  it("leaves the legacy route alone and sweeps stale lip layers", async () => {
    const d = parts();
    await writePartsSet(d);
    const stale = out();
    fs.writeFileSync(path.join(stale, "lip_upper.png"), "stale");
    await ok({ partsDir: d, outDir: stale });
    expect(fs.existsSync(path.join(stale, "lip_upper.png"))).toBe(false);
    const fresh = out();
    await ok({ partsDir: d, outDir: fresh });
    expect(digest(stale)).toEqual(digest(fresh));
    expect(fs.existsSync(path.join(fresh, "mouth.png"))).toBe(true);
    for (const r of LIPS)
      expect(fs.existsSync(path.join(fresh, `${r}.png`))).toBe(false);

    const dir = out();
    fs.writeFileSync(path.join(dir, "mouth.png"), "stale");
    await ok({ partsDir: await lipParts(), outDir: dir });
    expect(fs.existsSync(path.join(dir, "mouth.png"))).toBe(false);
  });

  it("rigs: the composer's output meets the rig's reader", async () => {
    const outputPath = path.join(outDir, "model.iki");
    const rigged = await autoRigFromLayers({
      layers: result.layers.map((l) => ({ path: l.path })),
      outputPath,
    });
    expect(rigged.ok).toBe(true);
    const model = parseIkiModel(
      JSON.parse(fs.readFileSync(outputPath, "utf8")),
    );
    expect(model.parts.map((p) => p.id)).toEqual(
      expect.arrayContaining([...LIPS]),
    );
  });
});
