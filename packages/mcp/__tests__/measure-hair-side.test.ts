import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { measureLayers } from "../src/measure";

/**
 * Real painted pixels, as in measure.test.ts. The clean set: a face 80 wide
 * (axis x=100, bottom row 159), eyes with centre row 89 (bbox centre 89.5, so
 * the near lean is round(0.12 × (159 − 89)) = 8 px), bangs over y 20-49, back
 * hair behind the whole left edge, and a lock at x 45-59 whose top row (y 30)
 * is under the bangs. A fixture option left out takes that default; `null`
 * leaves the layer out.
 */

const CANVAS = 200;
type RGB = [number, number, number];
const INK: RGB = [20, 20, 30];
const WHITE: RGB = [255, 255, 255];

const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-measure-side-"));
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

type Rect = [x: number, y: number, w: number, h: number];

async function writeRects(
  dir: string,
  role: string,
  rects: Rect[],
  rgb: RGB = INK,
  size = CANVAS,
): Promise<void> {
  const buf = Buffer.alloc(size * size * 4);
  for (const [x0, y0, w, h] of rects) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * size + x) * 4;
        buf[i] = rgb[0];
        buf[i + 1] = rgb[1];
        buf[i + 2] = rgb[2];
        buf[i + 3] = 255;
      }
    }
  }
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toFile(path.join(dir, `${role}.png`));
}

interface Parts {
  face?: Rect[];
  hairBack?: Rect[] | null;
  hairFront?: Rect[] | null;
  lock?: Rect[] | null;
  /** The lock on the screen right (`hair_side_L`, the mirror); absent unless
   *  given. */
  lockL?: Rect[];
}

async function writeSet(parts: Parts = {}): Promise<string> {
  const dir = tmpDir();
  await writeRects(dir, "face", parts.face ?? [[60, 40, 80, 120]]);
  // The screen-left eye is eye_R, beside hair_side_R.
  await writeRects(dir, "eye_R", [[68, 85, 24, 10]], WHITE);
  await writeRects(dir, "eye_L", [[108, 85, 24, 10]], WHITE);
  if (parts.hairFront !== null) {
    await writeRects(dir, "hair_front", parts.hairFront ?? [[30, 20, 140, 30]]);
  }
  if (parts.hairBack !== null) {
    await writeRects(dir, "hair_back", parts.hairBack ?? [[40, 30, 120, 120]]);
  }
  if (parts.lock !== null) {
    await writeRects(dir, "hair_side_R", parts.lock ?? [[45, 30, 15, 90]]);
  }
  if (parts.lockL) {
    await writeRects(dir, "hair_side_L", parts.lockL);
  }
  return dir;
}

async function lockWarnings(
  dir: string,
  role: RegExp = /hair_side/,
): Promise<string[]> {
  const result = await measureLayers({ layersDir: dir });
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  // Painted rects are cut flat, which the edge checks flag on any layer; those
  // are not the lock rules under test.
  return result.warnings.filter(
    (w) =>
      role.test(w) &&
      !/% of its (left|right|top|bottom) edge is opaque/.test(w),
  );
}

