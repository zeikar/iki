import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fillHoles } from "../src/illustration";
import {
  cutLayersFromIllustration,
  formatCutReport,
  type CutLayersFromIllustrationResult,
} from "../src/illustration-cut";
import { bridges, browBand } from "../src/illustration-labels";
import { validateLandmarks } from "../src/illustration-landmarks";
import {
  BLACK_ON_PEACH,
  BROWS,
  characterLandmarks,
  EYE,
  EYE_STROKE,
  inBrow,
  inLash,
  ORANGE_ON_WARM,
  GAP,
  NECK_TIPS,
  onBodyInkDash,
  ORNAMENT,
  PINK_ON_PEACH,
  POCKET,
  SIDE_LOCK,
  sideLockLandmarks,
  STRAND,
  TEMPLE_LOCK,
  TORSO_BODY_ONLY,
  WISP,
  writeCharacter,
  type CharacterColours,
  type CharacterOptions,
} from "./helpers/illustration-character";
import { writeInterior, writeKeyedMouth } from "./helpers/parts";

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
  options?: CharacterOptions,
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

/** The written layers' RGBA, in draw order (the layers come in it, the
 *  custom parts right after the back hair). */
async function stackOf(r: Ok): Promise<Buffer[]> {
  const files = r.layers.flatMap((l) =>
    l.role === "hair_back"
      ? [l.path, ...r.customParts.map((p) => p.path)]
      : [l.path],
  );
  return Promise.all(files.map((f) => sharp(f).ensureAlpha().raw().toBuffer()));
}

const W = 1100;

/** A hook that cuts a picture runs a full cut, about 5 s alone and several
 *  times that on a CI runner with the suite running beside it. */
const CUT_HOOK_TIMEOUT = 120_000;
// A test here may cut several times; a CI runner takes a few seconds a cut.
vi.setConfig({ testTimeout: CUT_HOOK_TIMEOUT });

/** The written layers stacked over `ground`, the brows moved `browShift`
 *  px down (negative: up): RGB per pixel. */
async function composite(
  r: Ok,
  ground: readonly number[],
  browShift = 0,
): Promise<Float32Array> {
  const out = new Float32Array(W * W * 3);
  for (let i = 0; i < W * W; i++) out.set(ground, i * 3);
  const files = r.layers.flatMap((l) =>
    l.role === "hair_back"
      ? [l, ...r.customParts.map((p) => ({ role: p.id, path: p.path }))]
      : [l],
  );
  for (const f of files) {
    const data = await sharp(f.path).ensureAlpha().raw().toBuffer();
    const dy = f.role.startsWith("brow_") ? browShift : 0;
    for (let y = 0; y < W; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= W) continue;
      for (let x = 0; x < W; x++) {
        const j = (sy * W + x) * 4;
        const a = data[j + 3] / 255;
        if (a === 0) continue;
        const i = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) {
          out[i + c] = data[j + c] * a + out[i + c] * (1 - a);
        }
      }
    }
  }
  return out;
}

/** The largest channel difference between two colours. */
const off = (a: ArrayLike<number>, b: readonly number[]) =>
  Math.max(...[0, 1, 2].map((c) => Math.abs(a[c] - b[c])));

/** Inside the ellipse of the iris drawn about `cx`, `inset` px in. */
const inIris = (cx: number, x: number, y: number, inset = 0) =>
  ((x - cx) / (EYE.iris.rx - inset)) ** 2 +
    ((y - EYE.iris.cy) / (EYE.iris.ry - inset)) ** 2 <=
  1;

/** A resized flat colour stays within this many levels of itself, and a
 *  feature's trace is many times more. */
const NEAR = 16;
/** The resize's soft edge and overshoot reach this many px into a shape. */
const EDGE = 3;

