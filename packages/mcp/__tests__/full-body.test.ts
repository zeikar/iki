/**
 * The full-body path on script-drawn parts: the composer on a canvas grown
 * downward by `canvasHeight`, and what the measure and the rig make of it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { armGeometry, createLayerSetMeasurer } from "@ikijs/editor";
import { ROLE_TABLE } from "../../editor/src/auto-rig/roles";
import { ARM_WIDTH, SHOULDER_DROP } from "../src/compose-arms";
import {
  CANVAS,
  ORDER,
  composeLayersFromParts,
  type ComposeInput,
  type ComposeResult,
} from "../src/compose";
import { parseIkiModel } from "@ikijs/format";
import { decodePng } from "../src/node-images";
import { autoRigFromLayers } from "../src/tools";
import { ARM_MARK, writeFullBodyParts, writePartsSet } from "./helpers/parts";

const createdDirs: string[] = [];
/** Parts are read-only input, so the fixture lives in the system temp dir. */
function partsDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-full-body-parts-"));
  createdDirs.push(d);
  return d;
}
/** Output must resolve UNDER cwd to satisfy resolveOutputDir; node_modules is
 *  gitignored, matching the tmpDir helpers in compose.test.ts. */
function outDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-full-body-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

type ComposeOk = Extract<ComposeResult, { ok: true }>;

