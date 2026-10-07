/**
 * The full-body path on script-drawn parts: the composer on a canvas grown
 * downward by `canvasHeight`, and what the measure and the rig make of it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  CANVAS,
  composeLayersFromParts,
  type ComposeInput,
  type ComposeResult,
} from "../src/compose";
import { decodePng } from "../src/node-images";
import { writePartsSet } from "./helpers/parts";

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
