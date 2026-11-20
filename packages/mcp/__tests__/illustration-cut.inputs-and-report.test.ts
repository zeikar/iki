import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  cutLayersFromIllustration,
  formatCutReport,
} from "../src/illustration-cut";
import {
  characterLandmarks,
  PINK_ON_PEACH,
} from "./helpers/illustration-character";
import {
  outDir,
  tmpDir,
  removeCutDirs,
  type Ok,
  picture,
  cut,
  check,
  layer,
  pixelsOf,
  CUT_HOOK_TIMEOUT,
  off,
  NEAR,
} from "./helpers/illustration-cut";
import { writeInterior, writeKeyedMouth } from "./helpers/parts";

afterAll(removeCutDirs);
// A test here may cut several times; a CI runner takes a few seconds a cut.
vi.setConfig({ testTimeout: CUT_HOOK_TIMEOUT });

describe("cutLayersFromIllustration with a lip set", () => {
  let pink: string;
  let lipDir: string;
  const lipInputs = () => ({
    mouthKeyed: path.join(lipDir, "mouth_keyed.png"),
    mouthInterior: path.join(lipDir, "mouth_interior.png"),
  });
  async function cutWithLips(
    landmarks: Record<string, any>,
    outputDir = outDir(),
  ): Promise<Ok> {
    const r = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks,
      outputDir,
      ...lipInputs(),
    });
    if (!r.ok) throw new Error(r.error);
    return r;
  }
  /** Corners a little wider than the drawn mouth's, so the set's 3 px
   *  outline stays a closed line at the size it lands at. */
  const WIDE_MOUTH = {
    box: [480, 540, 620, 580],
    cornerL: [490, 561],
    cornerR: [610, 561],
  };
  beforeAll(async () => {
    pink = await picture(PINK_ON_PEACH);
    lipDir = tmpDir();
    await writeKeyedMouth(lipDir);
    await writeInterior(lipDir);
  });

  /** A layer's first and last painted columns, and each one's
   *  alpha-weighted mean row (a pixel's centre at +0.5). */
  async function ends(file: string) {
    const { data, info } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const column = (x: number) => {
      let sum = 0;
      let weight = 0;
      for (let y = 0; y < info.height; y++) {
        const a = data[(y * info.width + x) * 4 + 3];
        sum += a * (y + 0.5);
        weight += a;
      }
      return weight > 0 ? sum / weight : null;
    };
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < info.width; x++) {
      if (column(x) === null) continue;
      if (x0 < 0) x0 = x;
      x1 = x;
    }
    return { x0, x1, y0: column(x0)!, y1: column(x1)! };
  }

  it("lands the lip set's own corners on the drawn corners, with no mouth beside it", async () => {
    const lm = characterLandmarks();
    lm.mouth = WIDE_MOUTH;
    const r = await cutWithLips(lm);
    const roles = r.layers.map((l) => l.role);
    expect(roles).not.toContain("mouth");
    // In the rig's order, the interior's teeth and tongue with them.
    expect(roles.slice(roles.indexOf("nose"), roles.indexOf("eye_L"))).toEqual([
      "nose",
      "mouth_inner",
      "mouth_tongue",
      "mouth_teeth",
      "lip_lower",
      "lip_upper",
    ]);
    const upper = await ends(layer(r, "lip_upper").path);
    expect(Math.abs(upper.x0 - 490)).toBeLessThanOrEqual(1);
    expect(Math.abs(upper.x1 - 610)).toBeLessThanOrEqual(1);
    expect(Math.abs(upper.y0 - 561.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(upper.y1 - 561.5)).toBeLessThanOrEqual(1);
    expect(check(r, "mouth")).toMatchObject({ level: "fail", pass: true });
    expect(check(r, "mouth").hint).toMatch(
      /lifted off the face under the lip set/,
    );
    expect(r.passed).toBe(true);
    expect(r.measure.lips).toBeDefined();
  });

  it("lifts the drawn mouth off the face and counts its box apart in the stack", async () => {
    const plain = await cut(pink);
    const lm = characterLandmarks();
    lm.mouth = WIDE_MOUTH;
    const r = await cutWithLips(lm);
    // Where the plain cut lifts the drawn mouth, the lip set's face is skin.
    const face = await pixelsOf(layer(r, "face").path);
    const mouth = await pixelsOf(layer(plain, "mouth").path);
    const [x0, y0, x1, y1] = layer(plain, "mouth").box!;
    let looked = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (mouth.at(x, y)[3] === 0 || face.at(x, y)[3] === 0) continue;
        expect(
          off(face.at(x, y), PINK_ON_PEACH.skin),
          `${x},${y}`,
        ).toBeLessThan(NEAR);
        looked++;
      }
    }
    expect(looked).toBeGreaterThan(50);
    expect(check(r, "stack").value).toBeLessThan(0.003);
    expect(check(r, "stack").apart!.mouthBox).toBeGreaterThan(0);
  });

  it("passes mouth with a lip set over a mouth box with nothing drawn in it", async () => {
    const lm = characterLandmarks();
    lm.mouth = {
      box: [480, 600, 620, 640],
      cornerL: [490, 620],
      cornerR: [610, 620],
    };
    const r = await cutWithLips(lm);
    expect(check(r, "mouth")).toMatchObject({
      level: "fail",
      pass: true,
      value: 0,
    });
    expect(check(r, "mouth").hint).toMatch(/the lip set stands for the mouth/);
    expect(r.layers.map((l) => l.role)).toContain("lip_upper");
    expect(r.passed).toBe(true);
  });

  const refuseLips = async (mouth: Record<string, any>, message: RegExp) => {
    const lm = characterLandmarks();
    lm.mouth = mouth;
    const dir = outDir();
    const r = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks: lm,
      outputDir: dir,
      ...lipInputs(),
    });
    expect(r.ok).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    return r.ok ? "" : (r.error.match(message) ?? [r.error]);
  };

  it("refuses a lip set that would run off the canvas, naming the corners", async () => {
    const [match] = await refuseLips(
      {
        box: [480, 1080, 620, 1099],
        cornerL: [490, 1095],
        cornerR: [610, 1095],
      },
      /^landmarks\.mouth\.cornerL\/cornerR place the lip set, \d+x\d+ px, at \(\d+, \d+\), past the 1100x1100 canvas/,
    );
    expect(match).toMatch(/^landmarks\.mouth\.cornerL\/cornerR place/);
  });

  it("refuses corners too close for the set's outline, naming the least distance, which then cuts", async () => {
    const found = await refuseLips(
      { box: [480, 540, 620, 580], cornerL: [540, 561], cornerR: [552, 561] },
      /^landmarks\.mouth\.cornerL\/cornerR are 12 px apart, too close for the lip set: .* It cuts from (\d+) px apart/,
    );
    expect(found[0]).toMatch(
      /^landmarks\.mouth\.cornerL\/cornerR are 12 px apart/,
    );
    expect(found[0]).not.toMatch(/regenerate/);
    const least = Number(found[1]);
    expect(least).toBeGreaterThan(12);
    expect(least).toBeLessThan(118);
    const lm = characterLandmarks();
    const x0 = 550 - Math.floor(least / 2);
    lm.mouth = {
      box: [480, 540, 620, 580],
      cornerL: [x0, 561],
      cornerR: [x0 + least, 561],
    };
    const r = await cutWithLips(lm);
    expect(r.layers.map((l) => l.role)).toContain("lip_upper");
  });

  it("removes an earlier cut's drawn mouth from the dir, and the lip set after it", async () => {
    const dir = outDir();
    const lm = characterLandmarks();
    lm.mouth = WIDE_MOUTH;
    const first = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks: lm,
      outputDir: dir,
    });
    expect(first.ok && fs.existsSync(path.join(dir, "mouth.png"))).toBe(true);
    await cutWithLips(lm, dir);
    expect(fs.existsSync(path.join(dir, "mouth.png"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "lip_upper.png"))).toBe(true);
    const again = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks: lm,
      outputDir: dir,
    });
    expect(again.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "lip_upper.png"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "mouth.png"))).toBe(true);
  });

  it("removes no earlier role when a write fails part-way, and says the dir is a mix", async () => {
    const dir = outDir();
    const lm = characterLandmarks();
    lm.mouth = WIDE_MOUTH;
    const first = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks: lm,
      outputDir: dir,
    });
    expect(first.ok).toBe(true);
    // A directory where the first layer goes: its write fails.
    fs.rmSync(path.join(dir, "hair_back.png"));
    fs.mkdirSync(path.join(dir, "hair_back.png"));
    const r = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks: lm,
      outputDir: dir,
      ...lipInputs(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(
        /^write: .*the cut stopped part-way: .* the dir is a mix of the two until the cut is run again$/,
      );
    }
    expect(fs.existsSync(path.join(dir, "mouth.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "lip_upper.png"))).toBe(false);
  });
});