async function composeOk(input: ComposeInput): Promise<ComposeOk> {
  const result = await composeLayersFromParts(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

async function composeError(input: ComposeInput): Promise<string> {
  const result = await composeLayersFromParts(input);
  if (result.ok) throw new Error("expected a failure, got ok");
  return result.error;
}

const TALL = 3650;

describe("compose on a tall canvas", () => {
  let parts: string;
  let square: ComposeOk;
  let tall: ComposeOk;

  beforeAll(async () => {
    parts = partsDir();
    await writePartsSet(parts);
    square = await composeOk({ partsDir: parts, outDir: outDir() });
    tall = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: TALL,
    });
  }, 30_000);

  const layerOf = (result: ComposeOk, role: string) =>
    result.layers.find((l) => l.role === role)!;

  it("composes byte-identically at canvasHeight 1100", async () => {
    const explicit = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: CANVAS,
    });
    expect(explicit.layers.map((l) => l.role)).toEqual(
      square.layers.map((l) => l.role),
    );
    for (const layer of explicit.layers) {
      const bytes = fs.readFileSync(layer.path);
      expect(
        bytes.equals(fs.readFileSync(layerOf(square, layer.role).path)),
        layer.role,
      ).toBe(true);
    }
    expect(
      fs.readFileSync(explicit.preview).equals(fs.readFileSync(square.preview)),
    ).toBe(true);
  });

  it("grows the canvas downward: every part where the square compose puts it", async () => {
    expect(tall.layers.map((l) => l.role)).toEqual(
      square.layers.map((l) => l.role),
    );
    for (const layer of tall.layers) {
      const meta = await sharp(layer.path).metadata();
      expect([meta.width, meta.height], layer.role).toEqual([CANVAS, TALL]);
      const { width, height, left, top } = layerOf(square, layer.role);
      expect(layer, layer.role).toMatchObject({ width, height, left, top });
    }
    const preview = await sharp(tall.preview).metadata();
    expect([preview.width, preview.height]).toEqual([CANVAS, TALL]);

    const tallFace = await decodePng(layerOf(tall, "face").path);
    const squareFace = await decodePng(layerOf(square, "face").path);
    const squareBytes = CANVAS * CANVAS * 4;
    expect(tallFace.rgba.subarray(0, squareBytes).equals(squareFace.rgba)).toBe(
      true,
    );
    const below = tallFace.rgba.subarray(squareBytes);
    let opaque = 0;
    for (let i = 3; i < below.length; i += 4) if (below[i] !== 0) opaque++;
    expect(opaque).toBe(0);
  });

  it("bounds w by the width and h by the height", async () => {
    const stretched = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: TALL,
      layout: { body: { h: 2000 } },
    });
    expect(layerOf(stretched, "body").height).toBe(2000);

    expect(
      await composeError({
        partsDir: parts,
        outDir: outDir(),
        canvasHeight: TALL,
        layout: { body: { h: TALL + 1 } },
      }),
    ).toBe(`layout.body.h must be an integer in 1..${TALL}, got ${TALL + 1}`);
    expect(
      await composeError({
        partsDir: parts,
        outDir: outDir(),
        canvasHeight: TALL,
        layout: { body: { w: CANVAS + 1 } },
      }),
    ).toBe(
      `layout.body.w must be an integer in 1..${CANVAS}, got ${CANVAS + 1}`,
    );
  });

  it("fits a part taller than 1100 that the square canvas refuses", async () => {
    // compose.test.ts's strip face: a 4x100 part scaled to 100px wide is
    // 2500px tall.
    const strip = partsDir();
    await writePartsSet(strip);
    const rgba = Buffer.alloc(20 * 120 * 4);
    for (let y = 10; y < 110; y++) {
      for (let x = 8; x < 12; x++) {
        const i = (y * 20 + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 30;
        rgba[i + 3] = 255;
      }
    }
    await sharp(rgba, { raw: { width: 20, height: 120, channels: 4 } })
      .png()
      .toFile(path.join(strip, "face.png"));
    const layout = { face: { w: 100 } };

    expect(
      await composeError({ partsDir: strip, outDir: outDir(), layout }),
    ).toBe(`layout.face.w: resized part 100x2500 exceeds the ${CANVAS} canvas`);
    const result = await composeOk({
      partsDir: strip,
      outDir: outDir(),
      canvasHeight: TALL,
      layout,
    });
    expect(layerOf(result, "face")).toMatchObject({
      width: 100,
      height: 2500,
    });
  });

  it("places a part below row 1100, and refuses one past the last row", async () => {
    const low = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: TALL,
      layout: { body: { cy: 3000 } },
    });
    const body = layerOf(low, "body");
    expect(body.top).toBe(Math.round(3000 - body.height / 2));
    expect(body.top).toBeGreaterThan(CANVAS);

    // Its top on the row past the last one: the part misses the canvas.
    const error = await composeError({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: TALL,
      layout: { body: { cy: TALL + body.height / 2 } },
    });
    expect(error).toBe(
      `layout.body.cx/cy: the placed part (${body.width}x${body.height} at ${body.left},${TALL}) ` +
        `falls entirely outside the ${CANVAS}x${TALL} canvas`,
    );
  });

  it.each([3651, 1098, 4098, 3650.5])(
    "refuses canvasHeight %s before decoding anything",
    async (canvasHeight) => {
      // An empty parts dir: anything decoded first would fail on the
      // missing eyewhite instead.
      const error = await composeError({
        partsDir: partsDir(),
        outDir: outDir(),
        canvasHeight,
      });
      expect(error).toBe(
        `canvasHeight must be an even integer in 1100..4096, got ${canvasHeight}`,
      );
    },
  );
});

