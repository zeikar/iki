import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  characterLandmarks,
  EYE,
  PINK_ON_PEACH,
} from "./helpers/illustration-character";
import {
  removeCutDirs,
  picture,
  cut,
  check,
  CUT_HOOK_TIMEOUT,
} from "./helpers/illustration-cut";

afterAll(removeCutDirs);
// A test here may cut several times; a CI runner takes a few seconds a cut.
vi.setConfig({ testTimeout: CUT_HOOK_TIMEOUT });

// Its second half is in illustration-cut.checks-pockets-parts.test.ts: the
// two halves together outlast every other file, so they run apart.
describe("cutLayersFromIllustration checks", () => {
  let pink: string;
  beforeAll(async () => {
    pink = await picture(PINK_ON_PEACH);
  });

  it("fails seeds on a skin seed placed on hair, naming its path", async () => {
    const lm = characterLandmarks();
    lm.skinSeeds.push([550, 230]);
    const seeds = check(await cut(pink, lm), "seeds");
    expect(seeds.pass).toBe(false);
    expect(seeds.value).toBe(1);
    expect(seeds.hint).toMatch(
      /^landmarks\.skinSeeds\[5\] \[550, 230\] reads as hair: move it/,
    );
  });

  it("fails seeds on a hair sample on the hair's outline, judged by the other samples", async () => {
    const lm = characterLandmarks();
    lm.samples.hair.base.push([550, 127]);
    const seeds = check(await cut(pink, lm), "seeds");
    expect(seeds.pass).toBe(false);
    expect(seeds.hint).toContain(
      "landmarks.samples.hair.base[2] [550, 127] reads as neither to the other samples",
    );
  });

  it("says which tones it could not judge, one point each", async () => {
    const seeds = check(await cut(pink), "seeds");
    expect(seeds.pass).toBe(true);
    expect(seeds.hint).toMatch(
      /not judged against the rest \(one point each\): landmarks\.samples\.hair\.shadow, landmarks\.samples\.hair\.highlight, landmarks\.samples\.skin\.shadow$/,
    );
  });

  it("fails seeds on a sample on the backdrop and a body seed on hair", async () => {
    const lm = characterLandmarks();
    lm.samples.skin.shadow.push([20, 20]);
    lm.bodySeeds.push([200, 600]);
    const seeds = check(await cut(pink, lm), "seeds");
    expect(seeds.value).toBe(2);
    expect(seeds.hint).toContain(
      "landmarks.bodySeeds[2] [200, 600] reads as hair",
    );
    expect(seeds.hint).toContain(
      "landmarks.samples.skin.shadow[1] [20, 20] is on the backdrop",
    );
  });

  it("fails frontHairWidth on a front-hair polygon wider than the face", async () => {
    const lm = characterLandmarks();
    lm.frontHair = [
      [250, 100],
      [850, 100],
      [850, 345],
      [250, 345],
    ];
    const width = check(await cut(pink, lm), "frontHairWidth");
    expect(width.pass).toBe(false);
    expect(width.value).toBeGreaterThan(1);
    expect(width.hint).toMatch(
      /the head turn will be clamped; narrow landmarks\.frontHair to the face/,
    );
  });

  it("reports every fill region as a warning, the made-up-by-construction ones without a limit", async () => {
    const r = await cut(pink);
    expect(r.checks.map((c) => c.id)).toEqual([
      "stack",
      "seeds",
      "opening.L",
      "eye.L",
      "iris.L",
      "opening.R",
      "eye.R",
      "iris.R",
      "brow.L",
      "browBand.L",
      "brow.R",
      "browBand.R",
      "mouth",
      "fills.face.features",
      "fills.face.forehead",
      "fills.hair_back.shell",
      "fills.custom.tail_R.root",
      "fills.custom.tail_L.root",
      "fills.hair_back.underBody",
      "fills.custom.tail_R.underBody",
      "fills.custom.tail_L.underBody",
      "fills.body.neck",
      "fills.hair_front.strands",
      "frontHairWidth",
      "pockets",
    ]);
    for (const c of r.checks.filter((c) => c.id.startsWith("fills."))) {
      expect(c.level, c.id).toBe("warn");
    }
    expect(check(r, "fills.custom.tail_R.root")).toMatchObject({
      pass: true,
      limit: 0.25,
    });
    for (const id of [
      "fills.face.features",
      "fills.hair_back.shell",
      "fills.body.neck",
    ]) {
      expect(check(r, id)).toMatchObject({ pass: true, limit: null });
      expect(check(r, id).hint).toMatch(/by construction/);
    }
    // Under the whole cap, the forehead's skin is mostly made up: a warning
    // naming the landmark, which does not fail the cut.
    const forehead = check(r, "fills.face.forehead");
    expect(forehead.pass).toBe(false);
    expect(forehead.hint).toMatch(/landmarks\.skull/);
    expect(r.passed).toBe(true);
  });

  it("passes each eye's opening and iris on landmarks on the drawing", async () => {
    const r = await cut(pink);
    for (const side of ["L", "R"]) {
      expect(check(r, `opening.${side}`)).toMatchObject({
        level: "fail",
        pass: true,
        limit: 1,
      });
      expect(check(r, `iris.${side}`)).toMatchObject({
        level: "warn",
        pass: true,
      });
      expect(check(r, `iris.${side}`).value).toBeGreaterThan(0.8);
    }
  });

  it("fails opening on an eye box that clips the lash, saying how far to grow it", async () => {
    const lm = characterLandmarks();
    lm.eyes.L.box = [592, 414, 668, 466];
    const r = await cut(pink, lm);
    const opening = check(r, "opening.L");
    expect(opening).toMatchObject({ level: "fail", pass: false, value: 0 });
    const grow = opening.hint.match(
      /at its top: move y0 up by (\d+) \(to (\d+)\)/,
    )!;
    expect(grow).not.toBeNull();
    // To above the lash's top row, short of the crease.
    const to = Number(grow[2]);
    expect(to).toBeLessThanOrEqual(EYE.lashOuter.cy - EYE.lashOuter.ry);
    expect(to).toBeGreaterThan(EYE.creaseInner.cy - EYE.creaseInner.ry);
    expect(check(r, "opening.R").pass).toBe(true);
    expect(r.passed).toBe(false);
    // The box it suggests leaves the 2 to 4 px to spare the skill asks for.
    lm.eyes.L.box[1] = to;
    const grown = check(await cut(pink, lm), "opening.L");
    expect(grown.pass).toBe(true);
    expect(grown.value).toBeGreaterThanOrEqual(2);
    expect(grown.value).toBeLessThanOrEqual(4);
  });

  it.each([
    ["left", 0, 610, /move x0 left by \d+ \(to (\d+)\)/],
    ["bottom", 3, 447, /move y1 down by \d+ \(to (\d+)\)/],
  ] as const)(
    "suggests a box that leaves 2 to 4 px to spare past the eye's %s, rim included",
    async (_side, k, clip, move) => {
      const lm = characterLandmarks();
      lm.eyes.L.box[k] = clip;
      const hint = check(await cut(pink, lm), "opening.L").hint.match(move)!;
      expect(hint).not.toBeNull();
      lm.eyes.L.box[k] = Number(hint[1]);
      const grown = check(await cut(pink, lm), "opening.L");
      expect(grown.pass).toBe(true);
      expect(grown.value).toBeGreaterThanOrEqual(2);
      expect(grown.value).toBeLessThanOrEqual(4);
    },
  );

  it("warns that an eye box is loose", async () => {
    const lm = characterLandmarks();
    lm.eyes.L.box = [570, 388, 690, 492];
    const opening = check(await cut(pink, lm), "opening.L");
    expect(opening).toMatchObject({ level: "warn", pass: false, limit: 0.2 });
    expect(opening.hint).toMatch(
      /the eye covers [\d.]+% of landmarks\.eyes\.L\.box/,
    );
  });

  it("fails iris on an ellipse 10 px off the disc, saying which way to move it", async () => {
    const lm = characterLandmarks();
    lm.eyes.L.iris.cx += 10;
    const r = await cut(pink, lm);
    const iris = check(r, "iris.L");
    expect(iris).toMatchObject({ level: "warn", pass: false, limit: 0.7 });
    expect(iris.value).toBeLessThan(0.7);
    const left = iris.hint.match(
      /move landmarks\.eyes\.L\.iris\.cx left by (\d+)/,
    )!;
    expect(Number(left[1])).toBeGreaterThanOrEqual(6);
    expect(check(r, "iris.R").pass).toBe(true);
    expect(r.passed).toBe(true);
  });

  it("reports no face width when the face's flood misses the eye row", async () => {
    const lm = characterLandmarks();
    lm.skinSeeds = [[550, 720]]; // the neck only
    const width = check(await cut(pink, lm), "frontHairWidth");
    expect(width).toMatchObject({ pass: false, value: null });
    expect(width.hint).toMatch(/^no face on the eye row 432/);
  });
});