const SIDES = [
  ["L", EYE.L],
  ["R", EYE.R],
] as const;

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
  }, CUT_HOOK_TIMEOUT);

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

  it("writes canvas-sized layers in the rig's order, each tail its own file", async () => {
    expect(r.layers.map((l) => l.role)).toEqual([
      "hair_back",
      "body",
      "face",
      "nose",
      "mouth",
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

  it("cuts each eye the way the rig's eye roles split one drawing", async () => {
    for (const [side, { cx }] of SIDES) {
      // The sclera and its lash share a top row: the blink fold rides it.
      const eye = layer(r, `eye_${side}`);
      expect(layer(r, `lash_${side}`).box![1], side).toBe(eye.box![1]);
      // Its top is the lash's drawn top, a px for the resize's sampling.
      expect(eye.box![1]).toBeLessThanOrEqual(
        EYE.lashOuter.cy - EYE.lashOuter.ry + 1,
      );
      const sclera = await pixelsOf(eye.path);
      const lash = await pixelsOf(layer(r, `lash_${side}`).path);
      const lower = await pixelsOf(layer(r, `lash_lower_${side}`).path);
      // The lash's body: in the lash, white in the sclera under it.
      expect(lash.at(cx, 412)[3]).toBe(255);
      expect(off(sclera.at(cx, 412), [255, 255, 255])).toBeLessThan(NEAR);
      // The lower lid, across the iris's bottom and past it: in lash_lower,
      // not the lash nor the iris, as drawn in the sclera; the iris under
      // it is the disc's colour, not the lid's.
      const iris = await pixelsOf(layer(r, `iris_${side}`).path);
      const lid = (EYE.lower.y0 + EYE.lower.y1) >> 1;
      for (const x of [cx - 17, cx - 6, cx, cx + 6, cx + 17]) {
        expect(lower.at(x, lid)[3], `${side} ${x},${lid}`).toBe(255);
        expect(lash.at(x, lid)[3]).toBe(0);
        expect(off(lower.at(x, lid), colours.ink)).toBeLessThan(2 * NEAR);
        expect(sclera.at(x, lid)).toEqual(lower.at(x, lid));
      }
      for (const x of [cx - 6, cx, cx + 6]) {
        const px = iris.at(x, lid);
        expect(px[3], `${side} ${x},${lid}`).toBe(255);
        expect(off(px, colours.iris)).toBeLessThan(off(px, colours.ink));
      }
      // The white beside the iris, and the sclera white under the iris.
      expect(off(sclera.at(cx - 18, 440), [255, 255, 255])).toBeLessThan(NEAR);
      expect(off(sclera.at(cx, 440), [255, 255, 255])).toBeLessThan(NEAR);
    }
  });

  it("makes each iris the whole ellipse, filled where the lids covered it from the disc's own colours", async () => {
    for (const [side, { cx, outer }] of SIDES) {
      const iris = await pixelsOf(layer(r, `iris_${side}`).path);
      let hidden = 0;
      for (
        let y = EYE.iris.cy - EYE.iris.ry;
        y <= EYE.iris.cy + EYE.iris.ry;
        y++
      ) {
        for (let x = cx - EYE.iris.rx; x <= cx + EYE.iris.rx; x++) {
          if (!inIris(cx, x, y, 1.5)) continue;
          const px = iris.at(x, y);
          expect(px[3], `${side} ${x},${y}`).toBe(255);
          // Inside the lash, off its bottom row (a blend of lash and iris),
          // or inside the lower lid, off its edges.
          const underLash =
            inLash(cx, outer, x, y) && inLash(cx, outer, x, y + 1);
          const underLid = y > EYE.lower.y0 && y < EYE.lower.y1;
          if (!underLash && !underLid) continue;
          // Where the lids hid the disc, the disc's colour: no near-white
          // pixel (the highlight's top included) and none of the lid's.
          hidden++;
          expect(
            Math.min(px[0], px[1], px[2]),
            `${side} ${x},${y}`,
          ).toBeLessThan(200);
          expect(off(px, colours.iris), `${side} ${x},${y}`).toBeLessThan(
            off(px, colours.ink),
          );
        }
      }
      expect(hidden).toBeGreaterThan(20);
    }
  });

  it("leaves each lid's crease on the face, as drawn", async () => {
    const face = await pixelsOf(layer(r, "face").path);
    for (const [side, { cx }] of SIDES) {
      const y = EYE.creaseOuter.cy - EYE.creaseOuter.ry + 2;
      expect(off(face.at(cx, y), colours.ink), side).toBeLessThan(NEAR);
      for (const role of [`eye_${side}`, `lash_${side}`]) {
        expect((await pixelsOf(layer(r, role).path)).at(cx, y)[3]).toBe(0);
      }
    }
  });

  it("lifts every feature off the face, skin filled under it", async () => {
    const face = await pixelsOf(layer(r, "face").path);
    const skinAt = (x: number, y: number, what: string) => {
      const px = face.at(x, y);
      if (px[3] === 0) return;
      expect(off(px, colours.skin), `${what} ${x},${y}`).toBeLessThan(NEAR);
    };
    for (const role of ["eye_L", "eye_R", "nose", "mouth"]) {
      const m = await pixelsOf(layer(r, role).path);
      const [x0, y0, x1, y1] = layer(r, role).box!;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++)
          if (m.at(x, y)[3] > 0) skinAt(x, y, role);
      }
    }
    // Each brow's band, but where the strand crosses it (hair over the
    // face there, with its own soft edge).
    const size = { width: W, height: W };
    const lm = validateLandmarks(characterLandmarks(), size);
    let looked = 0;
    for (const side of ["L", "R"] as const) {
      const band = browBand(size, lm.brows![side]!);
      for (let i = 0; i < band.length; i++) {
        const x = i % W;
        if (!band[i] || (x >= STRAND.x0 - EDGE && x <= STRAND.x1 + EDGE)) {
          continue;
        }
        skinAt(x, Math.floor(i / W), `brow_${side}`);
        looked++;
      }
    }
    expect(looked).toBeGreaterThan(1000);
  });

  it("carries the strand across the brow's band in the front hair, with no hole and no brow in it", async () => {
    const front = await pixelsOf(layer(r, "hair_front").path);
    let crossed = 0;
    for (let y = 355; y <= 385; y++) {
      for (let x = STRAND.x0 + EDGE; x <= STRAND.x1 - EDGE; x++) {
        if (!inBrow("R", x, y)) continue;
        crossed++;
        const px = front.at(x, y);
        expect(px[3], `${x},${y}`).toBe(255);
        expect(off(px, colours.hair), `${x},${y}`).toBeLessThan(NEAR);
      }
    }
    expect(crossed).toBeGreaterThan(30);
  });

  it("leaves no second brow when the brows move", async () => {
    const shift = -10;
    const moved = await composite(r, colours.backdrop, shift);
    const brows = await Promise.all(
      ["brow_L", "brow_R"].map((b) => pixelsOf(layer(r, b).path)),
    );
    let looked = 0;
    for (const side of ["L", "R"] as const) {
      for (let y = 355; y <= 390; y++) {
        for (let x = 425; x <= 675; x++) {
          if (!inBrow(side, x, y)) continue;
          // Where the moved brows do not cover it now.
          if (brows.some((b) => b.at(x, y - shift)[3] > 0)) continue;
          const strand = x >= STRAND.x0 && x <= STRAND.x1;
          if (strand && (x < STRAND.x0 + EDGE || x > STRAND.x1 - EDGE)) {
            continue;
          }
          looked++;
          const i = (y * W + x) * 3;
          const want = strand ? colours.hair : colours.skin;
          expect(
            off(moved.subarray(i, i + 3), want),
            `${side} ${x},${y}`,
          ).toBeLessThan(NEAR);
        }
      }
    }
    expect(looked).toBeGreaterThan(300);
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

/** The pixels 4-connected to (x, y) through a layer's paint. */
async function paintFrom(
  file: string,
  x: number,
  y: number,
): Promise<Uint8Array> {
  const alpha = await sharp(file)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  const seen = new Uint8Array(W * W);
  const queue = [y * W + x];
  seen[queue[0]] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const j of [i - 1, i + 1, i - W, i + W]) {
      if (j >= 0 && j < W * W && !seen[j] && alpha[j] > 0) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return seen;
}

/** A point inside each SIDE_LOCK, clear of its outline: where the lock's
 *  body lies over the ear's edge and the cheek's, and its lower end below
 *  `skull` and `shellLower`, over the back hair, where nothing is filled. */
const LOCK_BODY: [number, number] = [370, 450];
const LOCK_END: [number, number] = [368, 605];
/** Under the lock's lower part, inside the shell, below the skull and the
 *  ear: only the side fill puts back hair there. */
const LOCK_SHELL: [number, number] = [372, 580];
const mirrored = ([x, y]: [number, number]): [number, number] => [W - x, y];

describe.each(COLOURINGS)(
  "cutting %s with a side lock on each side",
  (_name, colours, bodyOnly) => {
    let r: Ok;
    beforeAll(async () => {
      const lm = { ...characterLandmarks(), ...sideLockLandmarks() };
      if (bodyOnly) lm.bodyOnly = [TORSO_BODY_ONLY];
      r = await cut(await picture(colours, { sideLocks: true }), lm);
    }, CUT_HOOK_TIMEOUT);

    it("stacks back into the picture and passes, each lock a layer between the brows and the front hair", () => {
      expect(check(r, "stack").pass).toBe(true);
      expect(check(r, "seeds").pass).toBe(true);
      for (const side of ["L", "R"]) {
        expect(check(r, `sideHair.${side}`), side).toMatchObject({
          level: "warn",
          pass: true,
          value: 0,
        });
      }
      expect(r.passed).toBe(true);
      expect(r.layers.map((l) => l.role).slice(-5)).toEqual([
        "brow_L",
        "brow_R",
        "hair_side_L",
        "hair_side_R",
        "hair_front",
      ]);
    });

    it("puts each lock's paint in its own layer and no other, L on the viewer's right", async () => {
      const read = async (role: string) => pixelsOf(layer(r, role).path);
      const lockR = await read("hair_side_R");
      const lockL = await read("hair_side_L");
      const front = await read("hair_front");
      const face = await read("face");
      for (const [own, other, at] of [
        [lockR, lockL, LOCK_END],
        [lockL, lockR, mirrored(LOCK_END)],
      ] as const) {
        expect(own.at(...at)[3], `${at}`).toBe(255);
        expect(off(own.at(...at), colours.hair), `${at}`).toBeLessThan(NEAR);
        expect(other.at(...at)[3], `${at}`).toBe(0);
        // Its lower end lies past every fill: no other layer has paint.
        expect((await coverAt(r, ...at)).filter((a) => a > 0)).toEqual([255]);
      }
      for (const at of [LOCK_BODY, mirrored(LOCK_BODY)]) {
        expect(lockR.at(...at)[3] + lockL.at(...at)[3], `${at}`).toBe(255);
        expect(front.at(...at)[3], `${at}`).toBe(0);
        // The face's paint under the lock is skin, filled, not the lock's.
        expect(off(face.at(...at), colours.hair), `${at}`).toBeGreaterThan(40);
      }
    });

    it("carries each lock's root up under the front hair by 12 px, none of it showing at rest", async () => {
      const front = await pixelsOf(layer(r, "hair_front").path);
      for (const [side, x] of [
        ["R", LOCK_BODY[0]],
        ["L", W - LOCK_BODY[0]],
      ] as const) {
        const lock = await pixelsOf(layer(r, `hair_side_${side}`).path);
        let top = 0;
        while (lock.at(x, top)[3] === 0) top++;
        // Where the lock shows: the first row the front hair leaves.
        let shows = top;
        while (front.at(x, shows)[3] > 0) shows++;
        expect(shows - top, side).toBe(12);
        expect(off(lock.at(x, top), colours.hair), side).toBeLessThan(NEAR);
      }
      // Wherever a lock has paint the front hair covers, the cover is opaque.
      const stack = await stackOf(r);
      const roles = r.layers.map((l) => l.role);
      const frontAt = stack[roles.indexOf("hair_front") + r.customParts.length];
      let hidden = 0;
      for (const role of ["hair_side_L", "hair_side_R"]) {
        const lock = stack[roles.indexOf(role) + r.customParts.length];
        for (let i = 0; i < W * W; i++) {
          if (lock[i * 4 + 3] === 0 || frontAt[i * 4 + 3] === 0) continue;
          hidden++;
          expect(frontAt[i * 4 + 3], `${role} ${i}`).toBe(255);
        }
      }
      expect(hidden).toBeGreaterThan(2 * 12 * 40);
    });

    it("shows no fill: every pixel under another layer's paint is under opaque paint", async () => {
      const stack = await stackOf(r);
      for (let i = 0; i < W * W; i++) {
        for (let k = 0; k < stack.length - 1; k++) {
          if (stack[k][i * 4 + 3] === 0) continue;
          const above = stack.slice(k + 1).map((l) => l[i * 4 + 3]);
          if (above.every((a) => a === 0)) continue;
          expect(Math.max(...above), `pixel ${i}, layer ${k}`).toBe(255);
        }
      }
    });

    it("fills skin under each lock only between the ear and the cheek, joining them", async () => {
      const file = layer(r, "face").path;
      const face = await pixelsOf(file);
      const joined = await paintFrom(file, 550, 430);
      for (const [at, ear] of [
        [LOCK_BODY, [330, 460]],
        [mirrored(LOCK_BODY), [770, 460]],
      ] as const) {
        expect(face.at(...at)[3], `${at}`).toBe(255);
        expect(off(face.at(...at), colours.skin), `${at}`).toBeLessThan(24);
        expect(joined[ear[1] * W + ear[0]], `${ear}`).toBe(1);
      }
      // The lock's outline where it crosses the ear goes with the lock, so
      // no line stays on the face when it moves.
      const lockR = await pixelsOf(layer(r, "hair_side_R").path);
      const lockL = await pixelsOf(layer(r, "hair_side_L").path);
      expect(lockR.at(343, 450)[3]).toBe(255);
      expect(lockL.at(W - 343, 450)[3]).toBe(255);
      // Above the ear and under the lobe the lock has the face on one side
      // only: hair is behind it there, no skin.
      for (const at of [
        [348, 385],
        [352, 508],
      ] as [number, number][]) {
        for (const p of [at, mirrored(at)]) {
          expect(face.at(...p)[3], `${p}`).toBe(0);
        }
      }
      expect(check(r, "fills.face.sideHair").pass).toBe(true);
    });

    it("uncovers no skin outside the face and the ears when each lock moves 30 px toward the face's centre", async () => {
      const files = r.layers.flatMap((l) =>
        l.role === "hair_back"
          ? [l.path, ...r.customParts.map((p) => p.path)]
          : [l.path],
      );
      const out = new Float32Array(W * W * 3);
      for (let i = 0; i < W * W; i++) out.set(colours.backdrop, i * 3);
      for (const f of files) {
        const data = await sharp(f).ensureAlpha().raw().toBuffer();
        const role = path.basename(f, ".png");
        const dx =
          role === "hair_side_R" ? 30 : role === "hair_side_L" ? -30 : 0;
        for (let y = 0; y < W; y++) {
          for (let x = 0; x < W; x++) {
            const sx = x - dx;
            if (sx < 0 || sx >= W) continue;
            const j = (y * W + sx) * 4;
            const a = data[j + 3] / 255;
            if (a === 0) continue;
            const i = (y * W + x) * 3;
            for (let c = 0; c < 3; c++) {
              out[i + c] = data[j + c] * a + out[i + c] * (1 - a);
            }
          }
        }
      }
      // The face's and the ears' drawn shapes, grown by their outline and
      // its soft edge: the face's own silhouette, the gap under each strand
      // between the ear and the cheek inside it.
      const grow = 7;
      const inside =
        (cx: number, cy: number, rx: number, ry: number) =>
        (x: number, y: number) =>
          ((x - cx) / (rx + grow)) ** 2 + ((y - cy) / (ry + grow)) ** 2 <= 1;
      const silhouette = [
        inside(550, 430, 200, 230),
        inside(345, 450, 32, 48),
        inside(755, 450, 32, 48),
      ];
      const skin: [number, number][] = [];
      for (let y = 300; y < 650; y++) {
        for (const [x0, x1] of [
          [290, 430],
          [670, 810],
        ]) {
          for (let x = x0; x < x1; x++) {
            if (silhouette.some((s) => s(x, y))) continue;
            const i = (y * W + x) * 3;
            if (off(out.subarray(i, i + 3), colours.skin) < NEAR) {
              skin.push([x, y]);
            }
          }
        }
      }
      expect(skin.slice(0, 5)).toEqual([]);
    });

    it("fills the back hair under each lock inside the shell, none below it", async () => {
      const back = await pixelsOf(layer(r, "hair_back").path);
      for (const at of [LOCK_SHELL, mirrored(LOCK_SHELL)]) {
        expect(back.at(...at)[3], `${at}`).toBe(255);
      }
      expect(back.at(...LOCK_END)[3]).toBe(0);
      expect(check(r, "fills.hair_back.sideHair").limit).toBe(null);
    });
  },
);

describe("bridges", () => {
  it("bridges a strand's runs with the face on both ends, and nothing with the face on one end", () => {
    // 12 x 6: a strand down columns 4-6; the face on both sides of it in
    // rows 0-2, on its right only in rows 3-5.
    const size = { width: 12, height: 6 };
    const n = size.width * size.height;
    const lock = new Uint8Array(n);
    const face = new Uint8Array(n);
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const i = y * size.width + x;
        if (x >= 4 && x <= 6) lock[i] = 1;
        else if (x > 6 || y < 3) face[i] = 1;
      }
    }
    const mask = bridges(size, lock, face);
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        expect(mask[y * size.width + x], `${x},${y}`).toBe(
          x >= 4 && x <= 6 && y < 3 ? 1 : 0,
        );
      }
    }
  });

  it("bridges nothing that runs to the canvas's edge, the face beyond it or not", () => {
    // 6 x 4, the face everywhere but a lock along the left column and the
    // bottom row: every run of it ends at an edge.
    const size = { width: 6, height: 4 };
    const n = size.width * size.height;
    const lock = new Uint8Array(n);
    const face = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const x = i % size.width;
      const y = Math.floor(i / size.width);
      if (x === 0 || y === size.height - 1) {
        lock[i] = 1;
        face[i] = 0;
      }
    }
    expect([...bridges(size, lock, face)].every((v) => v === 0)).toBe(true);
  });
});

