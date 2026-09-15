import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatTurnReport, measureTurnReference } from "../src/measure-turn";
import {
  AMBER_IRIS,
  FAR_IRIS_W,
  HAIR_LEFT,
  HAIR_RIGHT,
  IRIS_W,
  PLAIN_FRONT,
  PAIR_SHIFT,
  SKEWED_FRONT,
  SKEWED_TURNED,
  headSpanFor,
  writeScaledTurnPair,
  writeSkewedTurnPair,
  writeTurnPair,
} from "./helpers/turn-pair";

/**
 * Fixtures live under the repo's node_modules (gitignored) rather than the
 * system temp dir: `debugDir` is a WRITE target, and writes are confined to the
 * MCP process working directory.
 */
const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-turn-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function measureOk(input: {
  front: string;
  turned: string;
  iris?: { hueMin?: number; hueMax?: number; satMin?: number };
  debugDir?: string;
}) {
  const result = await measureTurnReference(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

/** ±0.02 is the margin a rig's turn is judged to hit, and it also covers the
 *  half-pixel quantisation of an ellipse painted on a 400 px grid. */
function within(actual: number, expected: number, tol = 0.02): void {
  expect(
    Math.abs(actual - expected),
    `${actual} is not within ${tol} of ${expected}`,
  ).toBeLessThanOrEqual(tol);
}

const PLAIN_HEAD = headSpanFor(PLAIN_FRONT);

describe("measureTurnReference", () => {
  it("reports the turn ratios of a synthetic front/turned pair", async () => {
    const { front, turned } = await writeTurnPair(tmpDir());

    const result = await measureOk({ front, turned });

    // The pair slid toward the image's left, so the left eye is the far one.
    expect(result.turnSign).toBe(-1);
    // Both views share one head, so the far/near ratio at rest is 1 and the
    // silhouette does not change. The blob close leaves widths where they are.
    within(result.farEyeRatio, FAR_IRIS_W / IRIS_W);
    within(result.eyeShift, -PAIR_SHIFT / PLAIN_HEAD.half);
    within(result.silhouetteRatio, 1);
    // ...and the raw numbers those came from.
    expect(result.front.irisL.w).toBe(IRIS_W);
    expect(result.turned.irisL.w).toBe(FAR_IRIS_W);
    expect(result.front.head).toEqual({
      left: PLAIN_HEAD.left,
      right: PLAIN_HEAD.right,
      cx: (PLAIN_HEAD.left + PLAIN_HEAD.right) / 2,
      half: PLAIN_HEAD.half,
    });
    expect(result.turned.head).toEqual(result.front.head);
  });

  it("divides out a resting asymmetry and measures against the FRONT head", async () => {
    // Every ratio is non-degenerate here: the front pair is unequal AND sits
    // off the head's centre, the turned head is genuinely narrower, and it sits
    // somewhere else laterally. Drop the front normalisation, divide the shift
    // by the turned head, measure both pairs against the FRONT head's centre,
    // or swap the silhouette operands, and each number lands elsewhere.
    const { front, turned } = await writeSkewedTurnPair(tmpDir());
    const frontHead = headSpanFor(SKEWED_FRONT);
    const turnedHead = headSpanFor(SKEWED_TURNED);

    const result = await measureOk({ front, turned });

    expect(result.turnSign).toBe(-1);
    within(
      result.farEyeRatio,
      SKEWED_TURNED.irisLW /
        SKEWED_TURNED.irisRW /
        (SKEWED_FRONT.irisLW / SKEWED_FRONT.irisRW),
    );
    within(
      result.eyeShift,
      (SKEWED_TURNED.pairOffset - SKEWED_FRONT.pairOffset) / frontHead.half,
    );
    within(result.silhouetteRatio, turnedHead.half / frontHead.half);
    // The turned-only readings, which each of those normalisations removes.
    expect(result.farEyeRatio).not.toBeCloseTo(
      SKEWED_TURNED.irisLW / SKEWED_TURNED.irisRW,
      2,
    );
    expect(result.front.head.half).toBe(frontHead.half);
    expect(result.turned.head.half).toBe(turnedHead.half);
    // The two heads are NOT at the same place, so each image's pair offset has
    // to be taken against its own head centre.
    expect(result.turned.head.cx).not.toBe(result.front.head.cx);
  });

  it("counts near-black hair as head on a transparent render", async () => {
    const { front, turned } = await writeTurnPair(tmpDir(), {
      transparent: true,
      hair: true,
    });

    const result = await measureOk({ front, turned });

    // An engine render is masked by alpha ALONE — its ink-dark hair is part of
    // the silhouette, and the head is wider than the skin ellipse because of it.
    expect(result.front.maskMode).toBe("alpha");
    expect(result.front.head.left).toBe(HAIR_LEFT);
    expect(result.front.head.right).toBe(HAIR_RIGHT);
    // Same head both views, so the extra width cancels in the ratio.
    within(result.silhouetteRatio, 1);
  });

  it("keys a near-black border out of an opaque reference", async () => {
    const { front, turned } = await writeTurnPair(tmpDir(), { border: true });

    const result = await measureOk({ front, turned });

    // No alpha to read: the lavender backdrop and the black frame are keyed by
    // colour, so the border does not become the head's edge.
    expect(result.front.maskMode).toBe("keyed");
    expect(result.front.head.left).toBe(PLAIN_HEAD.left);
    expect(result.front.head.right).toBe(PLAIN_HEAD.right);
  });

  it("refuses a keyed image whose backdrop is not lavender, rather than reading the whole frame as head", async () => {
    const { front, turned } = await writeTurnPair(tmpDir(), {
      wrongBackdrop: true,
    });

    const result = await measureTurnReference({ front, turned });

    // White fails the lavender hue window, so every pixel reads as
    // foreground: the eye-row span would otherwise be the whole image width.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/background not keyed|not an engine render/);
  });

  it("finds an off-default iris colour only through its own window", async () => {
    const { front, turned } = await writeTurnPair(tmpDir(), {
      amberIrises: true,
    });

    // The violet default does not see an amber iris at all.
    const missed = await measureTurnReference({ front, turned });
    expect(missed).toEqual({
      ok: false,
      error: expect.stringContaining("no iris pair found"),
    });

    const result = await measureOk({ front, turned, iris: AMBER_IRIS });
    expect(result.front.irisL.w).toBe(IRIS_W);
    within(result.farEyeRatio, FAR_IRIS_W / IRIS_W);
  });

  it("rejects an inverted iris hue window", async () => {
    const dir = tmpDir();
    const { front, turned } = await writeTurnPair(dir);

    const result = await measureTurnReference({
      front,
      turned,
      iris: { hueMin: 300, hueMax: 230 },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /iris hue window must be 0 <= hueMin < hueMax <= 360, got 300\.\.230/,
      ),
    });
  });

  it("returns ok:false naming the file when no iris pair is found", async () => {
    const dir = tmpDir();
    const { front, turned } = await writeTurnPair(dir, { noIrises: true });

    const result = await measureTurnReference({ front, turned });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(front),
    });
    expect(result.ok ? "" : result.error).toMatch(
      /no iris pair found .* among 0 candidate blobs/,
    );
  });

  it("returns ok:false for a pair at different scales, naming both iris heights", async () => {
    const dir = tmpDir();
    // Same unturned character, but the "turned" image is a 20% bigger redraw
    // — a yaw never changes iris height, so this is a scale/framing mismatch,
    // not a turn. (20%, not the tolerance's own 10%, so the rasterised iris
    // clears the pixel-rounding noise a borderline case would sit in.)
    const { front, turned } = await writeScaledTurnPair(dir, 1.2);

    const result = await measureTurnReference({ front, turned });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not at the same scale/);
    expect(result.error).toMatch(/mean iris height/);
  });

  it("returns ok:false for a missing file and for a missing debugDir", async () => {
    const dir = tmpDir();
    const { front, turned } = await writeTurnPair(dir);
    const missingImage = path.join(dir, "nope.png");

    const missing = await measureTurnReference({
      front: missingImage,
      turned,
    });
    expect(missing).toEqual({
      ok: false,
      error: expect.stringContaining(missingImage),
    });

    const missingDir = path.join(dir, "nope");
    const badDebug = await measureTurnReference({
      front,
      turned,
      debugDir: missingDir,
    });
    expect(badDebug).toEqual({
      ok: false,
      error: expect.stringContaining(missingDir),
    });
  });

  it("writes one debug overlay per image into debugDir", async () => {
    const dir = tmpDir();
    const { front, turned } = await writeTurnPair(dir);
    const debugDir = tmpDir();

    const result = await measureOk({ front, turned, debugDir });

    // Role-prefixed: both inputs here are called front.png/turned.png, but two
    // images that shared a basename would otherwise overwrite each other.
    expect(result.debug).toEqual([
      path.join(debugDir, "front-front.debug.png"),
      path.join(debugDir, "turned-turned.debug.png"),
    ]);
    for (const file of result.debug ?? []) {
      // A real PNG, not a zero-byte placeholder.
      const bytes = fs.readFileSync(file);
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      expect(bytes.length).toBeGreaterThan(1000);
    }
  });
});

describe("formatTurnReport", () => {
  it("prints each ratio with its raw inputs, then a block per image", async () => {
    const { front, turned } = await writeTurnPair(tmpDir());

    const result = await measureOk({ front, turned });
    const text = formatTurnReport(result);
    const lines = text.split("\n");

    expect(lines[0]).toMatch(
      new RegExp(
        `^farEyeRatio +0\\.\\d{3} +far/near iris width ${FAR_IRIS_W}/${IRIS_W} turned`,
      ),
    );
    expect(lines[1]).toMatch(
      new RegExp(
        `^eyeShift .*front head half ${PLAIN_HEAD.half.toFixed(1)} px \\(hh\\)$`,
      ),
    );
    expect(lines[2]).toMatch(/^silhouetteRatio +1\.000/);
    expect(lines[3]).toMatch(/^turnSign +-1 .*image's left/);
    expect(text).toContain(`# front  ${front}  400x400  mask: keyed`);
    expect(text).toContain(`# turned  ${turned}  400x400  mask: keyed`);
    expect(text).toContain(`head ${PLAIN_HEAD.left}..${PLAIN_HEAD.right}`);
  });
});
