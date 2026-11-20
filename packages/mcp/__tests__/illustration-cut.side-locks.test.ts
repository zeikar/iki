import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import sharp from "sharp";
import { bridges } from "../src/illustration-labels";
import {
  characterLandmarks,
  PINK_ON_PEACH,
  sideLockLandmarks,
  TORSO_BODY_ONLY,
} from "./helpers/illustration-character";
import {
  removeCutDirs,
  type Ok,
  picture,
  cut,
  check,
  layer,
  pixelsOf,
  coverAt,
  stackOf,
  W,
  CUT_HOOK_TIMEOUT,
  off,
  NEAR,
  COLOURINGS,
} from "./helpers/illustration-cut";

afterAll(removeCutDirs);
// A test here may cut several times; a CI runner takes a few seconds a cut.
vi.setConfig({ testTimeout: CUT_HOOK_TIMEOUT });

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