describe("cutLayersFromIllustration side-lock checks", () => {
  it("warns on a side polygon holding no hair and on a lock with no front hair above, naming each path and which way to move it", async () => {
    const lm = { ...characterLandmarks(), ...sideLockLandmarks() };
    // On the cheek's skin under the left eye: no hair at all.
    lm.sideHair.L = [
      [640, 500],
      [680, 500],
      [680, 530],
      [640, 530],
    ];
    // The lock's polygon starting 45 px under the front hair's, at y 390:
    // the lock above it stays in the back hair.
    lm.sideHair.R = [[340, 390], [400, 390], ...lm.sideHair.R.slice(2)];
    const r = await cut(await picture(PINK_ON_PEACH, { sideLocks: true }), lm);
    const none = check(r, "sideHair.L");
    expect(none).toMatchObject({ level: "warn", pass: false, value: 1 });
    expect(none.hint).toMatch(
      /^landmarks\.sideHair\.L holds no hair, so no hair_side_L is written: move it onto the lock hanging in front of the ear on the viewer's right/,
    );
    expect(r.layers.map((l) => l.role)).not.toContain("hair_side_L");
    const root = check(r, "sideHair.R");
    expect(root).toMatchObject({ level: "warn", pass: false, value: 1 });
    expect(root.hint).toMatch(
      /^hair_side_R's top row \(y 39\d\) shows past hair_front on \d+ px, x 3\d\d-3\d\d: hair_front ends 4\d px above it there, .* Move landmarks\.sideHair\.R's top up 4\d px or more into landmarks\.frontHair/,
    );
    // The measure reads the same root, naming the landmark, not the layout.
    const measured = r.measure.warnings.filter((w) =>
      /^hair_side_R: its top row/.test(w),
    );
    expect(measured).toHaveLength(1);
    expect(measured[0]).toMatch(
      /^hair_side_R: its top row \(canvas y 39\d\) shows past hair_front .* Move landmarks\.sideHair\.R's top up into landmarks\.frontHair/,
    );
    // A lock is in the back hair until its polygon takes it.
    expect(r.passed).toBe(true);
  });

  it("lays no skin under a strand beside the ear's outer edge and below the lobe", async () => {
    const lm = characterLandmarks();
    const R = [
      [293, 370],
      [313, 370],
      [313, 566],
      [293, 566],
    ];
    lm.sideHair = { R, L: R.map(([x, y]) => [W - x, y]) };
    const r = await cut(
      await picture(PINK_ON_PEACH, { sideLocks: "outer" }),
      lm,
    );
    const face = await pixelsOf(layer(r, "face").path);
    for (const side of ["R", "L"] as const) {
      const lock = await pixelsOf(layer(r, `hair_side_${side}`).path);
      for (const [x, y] of [
        [303, 450],
        [303, 520],
      ]) {
        const at: [number, number] = side === "R" ? [x, y] : [W - x, y];
        expect(lock.at(...at)[3], `${side} ${at}`).toBe(255);
        expect(face.at(...at)[3], `${side} ${at}`).toBe(0);
      }
    }
  });

  it("keeps a lock the face and the fringe close in as hair, in its own layer", async () => {
    const lm = { ...characterLandmarks(), ...sideLockLandmarks() };
    const R = [
      [370, 330],
      [405, 330],
      [404, 474],
      [388, 496],
      [371, 474],
    ];
    lm.sideHair = { R, L: R.map(([x, y]) => [W - x, y]) };
    const r = await cut(
      await picture(PINK_ON_PEACH, { sideLocks: "short" }),
      lm,
    );
    for (const [side, x] of [
      ["R", 388],
      ["L", W - 388],
    ] as const) {
      expect(check(r, `sideHair.${side}`).pass, side).toBe(true);
      const lock = await pixelsOf(layer(r, `hair_side_${side}`).path);
      expect(lock.at(x, 440)[3], side).toBe(255);
      const face = await pixelsOf(layer(r, "face").path);
      expect(off(face.at(x, 440), PINK_ON_PEACH.hair), side).toBeGreaterThan(
        40,
      );
    }
  });

  /** sideHair.R round SIDE_LOCK with a lobe out to `x`, rows 412-452. */
  const lobed = (x: number) => {
    const lm = { ...characterLandmarks(), ...sideLockLandmarks() };
    lm.sideHair.R = [
      [340, 330],
      [400, 330],
      [400, 412],
      [x, 412],
      [x, 452],
      [400, 452],
      ...lm.sideHair.R.slice(2),
    ];
    return lm;
  };

  it("warns on a lock drawn well over its eye, reading how far against the declared eye box", async () => {
    const r = await cut(
      await picture(PINK_ON_PEACH, { sideLocks: "overEye" }),
      lobed(462),
    );
    const over = check(r, "sideHair.R");
    expect(over.pass).toBe(false);
    // The lobe reaches x 459 into the box from 432: 28 px deep, 20 past
    // the box's spare and the lock's outline, far over the 3 px minimum.
    const px = Number(/reaches (\d+) px over eye_R/.exec(over.hint)?.[1]);
    expect(px).toBeGreaterThan(15);
    expect(over.hint).toMatch(
      /^hair_side_R reaches \d+ px over eye_R at rest \(to x 4\d\d on y 4\d\d\), past landmarks\.eyes\.R\.box's 4 px of spare and the lock's 4 px outline: .* Pull landmarks\.sideHair\.R's inner edge back \d+ px or more to the left, to x <= 439, and widen landmarks\.frontHair over the hair it leaves; if hair is really drawn over the eye there, the cut cannot split it from the eye: report it$/,
    );
    expect(check(r, "sideHair.L").pass).toBe(true);
  });

  it("passes a lock that only comes into the eye box's spare, short of the eye", async () => {
    const r = await cut(
      await picture(PINK_ON_PEACH, { sideLocks: "nearEye" }),
      lobed(440),
    );
    const lock = await pixelsOf(layer(r, "hair_side_R").path);
    expect(lock.at(434, 432)[3]).toBe(255); // inside the box, in its spare
    expect(check(r, "sideHair.R").pass).toBe(true);
  });

  it("reads a fractional eye box at the pixels it covers: a lock in its spare passes, one over the eye warns", async () => {
    const fractional = (lm: Record<string, any>) => {
      lm.eyes.R.box = [431.6, 391.6, 508.4, 466.4];
      return lm;
    };
    const near = await cut(
      await picture(PINK_ON_PEACH, { sideLocks: "nearEye" }),
      fractional(lobed(440)),
    );
    expect(check(near, "sideHair.R").pass).toBe(true);
    const over = check(
      await cut(
        await picture(PINK_ON_PEACH, { sideLocks: "overEye" }),
        fractional(lobed(462)),
      ),
      "sideHair.R",
    );
    expect(over.hint).toMatch(
      /^hair_side_R reaches \d+ px over eye_R at rest \(to x 4\d\d on y 4\d\d\), .* to x <= 439,/,
    );
  });

  it("fills the cheek under a lock's lobe beside the eye from skin, none of the eye's paint in it", async () => {
    const r = await cut(
      await picture(PINK_ON_PEACH, { sideLocks: "nearEye" }),
      lobed(440),
    );
    const face = await pixelsOf(layer(r, "face").path);
    // Under the lobe, clear of its outline: skin, however near the eye.
    let worst = 0;
    for (let y = 424; y <= 440; y++) {
      for (let x = 404; x <= 428; x++) {
        expect(face.at(x, y)[3], `${x},${y}`).toBe(255);
        worst = Math.max(worst, off(face.at(x, y), PINK_ON_PEACH.skin));
      }
    }
    expect(worst).toBeLessThan(24);
  });

  it("says which polygon took the hair: the front hair, or the other side's where the two overlap", async () => {
    const lm = { ...characterLandmarks(), ...sideLockLandmarks() };
    // R's polygon given to L as well: L keeps the paint both take.
    lm.sideHair.L = lm.sideHair.R.map((p: number[]) => [...p]);
    const overlap = await cut(
      await picture(PINK_ON_PEACH, { sideLocks: true }),
      lm,
    );
    expect(overlap.layers.map((l) => l.role)).not.toContain("hair_side_R");
    const kept = await pixelsOf(layer(overlap, "hair_side_L").path);
    expect(kept.at(...LOCK_BODY)[3]).toBe(255);
    expect(check(overlap, "sideHair.L").pass).toBe(true);
    expect(check(overlap, "sideHair.R").hint).toMatch(
      /^all of the hair inside landmarks\.sideHair\.R is taken by .*landmarks\.sideHair\.L, .* pull the two polygons apart$/,
    );

    // L wholly inside the front hair, over the cap; R reaching the canvas's
    // edge, over the left tail's lower part.
    lm.sideHair.L = [
      [600, 200],
      [700, 200],
      [700, 300],
      [600, 300],
    ];
    lm.sideHair.R = [
      [0, 600],
      [290, 600],
      [290, 1099],
      [0, 1099],
    ];
    const front = await cut(await picture(PINK_ON_PEACH), lm);
    expect(front.layers.map((l) => l.role)).not.toContain("hair_side_L");
    expect(check(front, "sideHair.L")).toMatchObject({ pass: false, value: 1 });
    expect(check(front, "sideHair.L").hint).toMatch(
      /^all of the hair inside landmarks\.sideHair\.L is taken by landmarks\.frontHair, which keeps the paint both claim, so no hair_side_L is written: start the polygon below the front hair's edge/,
    );
    expect(layer(front, "hair_side_R").box![0]).toBeLessThan(200);
    expect(check(front, "stack").pass).toBe(true);
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

describe.each([
  ["pink hair on peach skin", PINK_ON_PEACH],
  ["orange hair on warm skin", ORANGE_ON_WARM],
] as const)("cutting eyes drawn otherwise, %s", (_name, colours) => {
  // Left: an iris as dark as the lash at its top, outlined in that ink at
  // its bottom, a short lower lid joining the outline; right: a pale lid
  // band over the lash.
  let r: Ok;
  beforeAll(async () => {
    r = await cut(
      await picture(colours, { eyes: { L: "darkIris", R: "lidBand" } }),
    );
  }, CUT_HOOK_TIMEOUT);

  it("gives the lash the soft paint over its first dark row, so it shares the sclera's top row", async () => {
    const top = layer(r, "eye_R").box![1];
    expect(layer(r, "lash_R").box![1]).toBe(top);
    // The band's top, above the lash's drawn top.
    expect(top).toBeLessThan(EYE.lashOuter.cy - EYE.lashOuter.ry);
    const lash = await pixelsOf(layer(r, "lash_R").path);
    expect(lash.at(EYE.R.cx, top + 1)[3]).toBeGreaterThan(0);
  });

  it("keeps an iris top as dark as the lash in the iris, under the lash's thickness beside it", async () => {
    const { cx } = EYE.L;
    const lash = await pixelsOf(layer(r, "lash_L").path);
    const iris = await pixelsOf(layer(r, "iris_L").path);
    // Below the lash's drawn bottom, above where the dark top ends, left of
    // the highlight.
    for (const x of [cx - 8, cx - 4]) {
      for (const y of [422, 424]) {
        expect(lash.at(x, y)[3], `${x},${y}`).toBe(0);
        expect(iris.at(x, y)[3], `${x},${y}`).toBe(255);
        expect(off(iris.at(x, y), colours.ink)).toBeLessThan(2 * NEAR);
      }
    }
  });

  it("keeps the iris's own dark bottom outline in the iris where no lid line runs beside the disc", async () => {
    const { cx } = EYE.L;
    const iris = await pixelsOf(layer(r, "iris_L").path);
    const lower = await pixelsOf(layer(r, "lash_lower_L").path);
    const y = EYE.iris.cy + EYE.iris.ry - 2;
    expect(iris.at(cx, y)[3]).toBe(255);
    expect(off(iris.at(cx, y), colours.ink)).toBeLessThan(2 * NEAR);
    expect(lower.at(cx, y)[3]).toBe(0);
    // The short lid joining it is the lower lid only below the disc.
    expect(lower.at(cx, EYE.lowerShort.y1)[3]).toBe(255);
  });
});

describe("cutting open eyes with little white", () => {
  // Left: a white of warm grey; right: an iris covering most of the white.
  // On peach skin both read as too little white to go by.
  const colours = PINK_ON_PEACH;
  let r: Ok;
  beforeAll(async () => {
    const lm = characterLandmarks();
    lm.eyes.R.iris = { cx: EYE.R.cx, cy: EYE.iris.cy, ...EYE.bigIris };
    r = await cut(
      await picture(colours, { eyes: { L: "greyWhite", R: "bigIris" } }),
      lm,
    );
  }, CUT_HOOK_TIMEOUT);

  it.each([
    ["L", "a warm grey white", EYE.L, EYE.iris],
    ["R", "an iris covering most of the white", EYE.R, EYE.bigIris],
  ] as const)(
    "cuts eye %s, with %s, open: an iris layer holding the disc, a lash holding none of it",
    async (side, _what, { cx }, size) => {
      const eye = check(r, `eye.${side}`);
      expect(eye).toMatchObject({ level: "warn", pass: false });
      expect(eye.hint).toMatch(/tinted or mostly hidden/);
      expect(eye.hint).toMatch(new RegExp(`eye_${side}\\.png`));
      expect(r.layers.map((l) => l.role)).toContain(`iris_${side}`);
      const iris = await pixelsOf(layer(r, `iris_${side}`).path);
      const lash = await pixelsOf(layer(r, `lash_${side}`).path);
      // Inside the disc where it shows, between the lids: its left and
      // right, and left of the pupil.
      for (const [x, y] of [
        [cx - (size.rx - 4), EYE.iris.cy + 4],
        [cx + (size.rx - 4), EYE.iris.cy + 4],
        [cx - 9, EYE.iris.cy + 8],
      ]) {
        expect(iris.at(x, y)[3], `${x},${y}`).toBe(255);
        expect(off(iris.at(x, y), colours.iris), `${x},${y}`).toBeLessThan(
          NEAR,
        );
        expect(lash.at(x, y)[3], `${x},${y}`).toBe(0);
      }
    },
  );
});

describe("cutLayersFromIllustration on what lies beside the features", () => {
  it("carries only the neck's own skin up behind the chin, past a strand's tips and the chin's shadow under the jaw", async () => {
    const colours = PINK_ON_PEACH;
    const r = await cut(
      await picture(colours, { neckTips: true, chinShadow: true }),
    );
    const body = await pixelsOf(layer(r, "body").path);
    // Every column of the neck, the tips' included, from neckTopY down to
    // above the jaw's line (no lower than 640 there, where the face is
    // opaque at every column), off the neck's side lines.
    let looked = 0;
    for (let x = 503; x <= 597; x++) {
      for (let y = 540; y <= 640; y += 4) {
        const px = body.at(x, y);
        expect(px[3], `${x},${y}`).toBe(255);
        expect(off(px, colours.skinShadow), `${x},${y}`).toBeLessThan(NEAR);
        looked++;
      }
    }
    expect(looked).toBeGreaterThan(2000);
    // Under each tip's columns too.
    for (const tip of NECK_TIPS) {
      const x = Math.round((tip[0][0] + tip[1][0]) / 2);
      expect(off(body.at(x, 600), colours.skinShadow), `${x}`).toBeLessThan(
        NEAR,
      );
    }
  });

  it("starts the neck's fill on the row a fractional neckTopY rounds to", async () => {
    const r = await cut(await picture(PINK_ON_PEACH), {
      ...characterLandmarks(),
      neckTopY: 539.6,
    });
    const body = await pixelsOf(layer(r, "body").path);
    expect(body.at(550, 540)[3]).toBe(255);
    expect(body.at(550, 539)[3]).toBe(0);
    expect(body.at(550, 600)[3]).toBe(255);
  });

  it("warns that a brow's line runs off the brow, saying which way to move it, and passes once moved", async () => {
    const pink = await picture(PINK_ON_PEACH);
    const lm = characterLandmarks();
    // A tight band 5 px above the brow: its lower edge stays on the face.
    lm.brows.R = {
      line: BROWS.R.map(([x, y]) => [x, y - 5]),
      halfWidth: 4,
      tailHalfWidth: 4,
    };
    const r = await cut(pink, lm);
    expect(check(r, "brow.R").pass).toBe(true);
    const band = check(r, "browBand.R");
    expect(band).toMatchObject({ level: "warn", pass: false, limit: 0.05 });
    expect(band.value).toBeGreaterThan(0.05);
    const move = band.hint.match(
      /past the band's lower edge by up to \d+ px at x \d+\.\.\d+, and stay on the face when the brow moves: move landmarks\.brows\.R\.line's points over x \d+\.\.\d+ down by about (\d+) px/,
    )!;
    expect(move).not.toBeNull();
    expect(Number(move[1])).toBeGreaterThanOrEqual(2);
    expect(Number(move[1])).toBeLessThanOrEqual(5);
    expect(check(r, "browBand.L").pass).toBe(true);
    expect(r.passed).toBe(true);

    lm.brows.R.line = lm.brows.R.line.map(([x, y]: number[]) => [
      x,
      y + Number(move[1]),
    ]);
    expect(check(await cut(pink, lm), "browBand.R").pass).toBe(true);
  });

  it("leaves the back hair a brow's tail runs under in the hair, none of it in the brow or the face", async () => {
    const colours = PINK_ON_PEACH;
    const r = await cut(await picture(colours, { templeLock: true }));
    const brow = await pixelsOf(layer(r, "brow_L").path);
    const face = await pixelsOf(layer(r, "face").path);
    const back = await pixelsOf(layer(r, "hair_back").path);
    // The lock's middle where it lies over the brow's band, its edges left
    // aside.
    const size = { width: W, height: W };
    const lm = validateLandmarks(characterLandmarks(), size);
    const band = browBand(size, lm.brows!.L!);
    let looked = 0;
    for (let x = TEMPLE_LOCK.x0 + EDGE; x <= 680; x++) {
      for (let y = 340; y <= 400; y++) {
        if (!band[y * W + x]) continue;
        // 4 px inside the lock's edges, rows at this column.
        const top = 368 - ((x - 652) * 36) / 118;
        if (y < top + 4 + EDGE || y > top + 16 - 4 - EDGE) continue;
        looked++;
        expect(brow.at(x, y)[3], `${x},${y}`).toBe(0);
        expect(face.at(x, y)[3], `${x},${y}`).toBe(0);
        expect(back.at(x, y)[3], `${x},${y}`).toBe(255);
        expect(off(back.at(x, y), colours.hair), `${x},${y}`).toBeLessThan(
          NEAR,
        );
      }
    }
    expect(looked).toBeGreaterThan(10);
    // The brow is still cut, short of the lock.
    expect(layer(r, "brow_L").pixels).toBeGreaterThan(500);
  });

  it("gives the body an outline inked in a colour near the hair's, and keeps the wisp beside the neck in the hair", async () => {
    const r = await cut(
      await picture(PINK_ON_PEACH, { bodyInk: [190, 105, 135] }),
    );
    const back = await pixelsOf(layer(r, "hair_back").path);
    const body = await pixelsOf(layer(r, "body").path);
    // Round the torso's outline on its recoloured dashes, away from the
    // neck, where the outline meets the neck's own lines.
    let looked = 0;
    for (let deg = 0; deg < 360; deg += 2) {
      const a = (deg * Math.PI) / 180;
      const x = Math.round(550 + 262 * Math.cos(a));
      const y = Math.round(1000 + 232 * Math.sin(a));
      if (y >= W || !onBodyInkDash(x, y) || Math.abs(x - 550) < 90) continue;
      looked++;
      expect(back.at(x, y)[3], `${x},${y}`).toBe(0);
      expect(body.at(x, y)[3], `${x},${y}`).toBeGreaterThan(200);
    }
    expect(looked).toBeGreaterThan(40);
    const x = WISP.x0 + 1;
    const y = (WISP.y0 + WISP.y1) >> 1;
    expect(back.at(x, y)[3]).toBeGreaterThan(128);
    expect(body.at(x, y)[3]).toBe(0);
  });

  it("leaves a thin stroke crossing an eye box's corner out of the eye, and does not ask for the box to grow along it", async () => {
    const r = await cut(await picture(PINK_ON_PEACH, { eyeStroke: "dashed" }));
    expect(check(r, "opening.R")).toMatchObject({ level: "fail", pass: true });
    // Its first dash, inside the box: on the face, as drawn, not the eye's.
    const [[ax, ay], [bx, by]] = EYE_STROKE.line;
    const len = Math.hypot(bx - ax, by - ay);
    const sclera = await pixelsOf(layer(r, "eye_R").path);
    const face = await pixelsOf(layer(r, "face").path);
    for (const t of [2, 4, 6]) {
      const x = Math.round(ax + ((bx - ax) * t) / len);
      const y = Math.round(ay + ((by - ay) * t) / len);
      expect(sclera.at(x, y)[3], `${x},${y}`).toBe(0);
      expect(face.at(x, y)[3], `${x},${y}`).toBe(255);
      expect(off(face.at(x, y), PINK_ON_PEACH.ink)).toBeLessThan(4 * NEAR);
    }
    expect(r.passed).toBe(true);
  });

  it("says what it sees where a stroke joined to the eye runs on past its box, and warns rather than fails", async () => {
    const r = await cut(await picture(PINK_ON_PEACH, { eyeStroke: "joined" }));
    const opening = check(r, "opening.R");
    expect(opening).toMatchObject({ level: "warn", pass: false, value: 0 });
    expect(opening.hint).toMatch(
      /^landmarks\.eyes\.R\.box's border cuts paint it cannot tell from the eye: the paint its left edge cuts, \d+ px wide at y \d+\.\.\d+, runs on as a stroke more than \d+ px past the box: if it is hair or a line crossing the eye's box, leave that edge .*; if it is the eye's own \(a lash wing\), move x0 left by \d+/,
    );
    expect(check(r, "opening.L").pass).toBe(true);
    expect(r.passed).toBe(true);
  });
});

describe("cutting an iris squarer than its ellipse, and a white shaded under the lash", () => {
  // Left: a disc squarer than an ellipse, outlined in a dark shade of its
  // own colour; right: a grey shade on the white under the lash.
  const colours = PINK_ON_PEACH;
  let file: string;
  let r: Ok;
  beforeAll(async () => {
    file = await picture(colours, {
      eyes: { L: "squareIris", R: "shadedWhite" },
    });
    r = await cut(file);
  }, CUT_HOOK_TIMEOUT);

  it("gives the disc's corners past the ellipse to the iris, not the lower lid", async () => {
    const { cx } = EYE.L;
    const iris = await pixelsOf(layer(r, "iris_L").path);
    const lower = await pixelsOf(layer(r, "lash_lower_L").path);
    // The lower corners, on the dark rim, outside the ellipse the skill's
    // fit gives (the disc's own width and height).
    for (const dx of [-10, 10]) {
      const [x, y] = [cx + dx, EYE.iris.cy + 13];
      expect(
        ((x - cx) / EYE.iris.rx) ** 2 + (13 / EYE.iris.ry) ** 2,
      ).toBeGreaterThan(1);
      expect(iris.at(x, y)[3], `${x},${y}`).toBe(255);
      expect(lower.at(x, y)[3], `${x},${y}`).toBe(0);
    }
    // The lid line itself stays the lower lid's.
    const lid = (EYE.lower.y0 + EYE.lower.y1) >> 1;
    expect(lower.at(cx, lid)[3]).toBe(255);
    expect(check(r, "iris.L").pass).toBe(true);
  });

  it("finds the coloured disc by its own colour, not the white's shade beside it", async () => {
    // An ellipse half the disc's size: the check fails and says what disc
    // it found.
    const lm = characterLandmarks();
    lm.eyes.R.iris.rx = 7;
    lm.eyes.R.iris.ry = 9;
    const iris = check(await cut(file, lm), "iris.R");
    expect(iris.pass).toBe(false);
    const found = iris.hint.match(
      /the disc found spans x (\d+)\.\.(\d+) \(rx about [\d.]+\) and reaches down to y (\d+)/,
    )!;
    const { cx } = EYE.R;
    // The drawn disc, its soft edge aside: not the white's width, and down
    // to the lower lid over its bottom.
    expect(Number(found[1])).toBeGreaterThanOrEqual(cx - EYE.iris.rx - EDGE);
    expect(Number(found[2])).toBeLessThanOrEqual(cx + EYE.iris.rx + EDGE);
    expect(Number(found[3])).toBeGreaterThan(EYE.iris.cy + 9);
    expect(Number(found[3])).toBeLessThanOrEqual(EYE.lower.y1);
  });
});

describe("cutLayersFromIllustration on features it cannot cut", () => {
  it("cuts an eye drawn closed as lash over the sclera's shape, no iris, and warns", async () => {
    const r = await cut(
      await picture(PINK_ON_PEACH, { eyes: { L: "closed" } }),
    );
    const eye = check(r, "eye.L");
    expect(eye).toMatchObject({ level: "warn", pass: false, limit: 0.06 });
    expect(eye.hint).toMatch(/read as drawn closed/);
    expect(eye.hint).toMatch(/is off the iris/);
    expect(check(r, "eye.R").pass).toBe(true);
    const roles = r.layers.map((l) => l.role);
    expect(roles).toContain("eye_L");
    expect(roles).toContain("lash_L");
    expect(roles).not.toContain("iris_L");
    expect(roles).not.toContain("lash_lower_L");
    expect(roles).toContain("iris_R");
    expect(layer(r, "lash_L").pixels).toBe(layer(r, "eye_L").pixels);
    expect(r.passed).toBe(true);
  });

  it("warns on a brow band that holds no brow, and writes no brow layer for it", async () => {
    const lm = characterLandmarks();
    lm.brows.L.line = [
      [660, 505],
      [600, 505],
    ];
    const r = await cut(await picture(PINK_ON_PEACH), lm);
    expect(check(r, "brow.L")).toMatchObject({
      level: "warn",
      pass: false,
      value: 0,
    });
    expect(check(r, "brow.L").hint).toMatch(/the line is off the brow/);
    expect(check(r, "brow.R").pass).toBe(true);
    expect(r.layers.map((l) => l.role)).not.toContain("brow_L");
  });

  it("fails mouth on a mouth box with nothing drawn in it, and writes no mouth", async () => {
    const lm = characterLandmarks();
    lm.mouth = {
      box: [500, 600, 600, 630],
      cornerL: [510, 615],
      cornerR: [590, 615],
    };
    const r = await cut(await picture(PINK_ON_PEACH), lm);
    expect(check(r, "mouth")).toMatchObject({
      level: "fail",
      pass: false,
      value: 0,
    });
    expect(check(r, "mouth").hint).toMatch(
      /move the box onto the drawn mouth, or, for a picture with no mouth drawn, give a generated lip set/,
    );
    expect(r.layers.map((l) => l.role)).not.toContain("mouth");
    expect(r.passed).toBe(false);
  });
});

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
