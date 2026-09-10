import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { formatMeasureReport, measureLayers } from "../src/measure";

/**
 * Every fixture is real painted pixels encoded as a PNG, because the checks are
 * assertions about pixels: a mocked stat would pass while the alpha scan behind
 * it rots. The shapes are the ones the checks were written against — an almond
 * sclera, a disc iris, an upper lash arc, and a part cut flat by its frame.
 * Measuring is read-only, so the fixtures live in the system temp dir.
 */

const CANVAS = 200;
const WHITE: RGB = [255, 255, 255];
const DARK: RGB = [20, 20, 30];
const BLUE: RGB = [40, 90, 200];

type RGB = [number, number, number];
type SetPixel = (x: number, y: number, rgb: RGB) => void;

const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-measure-"));
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Paint a straight-alpha RGBA canvas and write it as a layer PNG. */
async function writeLayer(
  dir: string,
  name: string,
  paint: (set: SetPixel) => void,
): Promise<void> {
  const buf = Buffer.alloc(CANVAS * CANVAS * 4); // all transparent (alpha 0)
  const set: SetPixel = (x, y, rgb) => {
    const i = (y * CANVAS + x) * 4;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = 255;
  };
  paint(set);
  await sharp(buf, { raw: { width: CANVAS, height: CANVAS, channels: 4 } })
    .png()
    .toFile(path.join(dir, name));
}

/** Filled ellipse with an alpha bbox of exactly `w`x`h` centred on (cx, cy);
 *  an odd `w`/`h` needs a half-integer centre. */
function ellipse(
  set: SetPixel,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rgb: RGB,
): void {
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const u = (x + 0.5 - cx) / (w / 2);
      const v = (y + 0.5 - cy) / (h / 2);
      if (u * u + v * v <= 1) set(x, y, rgb);
    }
  }
}

/** The upper rim of that ellipse: the lash arc, thin enough that its cut-off
 *  bottom row is only the two tips (a filled cap would read as a cropped part). */
function topArc(
  set: SetPixel,
  cx: number,
  cy: number,
  w: number,
  h: number,
  thickness: number,
  rgb: RGB,
): void {
  for (let y = 0; y < cy; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const u = (x + 0.5 - cx) / (w / 2);
      const v = (y + 0.5 - cy) / (h / 2);
      const inner =
        ((x + 0.5 - cx) / (w / 2 - thickness)) ** 2 +
        ((y + 0.5 - cy) / (h / 2 - thickness)) ** 2;
      if (u * u + v * v <= 1 && inner > 1) set(x, y, rgb);
    }
  }
}

function rect(
  set: SetPixel,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: RGB,
): void {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) set(x, y, rgb);
}

/** A part cut flat by its own frame: a thin strand above a wider block, so the
 *  block's top row is a long "art appears out of nothing" run inside the bbox
 *  and its bottom row runs to the bbox edge. */
function cutShape(set: SetPixel): void {
  rect(set, 100, 10, 11, 11, DARK);
  rect(set, 60, 30, 101, 41, DARK);
}

/** Sclera + centred iris (0.5625 of the sclera width) + lash arc on top. */
async function writeEyeStack(dir: string): Promise<void> {
  await writeLayer(dir, "eye_L.png", (set) =>
    ellipse(set, 100, 100, 64, 40, WHITE),
  );
  await writeLayer(dir, "iris_L.png", (set) =>
    ellipse(set, 100, 100, 36, 36, BLUE),
  );
  await writeLayer(dir, "lash_L.png", (set) =>
    topArc(set, 100, 100, 64, 40, 4, DARK),
  );
}

/** Small enough (30px) that its own opaque edges stay under EDGE_RUN_MIN_PX. */
async function writeOptionalRoles(dir: string): Promise<void> {
  await writeLayer(dir, "body.png", (set) => rect(set, 20, 150, 30, 30, DARK));
  await writeLayer(dir, "hair_back.png", (set) =>
    rect(set, 150, 20, 30, 30, DARK),
  );
}

