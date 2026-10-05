import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  CANVAS,
  composeLayersFromParts,
  type ComposeInput,
  type ComposeResult,
  type LayerRole,
  type LayoutOverride,
} from "../src/compose";
import { layerStats, measureLayers } from "../src/measure";
import { denseCoreOf } from "../src/measure-turn";
import { decodePng } from "../src/node-images";
import {
  BLUSH_MARK,
  EYE_MARK_BELOW,
  EYE_MARK_BESIDE,
  EYE_SHADE,
  writeBodyWithMark,
  writeEyewhite,
  writePartsSet,
  writeSoftNose,
  writeTaperedBrow,
} from "./helpers/parts";

/** Draw order the composer walks, back -> front. */
const ROLES: LayerRole[] = [
  "hair_back",
  "body",
  "face",
  "blush_L",
  "blush_R",
  "nose",
  "mouth",
  "mouth_open",
  "eye_L",
  "eye_R",
  "iris_L",
  "iris_R",
  "lash_lower_L",
  "lash_lower_R",
  "lash_L",
  "lash_R",
  "brow_L",
  "brow_R",
  "hair_front",
];

const createdDirs: string[] = [];
/** Parts are read-only input, so the fixture lives in the system temp dir. */
function partsDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-compose-parts-"));
  createdDirs.push(d);
  return d;
}
/** Output must resolve UNDER cwd to satisfy resolveOutputDir; node_modules is
 *  gitignored, matching the tmpDir helpers in tools.test.ts / limits.test.ts. */
function outDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-compose-"),
  );
  createdDirs.push(d);
  return d;
}
/** A directory genuinely OUTSIDE the working tree, for confinement tests. */
function outsideDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-compose-outside-"));
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

type ComposeOk = Extract<ComposeResult, { ok: true }>;

