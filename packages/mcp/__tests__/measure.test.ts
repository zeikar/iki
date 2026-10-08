import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { armGeometry, createLayerSetMeasurer } from "@ikijs/editor";
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
type SetPixel = (x: number, y: number, rgb: RGB, alpha?: number) => void;

const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-measure-"));
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Paint a straight-alpha RGBA canvas (`CANVAS` square unless sized) and
 *  write it as a layer PNG. */
async function writeLayer(
  dir: string,
  name: string,
  paint: (set: SetPixel) => void,
  { width, height } = { width: CANVAS, height: CANVAS },
): Promise<void> {
  const buf = Buffer.alloc(width * height * 4); // all transparent (alpha 0)
  const set: SetPixel = (x, y, rgb, alpha = 255) => {
    const i = (y * width + x) * 4;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = alpha;
  };
  paint(set);
  await sharp(buf, { raw: { width, height, channels: 4 } })
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
 *  bottom row is only the two tips (a filled cap would read as a cropped part).
 *  `inked` leaves the columns it rejects bare, the way an eye's tear duct is. */
function topArc(
  set: SetPixel,
  cx: number,
  cy: number,
  w: number,
  h: number,
  thickness: number,
  rgb: RGB,
  inked: (x: number) => boolean = () => true,
): void {
  for (let y = 0; y < cy; y++) {
    for (let x = 0; x < CANVAS; x++) {
      if (!inked(x)) continue;
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
  await writeLayer(dir, "nose.png", (set) => rect(set, 95, 110, 10, 12, DARK));
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
      "nose",
    ]);
    expect(result.layers.eye_L.w).toBe(64);
    expect(result.layers.iris_L.w).toBe(36);
  });

  it("flags a nose whose dense core is a speck of its crop, and not one half its width", async () => {
    // A soft nose's feather, 40x50 at alpha 80 (under the core's 128): its
    // crop is that ellipse grown by 1 px, 42x52.
    const feather = (set: SetPixel) =>
      ellipse((x, y, rgb) => set(x, y, rgb, 80), 100, 100, 40, 50, DARK);

    // A 3x3 opaque nostril dot low in it: a speck of that crop.
    const speck = tmpDir();
    await writeLayer(speck, "nose.png", (set) => {
      feather(set);
      rect(set, 99, 110, 3, 3, DARK);
    });
    const dotted = (await measureOk(speck)).warnings.filter((w) =>
      w.startsWith("nose:"),
    );
    expect(dotted).toHaveLength(1);
    expect(dotted[0]).toMatch(
      /^nose: the layer's dense core is 3x3 in its 42x52 crop .* speck/,
    );

    // An opaque core half the feather's width is the drawing, not a speck.
    const drawn = tmpDir();
    await writeLayer(drawn, "nose.png", (set) => {
      feather(set);
      ellipse(set, 100, 108, 20, 26, DARK);
    });
    expect(warned((await measureOk(drawn)).warnings, /^nose:/)).toBe(false);
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

  it("flags a lash that drifted off its sclera", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    await writeLayer(dir, "lash_L.png", (set) =>
      topArc(set, 103, 100, 64, 40, 4, DARK),
    );

    const result = await measureOk(dir);
    expect(
      warned(
        result.warnings,
        /^lash_L: \d+ of its \d+ opaque px lie off eye_L's sclera/,
      ),
    ).toBe(true);
  });

  it("names the free move for a flush edge and the redraw for a cropped one", async () => {
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
    expect(w).toMatch(/sits flush against the canvas top/);
    expect(w).toMatch(/Move it inward first/);
    // The billed remedy is named only as the fallback, never as the diagnosis.
    expect(w).toMatch(/regenerate only if/);
  });

  it("tolerates a lash whose ink is asymmetric inside a shared frame", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // The layout entries are in sync, but the lash stops short of the tear
    // duct: its bare inner 12 px (eye_L's nose side is -x) put its ink centre
    // 6 px off the sclera's — what every eye drawn the right way does, and
    // nothing an artist could retune.
    await writeLayer(dir, "lash_L.png", (set) =>
      topArc(set, 100, 100, 64, 40, 4, DARK, (x) => x >= 80),
    );

    const result = await measureOk(dir);
    expect(warned(result.warnings, /^lash_L:/)).toBe(false);
  });

  it("flags a lash that drifted in toward its bare tear duct", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // The same lash moved 4 px toward the nose. Its bare end leaves it room,
    // so its ink stays inside the sclera's frame on both sides and still inks
    // its top row — but it no longer lies on the sclera it was cut from.
    await writeLayer(dir, "lash_L.png", (set) =>
      topArc(set, 96, 100, 64, 40, 4, DARK, (x) => x >= 76),
    );

    const result = await measureOk(dir);
    expect(
      warned(
        result.warnings,
        /^lash_L: \d+ of its \d+ opaque px lie off eye_L's sclera/,
      ),
    ).toBe(true);
  });

  it("flags an eye drawn facing the other way, reading the nose side per eye", async () => {
    const dir = tmpDir();
    // The same drawing on both sides: its lash-free tear duct at the screen
    // RIGHT end (x > 119 of the 68..131 almond). On eye_R, the screen-left eye,
    // that end is the nose side, where a tear duct belongs. On eye_L it is
    // the outer corner, so the lash ink leans in toward the nose.
    const tearDuctRight = (x: number) => x <= 119;
    for (const side of ["L", "R"]) {
      await writeLayer(dir, `eye_${side}.png`, (set) =>
        ellipse(set, 100, 100, 64, 40, WHITE),
      );
      await writeLayer(dir, `lash_${side}.png`, (set) =>
        topArc(set, 100, 100, 64, 40, 4, DARK, tearDuctRight),
      );
    }

    const result = await measureOk(dir);
    const facing = result.warnings.filter((w) => /facing/.test(w));
    expect(facing).toHaveLength(1);
    expect(facing[0]).toMatch(/^eye_L: .*facing the other way/);
    // The free fix, named so it can be applied as written.
    expect(facing[0]).toMatch(/mirrorParts: \["eyewhite\.png"\]/);
  });

  it("reads a long thin wing as the outer corner, whichever end it is on", async () => {
    // A 1 px wing flicking 40 px out past the almond (68..131), with an 8 px
    // tear duct bare at the other end of the arc. The sclera is the whole
    // silhouette, wing included (the split recolours the lash white), so the
    // wing widens the frame the lash is read in and drags the frame's centre
    // outward — past the lash's centroid, which so few pixels barely move.
    const wingedEye = async (side: "L" | "R", wingRight: boolean) => {
      const wing = (x: number) =>
        wingRight ? x >= 124 && x < 172 : x >= 28 && x < 76;
      const inked = (x: number) => (wingRight ? x > 75 : x <= 124);
      await writeLayer(dir, `eye_${side}.png`, (set) => {
        ellipse(set, 100, 100, 64, 40, WHITE);
        for (let x = 0; x < CANVAS; x++) if (wing(x)) set(x, 84, WHITE);
      });
      await writeLayer(dir, `lash_${side}.png`, (set) => {
        topArc(set, 100, 100, 64, 40, 4, DARK, inked);
        for (let x = 0; x < CANVAS; x++) if (wing(x)) set(x, 84, DARK);
      });
    };
    const dir = tmpDir();
    // eye_L's outer corner is screen right, eye_R's screen left: each drawn
    // the right way round, wing out and tear duct in.
    await wingedEye("L", true);
    await wingedEye("R", false);
    const right = await measureOk(dir);
    expect(warned(right.warnings, /facing/)).toBe(false);

    // The same two drawings swapped: each wing now points at the nose.
    const reversed = tmpDir();
    const swap = (from: string, to: string) =>
      fs.copyFileSync(path.join(dir, from), path.join(reversed, to));
    swap("eye_L.png", "eye_R.png");
    swap("lash_L.png", "lash_R.png");
    swap("eye_R.png", "eye_L.png");
    swap("lash_R.png", "lash_L.png");
    const wrong = await measureOk(reversed);
    expect(
      wrong.warnings.filter((w) => /facing the other way/.test(w)),
    ).toHaveLength(2);
  });

  it("flags a lash scaled down inside its sclera", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // A lash whose w fell out of sync with its sclera's: centred and smaller,
    // every pixel still lies on the sclera, but its top row no longer meets
    // the sclera's, which is the seam the fold rides.
    await writeLayer(dir, "lash_L.png", (set) =>
      topArc(set, 100, 100, 56, 34, 4, DARK),
    );

    const result = await measureOk(dir);
    const drift = result.warnings.find((w) => /^lash_L:/.test(w));
    expect(drift).toMatch(/top edge is 3\.0 px off the sclera's/);
    // Only the fault that fired is named.
    expect(drift).not.toMatch(/opaque px lie off/);
  });

  it("leaves a drifted lash to the drift check, not the facing one", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // 3 px toward the nose (eye_L's nose side is -x): a layout desync, which
    // also bares the lash's outer end. An eye drawn the other way still lies
    // on the sclera it was split from.
    await writeLayer(dir, "lash_L.png", (set) =>
      topArc(set, 97, 100, 64, 40, 4, DARK),
    );

    const result = await measureOk(dir);
    expect(
      warned(
        result.warnings,
        /^lash_L: \d+ of its \d+ opaque px lie off eye_L's sclera/,
      ),
    ).toBe(true);
    expect(warned(result.warnings, /facing/)).toBe(false);
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

  it("warns of feet cut by a tall canvas's bottom, and of nothing with margin left", async () => {
    const tall = { width: CANVAS, height: 600 };
    // Two soles side by side: a flat bottom row the generic edge check
    // would read as a crop.
    const legs = (bottom: number) => (set: SetPixel) => {
      rect(set, 60, 100, 80, bottom - 99, DARK);
      for (let y = 300; y <= bottom; y++)
        for (let x = 95; x < 105; x++) set(x, y, DARK, 0);
    };
    const feet =
      /^body: its bottom row is the canvas's last — on a tall canvas that cuts the feet off\. Free fix: raise canvasHeight/;

    const cut = tmpDir();
    await writeLayer(cut, "body.png", legs(599), tall);
    const cutWarnings = (await measureOk(cut)).warnings;
    expect(cutWarnings.filter((w) => feet.test(w))).toHaveLength(1);
    expect(warned(cutWarnings, /bottom edge is opaque/)).toBe(false);

    const standing = tmpDir();
    await writeLayer(standing, "body.png", legs(560), tall);
    const standingWarnings = (await measureOk(standing)).warnings;
    expect(warned(standingWarnings, feet)).toBe(false);
    expect(warned(standingWarnings, /bottom edge is opaque/)).toBe(false);

    // A bust's torso on a square canvas is meant to run off its bottom.
    const bust = tmpDir();
    await writeLayer(bust, "body.png", (set) =>
      rect(set, 60, 100, 80, 100, DARK),
    );
    const bustWarnings = (await measureOk(bust)).warnings;
    expect(warned(bustWarnings, /^body: its bottom row/)).toBe(false);
    expect(warned(bustWarnings, /bottom edge is opaque/)).toBe(false);
  });

  it("ignores every preview*.png", async () => {
    const dir = tmpDir();
    await writeEyeStack(dir);
    // Would trip the edge check if it were measured as a role.
    await writeLayer(dir, "preview-bust.png", (set) =>
      rect(set, 10, 10, 120, 120, DARK),
    );

    const result = await measureOk(dir);
    expect(Object.keys(result.layers).sort()).toEqual([
      "eye_L",
      "iris_L",
      "lash_L",
    ]);
    expect(warned(result.warnings, /preview/)).toBe(false);
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

describe("arms", () => {
  // A full body's canvas, and a torso whose edges are columns 60 and 140.
  const TALL = { width: CANVAS, height: 600 };
  const torso = (set: SetPixel) => rect(set, 60, 100, 80, 301, DARK);
  /** A hanging arm, `w` px wide and 200 tall from row `top`, its columns
   *  centred on canvas x `cx`: a 30-px arm's r_u is 15, and its shoulder
   *  pivot sits on its run's centre, 15 rows under its top. */
  const armAt =
    (cx: number, top = 100, w = 30, h = 200) =>
    (set: SetPixel) =>
      rect(set, cx - w / 2, top, w, h, DARK);

  /** armWarnings' own checks: a rect arm's straight sides trip the generic
   *  edge check besides. */
  const armChecks = (warnings: string[], arm: string) =>
    warnings.filter(
      (w) => w.startsWith(`${arm}: `) && !/edge is opaque/.test(w),
    );

  async function bodyWith(
    arms: Record<string, (set: SetPixel) => void>,
  ): Promise<string> {
    const dir = tmpDir();
    await writeLayer(dir, "body.png", torso, TALL);
    for (const [arm, paint] of Object.entries(arms))
      await writeLayer(dir, `${arm}.png`, paint, TALL);
    return dir;
  }

  it("passes a cap centred on the torso's edge", async () => {
    const dir = await bodyWith({ arm_R: armAt(60) });
    expect(armChecks((await measureOk(dir)).warnings, "arm_R")).toEqual([]);
  });

  it("warns of a cap moved 10 px off the torso, with the px to move", async () => {
    const dir = await bodyWith({ arm_R: armAt(50) });
    const warnings = armChecks((await measureOk(dir)).warnings, "arm_R");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^arm_R: its shoulder cap reaches 5 px under the torso's edge on its pivot row \(y=115\), under half its radius \(7\.5 px\) .* Move layout\.arm_R\.cx 3 px toward the body \(free\)\.$/,
    );
  });

  it("reads arm_L on the torso's right edge", async () => {
    const onEdge = await bodyWith({ arm_L: armAt(140) });
    expect(armChecks((await measureOk(onEdge)).warnings, "arm_L")).toEqual([]);

    // 10 px outward is +x on this side.
    const off = await bodyWith({ arm_L: armAt(150) });
    expect(armChecks((await measureOk(off)).warnings, "arm_L")).toEqual([
      expect.stringMatching(
        /^arm_L: its shoulder cap reaches 5 px under .* Move layout\.arm_L\.cx 3 px toward the body/,
      ),
    ]);
  });

  it("warns of an arm whose pivot row has no torso", async () => {
    const dir = await bodyWith({ arm_R: armAt(60, 20) });
    expect(armChecks((await measureOk(dir)).warnings, "arm_R")).toEqual([
      "arm_R: the body has no paint on its shoulder pivot's row (y=35) — the torso shows a gap " +
        "beside the shoulder once the arm raises. Retune layout.arm_R.cy onto the shoulder (free).",
    ]);
  });

  it("warns of an arm without a body, and of one too short to rig", async () => {
    const bodiless = tmpDir();
    await writeLayer(bodiless, "arm_R.png", armAt(60), TALL);
    expect(armChecks((await measureOk(bodiless)).warnings, "arm_R")).toEqual([
      "arm_R: no body layer — an arm hangs from the body's shoulder, and auto_rig_from_layers refuses it.",
    ]);

    // Wider than tall: the elbow would land above the shoulder.
    const squat = await bodyWith({ arm_R: armAt(60, 100, 60, 20) });
    expect(armChecks((await measureOk(squat)).warnings, "arm_R")).toEqual([
      expect.stringMatching(
        /^arm_R: auto-rig: layer "arm_R\.png": the arm is too short .* — auto_rig_from_layers refuses it\. Regenerate arm\.png drawn hanging, shoulder at the top\. Billed\.$/,
      ),
    ]);
  });

  it("warns of an arm on a canvas of another size than the body's, and checks it no further", async () => {
    // 300x400 holds as many px as the body's 200x600, so a length check
    // alone would read it with the wrong stride.
    const dir = await bodyWith({});
    await writeLayer(dir, "arm_R.png", armAt(50), {
      width: 300,
      height: 400,
    });

    const result = await measureLayers({ layersDir: dir });
    expect(result.ok).toBe(true);
    expect(armChecks(result.ok ? result.warnings : [], "arm_R")).toEqual([
      "arm_R: its canvas 300x400 differs from body's 200x600 — auto_rig_from_layers refuses " +
        "layers of different sizes; recompose them together.",
    ]);
  });

  it("words a cut arm's seam as the arm raising", async () => {
    const dir = tmpDir();
    // Wide enough for the 40 px edge run.
    await writeLayer(dir, "arm_R.png", armAt(60, 100, 60), TALL);
    // A block cut flat under a thin strand.
    await writeLayer(dir, "arm_L.png", cutShape, TALL);

    const { warnings } = await measureOk(dir);
    const top = warnings.find((w) => /^arm_R: .* top edge is opaque/.test(w));
    expect(top).toMatch(/a straight seam once the arm raises\. Cause:/);
    const cut = warnings.find((w) => /^arm_L: .* straight flat edge/.test(w));
    expect(cut).toMatch(
      /It hides at rest and opens into a seam once the arm raises\./,
    );
    expect(
      warnings.filter(
        (w) => /^arm_/.test(w) && /the head turns|on turn\./.test(w),
      ),
    ).toEqual([]);
  });

  describe("pose forearms", () => {
    /** The hanging arm's elbow row and its last painted row, canvas px. */
    async function armRows(dir: string) {
      const { data } = await sharp(path.join(dir, "arm_R.png"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const layer = createLayerSetMeasurer(TALL).add({
        role: "arm_R",
        fileName: "arm_R.png",
        rgba: data,
      })!;
      const { elbow } = armGeometry(layer, 0);
      return {
        elbow: Math.round(TALL.height / 2 - elbow.y - 0.5),
        last: layer.bbox.y + layer.bbox.h - 1,
      };
    }

    /** A pose forearm `w` wide on columns centred on `cx`, its rounded end
     *  (here a rect's flat one) `w / 2` under the elbow row, reaching `reach`
     *  px above it. */
    const poseAt =
      (elbow: number, reach: number, cx = 60, w = 30) =>
      (set: SetPixel) =>
        rect(set, cx - w / 2, elbow - reach, w, reach + w / 2 + 1, DARK);

    /** The pose checks, less the generic edge ones a rect's sides trip. */
    const poseChecks = (warnings: string[]) =>
      warnings.filter(
        (w) =>
          w.startsWith("forearm_pose_R: ") &&
          !/edge is opaque|straight flat edge/.test(w),
      );

    async function withPose(
      pose: (elbow: number, last: number) => (set: SetPixel) => void,
    ): Promise<string> {
      const dir = await bodyWith({ arm_R: armAt(60) });
      const { elbow, last } = await armRows(dir);
      await writeLayer(dir, "forearm_pose_R.png", pose(elbow, last), TALL);
      return dir;
    }

    it("passes a pose forearm standing on the arm's elbow", async () => {
      const dir = await withPose((e, last) => poseAt(e, last - e));
      expect(poseChecks((await measureOk(dir)).warnings)).toEqual([]);
    });

    it("warns of a pivot 10 px to the side, with the cx and cy to set", async () => {
      const dir = await withPose((e, last) => poseAt(e, last - e, 70));
      const warnings = poseChecks((await measureOk(dir)).warnings);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /^forearm_pose_R: its elbow end is 10 px off arm_R's elbow .* Remove layout\.forearm_pose_R\.cx\/cy .* or set layout\.forearm_pose_R\.cx to 60 and layout\.forearm_pose_R\.cy to \d+ \(free\)\.$/,
      );
    });

    it("warns of an elbow end 20 % wider, with the w to set", async () => {
      const dir = await withPose((e, last) => poseAt(e, last - e, 60, 36));
      const warnings = poseChecks((await measureOk(dir)).warnings);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /^forearm_pose_R: its elbow end is 36 px wide, 20% off arm_R's elbow run \(30 px\) .* Set layout\.forearm_pose_R\.w to 30 \(free\)\.$/,
      );
    });

    it("warns of a pose forearm twice as tall as a regeneration", async () => {
      const dir = await withPose((e, last) => poseAt(e, 2 * (last - e)));
      const warnings = poseChecks((await measureOk(dir)).warnings);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /^forearm_pose_R: its length from the elbow end to the hand is [\d.]+ px against arm_R's [\d.]+ px .* Regenerate forearm_pose\.png .* Billed\.$/,
      );
    });

    it("names one free w for a pose forearm uniformly too big", async () => {
      const dir = await withPose((e, last) =>
        poseAt(e, Math.round(1.2 * (last - e)), 60, 36),
      );
      const warnings = poseChecks((await measureOk(dir)).warnings);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(
        /Set layout\.forearm_pose_R\.w to 30 \(free\)\.$/,
      );
      expect(warnings[1]).toMatch(
        /Set layout\.forearm_pose_R\.w to 30 \(free\), which fixes the width too\.$/,
      );
      expect(warnings.join("\n")).not.toMatch(/Billed/);
    });

    it("reports, rather than throws, for a body on another canvas height", async () => {
      const dir = await withPose((e, last) => poseAt(e, last - e));
      await writeLayer(dir, "body.png", torso, { width: CANVAS, height: 700 });
      const result = await measureLayers({ layersDir: dir });
      expect(result.ok).toBe(true);
    });

    it("warns of a pose forearm without its arm", async () => {
      const dir = await bodyWith({});
      await writeLayer(dir, "forearm_pose_R.png", poseAt(200, 100), TALL);
      expect(poseChecks((await measureOk(dir)).warnings)).toEqual([
        "forearm_pose_R: no arm_R layer — a pose forearm hangs from its arm's elbow, and auto_rig_from_layers refuses it.",
      ]);
    });

    it("words a cut pose forearm's seam as the arm raising", async () => {
      const dir = tmpDir();
      await writeLayer(dir, "forearm_pose_R.png", armAt(60, 100, 60), TALL);
      const top = (await measureOk(dir)).warnings.find((w) =>
        /^forearm_pose_R: .* top edge is opaque/.test(w),
      );
      expect(top).toMatch(/a straight seam once the arm raises\. Cause:/);
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