async function measureOk(dir: string) {
  const result = await measureLayers({ layersDir: dir });
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

const warned = (warnings: string[], re: RegExp) =>
  warnings.some((w) => re.test(w));

describe("measureLayers", () => {
  it("passes a healthy eye stack with the optional roles present", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    await writeOptionalRoles(dir);

    const result = await measureOk(dir);
    expect(result.warnings).toEqual([]);
    expect(result.passed).toBe(true);
    expect(Object.keys(result.layers).sort()).toEqual([
      "body",
      "eye_L",
      "hair_back",
      "iris_L",
      "lash_L",
    ]);
    expect(result.layers.eye_L.w).toBe(64);
    expect(result.layers.iris_L.w).toBe(36);
  });

  it("flags an iris that reads as a bead floating in white", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // Half-integer centre: 21px is odd, and 21/64 is the 33% that shipped.
    await writeLayer(dir, "iris_L.png", (set) =>
      ellipse(set, 100.5, 100.5, 21, 21, BLUE),
    );

    const result = await measureOk(dir);
    expect(warned(result.warnings, /iris_L: width is 33%/)).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("flags an iris that drifted sideways off the white's centre of mass", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // 4px sideways, past IRIS_OFFSET_MAX_X; the vertical axis tolerates more,
    // since the reference rides its iris high under the lash.
    await writeLayer(dir, "iris_L.png", (set) =>
      ellipse(set, 104, 100, 36, 36, BLUE),
    );

    const result = await measureOk(dir);
    expect(
      warned(result.warnings, /iris_L: sits \(4\.0, 0\.0\) px from the white/),
    ).toBe(true);
  });

  it("flags a lash whose centre drifted off its sclera", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    await writeLayer(dir, "lash_L.png", (set) =>
      topArc(set, 103, 100, 64, 40, 4, DARK),
    );

    const result = await measureOk(dir);
    expect(warned(result.warnings, /lash_L: centre is 3\.0 px/)).toBe(true);
  });

  it("separates a canvas-clipped edge from art that runs to its own frame", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // Flush against the canvas top: margin 0 is what a clipped placement leaves.
    await writeLayer(dir, "hair_front.png", (set) =>
      rect(set, 60, 0, 80, 60, DARK),
    );

    const result = await measureOk(dir);
    const w = result.warnings.find((x) =>
      /^hair_front: .* top edge is opaque/.test(x),
    );
    expect(w).toMatch(/the placement pushed it past the canvas top/);
    expect(w).not.toMatch(/regenerate/);
  });

  it("tolerates a lash whose ink is asymmetric inside a shared frame", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // 1 px: what a flick that runs one way costs on a 64 px eye. The layout
    // entries are in sync; there is nothing an artist could retune.
    await writeLayer(dir, "lash_L.png", (set) =>
      topArc(set, 101, 100, 64, 40, 4, DARK),
    );

    const result = await measureOk(dir);
    expect(warned(result.warnings, /lash_L: centre is/)).toBe(false);
  });

  it("flags a sclera too flat to hold a round iris", async () => {
    const dir = tmpDir();
    await writeLayer(dir, "eye_L.png", (set) =>
      ellipse(set, 100, 100, 64, 26, WHITE),
    );

    const result = await measureOk(dir);
    expect(warned(result.warnings, /eye_L: sclera aspect/)).toBe(true);
  });

  it("flags art that runs to its own edge, once the run is long enough", async () => {
    const wide = tmpDir();
    await writeLayer(wide, "hair_front.png", (set) =>
      rect(set, 60, 60, 60, 60, DARK),
    );
    expect(
      warned(
        (await measureOk(wide)).warnings,
        /hair_front: .* top edge is opaque/,
      ),
    ).toBe(true);

    // Same square edges, but a 30px run is a round part's tangent, not a crop.
    const narrow = tmpDir();
    await writeLayer(narrow, "hair_front.png", (set) =>
      rect(set, 60, 60, 30, 30, DARK),
    );
    expect(
      warned(
        (await measureOk(narrow)).warnings,
        /hair_front: .* edge is opaque/,
      ),
    ).toBe(false);
  });

  it("exempts body from the bottom-edge and flat-cut checks", async () => {
    const asBody = tmpDir();
    await writeLayer(asBody, "body.png", cutShape);
    const body = await measureOk(asBody);
    // The cut and the solid bottom row are measured, just not warned about.
    expect(body.layers.body.flatCutRun).toBe(101);
    expect(body.layers.body.edgeBottom).toBe(1);
    expect(warned(body.warnings, /bottom edge is opaque/)).toBe(false);
    expect(warned(body.warnings, /straight flat edge/)).toBe(false);

    // The same shape under any other role is the seam this check was written for.
    const asHair = tmpDir();
    await writeLayer(asHair, "hair_front.png", cutShape);
    const hair = await measureOk(asHair);
    expect(warned(hair.warnings, /hair_front: .* bottom edge is opaque/)).toBe(
      true,
    );
    expect(
      warned(hair.warnings, /hair_front: 101px of straight flat edge at y=30/),
    ).toBe(true);
  });

  it("ignores preview.png and reports a transparent layer as empty", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // Would trip the edge check if it were measured as a role.
    await writeLayer(dir, "preview.png", (set) =>
      rect(set, 10, 10, 120, 120, DARK),
    );
    await writeLayer(dir, "mouth.png", () => {});

    const result = await measureOk(dir);
    expect(result.layers.preview).toBeUndefined();
    expect(warned(result.warnings, /preview/)).toBe(false);
    expect(result.empty).toEqual(["mouth"]);
    expect(result.layers.mouth).toBeUndefined();
  });

  it("returns ok:false for a directory holding more layers than the budget", async () => {
    const dir = tmpDir();
    await writeLayer(dir, "eye_L.png", (set) =>
      ellipse(set, 100, 100, 64, 40, WHITE),
    );
    // 65 files (> MAX_LAYERS = 64). Copying one real PNG is enough: the count
    // is checked before anything is decoded, which is the point of the guard.
    const png = fs.readFileSync(path.join(dir, "eye_L.png"));
    for (let i = 0; i < 64; i++) {
      fs.writeFileSync(path.join(dir, `extra_${i}.png`), png);
    }

    const result = await measureLayers({ layersDir: dir });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^too many layers in .*: 65 > 64$/),
    });
  });

  it("returns ok:false for a missing directory and for one with no layers", async () => {
    const missing = await measureLayers({
      layersDir: path.join(tmpDir(), "nope"),
    });
    expect(missing).toEqual({
      ok: false,
      error: expect.stringMatching(/layers dir not found/),
    });

    const emptyDir = tmpDir();
    const noLayers = await measureLayers({ layersDir: emptyDir });
    expect(noLayers).toEqual({
      ok: false,
      error: `no role layers in ${emptyDir}`,
    });
  });
});

describe("formatMeasureReport", () => {
  it("prints the layer table then the passing verdict", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    await writeOptionalRoles(dir);
    await writeLayer(dir, "mouth.png", () => {});

    const text = formatMeasureReport(await measureOk(dir));
    expect(text.startsWith("# layers")).toBe(true);
    expect(text).toContain(
      "role          size        bbox-centre    mass-centre   margins t/b/l/r",
    );
    expect(text).toContain("mouth         EMPTY (fully transparent)");
    expect(text).toContain("# checks");
    expect(text.endsWith("all geometry checks passed")).toBe(true);
  });

  it("prints the failing checks as bullets", async () => {
    const dir = tmpDir();
    await writeLayer(dir, "hair_front.png", (set) =>
      rect(set, 60, 60, 60, 60, DARK),
    );

    const result = await measureOk(dir);
    const text = formatMeasureReport(result);
    expect(text.startsWith("# layers")).toBe(true);
    expect(
      text.endsWith(`- ${result.warnings[result.warnings.length - 1]}`),
    ).toBe(true);
  });
});