async function composeOk(input: ComposeInput): Promise<ComposeOk> {
  const result = await composeLayersFromParts(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

async function composeError(input: ComposeInput): Promise<string> {
  const result = await composeLayersFromParts(input);
  if (result.ok) throw new Error("expected a failure, got ok");
  return result.error;
}

/** Content digest of a directory: proves the parts dir came out untouched. */
function digest(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .sort()
    .map(
      (f) =>
        `${f}:${crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(dir, f)))
          .digest("hex")}`,
    );
}

/** Luma (0..255) of the RGBA pixel at byte offset `i`. */
function lumaAt(rgba: Buffer, i: number): number {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

/** Whether the RGBA pixel at byte offset `i` is over alpha 128 and within 8
 *  per channel of `rgb`. */
function isNear(rgba: Buffer, i: number, rgb: readonly number[]): boolean {
  return (
    rgba[i + 3] > 128 &&
    [0, 1, 2].every((c) => Math.abs(rgba[i + c] - rgb[c]) <= 8)
  );
}

/** How many pixels of `rgba` are near `rgb` (`isNear`). */
function countNear(rgba: Buffer, rgb: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (isNear(rgba, i, rgb)) n++;
  return n;
}

/** The mean column of a decoded PNG's pixels near `rgb` (`isNear`). */
function meanColumnNear(
  png: { rgba: Buffer; width: number },
  rgb: readonly number[],
): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < png.rgba.length; i += 4) {
    if (!isNear(png.rgba, i, rgb)) continue;
    sum += (i / 4) % png.width;
    n++;
  }
  if (n === 0) throw new Error("no pixel near the colour");
  return sum / n;
}

async function statsFor(dir: string, role: string) {
  const stats = await layerStats(path.join(dir, `${role}.png`));
  if (stats === null) throw new Error(`${role} is fully transparent`);
  return stats;
}

/**
 * The composed nose's dense core, in canvas px, read the way the composer
 * places it: a box's centre is `x + w/2` (pixel x covers [x, x+1)), and its
 * bottom row — the nose's tip — is the last row index it covers.
 */
async function noseCoreIn(dir: string) {
  const png = await decodePng(path.join(dir, "nose.png"));
  const core = denseCoreOf(png.rgba, png.width, png.height);
  if (core === null) throw new Error("the composed nose has no dense core");
  return {
    ...core,
    cx: core.x + core.w / 2,
    cy: core.y + core.h / 2,
    bottom: core.y + core.h - 1,
  };
}

/** The full parts set with its nose.png swapped for the soft one. */
async function softNoseParts(
  opts?: Parameters<typeof writeSoftNose>[1],
): Promise<string> {
  const dir = partsDir();
  await writePartsSet(dir, { omit: ["nose.png"] });
  await writeSoftNose(dir, opts);
  return dir;
}

describe("composeLayersFromParts", () => {
  // One full compose of the complete parts set, shared by the assertions that
  // only read its output.
  let parts: string;
  let out: string;
  let partsBefore: string[];
  let full: ComposeOk;

  beforeAll(async () => {
    parts = partsDir();
    await writePartsSet(parts);
    partsBefore = digest(parts);
    out = outDir();
    full = await composeOk({ partsDir: parts, outDir: out });
  }, 30_000);

  it("writes each role at canvas size, in draw order, plus the preview", async () => {
    expect(full.layers.map((l) => l.role)).toEqual(ROLES);
    expect(full.skipped).toEqual([]);
    expect(full.outDir).toBe(fs.realpathSync(out));
    for (const layer of full.layers) {
      expect(layer.path).toBe(path.join(full.outDir, `${layer.role}.png`));
      const meta = await sharp(layer.path).metadata();
      expect([meta.width, meta.height]).toEqual([CANVAS, CANVAS]);
      // The reported size is the part itself, not the canvas it sits on, and
      // the bound keeps it inside that canvas.
      expect(layer.height).toBeLessThanOrEqual(CANVAS);
    }
    // A part is resized to its layout width and centred on its cx, so both are
    // fixed by the layout, not by the fixture's aspect ratio.
    expect(full.layers.find((l) => l.role === "eye_L")).toMatchObject({
      width: 98,
      left: 587,
    });
    expect(full.preview).toBe(path.join(full.outDir, "preview.png"));
    const preview = await sharp(full.preview).metadata();
    expect([preview.width, preview.height]).toEqual([CANVAS, CANVAS]);
  });

  it("leaves the parts dir byte-identical (the eye split stays in memory)", () => {
    expect(digest(parts)).toEqual(partsBefore);
    expect(fs.existsSync(path.join(parts, "eyewhite_sclera.png"))).toBe(false);
    expect(fs.existsSync(path.join(parts, "eyewhite_lash.png"))).toBe(false);
  });

  it("splits the eyewhite into a sclera, an upper lash and a lower lid", async () => {
    const eye = await statsFor(out, "eye_L");
    const lash = await statsFor(out, "lash_L");
    const lower = await statsFor(out, "lash_lower_L");
    const rowsOf = async (role: string) => {
      const png = await decodePng(path.join(out, `${role}.png`));
      const dark: number[] = [];
      let inked = 0;
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const i = (y * png.width + x) * 4;
          if (png.rgba[i + 3] <= 8) continue;
          inked++;
          if (lumaAt(png.rgba, i) < 120) dark.push(y);
        }
      }
      return { dark, inked };
    };
    const mid = eye.marginTop + eye.h / 2;

    // The sclera is the blink clip-mask shape: the upper lash was recoloured
    // white, so nothing dark survives in its top half. The lower lid stays as
    // drawn: whitened, a lash hanging below the white would show as a flick.
    const sclera = await rowsOf("eye_L");
    expect(sclera.dark.length).toBeGreaterThan(0);
    expect(Math.min(...sclera.dark)).toBeGreaterThan(mid);

    // The lash inks only the TOP of the shared frame — that is the fold that
    // covers the closed-eye seam, rather than the eye shrinking in place.
    const upper = await rowsOf("lash_L");
    expect(Math.max(...upper.dark)).toBeGreaterThan(eye.marginTop);
    expect(Math.max(...upper.dark)).toBeLessThanOrEqual(mid);

    // The lower lid inks only the bottom, all of it dark: it is the ink the
    // iris would otherwise paint over.
    const lowerRows = await rowsOf("lash_lower_L");
    expect(lowerRows.dark.length).toBe(lowerRows.inked);
    expect(Math.min(...lowerRows.dark)).toBeGreaterThan(mid);

    // ...and all keep the eyewhite's frame, so the fold cannot tear.
    for (const s of [lash, lower]) expect(s.marginLeft).toBe(eye.marginLeft);
    expect(lash.marginTop).toBe(eye.marginTop);
    expect(lower.marginTop + lower.h).toBe(eye.marginTop + eye.h);
    expect(full.layers.find((l) => l.role === "lash_lower_L")).toMatchObject({
      width: 98,
      left: 587,
    });
  });

  it("writes no lower lid from dark residue too faint for the rig to count", async () => {
    const faint = partsDir();
    await writePartsSet(faint, { omit: ["eyewhite.png"] });
    await writeEyewhite(faint, { lowerLid: false, faintLowerSpeck: true });
    const dir = outDir();
    const r = await composeOk({ partsDir: faint, outDir: dir });
    // Written, it would hold no pixel at alpha 8, and the rig refuses an
    // empty layer.
    expect(r.skipped).toEqual(["lash_lower_L", "lash_lower_R"]);
    expect(r.measure.empty).toEqual([]);
    expect(fs.existsSync(path.join(dir, "lash_lower_L.png"))).toBe(false);
  });

  it("places the lower lid by its eye's layout, mirrored with it", async () => {
    const moved = outDir();
    await composeOk({
      partsDir: parts,
      outDir: moved,
      layout: {
        eye_L: { cx: 667 },
        lash_L: { cx: 667 },
        eye_R: { cx: 433, w: 120 },
        lash_R: { cx: 433, w: 120 },
      },
    });
    for (const side of ["L", "R"]) {
      const eye = await statsFor(moved, `eye_${side}`);
      const lower = await statsFor(moved, `lash_lower_${side}`);
      expect(lower.marginLeft).toBe(eye.marginLeft);
      expect(lower.marginLeft + lower.w).toBe(eye.marginLeft + eye.w);
      expect(lower.marginTop + lower.h).toBe(eye.marginTop + eye.h);
    }
    // Its own key would leave it behind when only the eye moves.
    const error = await composeError({
      partsDir: parts,
      outDir: outDir(),
      layout: { lash_lower_L: { cx: 667 } } as LayoutOverride,
    });
    expect(error).toMatch(/layout\.lash_lower_L: unknown role/);
  });

  it("writes no lower lid for a white that draws none, and removes an earlier one", async () => {
    const dir = outDir();
    await composeOk({ partsDir: parts, outDir: dir });
    expect(fs.existsSync(path.join(dir, "lash_lower_L.png"))).toBe(true);

    const plain = partsDir();
    await writePartsSet(plain, { omit: ["eyewhite.png"] });
    await writeEyewhite(plain, { lowerLid: false });
    const r = await composeOk({ partsDir: plain, outDir: dir });
    expect(r.skipped).toEqual(["lash_lower_L", "lash_lower_R"]);
    expect(r.layers.map((l) => l.role)).toEqual(
      ROLES.filter((role) => !r.skipped.includes(role)),
    );
    for (const side of ["L", "R"]) {
      expect(fs.existsSync(path.join(dir, `lash_lower_${side}.png`))).toBe(
        false,
      );
    }
  });

  it("drops a crease drawn detached above the eye white from the sclera", async () => {
    const creased = partsDir();
    await writePartsSet(creased, { omit: ["eyewhite.png"] });
    // No lower lid: its dark rim, kept in the sclera, would blend into the
    // edges of the dots under it when resampled.
    await writeEyewhite(creased, { crease: "short", lowerLid: false });
    const dir = outDir();
    const r = await composeOk({ partsDir: creased, outDir: dir });

    // The frame is still the source's alpha bbox, crease rows and all (68x47,
    // 98x68 at w 98), so no layout moves.
    for (const role of ["eye_L", "eye_R", "lash_L", "lash_R"]) {
      expect(r.layers.find((l) => l.role === role)?.height).toBe(68);
    }
    const source = await decodePng(path.join(creased, "eyewhite.png"));
    for (const side of ["L", "R"]) {
      // The sclera is the iris's clip, so nothing of it may stand above the
      // lash that folds down over it.
      const eye = await statsFor(dir, `eye_${side}`);
      const lash = await statsFor(dir, `lash_${side}`);
      expect(eye.marginTop).toBe(lash.marginTop);
      // The light ink that is not above the white stays: the shade band
      // touches it, and the dots under its rim and beside its end lie level
      // with or below it. At w 128 each source px covers about 3.5 layer px,
      // so more layer px than source px survive even with resampled edges.
      const sclera = await decodePng(path.join(dir, `eye_${side}.png`));
      for (const rgb of [EYE_SHADE, EYE_MARK_BELOW, EYE_MARK_BESIDE]) {
        expect(countNear(sclera.rgba, rgb)).toBeGreaterThan(
          countNear(source.rgba, rgb),
        );
      }
      // The lash still carries only the dark rim: none of the crease's light
      // ink moved into it.
      const lashPng = await decodePng(path.join(dir, `lash_${side}.png`));
      let lightest = 0;
      for (let i = 0; i < lashPng.rgba.length; i += 4) {
        if (lashPng.rgba[i + 3] < 128) continue;
        lightest = Math.max(lightest, lumaAt(lashPng.rgba, i));
      }
      expect(lightest).toBeLessThan(120);
    }
    expect(r.measure.warnings.filter((w) => /^lash_/.test(w))).toEqual([]);
  });

  it("drops a crease that runs past the ends of the eye white", async () => {
    // Past the white's ends the crease has no white under it, so it is judged
    // against the top of the white's end column.
    const creased = partsDir();
    await writePartsSet(creased, { omit: ["eyewhite.png"] });
    await writeEyewhite(creased, { crease: "long" });
    const dir = outDir();
    const r = await composeOk({ partsDir: creased, outDir: dir });

    for (const side of ["L", "R"]) {
      const eye = await statsFor(dir, `eye_${side}`);
      const lash = await statsFor(dir, `lash_${side}`);
      expect(eye.marginTop).toBe(lash.marginTop);
    }
    expect(r.measure.warnings.filter((w) => /^lash_/.test(w))).toEqual([]);
  });

  it("drops a crease that a nearly invisible halo joins to the eye white, with the halo's crease-side half", async () => {
    // The halo runs at alpha 24 from the crease's left end down to the
    // white's: it must not make the crease part of the white.
    const creased = partsDir();
    await writePartsSet(creased, { omit: ["eyewhite.png"] });
    await writeEyewhite(creased, { crease: "bridged" });
    const dir = outDir();
    const r = await composeOk({ partsDir: creased, outDir: dir });

    for (const side of ["L", "R"]) {
      const eye = await statsFor(dir, `eye_${side}`);
      const lash = await statsFor(dir, `lash_${side}`);
      expect(eye.marginTop).toBe(lash.marginTop);
    }
    // The halo's upper half, nearer the crease than the white, goes with it:
    // nothing is left where source columns 2-4 and rows 8-11 land in eye_R.
    // eye_R takes the source as drawn, and the 72x48 image's alpha box (the
    // 72x47 frame) starts at its row 0 and column 0, so a source pixel lands
    // at its own coordinates times the layer's scale.
    const layer = r.layers.find((l) => l.role === "eye_R")!;
    const sclera = await decodePng(layer.path);
    const scale = layer.width / 72;
    let alpha = 0;
    for (
      let y = Math.floor(layer.top + 8 * scale);
      y < layer.top + 12 * scale;
      y++
    ) {
      for (
        let x = Math.floor(layer.left + 2 * scale);
        x < layer.left + 5 * scale;
        x++
      ) {
        alpha = Math.max(alpha, sclera.rgba[(y * sclera.width + x) * 4 + 3]);
      }
    }
    expect(alpha).toBeLessThanOrEqual(8);
    // Its lower half, nearer the white, stays the white's fringe: over the
    // sclera composed without the halo (the "long" crease, otherwise the
    // same), source column 3's rows 16-19 add alpha in eye_R. Recoloured
    // lash ink reaches that column too, so the halo is read as the
    // difference.
    const plain = partsDir();
    await writePartsSet(plain, { omit: ["eyewhite.png"] });
    await writeEyewhite(plain, { crease: "long" });
    const plainDir = outDir();
    const p = await composeOk({ partsDir: plain, outDir: plainDir });
    const without = await decodePng(
      p.layers.find((l) => l.role === "eye_R")!.path,
    );
    let added = 0;
    for (
      let y = Math.floor(layer.top + 16 * scale);
      y < layer.top + 20 * scale;
      y++
    ) {
      for (
        let x = Math.floor(layer.left + 3 * scale);
        x < layer.left + 4 * scale;
        x++
      ) {
        const i = (y * sclera.width + x) * 4 + 3;
        added += sclera.rgba[i] - without.rgba[i];
      }
    }
    expect(added).toBeGreaterThanOrEqual(12);
    expect(r.measure.warnings.filter((w) => /^lash_/.test(w))).toEqual([]);
  });

  it("drops a translucent crease that a fainter halo joins to the eye white", async () => {
    // The crease is painted at alpha 100: no pixel of it counts as painted,
    // and the alpha-24 halo still runs from it down to the white. A fringe
    // fades away from what it fringes, so the halo does not make the brighter
    // crease the white's.
    const creased = partsDir();
    await writePartsSet(creased, { omit: ["eyewhite.png"] });
    await writeEyewhite(creased, { crease: "translucent" });
    const dir = outDir();
    const r = await composeOk({ partsDir: creased, outDir: dir });

    for (const side of ["L", "R"]) {
      const eye = await statsFor(dir, `eye_${side}`);
      const lash = await statsFor(dir, `lash_${side}`);
      expect(eye.marginTop).toBe(lash.marginTop);
    }
    expect(r.measure.warnings.filter((w) => /^lash_/.test(w))).toEqual([]);
  });

  it("keys the white ground out of a part that arrived without alpha", async () => {
    const mouth = await statsFor(out, "mouth");
    const png = await decodePng(path.join(out, "mouth.png"));
    const alphaAt = (x: number, y: number) =>
      png.rgba[(y * png.width + x) * 4 + 3];
    // The lip is an ellipse, so its bbox corner is empty. A part pasted with its
    // white ground still opaque would cover the face with a rectangle there.
    expect(alphaAt(mouth.marginLeft, mouth.marginTop)).toBeLessThan(8);
    expect(
      alphaAt(Math.round(mouth.bboxCx), Math.round(mouth.bboxCy)),
    ).toBeGreaterThan(200);
  });

  it("returns the measurement of the layers it just wrote", async () => {
    const direct = await measureLayers({ layersDir: out });
    if (!direct.ok) throw new Error(`expected ok, got: ${direct.error}`);
    expect(full.measure).toEqual({
      layers: direct.layers,
      empty: direct.empty,
      warnings: direct.warnings,
    });
  });

  it("skips the optional roles whose part is absent", async () => {
    const headOnly = partsDir();
    await writePartsSet(headOnly, {
      omit: ["hair_back.png", "body.png", "mouth_open.png"],
    });
    const dir = outDir();
    const result = await composeOk({ partsDir: headOnly, outDir: dir });

    expect(result.skipped).toEqual(["hair_back", "body", "mouth_open"]);
    expect(result.layers.map((l) => l.role)).toEqual(
      ROLES.filter((r) => !result.skipped.includes(r)),
    );
    expect(fs.existsSync(path.join(dir, "body.png"))).toBe(false);
  });

  it("composes the cheek blush pair from one blush.png, mirrored for blush_L", async () => {
    // blush.png is read as the blush on the screen left: blush_R takes it as
    // drawn and blush_L mirrored, so the mark at the image's left end shows
    // on blush_R's left and on blush_L's right.
    const roles = full.layers.map((l) => l.role);
    for (const [role, cx, markSide] of [
      ["blush_L", 641, 1],
      ["blush_R", 459, -1],
    ] as const) {
      expect(roles.indexOf(role)).toBeGreaterThan(roles.indexOf("face"));
      expect(roles.indexOf(role)).toBeLessThan(roles.indexOf("nose"));
      // Centred on its cx and cy 530, 56 wide; the fixture trims to 40x16,
      // so it is round(16 * 56 / 40) = 22 tall.
      const layer = full.layers.find((l) => l.role === role)!;
      expect([layer.left, layer.top, layer.width, layer.height]).toEqual([
        cx - 28,
        530 - 11,
        56,
        22,
      ]);
      const mark = meanColumnNear(await decodePng(layer.path), BLUSH_MARK);
      expect(Math.sign(mark - (layer.left + layer.width / 2))).toBe(markSide);
    }
  });

  it("skips the blush pair without a blush.png, leaving no stale layer and no warning", async () => {
    const dir = outDir();
    await composeOk({ partsDir: parts, outDir: dir });
    for (const role of ["blush_L", "blush_R"]) {
      expect(fs.existsSync(path.join(dir, `${role}.png`))).toBe(true);
    }

    const noBlush = partsDir();
    await writePartsSet(noBlush, { omit: ["blush.png"] });
    const result = await composeOk({ partsDir: noBlush, outDir: dir });

    expect(result.skipped).toEqual(["blush_L", "blush_R"]);
    for (const role of ["blush_L", "blush_R"]) {
      expect(fs.existsSync(path.join(dir, `${role}.png`))).toBe(false);
      expect(result.measure.layers[role]).toBeUndefined();
    }
    // Blush is optional decoration, so its absence is not reported: a warning
    // would send every character drawn without one to a billed regeneration.
    expect(result.measure.warnings).toEqual(full.measure.warnings);
  });

  it("places the nose as a part of its own, under the face and over the mouth", async () => {
    // The rig leads the head turn with the nose, so it is a part like the eyes
    // and the mouth, not something cut out of the face.
    // The blush pair draws between them: over the face, under the nose.
    const roles = full.layers.map((l) => l.role);
    const face = roles.indexOf("face");
    expect(roles.slice(face, face + 4)).toEqual([
      "face",
      "blush_L",
      "blush_R",
      "nose",
    ]);
    expect(roles.indexOf("nose")).toBeLessThan(roles.indexOf("mouth"));
    // Its dense core is w wide and centred on cx; with no cy its tip lands
    // 0.66 of the way from the eye row (475) to the mouth's (594): row 554.
    // The fixture nose is opaque, so its core is the whole part, exactly w.
    const core = await noseCoreIn(out);
    expect(core.w).toBe(20);
    expect(Math.abs(core.cx - 550)).toBeLessThanOrEqual(0.5);
    expect(core.bottom).toBe(554);
  });

  it("sizes and places a soft nose by its dense core, not its feather", async () => {
    const dir = outDir();
    const result = await composeOk({
      partsDir: await softNoseParts(),
      outDir: dir,
    });

    // ±1 on a soft core: resampling the feather can lift a column next to it
    // over 128.
    const core = await noseCoreIn(dir);
    expect(Math.abs(core.w - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(core.cx - 550)).toBeLessThanOrEqual(0.5);
    expect(core.bottom).toBe(554);
    // Sized by its trimmed extent, the whole feather would have been 20 wide
    // and the core a dot inside it.
    const extent = await statsFor(dir, "nose");
    expect(extent.w).toBeGreaterThan(core.w);
    expect(extent.h).toBeGreaterThan(core.h);
    // A core over half the feather's size is the drawing, not a speck.
    expect(
      result.measure.warnings.filter((w) => w.startsWith("nose:")),
    ).toEqual([]);
  });

  it("follows the mouth with the nose's tip when its cy is left out", async () => {
    const dir = outDir();
    await composeOk({
      partsDir: await softNoseParts(),
      outDir: dir,
      layout: { mouth: { cy: 633 } },
    });
    // 475 + 0.66 * (633 - 475) = 579.28.
    expect((await noseCoreIn(dir)).bottom).toBe(579);
  });

  it("centres the nose's dense core on a given cy", async () => {
    const dir = outDir();
    await composeOk({
      partsDir: await softNoseParts(),
      outDir: dir,
      layout: { nose: { cy: 586 } },
    });
    expect(Math.abs((await noseCoreIn(dir)).cy - 586)).toBeLessThanOrEqual(0.5);
  });

  it("sizes the nose's dense core to a given w", async () => {
    const dir = outDir();
    await composeOk({
      partsDir: await softNoseParts(),
      outDir: dir,
      layout: { nose: { w: 50 } },
    });
    expect(Math.abs((await noseCoreIn(dir)).w - 50)).toBeLessThanOrEqual(1);
  });

  it("stretches the nose's dense core to a given h and keeps its tip", async () => {
    const dir = outDir();
    await composeOk({
      partsDir: await softNoseParts(),
      outDir: dir,
      layout: { nose: { h: 70 } },
    });
    const core = await noseCoreIn(dir);
    expect(Math.abs(core.h - 70)).toBeLessThanOrEqual(1);
    expect(Math.abs(core.w - 20)).toBeLessThanOrEqual(1);
    expect(core.bottom).toBe(554);
  });

  it.each([
    // The feather scales with the core, so a nose's w or h can run the whole
    // part past the canvas although resolveLayout caps both at it.
    [{ h: 1100 }, "h", "36x1760"],
    [{ w: 1100 }, "w", "1980x2640"],
  ])(
    "rejects a nose core %o whose part would overflow the canvas",
    async (nose, field, size) => {
      const error = await composeError({
        partsDir: await softNoseParts(),
        outDir: outDir(),
        layout: { nose },
      });
      expect(error).toBe(
        `layout.nose.${field}: resized part ${size} exceeds the ${CANVAS} canvas`,
      );
    },
  );

  it("names the eye and mouth rows when the tip rule puts the nose off the canvas", async () => {
    const error = await composeError({
      partsDir: await softNoseParts(),
      outDir: outDir(),
      layout: { mouth: { cy: 5e6 } },
    });
    // The nose draws before the mouth, so it is the first part refused.
    expect(error).toBe(
      "layout.nose.cx/cy (cy unset: its tip row comes from layout.eye_L/eye_R/mouth.cy): " +
        `the placed part (36x48 at 532,3300118) falls entirely outside the ${CANVAS} canvas`,
    );
  });

  it("sizes a nose painted wholly under alpha 128 by its whole extent", async () => {
    // No pixel reaches the core's threshold, so the part is its own core:
    // today's sizing, placed by the same tip rule.
    const dir = outDir();
    await composeOk({
      partsDir: await softNoseParts({ core: false }),
      outDir: dir,
    });
    const extent = await statsFor(dir, "nose");
    expect(extent.w).toBe(20);
    expect(CANVAS - 1 - extent.marginBottom).toBe(554);
  });

  it("sizes and places a nose whose dense core is a speck by its whole part, and warns", async () => {
    // Its only pixels at alpha 128 are a 4x3 nostril mark: sized by that, the
    // 36 px part would have come out 180 px wide. The whole part stands in, as
    // for a nose with no core, placed by the same tip rule.
    const dir = outDir();
    const result = await composeOk({
      partsDir: await softNoseParts({ core: "speck" }),
      outDir: dir,
    });
    const extent = await statsFor(dir, "nose");
    expect(extent.w).toBe(20);
    expect(CANVAS - 1 - extent.marginBottom).toBe(554);
    const nose = result.measure.warnings.filter((w) => w.startsWith("nose:"));
    expect(nose).toHaveLength(1);
    expect(nose[0]).toMatch(
      /^nose: the source part's dense core is 4x3 in its 36x48 trimmed part .* speck/,
    );
  });

  it("reports compose's own verdict on a speck that resampling erased from the layer", async () => {
    const dir = outDir();
    const result = await composeOk({
      partsDir: await softNoseParts({ core: "dot" }),
      outDir: dir,
      layout: { nose: { w: 20 } },
    });
    // The premise: shrunk to 20 of its 36 px, the 1x1 dot blurs under alpha
    // 128, so the composed layer has no dense core left to judge.
    const png = await decodePng(path.join(dir, "nose.png"));
    expect(denseCoreOf(png.rgba, png.width, png.height)).toBeNull();
    // Compose judged the source part, so its report still warns...
    const nose = result.measure.warnings.filter((w) => w.startsWith("nose:"));
    expect(nose).toHaveLength(1);
    expect(nose[0]).toMatch(/^nose: the source part's dense core is 1x1 /);
    // ...where measure_layers, reading only the file, has nothing to flag.
    const direct = await measureLayers({ layersDir: dir });
    if (!direct.ok) throw new Error(`expected ok, got: ${direct.error}`);
    expect(direct.warnings.filter((w) => w.startsWith("nose:"))).toEqual([]);
  });

  it("warns from the composed layer when only resampling made its core a speck", async () => {
    const dir = outDir();
    const result = await composeOk({
      partsDir: await softNoseParts({ core: "scatter" }),
      outDir: dir,
      layout: { nose: { w: 12 } },
    });
    // The source part's core, stretched by two far-apart dots to 25 of its
    // 36 px, is no speck, so it is what w sizes: round(36·12/25) = 17 wide.
    expect((await statsFor(dir, "nose")).w).toBe(17);
    // Shrunk that far, the dots blur under alpha 128 and leave the mark a
    // speck of the layer's crop, which the rig will not hand on. The report
    // says so from the layer, as measure_layers does on the same file.
    const nose = result.measure.warnings.filter((w) => w.startsWith("nose:"));
    expect(nose).toHaveLength(1);
    expect(nose[0]).toMatch(
      /^nose: the layer's dense core is 3x3 in its 19x25 crop .* speck/,
    );
    const direct = await measureLayers({ layersDir: dir });
    if (!direct.ok) throw new Error(`expected ok, got: ${direct.error}`);
    expect(direct.warnings.filter((w) => w.startsWith("nose:"))).toEqual(nose);
  });

  // brow.png feeds two roles, so the message has to name the role, not the file.
  it.each([
    ["face.png", "face"],
    ["brow.png", "brow_L"],
  ])("fails when the required %s is missing", async (missing, role) => {
    const incomplete = partsDir();
    await writePartsSet(incomplete, { omit: [missing] });
    const error = await composeError({
      partsDir: incomplete,
      outDir: outDir(),
    });
    expect(error).toBe(
      `missing part source for role "${role}": ${path.join(incomplete, missing)}`,
    );
  });

  it("moves a part by its layout override", async () => {
    const moved = outDir();
    await composeOk({
      partsDir: parts,
      outDir: moved,
      layout: { mouth: { cx: 600 } },
    });
    const before = await statsFor(out, "mouth");
    const after = await statsFor(moved, "mouth");
    expect(after.bboxCx - before.bboxCx).toBe(50);
    expect(after.bboxCy).toBe(before.bboxCy);
  });

  it("removes a skipped role's layer left by an earlier compose", async () => {
    const dir = outDir();
    await composeOk({ partsDir: parts, outDir: dir });
    expect(fs.existsSync(path.join(dir, "body.png"))).toBe(true);

    const headOnly = partsDir();
    await writePartsSet(headOnly, {
      omit: ["hair_back.png", "body.png", "mouth_open.png"],
    });
    const result = await composeOk({ partsDir: headOnly, outDir: dir });

    // The result and the directory have to agree: a stale body would still be
    // measured here, and rigged in by the next auto_rig_from_layers.
    for (const role of result.skipped) {
      expect(fs.existsSync(path.join(dir, `${role}.png`))).toBe(false);
      expect(result.measure.layers[role]).toBeUndefined();
    }
    expect(
      result.measure.warnings.some((w) => w.startsWith("body: missing")),
    ).toBe(true);
  });

  it("rejects a centre that puts the part entirely off the canvas", async () => {
    const error = await composeError({
      partsDir: parts,
      outDir: outDir(),
      layout: { face: { cx: -900000, cy: 5e9 } },
    });
    // A sign-flipped centre composes to a blank layer that no check downstream
    // can flag, so it has to fail here instead of reading as success.
    expect(error).toBe(
      `layout.face.cx/cy: the placed part (400x500 at -900200,4999999750) ` +
        `falls entirely outside the ${CANVAS} canvas`,
    );
  });

  it("allows a part that only hangs off an edge", async () => {
    // `body` runs off the canvas bottom by design at its default cy — the test
    // is intersection with the canvas, not containment in it. The face's
    // features ride up with it and stay on the canvas.
    const dir = outDir();
    const result = await composeOk({
      partsDir: parts,
      outDir: dir,
      layout: { face: { cy: 100 } },
    });
    expect(result.layers.find((l) => l.role === "face")?.top).toBeLessThan(0);
  });

  it("moves and scales the features' defaults with the face", async () => {
    // The face 1.2x as wide and moved by (50, 50): eye_L's default (86, 38)
    // from the face's centre becomes (103.2, 45.6), 98 wide becomes 118.
    const dir = outDir();
    const r = await composeOk({
      partsDir: parts,
      outDir: dir,
      layout: { face: { cx: 600, cy: 487, w: 480 } },
    });
    const at = (role: string) => r.layers.find((l) => l.role === role)!;
    const eye = at("eye_L");
    expect(eye.width).toBe(118);
    expect(eye.left).toBe(Math.round(703.2 - 118 / 2));
    expect(eye.top).toBe(Math.round(532.6 - eye.height / 2));
    expect(at("lash_lower_L")).toMatchObject({ left: eye.left, top: eye.top });
    // The mouth moves the same way; the hair does not follow the face.
    const mouth = at("mouth");
    expect(mouth.width).toBe(Math.round(76 * 1.2));
    expect(mouth.left).toBe(Math.round(600 - mouth.width / 2));
    expect(at("hair_front").left).toBe(
      full.layers.find((l) => l.role === "hair_front")!.left,
    );
    // A feature's own override still names canvas px.
    const pinned = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      layout: {
        face: { cx: 600, cy: 487, w: 480 },
        mouth: { cx: 550, cy: 594, w: 76 },
      },
    });
    const box = (l: { left: number; top: number; width: number }) => [
      l.left,
      l.top,
      l.width,
    ];
    expect(box(pinned.layers.find((l) => l.role === "mouth")!)).toEqual(
      box(full.layers.find((l) => l.role === "mouth")!),
    );
  });

  describe("a mark detached from the body", () => {
    /** The full parts set with its body.png carrying a detached mark. */
    async function bodyWithMark(opts: Parameters<typeof writeBodyWithMark>[1]) {
      const dir = partsDir();
      await writePartsSet(dir, { omit: ["body.png"] });
      await writeBodyWithMark(dir, opts);
      const result = await composeOk({ partsDir: dir, outDir: outDir() });
      return result.layers.find((l) => l.role === "body")!;
    }
    const plainBody = () => full.layers.find((l) => l.role === "body")!;

    it("leaves a faint speck out of the part's box, so the body lands as if it had none", async () => {
      // Alpha 88 never reaches 128 and its 18 px are under 1 % of the part.
      const layer = await bodyWithMark({ markAlpha: 88 });
      const plain = plainBody();
      expect([layer.left, layer.top, layer.width, layer.height]).toEqual([
        plain.left,
        plain.top,
        plain.width,
        plain.height,
      ]);
      expect((await decodePng(layer.path)).rgba).toEqual(
        (await decodePng(plain.path)).rgba,
      );
    });

    it.each([
      ["a drawn stroke", { markAlpha: 255 }],
      [
        "a part painted wholly under alpha 128",
        { markAlpha: 88, bodyAlpha: 100 },
      ],
    ])("keeps the mark of %s in the part's box", async (_, opts) => {
      // w sizes the 109-wide trimmed part, so the ellipse's 60 rows come out
      // shorter than the plain body's.
      const layer = await bodyWithMark(opts);
      const plain = plainBody();
      expect(layer.width).toBe(plain.width);
      expect(layer.height).toBe(Math.round((60 * plain.width) / 109));
    });
  });

  it("rejects an unknown role in the layout", async () => {
    const error = await composeError({
      partsDir: parts,
      outDir: outDir(),
      // Agents send arbitrary JSON; a typo'd role must not silently do nothing.
      layout: { eyebrow: { cx: 500 } } as unknown as LayoutOverride,
    });
    expect(error).toBe(
      "layout.eyebrow: unknown role — expected one of hair_back, body, face, " +
        "blush_L, blush_R, nose, mouth, mouth_open, eye_L, eye_R, iris_L, " +
        "iris_R, lash_L, lash_R, brow_L, brow_R, hair_front",
    );
  });

  it.each([0, 1101])("rejects a layout width of %i", async (w) => {
    const error = await composeError({
      partsDir: parts,
      outDir: outDir(),
      layout: { mouth: { w } },
    });
    expect(error).toBe(
      `layout.mouth.w must be an integer in 1..${CANVAS}, got ${w}`,
    );
  });

  it("rejects a width whose resized part would overflow the canvas", async () => {
    // A 4x100 part scaled to 100px wide is 2500px tall — caught from the
    // trimmed buffer's dimensions, before the resize allocates anything.
    const tall = partsDir();
    await writePartsSet(tall);
    const strip = Buffer.alloc(20 * 120 * 4);
    for (let y = 10; y < 110; y++) {
      for (let x = 8; x < 12; x++) {
        const i = (y * 20 + x) * 4;
        strip[i] = strip[i + 1] = strip[i + 2] = 30;
        strip[i + 3] = 255;
      }
    }
    await sharp(strip, { raw: { width: 20, height: 120, channels: 4 } })
      .png()
      .toFile(path.join(tall, "face.png"));

    const error = await composeError({
      partsDir: tall,
      outDir: outDir(),
      layout: { face: { w: 100 } },
    });
    expect(error).toBe(
      `layout.face.w: resized part 100x2500 exceeds the ${CANVAS} canvas`,
    );
  });

  it("rejects an output dir that does not exist", async () => {
    const error = await composeError({
      partsDir: parts,
      outDir: "no-such-compose-out",
    });
    expect(error).toMatch(/output dir not found/);
  });

  it("rejects an output dir outside the working directory", async () => {
    const error = await composeError({
      partsDir: parts,
      outDir: outsideDir(),
    });
    expect(error).toMatch(/output dir escapes the working directory/);
  });

  it("rejects an output dir symlinked out of the working directory", async () => {
    const link = path.join(outDir(), "link");
    fs.symlinkSync(outsideDir(), link);
    const error = await composeError({ partsDir: parts, outDir: link });
    expect(error).toMatch(/output dir escapes the working directory/);
  });

  it("replaces a symlinked layer at the target instead of following it", async () => {
    const dir = outDir();
    const hijacked = path.join(outsideDir(), "hijacked.png");
    const target = path.join(dir, "face.png");
    fs.symlinkSync(hijacked, target);

    await composeOk({ partsDir: parts, outDir: dir });

    // The symlink's external target was NOT written; the link itself was
    // replaced by a real file (writeFileAtomic renames over the entry).
    expect(fs.existsSync(hijacked)).toBe(false);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    const meta = await sharp(target).metadata();
    expect([meta.width, meta.height]).toEqual([CANVAS, CANVAS]);
  });

  it("rejects partsDir and outDir resolving to the same directory", async () => {
    const dir = outDir();
    await writePartsSet(dir);
    const before = digest(dir);

    const error = await composeError({ partsDir: dir, outDir: dir });

    expect(error).toMatch(/partsDir and outDir resolve to the same directory/);
    // The rejection must fire before any decode/write touches the sources.
    expect(digest(dir)).toEqual(before);
  });

  it("rejects partsDir aliasing outDir through a symlink", async () => {
    const dir = outDir();
    await writePartsSet(dir);
    const before = digest(dir);
    const link = path.join(outDir(), "alias");
    fs.symlinkSync(dir, link);

    const error = await composeError({ partsDir: link, outDir: dir });

    expect(error).toMatch(/partsDir and outDir resolve to the same directory/);
    expect(digest(dir)).toEqual(before);
  });

  it("sends a canvas-clipped part to the free move before any regeneration", async () => {
    // The shipped default did exactly this on a real character: the source keeps
    // its margin and the layout pushes the crown off the canvas top.
    const r = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      layout: { hair_front: { cy: 10 } },
    });

    const w = r.measure.warnings.find((x) =>
      /^hair_front: .* top edge is opaque/.test(x),
    );
    expect(w).toMatch(/sits flush against the canvas top/);
    expect(w).toMatch(/retune layout\.hair_front\.cx\/cy\/w/);
    expect(w).toMatch(/remeasure; regenerate only if/);
  });

  it("stretches a role to an explicit h and leaves the rest on their aspect", async () => {
    const r = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      layout: { eye_L: { h: 80 }, lash_L: { h: 80 } },
    });

    const eye = r.layers.find((l) => l.role === "eye_L")!;
    const lash = r.layers.find((l) => l.role === "lash_L")!;
    expect(eye.height).toBe(80);
    expect(lash.height).toBe(80);
    // The pair still shares one frame, which is what the blink fold rides.
    expect(lash.left).toBe(eye.left);
    expect(lash.top).toBe(eye.top);
    // An untouched role keeps the aspect it had without h.
    const face = r.layers.find((l) => l.role === "face")!;
    const baseFace = full.layers.find((l) => l.role === "face")!;
    expect(face.height).toBe(baseFace.height);
  });

  it("clears the flat-sclera warning the way its own text prescribes", async () => {
    // Squash the pair flat enough to trip the aspect check, the way a real
    // generated eyewhite does.
    const flat = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      layout: { eye_L: { h: 40 }, lash_L: { h: 40 } },
    });
    const warning = flat.measure.warnings.find((w) =>
      /^eye_L: sclera aspect/.test(w),
    );
    expect(warning).toBeDefined();

    // Take the h the warning names and set it on the pair, as it instructs.
    const h = Number(/\.h to (\d+)/.exec(warning!)![1]);
    const fixed = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      layout: { eye_L: { h }, lash_L: { h } },
    });
    expect(
      fixed.measure.warnings.filter((w) => /^eye_L: sclera aspect/.test(w)),
    ).toEqual([]);
  });

  it("clears the facing warning the way its own text prescribes", async () => {
    // Drawn the other way round: the tear duct at the image's LEFT end, where
    // the composer reads the lash wing — the way all three eyewhite variants
    // of one real run came back.
    const facing = partsDir();
    await writePartsSet(facing, { omit: ["eyewhite.png"] });
    await writeEyewhite(facing, { tearDuct: "left" });
    const wrong = await composeOk({ partsDir: facing, outDir: outDir() });
    const warning = wrong.measure.warnings.find((w) =>
      /^eye_R: .*facing/.test(w),
    );
    expect(warning).toBeDefined();

    // Take the mirrorParts the warning names and pass it, as it instructs.
    const mirrorParts = JSON.parse(
      /mirrorParts: (\[[^\]]*\])/.exec(warning!)![1],
    ) as string[];
    const fixed = await composeOk({
      partsDir: facing,
      outDir: outDir(),
      mirrorParts,
    });
    expect(fixed.measure.warnings.filter((w) => /facing/.test(w))).toEqual([]);
    // Both halves of each pair are cut from the one flipped source, so the
    // lash still sits inside its sclera's frame and the fold cannot tear.
    for (const side of ["L", "R"]) {
      const eye = await statsFor(fixed.outDir, `eye_${side}`);
      const lash = await statsFor(fixed.outDir, `lash_${side}`);
      expect(lash.marginLeft).toBeGreaterThanOrEqual(eye.marginLeft);
      expect(lash.marginRight).toBeGreaterThanOrEqual(eye.marginRight);
      expect(lash.marginTop).toBe(eye.marginTop);
    }
  });

  it("flips a regular part's source under both roles cut from it", async () => {
    const tapered = partsDir();
    await writePartsSet(tapered, { omit: ["brow.png"] });
    await writeTaperedBrow(tapered);
    const asDrawn = await composeOk({ partsDir: tapered, outDir: outDir() });
    const flipped = await composeOk({
      partsDir: tapered,
      outDir: outDir(),
      mirrorParts: ["brow.png"],
    });

    for (const role of ["brow_L", "brow_R"]) {
      const a = await statsFor(asDrawn.outDir, role);
      const b = await statsFor(flipped.outDir, role);
      // The same box, with the thick head at the other end of it.
      expect(b.bboxCx).toBe(a.bboxCx);
      expect(Math.sign(b.massCx - b.bboxCx)).toBe(
        -Math.sign(a.massCx - a.bboxCx),
      );
    }
  });

  it("rejects a lash placed apart from its sclera", async () => {
    // Narrowed alone, the lash still lies on its sclera and inks its top row,
    // so nothing in the composed layers would show the fold it tears.
    const narrowed = await composeError({
      partsDir: parts,
      outDir: outDir(),
      layout: { eye_L: { w: 140, h: 86 }, lash_L: { w: 120, h: 86 } },
    });
    expect(narrowed).toMatch(
      /^layout\.lash_L places the lash at 120x86 \(576,432\), but layout\.eye_L places its sclera at 140x86 \(566,432\)/,
    );

    // An h set on the sclera alone leaves the lash on the part's own aspect.
    const halfSet = await composeError({
      partsDir: parts,
      outDir: outDir(),
      layout: { eye_R: { h: 90 } },
    });
    expect(halfSet).toMatch(
      /^layout\.lash_R places the lash at 98x61 .* sclera at 98x90/,
    );
  });

  it("leaves the output dir as it was when a placement is rejected", async () => {
    const out = outDir();
    await composeOk({ partsDir: parts, outDir: out });
    const before = digest(out);

    // Both are refused only after the roles drawn before them have been
    // placed — the lash after the eyes, hair_front last of all — while the
    // moved face would already differ from the layer on disk.
    for (const layout of [
      { face: { cx: 560 }, lash_L: { w: 120 } },
      { face: { cx: 560 }, hair_front: { cx: -1000 } },
    ] as LayoutOverride[]) {
      await composeError({ partsDir: parts, outDir: out, layout });
      expect(digest(out)).toEqual(before);
    }
  });

  it("accepts an h that lands the pair on the same frame as its aspect", async () => {
    // The fixture eyewhite crops to 64x40, so 98 wide it is 61 tall anyway.
    const r = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      layout: { eye_R: { h: 61 } },
    });
    const eye = r.layers.find((l) => l.role === "eye_R")!;
    const lash = r.layers.find((l) => l.role === "lash_R")!;
    expect([lash.left, lash.top, lash.width, lash.height]).toEqual([
      eye.left,
      eye.top,
      eye.width,
      eye.height,
    ]);
  });

  it("rejects an unknown part in mirrorParts", async () => {
    const error = await composeError({
      partsDir: parts,
      outDir: outDir(),
      // A role name is not a part file: eye_L is cut from eyewhite.png.
      mirrorParts: ["eye_L"],
    });
    expect(error).toMatch(
      /^mirrorParts\[0\]: unknown part "eye_L" — expected one of .*eyewhite\.png/,
    );
  });

  it("rejects an h outside the canvas", async () => {
    const r = await composeLayersFromParts({
      partsDir: parts,
      outDir: outDir(),
      layout: { eye_L: { h: 0 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatch(
        /layout\.eye_L\.h must be an integer in 1\.\.1100/,
      );
  });
});
