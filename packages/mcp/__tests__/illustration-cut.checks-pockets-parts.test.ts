import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import sharp from "sharp";
import { cutLayersFromIllustration } from "../src/illustration-cut";
import {
  BLACK_ON_PEACH,
  characterLandmarks,
  GAP,
  ORNAMENT,
  PINK_ON_PEACH,
  POCKET,
  TORSO_BODY_ONLY,
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
  part,
  pixelsOf,
  coverAt,
  W,
  CUT_HOOK_TIMEOUT,
  off,
} from "./helpers/illustration-cut";

afterAll(removeCutDirs);
// A test here may cut several times; a CI runner takes a few seconds a cut.
vi.setConfig({ testTimeout: CUT_HOOK_TIMEOUT });

// Its first half is in illustration-cut.checks-seeds-eyes.test.ts: the two
// halves together outlast every other file, so they run apart.
describe("cutLayersFromIllustration checks", () => {
  let pink: string;
  beforeAll(async () => {
    pink = await picture(PINK_ON_PEACH);
  });

  it("keys a gap between strands the torso closes off, with no seed, and says so", async () => {
    const r = await cut(await picture(PINK_ON_PEACH, { gap: true }));
    const pockets = check(r, "pockets");
    expect(pockets.keyed).toHaveLength(1);
    // The region left of the strands, closed in by the back hair, the neck
    // and the torso, is a mix: named, not keyed. The value counts both.
    expect(pockets.value).toBe(2);
    const named = pockets.hint.match(
      /1 region of backdrop-coloured paint the border flood cannot reach, at \[(\d+), \d+\] \(\d+ px\), is cut into a layer: if it is backdrop/,
    )!;
    expect(Number(named[1])).toBeLessThan(672);
    const [x, y] = pockets.keyed![0];
    expect(Math.abs(x - GAP.cx)).toBeLessThan(14);
    // Keyed, so it warns, the keyed points first.
    expect(pockets.pass).toBe(false);
    expect(pockets.hint).toMatch(
      /^keyed 1 gap the hair rings as backdrop on its own, at \[\d+, \d+\]; check each on preview-labels\.png, and if one is paint .* landmarks\.paintSeeds; 1 region of backdrop-coloured paint/,
    );
    expect(r.passed).toBe(true);
    for (const a of await coverAt(r, GAP.cx, GAP.cy)) expect(a).toBe(0);
  });

  it("warns when it keys a pale ornament the hair rings, and lists it", async () => {
    const r = await cut(await picture(PINK_ON_PEACH, { ornament: true }));
    const pockets = check(r, "pockets");
    // What the line is about: one point keyed, none named.
    expect(pockets).toMatchObject({ level: "warn", pass: false, value: 1 });
    expect(pockets.keyed).toHaveLength(1);
    const [x, y] = pockets.keyed![0];
    expect(Math.hypot(x - ORNAMENT.cx, y - ORNAMENT.cy)).toBeLessThan(
      ORNAMENT.r,
    );
    expect(pockets.hint).toMatch(
      new RegExp(
        `^keyed 1 gap the hair rings as backdrop on its own, at \\[${x}, ${y}\\]`,
      ),
    );
  });

  it("leaves a hair-rung pocket holding a paint seed painted, and names it", async () => {
    const lm = characterLandmarks();
    lm.paintSeeds = [[GAP.cx, GAP.cy]];
    const r = await cut(await picture(PINK_ON_PEACH, { gap: true }), lm);
    const pockets = check(r, "pockets");
    expect(pockets).toMatchObject({ pass: false, value: 2, keyed: [] });
    expect(Math.max(...(await coverAt(r, GAP.cx, GAP.cy)))).toBe(255);
  });

  it("names for backgroundSeeds only points a cut then accepts, and calls a pale texture near the backdrop's colour paint", async () => {
    // The pocket filled with a fine checker of the backdrop and a paint 50
    // from it, on a picture twice the canvas: the resize averages it to 25
    // from the backdrop, under the seed's limit of 32, but every picture
    // pixel a seed reads is the paint.
    const colours = PINK_ON_PEACH;
    const drawn = await picture(colours, { pocket: true });
    const { data, info } = await sharp(drawn)
      .resize(2 * W, 2 * W, { kernel: "nearest" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const back = colours.backdrop;
    const paint = back.map((v) => v - 29);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (Math.hypot(x - 2 * POCKET.cx, y - 2 * POCKET.cy) > 2 * POCKET.r) {
          continue;
        }
        const i = (y * info.width + x) * 3;
        if ((x + y) % 2 !== 0 || off(data.subarray(i, i + 3), back) !== 0) {
          continue;
        }
        data.set(paint, i);
      }
    }
    const file = path.join(tmpDir(), "textured.png");
    await sharp(data, { raw: { ...info, channels: 3 } })
      .png()
      .toFile(file);

    const pockets = check(await cut(file), "pockets");
    const pale = pockets.hint.match(
      /1 region near the backdrop's colour, at \[(\d+), (\d+)\] \(\d+ px\), is pale paint, not backdrop .*: it needs nothing/,
    )!;
    expect(
      Math.hypot(Number(pale[1]) - POCKET.cx, Number(pale[2]) - POCKET.cy),
    ).toBeLessThan(POCKET.r);
    const seeds = pockets.hint
      .split("; ")
      .filter((part) => part.endsWith("landmarks.backgroundSeeds"))
      .flatMap((part) => [...part.matchAll(/\[(\d+), (\d+)\] \(\d+ px\)/g)])
      .map((m) => [Number(m[1]), Number(m[2])]);
    for (const seed of seeds) {
      const lm = characterLandmarks();
      lm.backgroundSeeds = [seed];
      const r = await cutLayersFromIllustration({
        imagePath: file,
        landmarks: lm,
        outputDir: outDir(),
      });
      expect(r.ok, `${seed}: ${r.ok ? "" : r.error}`).toBe(true);
    }
  });

  it("names a pocket of enclosed backdrop the cloth rings, without keying it, which its seed then keys", async () => {
    const file = await picture(PINK_ON_PEACH, { pocket: true });
    const pockets = check(await cut(file), "pockets");
    expect(pockets).toMatchObject({
      level: "warn",
      pass: false,
      value: 1,
      keyed: [],
    });
    const at = pockets.hint.match(/\[(\d+), (\d+)\] \(\d+ px\)/)!;
    const seed = [Number(at[1]), Number(at[2])];
    expect(Math.hypot(seed[0] - POCKET.cx, seed[1] - POCKET.cy)).toBeLessThan(
      POCKET.r,
    );
    const lm = characterLandmarks();
    lm.backgroundSeeds = [seed];
    const r = await cut(file, lm);
    expect(check(r, "pockets").pass).toBe(true);
    const body = await pixelsOf(layer(r, "body").path);
    expect(body.at(POCKET.cx, POCKET.cy)[3]).toBe(0);
  });

  it("gives the face hair it and the front hair close in", async () => {
    // A notch in the polygon's lower edge leaves the middle teeth's tips
    // outside it, closed in by the forehead and the rest of the fringe.
    const lm = characterLandmarks();
    lm.frontHair.push([700, 345], [700, 320], [400, 320], [400, 345]);
    const r = await cut(pink, lm);
    const tip = [467, 330] as const; // the third tooth's tip
    // In the face as drawn, the hair's own colour (the back hair holds only
    // its shell fill there, under the face).
    const onFace = (await pixelsOf(layer(r, "face").path)).at(...tip);
    expect(onFace[3]).toBe(255);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(onFace[c] - PINK_ON_PEACH.hair[c])).toBeLessThan(12);
    }
  });

  it("gives paint inside a bodyOnly polygon to the body, even where the body's flood cannot reach", async () => {
    const lm = characterLandmarks();
    lm.bodyOnly = [
      [
        [170, 580],
        [230, 580],
        [230, 640],
        [170, 640],
      ],
    ];
    const r = await cut(pink, lm);
    expect((await pixelsOf(layer(r, "body").path)).at(200, 610)[3]).toBe(255);
    expect((await pixelsOf(part(r, "tail_R").path)).at(200, 610)[3]).toBe(0);
  });

  it("takes the ribbon inside ribbonBox with the part when it lies on the head's side of the line", async () => {
    const lm = characterLandmarks();
    lm.customParts[0].line = [
      [228, 200],
      [228, 330],
      [262, 500],
    ];
    const knot = [262, 280] as const;
    const withBox = await cut(pink, lm);
    expect((await pixelsOf(part(withBox, "tail_R").path)).at(...knot)[3]).toBe(
      255,
    );
    delete lm.customParts[0].ribbonBox;
    const without = await cut(pink, lm);
    expect((await pixelsOf(part(without, "tail_R").path)).at(...knot)[3]).toBe(
      0,
    );
    expect(
      (await pixelsOf(layer(without, "hair_back").path)).at(...knot)[3],
    ).toBe(255);
  });

  it("cuts a side: right part, and under its line's last point by the below column", async () => {
    const lm = characterLandmarks();
    lm.customParts[1] = {
      id: "tail_L",
      tie: [838, 280],
      side: "right",
      line: [
        [810, 200],
        [816, 330],
        [830, 500],
      ],
      below: 838,
    };
    const r = await cut(pink, lm);
    const tail = await pixelsOf(part(r, "tail_L").path);
    expect(tail.at(900, 600)[3]).toBe(255);
    expect(tail.at(900, 750)[3]).toBe(255);
    // The back hair at x 765 under the line's end: left of `below`, kept.
    const back = await pixelsOf(layer(r, "hair_back").path);
    expect(back.at(765, 600)[3]).toBe(255);
    lm.customParts[1].below = 760;
    const wider = await cut(pink, lm);
    expect((await pixelsOf(part(wider, "tail_L").path)).at(765, 600)[3]).toBe(
      255,
    );
  });

  it("stacks a picture with real transparency back into it", async () => {
    const r = await cut(await picture(PINK_ON_PEACH, { transparent: true }));
    expect(check(r, "stack").pass).toBe(true);
  });

  it("cuts a dark torso under near-black hair into the hair without bodyOnly, into the body with it", async () => {
    const black = await picture(BLACK_ON_PEACH);
    const torso = async (r: Ok) => ({
      body: (await pixelsOf(layer(r, "body").path)).at(550, 950)[3],
      back: (await pixelsOf(layer(r, "hair_back").path)).at(550, 950)[3],
    });
    expect(await torso(await cut(black))).toEqual({ body: 0, back: 255 });

    const lm = characterLandmarks();
    lm.bodyOnly = [TORSO_BODY_ONLY];
    const r = await cut(black, lm);
    expect(await torso(r)).toEqual({ body: 255, back: 0 });
    for (const file of [
      layer(r, "hair_front").path,
      ...r.customParts.map((p) => p.path),
    ]) {
      expect((await pixelsOf(file)).at(550, 950)[3]).toBe(0);
    }
  });
});