describe("arms", () => {
  // The full body's torso is 160x600 trimmed: at w 600 it is 2250 tall, and
  // cy 1585 puts its top at row 460, under the face.
  const body = { w: 600, cy: 1585 };
  let parts: string;
  let composed: ComposeOk;

  beforeAll(async () => {
    parts = partsDir();
    await writeFullBodyParts(parts);
    composed = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: TALL,
      layout: { body },
    });
  }, 30_000);

  const layerOf = (result: ComposeOk, role: string) =>
    result.layers.find((l) => l.role === role)!;

  /** The mean column of a composed layer's pixels near ARM_MARK. */
  async function markColumn(layerPath: string): Promise<number> {
    const { rgba, width } = await decodePng(layerPath);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] <= 128) continue;
      if (![0, 1, 2].every((c) => Math.abs(rgba[i + c] - ARM_MARK[c]) <= 8))
        continue;
      sum += (i / 4) % width;
      n++;
    }
    if (n === 0) throw new Error("no pixel near ARM_MARK");
    return sum / n;
  }

  /** A composed arm's shoulder pivot as the rig reads it, in canvas px
   *  (pixel x covers [x, x + 1)). */
  async function shoulderOf(result: ComposeOk, role: "arm_L" | "arm_R") {
    const { rgba } = await decodePng(layerOf(result, role).path);
    const layer = createLayerSetMeasurer({ width: CANVAS, height: TALL }).add({
      role,
      fileName: "arm.png",
      rgba,
    })!;
    const { shoulder } = armGeometry(layer, 0);
    return { x: shoulder.x + CANVAS / 2, y: TALL / 2 - shoulder.y };
  }

  it("draws in ROLE_TABLE's order", () => {
    const roles = ROLE_TABLE.map((r) => r.role);
    for (const role of ORDER) expect(roles, role).toContain(role);
    expect(roles.filter((r) => (ORDER as string[]).includes(r))).toEqual(ORDER);
  });

  it("composes arm_R as drawn and arm_L mirrored, and flips both under mirrorParts", async () => {
    // arm.png is the arm on the screen left, its mark in its left half.
    const flipped = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: TALL,
      layout: { body },
      mirrorParts: ["arm.png"],
    });
    for (const [result, sign] of [
      [composed, 1],
      [flipped, -1],
    ] as const) {
      for (const [role, side] of [
        ["arm_R", -1],
        ["arm_L", 1],
      ] as const) {
        const layer = layerOf(result, role);
        const mark = await markColumn(layer.path);
        expect(
          Math.sign(mark - (layer.left + layer.width / 2)),
          `${role}, mirrored: ${sign === -1}`,
        ).toBe(side * sign);
      }
    }
  });

  it("hangs each arm's shoulder pivot on the body box's shoulder corner", async () => {
    const box = layerOf(composed, "body");
    expect(box.width).toBe(body.w);
    const cornerY = box.top + SHOULDER_DROP * box.height;
    for (const [role, cornerX] of [
      ["arm_R", box.left],
      ["arm_L", box.left + box.width],
    ] as const) {
      expect(layerOf(composed, role).width, role).toBe(
        Math.round(ARM_WIDTH * box.width),
      );
      const pivot = await shoulderOf(composed, role);
      expect(Math.abs(pivot.x - cornerX), role).toBeLessThanOrEqual(1);
      expect(Math.abs(pivot.y - cornerY), role).toBeLessThanOrEqual(1);
    }
  });

  it("centres an arm on a set cx/cy and sizes it to a set w", async () => {
    const result = await composeOk({
      partsDir: parts,
      outDir: outDir(),
      canvasHeight: TALL,
      layout: {
        body,
        arm_R: { cx: 300, cy: 1500, w: 100 },
        arm_L: { w: 100 },
      },
    });
    const armR = layerOf(result, "arm_R");
    expect(armR.width).toBe(100);
    expect([armR.left, armR.top]).toEqual([
      250,
      Math.round(1500 - armR.height / 2),
    ]);
    // A set w alone leaves the pivot on the corner.
    const box = layerOf(result, "body");
    expect(layerOf(result, "arm_L").width).toBe(100);
    const pivot = await shoulderOf(result, "arm_L");
    expect(Math.abs(pivot.x - (box.left + box.width))).toBeLessThanOrEqual(1);
    expect(
      Math.abs(pivot.y - (box.top + SHOULDER_DROP * box.height)),
    ).toBeLessThanOrEqual(1);
  });

  it("leaves a bust's skipped list as it was, and removes an earlier compose's arms", async () => {
    const dir = partsDir();
    await writeFullBodyParts(dir);
    const out = outDir();
    const input = {
      partsDir: dir,
      outDir: out,
      canvasHeight: TALL,
      layout: { body },
    };
    const withArms = await composeOk(input);
    expect(withArms.layers.map((l) => l.role)).toEqual(
      expect.arrayContaining(["arm_L", "arm_R"]),
    );

    fs.rmSync(path.join(dir, "arm.png"));
    const result = await composeOk(input);
    for (const role of ["arm_L", "arm_R"]) {
      expect(fs.existsSync(path.join(out, `${role}.png`)), role).toBe(false);
    }
    expect(result.layers.filter((l) => l.role.startsWith("arm_"))).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("refuses an arm without a body, and an arm too short to rig", async () => {
    const noBody = partsDir();
    await writeFullBodyParts(noBody);
    fs.rmSync(path.join(noBody, "body.png"));
    expect(
      await composeError({
        partsDir: noBody,
        outDir: outDir(),
        canvasHeight: TALL,
      }),
    ).toMatch(/^arm\.png: an arm needs body\.png/);

    const squat = partsDir();
    await writeFullBodyParts(squat, { arm: "squat" });
    // arm_L is placed first in ORDER.
    expect(
      await composeError({
        partsDir: squat,
        outDir: outDir(),
        canvasHeight: TALL,
        layout: { body },
      }),
    ).toMatch(/^layout\.arm_L: .*layer "arm\.png": the arm is too short/);
  });
});

