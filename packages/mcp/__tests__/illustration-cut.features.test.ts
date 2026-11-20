import { afterAll, describe, expect, it, vi } from "vitest";
import { browBand } from "../src/illustration-labels";
import { validateLandmarks } from "../src/illustration-landmarks";
import {
  BROWS,
  characterLandmarks,
  EYE_STROKE,
  NECK_TIPS,
  onBodyInkDash,
  PINK_ON_PEACH,
  TEMPLE_LOCK,
  WISP,
} from "./helpers/illustration-character";
import {
  removeCutDirs,
  picture,
  cut,
  check,
  layer,
  pixelsOf,
  W,
  CUT_HOOK_TIMEOUT,
  off,
  NEAR,
  EDGE,
} from "./helpers/illustration-cut";

afterAll(removeCutDirs);
// A test here may cut several times; a CI runner takes a few seconds a cut.
vi.setConfig({ testTimeout: CUT_HOOK_TIMEOUT });

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