describe("cutLayersFromIllustration refusals", () => {
  let pink: string;
  beforeAll(async () => {
    pink = await picture(PINK_ON_PEACH);
  });

  const refuse = async (
    input: Partial<Parameters<typeof cutLayersFromIllustration>[0]>,
    message: RegExp,
  ) => {
    const dir = outDir();
    const r = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks: characterLandmarks(),
      outputDir: dir,
      ...input,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
    expect(fs.readdirSync(dir)).toEqual([]);
  };

  it("refuses bad landmarks with their path, writing nothing", async () => {
    const lm = characterLandmarks();
    lm.eyes.L.iris.rx = -1;
    await refuse(
      { landmarks: lm },
      /^landmarks\.eyes\.L\.iris\.rx must be a positive number/,
    );
  });

  it("refuses a hair sample set with none on paint", async () => {
    const lm = characterLandmarks();
    lm.samples.hair = { base: [[10, 10]] };
    await refuse(
      { landmarks: lm },
      /^landmarks\.samples\.hair: no sample is on paint/,
    );
  });

  it("refuses one of the lip set's inputs without the other", async () => {
    await refuse(
      { mouthKeyed: "keyed.png" },
      /^mouthKeyed needs mouthInterior/,
    );
    await refuse(
      { mouthInterior: "interior.png" },
      /^mouthInterior needs mouthKeyed/,
    );
  });

  it("refuses a lip set whose key fails, writing nothing", async () => {
    const dir = tmpDir();
    await writeKeyedMouth(dir, { noGreen: true });
    await writeInterior(dir);
    await refuse(
      {
        mouthKeyed: path.join(dir, "mouth_keyed.png"),
        mouthInterior: path.join(dir, "mouth_interior.png"),
      },
      /no green opening/,
    );
  });

  it("refuses a missing picture and an output dir outside the working directory", async () => {
    await refuse(
      { imagePath: path.join(tmpDir(), "none.png") },
      /picture file not found/,
    );
    const r = await cutLayersFromIllustration({
      imagePath: pink,
      landmarks: characterLandmarks(),
      outputDir: tmpDir(),
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/escapes the working directory/);
  });
});

describe("formatCutReport", () => {
  const base: Ok = {
    ok: true,
    outputDir: "/out",
    canvas: { width: 1100, height: 1100 },
    layers: [{ role: "face", path: "/out/face.png", box: null, pixels: 0 }],
    customParts: [
      {
        id: "tail",
        path: "/out/custom/tail.png",
        box: null,
        pixels: 0,
        tie: [1, 2],
      },
    ],
    previews: {
      labels: "/out/preview-labels.png",
      landmarks: "/out/preview-landmarks.png",
    },
    checks: [
      {
        id: "stack",
        level: "fail",
        pass: false,
        value: 0.01,
        limit: 0.003,
        hint: "off",
        apart: { mouthBox: 0.5 },
      },
      {
        id: "fills.body.neck",
        level: "warn",
        pass: true,
        value: 0.2,
        limit: null,
        hint: "made up",
      },
      {
        id: "frontHairWidth",
        level: "warn",
        pass: false,
        value: null,
        limit: 1,
        hint: "no face",
      },
      {
        id: "seeds",
        level: "fail",
        pass: false,
        value: 2,
        limit: 0,
        hint: "two",
      },
    ],
    measure: { warnings: ["nose: missing"] },
    passed: false,
  };

  it("prints the files, a CHECK line per check, the MEASURE lines and the failed fail-level ids last", () => {
    expect(formatCutReport(base).split("\n")).toEqual([
      "/out/face.png",
      "/out/custom/tail.png",
      "/out/preview-labels.png",
      "/out/preview-landmarks.png",
      "CHECK stack: FAIL 0.01 (limit 0.003) off; the mouth's box, counted apart: 50.00% of it off",
      "CHECK fills.body.neck: pass 0.2 (limit none) made up",
      "CHECK frontHairWidth: WARN none (limit 1) no face",
      "CHECK seeds: FAIL 2 (limit 0) two",
      "MEASURE: nose: missing",
      "CUT FAIL: stack, seeds",
    ]);
  });

  it("says when the measure found nothing, and ends CUT pass when only warnings fail", () => {
    const lines = formatCutReport({
      ...base,
      checks: [base.checks[2]],
      measure: { warnings: [] },
      passed: true,
    }).split("\n");
    expect(lines.slice(-2)).toEqual([
      "MEASURE: all geometry checks passed",
      "CUT pass",
    ]);
  });
});
