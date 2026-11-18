import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fillHoles } from "../src/illustration";
import {
  cutLayersFromIllustration,
  type CutLayersFromIllustrationResult,
} from "../src/illustration-cut";
import {
  BLACK_ON_PEACH,
  characterLandmarks,
  ORANGE_ON_WARM,
  GAP,
  ORNAMENT,
  PINK_ON_PEACH,
  POCKET,
  TORSO_BODY_ONLY,
  WISP,
  writeCharacter,
  type CharacterColours,
} from "./helpers/illustration-character";

const createdDirs: string[] = [];
/** Outputs must lie under the working directory. */
function outDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-cut-"),
  );
  createdDirs.push(d);
  return d;
}
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-cut-"));
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

type Ok = Extract<CutLayersFromIllustrationResult, { ok: true }>;

async function picture(
  colours: CharacterColours,
  options?: {
    transparent?: boolean;
    pocket?: boolean;
    gap?: boolean;
    ornament?: boolean;
  },
): Promise<string> {
  const file = path.join(tmpDir(), "character.png");
  await writeCharacter(file, colours, options);
  return file;
}

async function cut(
  imagePath: string,
  landmarks: Record<string, any> = characterLandmarks(),
): Promise<Ok> {
  const r = await cutLayersFromIllustration({
    imagePath,
    landmarks,
    outputDir: outDir(),
  });
  if (!r.ok) throw new Error(r.error);
  return r;
}

const check = (r: Ok, id: string) => r.checks.find((c) => c.id === id)!;
const layer = (r: Ok, role: string) => r.layers.find((l) => l.role === role)!;
const part = (r: Ok, id: string) => r.customParts.find((p) => p.id === id)!;

/** A written PNG's RGBA at (x, y). */
async function pixelsOf(file: string) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    info,
    at: (x: number, y: number) => {
      const i = (y * info.width + x) * 4;
      return [...data.subarray(i, i + 4)];
    },
  };
}

/** Every written layer's alpha at (x, y). */
async function coverAt(r: Ok, x: number, y: number): Promise<number[]> {
  const files = [
    ...r.layers.map((l) => l.path),
    ...r.customParts.map((p) => p.path),
  ];
  return Promise.all(files.map(async (f) => (await pixelsOf(f)).at(x, y)[3]));
}

/** The written layers' RGBA, in draw order (custom parts after the back
 *  hair). */
async function stackOf(r: Ok): Promise<Buffer[]> {
  const files = [
    layer(r, "hair_back").path,
    ...r.customParts.map((p) => p.path),
    layer(r, "body").path,
    layer(r, "face").path,
    layer(r, "hair_front").path,
  ];
  return Promise.all(files.map((f) => sharp(f).ensureAlpha().raw().toBuffer()));
}

const COLOURINGS: [string, CharacterColours, boolean][] = [
  ["pink hair on peach skin", PINK_ON_PEACH, false],
  ["orange hair on warm skin", ORANGE_ON_WARM, false],
  [
    "near-black hair over a dark torso, a bodyOnly polygon on it",
    BLACK_ON_PEACH,
    true,
  ],
];