describe("measure_layers side-lock checks", () => {
  it("passes a clean lock with no lock warning and no missing line", async () => {
    expect(await lockWarnings(await writeSet())).toEqual([]);
  });

  it("warns of a root showing past the bangs at rest", async () => {
    const w = await lockWarnings(await writeSet({ lock: [[45, 55, 15, 60]] }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /^hair_side_R: its top row \(canvas y 55\) shows past hair_front on 15 px/,
    );
    expect(w[0]).toMatch(
      /Move it under the bangs — up \(layout\.hair_side_R\.cy\) or toward the face \(layout\.hair_side_R\.cx\) \(free\), or regenerate hair_side\.png with a longer hidden root\. Billed\.$/,
    );
  });

  it("warns of a root sticking out sideways past the bangs, on either side", async () => {
    const left = await lockWarnings(
      await writeSet({ hairFront: [[50, 20, 100, 30]] }),
    );
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(
      /^hair_side_R: its top row \(canvas y 30\) shows past hair_front on 5 px/,
    );
    const right = await lockWarnings(
      await writeSet({
        hairFront: [[30, 20, 120, 30]],
        lock: null,
        lockL: [[140, 30, 15, 90]],
      }),
    );
    expect(right).toHaveLength(1);
    expect(right[0]).toMatch(
      /^hair_side_L: its top row \(canvas y 30\) shows past hair_front on 5 px/,
    );
  });

  it("lets 2 px of root past the bangs pass and warns at 3", async () => {
    const two = await writeSet({ hairFront: [[47, 20, 123, 30]] });
    expect(await lockWarnings(two)).toEqual([]);
    const three = await writeSet({ hairFront: [[48, 20, 122, 30]] });
    expect(await lockWarnings(three)).toHaveLength(1);
  });

  it("reads a right-hand lock's root alone", async () => {
    const w = await lockWarnings(
      await writeSet({ lock: null, lockL: [[140, 55, 15, 60]] }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^hair_side_L: its top row \(canvas y 55\)/);
  });

  it("warns of a lock over the eye white's outer corner", async () => {
    const w = await lockWarnings(await writeSet({ lock: [[45, 30, 30, 90]] }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /^hair_side_R: covers eye_R's outer corner at rest \(canvas x 68, y 89\) by 7 px/,
    );
    expect(w[0]).toMatch(
      /Move layout\.hair_side_R\.cx 7 px left, outward \(free\), or regenerate it narrower\. Billed\.$/,
    );
  });

  it("lets a lock reach the eye's corner by 2 px and warns at 3", async () => {
    expect(
      await lockWarnings(await writeSet({ lock: [[45, 30, 25, 90]] })),
    ).toEqual([]);
    const w = await lockWarnings(await writeSet({ lock: [[45, 30, 26, 90]] }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/by 3 px/);
  });

  it("warns of columns nothing is painted behind the near lean", async () => {
    const w = await lockWarnings(
      await writeSet({ hairBack: [[50, 30, 110, 120]] }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /leans inward about 8 px and leaves bare pixels spanning columns 45–49, rows 30–119, where neither hair_back nor the face is painted/,
    );
    expect(w[0]).toMatch(
      /widen hair_back there \(layout\.hair_back\.w\) \(free\), or regenerate it fuller behind the locks\. Billed\.$/,
    );
  });

  it("reads the right-hand lock against eye_L's outer corner", async () => {
    const w = await lockWarnings(
      await writeSet({ lock: null, lockL: [[125, 30, 30, 90]] }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /^hair_side_L: covers eye_L's outer corner at rest \(canvas x 131, y 89\) by 7 px/,
    );
    expect(w[0]).toMatch(
      /Move layout\.hair_side_L\.cx 7 px right, outward \(free\)/,
    );
  });

  it("bares the right-hand lock's outer end behind the near lean", async () => {
    const w = await lockWarnings(
      await writeSet({
        lock: null,
        lockL: [[140, 30, 15, 90]],
        hairBack: [[40, 30, 110, 120]],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /^hair_side_L: .*leans inward about 8 px and leaves bare pixels spanning columns 150–154, rows 30–119/,
    );
  });

  it("warns of a lock on another canvas than hair_front's, and runs no lock rule", async () => {
    const dir = await writeSet({ lock: null });
    await writeRects(dir, "hair_side_R", [[45, 30, 15, 60]], INK, 100);
    const w = await lockWarnings(dir);
    expect(w).toEqual([
      "hair_side_R: its canvas 100x100 differs from hair_front's 200x200 — auto_rig_from_layers refuses layers of different sizes; recompose them together.",
    ]);
  });

  it("sizes the lean from the other eye when the lock's own is absent", async () => {
    const dir = await writeSet({ hairBack: [[50, 30, 110, 120]] });
    fs.rmSync(path.join(dir, "eye_R.png"));
    const w = await lockWarnings(dir);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /leans inward about 8 px and leaves bare pixels spanning columns 45–49/,
    );
  });

  it("warns of two locks drawn on one sheet", async () => {
    const w = await lockWarnings(
      await writeSet({
        lock: [
          [45, 30, 20, 90],
          [90, 30, 20, 90],
        ],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^hair_side\.png draws two locks — draw ONE lock/);
    expect(w[0]).toMatch(/Billed\.$/);
  });

  it("reads two locks on a right-hand sheet alone", async () => {
    const w = await lockWarnings(
      await writeSet({
        lock: null,
        lockL: [
          [90, 30, 20, 90],
          [135, 30, 20, 90],
        ],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^hair_side\.png draws two locks/);
  });

  it("passes one lock with a small parting", async () => {
    const w = await lockWarnings(
      await writeSet({
        lock: [
          [45, 30, 6, 90],
          [52, 30, 8, 90],
        ],
      }),
    );
    expect(w).toEqual([]);
  });

  it("reads the face alone behind the lean when there is no hair_back", async () => {
    const dir = await writeSet({
      face: [[40, 30, 120, 130]],
      hairBack: null,
    });
    expect(await lockWarnings(dir)).toEqual([]);
  });

  it("names the face alone when hair_back is absent and the strip bare", async () => {
    const w = await lockWarnings(await writeSet({ hairBack: null }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/where the face is not painted/);
    expect(w[0]).toMatch(
      /where the face is not painted — draw hair_back\.png behind the locks\. Billed\.$/,
    );
    expect(w[0]).not.toMatch(/layout\./);
  });

  it("warns of a hair_back on another canvas than hair_front's", async () => {
    const dir = await writeSet({ hairBack: null });
    await writeRects(dir, "hair_back", [[40, 30, 60, 60]], INK, 100);
    expect(await lockWarnings(dir, /^hair_back:/)).toEqual([
      "hair_back: its canvas 100x100 differs from hair_front's 200x200 — auto_rig_from_layers refuses layers of different sizes; recompose them together.",
    ]);
  });

  it("warns only of the missing hair_front when there is none", async () => {
    const w = await lockWarnings(await writeSet({ hairFront: null }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /^hair_side_R: needs hair_front — the rig refuses a lock without the bangs/,
    );
    expect(w[0]).toMatch(
      /Remove hair_side\.png and recompose \(free\), or draw hair_front\.png\. Billed\.$/,
    );
  });

  it("names the missing hair_front on a right-hand lock alone", async () => {
    const w = await lockWarnings(
      await writeSet({
        hairFront: null,
        lock: null,
        lockL: [[140, 30, 15, 90]],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^hair_side_L: needs hair_front/);
  });

  it("says nothing of locks for a set without one", async () => {
    const dir = tmpDir();
    await writeRects(dir, "face", [[60, 40, 80, 120]]);
    await writeRects(dir, "hair_front", [[30, 20, 140, 30]]);
    expect(await lockWarnings(dir)).toEqual([]);
  });
});
