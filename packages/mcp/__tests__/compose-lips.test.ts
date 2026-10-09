import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  columnRuns,
  createLayerSetMeasurer,
  mouthOpening,
  type LayerInput,
  type Opening,
} from "@ikijs/editor";
import {
  closedLips,
  keyGreen,
  prepInterior,
  splitLipSet,
} from "../src/compose-lips";
import { decodePng } from "../src/node-images";
import {
  CAVITY,
  LIP_RIM,
  TEETH,
  TONGUE,
  writeInterior,
  writeKeyedMouth,
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
      const grown = x < holeCols[0] || x > holeCols[1];
      expect(c.Tu).toBeLessThanOrEqual(c.T);
      expect(c.T).toBeLessThanOrEqual(c.lineTop);
      expect(c.lineH).toBeGreaterThan(0);
      if (grown) expect(c.Tu).toBeLessThan(c.T);
      else expect(c.Tu).toBe(c.T);
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
    const closed = await closedLips(split.upper, split.lower, split.opening);
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
