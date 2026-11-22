import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import sharp from "sharp";
import { fillHoles } from "../src/illustration";
import { browBand } from "../src/illustration-labels";
import { validateLandmarks } from "../src/illustration-landmarks";
import {
  characterLandmarks,
  EYE,
  inBrow,
  inLash,
  ORANGE_ON_WARM,
  PINK_ON_PEACH,
  STRAND,
  TORSO_BODY_ONLY,
  WISP,
} from "./helpers/illustration-character";
import {
  removeCutDirs,
  type Ok,
  picture,
  cut,
  check,
  layer,
  part,
  pixelsOf,
  stackOf,
  W,
  CUT_HOOK_TIMEOUT,
  off,
  NEAR,
  EDGE,
  COLOURINGS,
} from "./helpers/illustration-cut";

afterAll(removeCutDirs);
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

/** Inside the ellipse of the iris drawn about `cx`, `inset` px in. */
const inIris = (cx: number, x: number, y: number, inset = 0) =>
  ((x - cx) / (EYE.iris.rx - inset)) ** 2 +
    ((y - EYE.iris.cy) / (EYE.iris.ry - inset)) ** 2 <=
  1;

const SIDES = [
  ["L", EYE.L],
  ["R", EYE.R],
] as const;

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

describe("cutting eyes whose lash misleads its thickness", () => {
  // Both irises as dark as the lash at their top. Right: a flick rising from
  // the lash either side of the iris, over the columns the lash's thickness
  // is read on; left: a lighter streak drawn along the lash.
  let r: Ok;
  beforeAll(async () => {
    r = await cut(
      await picture(PINK_ON_PEACH, {
        eyes: { L: "streakedLash", R: "flickedLash" },
      }),
    );
  }, CUT_HOOK_TIMEOUT);

  it.each([
    ["R", "under a flick"],
    ["L", "through a streak"],
  ] as const)(
    "reads the lash's thickness %s %s, so the lash over a dark iris top stays the lash's",
    async (side) => {
      const { cx } = EYE[side];
      const lash = await pixelsOf(layer(r, `lash_${side}`).path);
      const iris = await pixelsOf(layer(r, `iris_${side}`).path);
      // In the ellipse and in the lash's drawn rows.
      for (const [x, y] of [
        [cx - 4, 417],
        [cx - 4, 418],
        [cx - 8, 419],
      ]) {
        expect(lash.at(x, y)[3], `${x},${y}`).toBe(255);
      }
      // Below the lash's drawn bottom, the dark top is the iris's.
      for (const x of [cx - 8, cx - 4]) {
        for (const y of [422, 424]) {
          expect(lash.at(x, y)[3], `${x},${y}`).toBe(0);
          expect(iris.at(x, y)[3], `${x},${y}`).toBe(255);
        }
      }
      expect(check(r, `iris.${side}`)).toMatchObject({ pass: true });
      expect(check(r, `iris.${side}`).value).toBeGreaterThan(0.8);
    },
  );
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