describe.each(COLOURINGS)("cutting %s", (_name, colours, bodyOnly) => {
  let r: Ok;
  let pictureFile: Promise<string>;
  beforeAll(async () => {
    const lm = characterLandmarks();
    if (bodyOnly) lm.bodyOnly = [TORSO_BODY_ONLY];
    pictureFile = picture(colours);
    r = await cut(await pictureFile, lm);
  });

  it("stacks back into the picture, every seed and sample on its paint, and passes", () => {
    expect(check(r, "stack")).toMatchObject({
      level: "fail",
      pass: true,
      limit: 0.003,
    });
    expect(check(r, "stack").value).toBeLessThan(0.003);
    expect(check(r, "seeds")).toMatchObject({
      level: "fail",
      pass: true,
      value: 0,
    });
    expect(check(r, "frontHairWidth")).toMatchObject({
      level: "warn",
      pass: true,
    });
    expect(check(r, "pockets")).toMatchObject({ level: "warn", pass: true });
    expect(r.passed).toBe(true);
  });

  it("shows no fill: every pixel under another layer's paint is under opaque paint", async () => {
    const stack = await stackOf(r);
    let under = 0;
    for (let i = 0; i < 1100 * 1100; i++) {
      for (let k = 0; k < stack.length - 1; k++) {
        if (stack[k][i * 4 + 3] === 0) continue;
        const above = stack.slice(k + 1).map((l) => l[i * 4 + 3]);
        if (above.every((a) => a === 0)) continue;
        under++;
        expect(Math.max(...above), `pixel ${i}, layer ${k}`).toBe(255);
      }
    }
    expect(under).toBeGreaterThan(10000);
  });

  it("puts no ring round the figure: over another ground, nothing outside the figure's silhouette is half covered", async () => {
    const stack = await stackOf(r);
    const source = await sharp(await pictureFile)
      .resize(1100, 1100, { kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer();
    // The figure: clear paint (past the key's flood distance from the
    // backdrop) and everything it closes in.
    const size = { width: 1100, height: 1100 };
    const paint = new Uint8Array(1100 * 1100);
    for (let i = 0; i < paint.length; i++) {
      const d = Math.hypot(
        ...[0, 1, 2].map((c) => source[i * 3 + c] - colours.backdrop[c]),
      );
      paint[i] = d >= 32 ? 1 : 0;
    }
    const figure = fillHoles(size, paint);
    let ring = 0;
    let outside = 0;
    for (let i = 0; i < paint.length; i++) {
      if (figure[i]) continue;
      outside++;
      // Over transparency: how much of the layers covers the pixel.
      let cover = 0;
      for (const l of stack) cover += (1 - cover) * (l[i * 4 + 3] / 255);
      if (cover >= 0.5) ring++;
    }
    expect(outside).toBeGreaterThan(100000);
    expect(ring).toBeLessThan(50);
  });

  it("keeps a thin wisp the backdrop parts from the neck in the hair", async () => {
    const back = await pixelsOf(layer(r, "hair_back").path);
    const body = await pixelsOf(layer(r, "body").path);
    const x = WISP.x0 + 1;
    const y = (WISP.y0 + WISP.y1) >> 1;
    expect(back.at(x, y)[3]).toBeGreaterThan(128);
    expect(body.at(x, y)[3]).toBe(0);
  });

  it("writes canvas-sized layers, each tail its own file", async () => {
    expect(r.layers.map((l) => l.role)).toEqual([
      "hair_back",
      "body",
      "face",
      "hair_front",
    ]);
    expect(r.customParts.map((p) => p.id)).toEqual(["tail_R", "tail_L"]);
    expect(r.customParts.map((p) => p.tie)).toEqual([
      [262, 280],
      [838, 280],
    ]);
    for (const file of [
      ...r.layers.map((l) => l.path),
      ...r.customParts.map((p) => p.path),
      r.previews.labels,
      r.previews.landmarks,
    ]) {
      const meta = await sharp(file).metadata();
      expect([meta.width, meta.height], file).toEqual([1100, 1100]);
    }
    expect(path.dirname(part(r, "tail_R").path)).toBe(
      path.join(r.outputDir, "custom"),
    );
  });

  it("keeps the tails out of the back hair, their knots with them", async () => {
    const back = layer(r, "hair_back");
    expect(back.box![0]).toBeGreaterThanOrEqual(240);
    expect(back.box![2]).toBeLessThanOrEqual(860);
    expect(part(r, "tail_R").box![0]).toBeLessThan(160);
    expect(part(r, "tail_L").box![2]).toBeGreaterThan(940);
    const tail = await pixelsOf(part(r, "tail_R").path);
    expect(tail.at(262, 280)[3]).toBe(255); // the knot
    expect(tail.at(200, 600)[3]).toBe(255);
    expect((await pixelsOf(back.path)).at(200, 600)[3]).toBe(0);
  });

  it("fills the back hair behind the face and skin under the fringe, from paint off the lines", async () => {
    const back = await pixelsOf(layer(r, "hair_back").path);
    const behind = back.at(550, 450);
    expect(behind[3]).toBe(255);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(behind[c] - colours.hairShadow[c])).toBeLessThan(12);
    }
    const face = await pixelsOf(layer(r, "face").path);
    const under = face.at(550, 250); // under the cap
    expect(under[3]).toBe(255);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(under[c] - colours.skin[c])).toBeLessThan(12);
    }
  });

  it("carries the neck up to neckTopY and no further, and keeps the body off the hair's outline", async () => {
    const body = await pixelsOf(layer(r, "body").path);
    expect(body.at(550, 540)[3]).toBe(255);
    expect(body.at(550, 539)[3]).toBe(0);
    const box = layer(r, "body").box!;
    expect(box[0]).toBeGreaterThanOrEqual(270);
    expect(box[1]).toBe(540);
  });

  it("gives the jaw's line to the face", async () => {
    // Drawn in the hair's own ink on the near-black colouring.
    const face = await pixelsOf(layer(r, "face").path);
    expect(face.at(550, 662)[3]).toBe(255);
    expect((await pixelsOf(layer(r, "hair_back").path)).at(550, 662)[3]).toBe(
      0,
    );
  });
});

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
      "fills.face.forehead",
      "fills.hair_back.shell",
      "fills.custom.tail_R.root",
      "fills.custom.tail_L.root",
      "fills.hair_back.underBody",
      "fills.custom.tail_R.underBody",
      "fills.custom.tail_L.underBody",
      "fills.body.neck",
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
    for (const id of ["fills.hair_back.shell", "fills.body.neck"]) {
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

  it("reports no face width when the face's flood misses the eye row", async () => {
    const lm = characterLandmarks();
    lm.skinSeeds = [[550, 720]]; // the neck only
    const width = check(await cut(pink, lm), "frontHairWidth");
    expect(width).toMatchObject({ pass: false, value: null });
    expect(width.hint).toMatch(/^no face on the eye row 430/);
  });

  it("keys a gap between strands the torso closes off, with no seed, and says so", async () => {
    const r = await cut(await picture(PINK_ON_PEACH, { gap: true }));
    const pockets = check(r, "pockets");
    expect(pockets.keyed).toHaveLength(1);
    // The region left of the strands, closed in by the back hair, the neck
    // and the torso, is a mix: named, not keyed.
    expect(pockets.value).toBe(1);
    const named = pockets.hint.match(/backgroundSeeds: \[(\d+), \d+\]/)!;
    expect(Number(named[1])).toBeLessThan(672);
    const [x, y] = pockets.keyed![0];
    expect(Math.abs(x - GAP.cx)).toBeLessThan(14);
    // Keyed, so it warns, the keyed points first.
    expect(pockets.pass).toBe(false);
    expect(pockets.hint).toMatch(
      /^keyed as backdrop on their own, the hair ringing them: \[\d+, \d+\]; check each on preview-labels\.png, and if one is paint .* landmarks\.paintSeeds; backdrop-coloured paint/,
    );
    expect(r.passed).toBe(true);
    for (const a of await coverAt(r, GAP.cx, GAP.cy)) expect(a).toBe(0);
  });

  it("warns when it keys a pale ornament the hair rings, and lists it", async () => {
    const r = await cut(await picture(PINK_ON_PEACH, { ornament: true }));
    const pockets = check(r, "pockets");
    expect(pockets).toMatchObject({ level: "warn", pass: false, value: 0 });
    expect(pockets.keyed).toHaveLength(1);
    const [x, y] = pockets.keyed![0];
    expect(Math.hypot(x - ORNAMENT.cx, y - ORNAMENT.cy)).toBeLessThan(
      ORNAMENT.r,
    );
    expect(pockets.hint).toMatch(
      new RegExp(
        `^keyed as backdrop on their own, the hair ringing them: \\[${x}, ${y}\\]`,
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

  it("refuses the lip set's inputs, not supported yet", async () => {
    await refuse({ mouthKeyed: "keyed.png" }, /not supported yet/);
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
