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
import { decodePng } from "../src/node-images";
import { writePartsSet } from "./helpers/parts";

/** Draw order the composer walks, back -> front, with the nose it cuts. */
const ROLES: LayerRole[] = [
  "hair_back",
  "body",
  "face",
  "nose",
  "mouth",
  "mouth_open",
  "eye_L",
  "eye_R",
  "iris_L",
  "iris_R",
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

async function statsFor(dir: string, role: string) {
  const stats = await layerStats(path.join(dir, `${role}.png`));
  if (stats === null) throw new Error(`${role} is fully transparent`);
  return stats;
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
      width: 128,
      left: 593,
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

  it("splits the eyewhite into a white sclera and an upper-lash-only layer", async () => {
    const eye = await statsFor(out, "eye_L");
    const lash = await statsFor(out, "lash_L");

    // The sclera is the blink clip-mask shape: every dark lash pixel of the
    // eyewhite was recoloured white, so nothing dark survives in it.
    const sclera = await decodePng(path.join(out, "eye_L.png"));
    let darkest = 255;
    for (let i = 0; i < sclera.rgba.length; i += 4) {
      if (sclera.rgba[i + 3] <= 8) continue;
      const luma =
        0.299 * sclera.rgba[i] +
        0.587 * sclera.rgba[i + 1] +
        0.114 * sclera.rgba[i + 2];
      if (luma < darkest) darkest = luma;
    }
    expect(darkest).toBeGreaterThanOrEqual(120);

    // The lash inks only the TOP of the shared frame — that is the fold that
    // covers the closed-eye seam, rather than the eye shrinking in place.
    const lashPng = await decodePng(path.join(out, "lash_L.png"));
    let lashMaxY = -1;
    for (let y = 0; y < lashPng.height; y++) {
      for (let x = 0; x < lashPng.width; x++) {
        if (lashPng.rgba[(y * lashPng.width + x) * 4 + 3] > 8) lashMaxY = y;
      }
    }
    expect(lashMaxY).toBeGreaterThan(eye.marginTop);
    expect(lashMaxY).toBeLessThanOrEqual(eye.marginTop + eye.h / 2);

    // ...and both keep the eyewhite's frame, so the fold cannot tear.
    expect(lash.marginLeft).toBe(eye.marginLeft);
    expect(lash.marginTop).toBe(eye.marginTop);
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
    // is intersection with the canvas, not containment in it.
    const dir = outDir();
    const result = await composeOk({
      partsDir: parts,
      outDir: dir,
      layout: { face: { cy: -100 } },
    });
    expect(result.layers.find((l) => l.role === "face")?.top).toBeLessThan(0);
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
        "mouth, mouth_open, eye_L, eye_R, iris_L, iris_R, lash_L, lash_R, " +
        "brow_L, brow_R, hair_front",
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

describe("the nose cut", () => {
  // The fixture face is a skin ellipse with a dark stroke on its centre line
  // between the eye row and the mouth; placed at the layout's face width the
  // stroke lands in the gap between the eyes, below their centre line and
  // above the mouth — the window the cut searches.
  let out: string;
  let full: ComposeOk;
  beforeAll(async () => {
    const parts = partsDir();
    await writePartsSet(parts);
    out = outDir();
    full = await composeOk({ partsDir: parts, outDir: out });
  }, 30_000);

  it("lifts the drawn nose into nose.png, between the eyes and above the mouth", async () => {
    const nose = full.layers.find((l) => l.role === "nose")!;
    expect(nose.path).toBe(path.join(full.outDir, "nose.png"));
    expect(full.skipped).not.toContain("nose");
    const stats = await statsFor(out, "nose");
    const eyeL = full.layers.find((l) => l.role === "eye_L")!;
    const eyeR = full.layers.find((l) => l.role === "eye_R")!;
    const mouth = full.layers.find((l) => l.role === "mouth")!;
    // Inside the gap between the eyes' inner edges, under their centre line,
    // above the mouth — and the reported placement is that alpha bbox.
    expect(nose.left).toBeGreaterThanOrEqual(eyeR.left + eyeR.width);
    expect(nose.left + nose.width).toBeLessThanOrEqual(eyeL.left);
    expect(nose.top).toBeGreaterThanOrEqual(eyeL.top + eyeL.height / 2 - 1);
    expect(nose.top + nose.height).toBeLessThanOrEqual(mouth.top);
    expect([stats.w, stats.h]).toEqual([nose.width, nose.height]);
    // The stroke is 3x13 source px at 5x: the cut is that plus its grown rim,
    // not the whole window.
    expect(nose.width).toBeLessThan(40);
    expect(nose.height).toBeLessThan(90);
  });

  it("fills skin in behind it, so the face no longer carries the stroke", async () => {
    const nose = full.layers.find((l) => l.role === "nose")!;
    const face = await decodePng(path.join(out, "face.png"));
    const skin = [240, 205, 180];
    let maxDist = 0;
    for (let y = nose.top; y < nose.top + nose.height; y++) {
      for (let x = nose.left; x < nose.left + nose.width; x++) {
        const i = (y * face.width + x) * 4;
        if (face.rgba[i + 3] === 0) continue;
        for (let c = 0; c < 3; c++)
          maxDist = Math.max(maxDist, Math.abs(face.rgba[i + c] - skin[c]));
      }
    }
    // Nothing darker than shading noise remains where the stroke was.
    expect(maxDist).toBeLessThan(20);
    // And the stroke itself is in the nose layer, at full alpha.
    const nosePng = await decodePng(path.join(out, "nose.png"));
    let dark = 0;
    for (let i = 0; i < nosePng.rgba.length; i += 4) {
      if (nosePng.rgba[i + 3] === 255 && nosePng.rgba[i] < 60) dark++;
    }
    expect(dark).toBeGreaterThan(100);
  });

  it("keeps the original pixels at their original alpha, over unbroken skin", async () => {
    // No feathered rim: the cut's pixels are the face's own, opaque where the
    // face was, so at rest nose-over-face is the original drawing — and
    // wherever the nose is opaque the face beneath is filled, not a hole.
    const face = await decodePng(path.join(out, "face.png"));
    const nosePng = await decodePng(path.join(out, "nose.png"));
    let opaque = 0;
    for (let i = 0; i < nosePng.rgba.length; i += 4) {
      const a = nosePng.rgba[i + 3];
      if (a === 0) continue;
      expect(a).toBe(255);
      expect(face.rgba[i + 3]).toBe(255);
      opaque++;
    }
    expect(opaque).toBeGreaterThan(100);
  });

  it("a face without a drawn nose yields no nose layer, and drops a stale one", async () => {
    const parts = partsDir();
    await writePartsSet(parts, { plainFace: true });
    const dir = outDir();
    // A nose.png from an earlier compose into the same dir.
    fs.copyFileSync(path.join(out, "nose.png"), path.join(dir, "nose.png"));
    const r = await composeOk({ partsDir: parts, outDir: dir });
    expect(r.skipped).toContain("nose");
    expect(r.layers.map((l) => l.role)).not.toContain("nose");
    expect(fs.existsSync(path.join(dir, "nose.png"))).toBe(false);
    // The face went out untouched: its skin is unbroken across the window.
    const face = await statsFor(dir, "face");
    expect(face.w).toBe(400);
  });

  it("a face shaded top to bottom, with no nose, is left whole", async () => {
    // 52 levels of vertical shading inside the search window: against one
    // window-wide skin reference this read as ink over most of the window and
    // moved bands of skin.
    const parts = partsDir();
    await writePartsSet(parts, { plainFace: true, shaded: "vertical" });
    const dir = outDir();
    const r = await composeOk({ partsDir: parts, outDir: dir });
    expect(r.skipped).toContain("nose");
    expect(fs.existsSync(path.join(dir, "nose.png"))).toBe(false);
  });

  it("a face shaded side to side, with no nose, is left whole", async () => {
    // A row's own median cannot absorb a gradient that runs ALONG the row: the
    // ends seed, and the hysteresis grows them across the whole window. The
    // size guard on the grown cut is what declines it.
    const parts = partsDir();
    await writePartsSet(parts, { plainFace: true, shaded: "horizontal" });
    const dir = outDir();
    const r = await composeOk({ partsDir: parts, outDir: dir });
    expect(r.skipped).toContain("nose");
    expect(fs.existsSync(path.join(dir, "nose.png"))).toBe(false);
  });

  it("a face shaded top to bottom still gives up only its nose", async () => {
    const parts = partsDir();
    await writePartsSet(parts, { shaded: "vertical" });
    const dir = outDir();
    const r = await composeOk({ partsDir: parts, outDir: dir });
    const nose = r.layers.find((l) => l.role === "nose")!;
    expect(nose).toBeDefined();
    // The stroke plus its grown rim, not the shading around it.
    expect(nose.width).toBeLessThan(40);
    expect(nose.height).toBeLessThan(90);
  });

  it("a half-transparent nose is not cut: the two layers would double its coverage", async () => {
    const parts = partsDir();
    await writePartsSet(parts, { translucentNose: true });
    const dir = outDir();
    const r = await composeOk({ partsDir: parts, outDir: dir });
    expect(r.skipped).toContain("nose");
    expect(fs.existsSync(path.join(dir, "nose.png"))).toBe(false);
  });
});