describe("end to end", () => {
  it("composes, measures and rigs a 1100x3650 full body with arms", async () => {
    const parts = partsDir();
    await writeFullBodyParts(parts);
    const out = outDir();
    // The torso is 160x600 trimmed: at w 600 it is 2250 tall, and cy 1585
    // puts its top at row 460, under the face, and its feet at row 2710, with
    // 940 rows of margin under them.
    const composed = await composeOk({
      partsDir: parts,
      outDir: out,
      canvasHeight: TALL,
      layout: { body: { w: 600, cy: 1585 } },
    });
    expect(composed.layers).toHaveLength(21);

    const bad = composed.measure.warnings.filter(
      (w) => w.startsWith("arm_") || w.startsWith("body:"),
    );
    expect(bad).toEqual([]);

    const rigged = await autoRigFromLayers({
      layers: composed.layers.map((l) => ({ path: l.path })),
      outputPath: path.join(out, "full-body.iki"),
    });
    if (!rigged.ok) throw new Error(`rig failed: ${rigged.error}`);
    expect(rigged.canvas).toEqual({ width: CANVAS, height: TALL });

    const model = parseIkiModel(
      JSON.parse(fs.readFileSync(rigged.path, "utf8")),
    );
    const partIds = model.parts.map((p) => p.id);
    expect(partIds).toEqual(
      expect.arrayContaining(["elbow_L", "forearm_L", "elbow_R", "forearm_R"]),
    );
    for (const part of model.parts) {
      expect(part.texture, part.id).toBeDefined();
    }
    for (const texture of model.textures ?? []) {
      const meta = await sharp(
        Buffer.from(
          texture.source.slice("data:image/png;base64,".length),
          "base64",
        ),
      ).metadata();
      expect(meta.width!).toBeLessThanOrEqual(4096);
      expect(meta.height!).toBeLessThanOrEqual(4096);
    }

    const box = composed.layers.find((l) => l.role === "body")!;
    const cornerY = box.top + SHOULDER_DROP * box.height;
    for (const [id, cornerX] of [
      ["armDeformer_R", box.left],
      ["armDeformer_L", box.left + box.width],
    ] as const) {
      const pivot = model.deformers!.find((d) => d.id === id)!.pivot;
      expect(Math.abs(pivot.x + CANVAS / 2 - cornerX), id).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(TALL / 2 - pivot.y - cornerY), id).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});
