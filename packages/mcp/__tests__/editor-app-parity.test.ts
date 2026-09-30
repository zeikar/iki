import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { parseIkiModel, type IkiModel } from "@ikijs/format";
import {
  generateIkiFromLayerSet,
  type LayerInput,
  type TurnSolveReport,
} from "@ikijs/editor";
import { autoRigFromLayers } from "../src/tools";
import { decodePng } from "../src/node-images";
// The editor app's import, by relative path: `sharp` resolves only from this
// package, so this is the one place both hosts can be handed the same RGBA.
import { buildLayerInputs } from "../../../examples/editor/src/auto-rig-image";

// Both auto-rig hosts decode differently — the editor app with a canvas, this
// package with sharp — and must rig the same pixels the same way. Here the app
// is handed exactly the RGBA sharp decoded, through a stubbed canvas, and its
// rig is compared with the one auto_rig_from_layers writes.

const CANVAS = 100;

// Temp dirs live UNDER cwd (node_modules is gitignored) so they satisfy the
// tool's output-path confinement to the working directory; cleaned up after.
const createdDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-app-parity-"),
  );
  createdDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  rgb?: { r: number; g: number; b: number };
  /** Fraction 0..1; defaults to fully opaque. */
  alpha?: number;
}

/** A full-canvas transparent PNG with the given overlays composited on it. */
async function writeLayer(
  dir: string,
  name: string,
  overlays: { input: Buffer; left: number; top: number }[],
): Promise<string> {
  const filePath = path.join(dir, name);
  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(overlays)
    .png()
    .toFile(filePath);
  return filePath;
}

/** A full-canvas transparent PNG with opaque (or `alpha`) rects on it. */
async function writeRects(
  dir: string,
  name: string,
  rects: Rect[],
): Promise<string> {
  const overlays = await Promise.all(
    rects.map(async (rect) => ({
      input: await sharp({
        create: {
          width: rect.w,
          height: rect.h,
          channels: 4,
          background: {
            ...(rect.rgb ?? { r: 200, g: 120, b: 60 }),
            alpha: rect.alpha ?? 1,
          },
        },
      })
        .png()
        .toBuffer(),
      left: rect.x,
      top: rect.y,
    })),
  );
  return writeLayer(dir, name, overlays);
}

/**
 * A layer set that exercises every field the measurement hands the rig:
 * - a face tapering to its chin (60 px wide down to its middle, then a
 *   straight taper to a 10 px chin), so its `rowHalfWidths` vary by row;
 * - eyes, and irises inside them;
 * - near-black bangs painted as two side strands (columns 10..27 and 72..89,
 *   rows 25..55), wider than the face plate at the eye row, so the head
 *   half-width is applied with its `headEdges`, and each iris measures its
 *   side's `strandEdges` against the strand outward of it;
 * - a soft nose, a feather at alpha 0.3 around an opaque 8×8 core, so its
 *   `denseCore` is set and the turn is solved;
 * - a mouth.
 */
async function writeLayerSet(dir: string): Promise<string[]> {
  const jaw = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="68">` +
      `<polygon points="0,0 60,0 60,34 35,68 25,68 0,34" ` +
      `fill="rgb(200,120,60)"/></svg>`,
  );
  const ink = { r: 8, g: 6, b: 10 };
  return [
    await writeLayer(dir, "face.png", [{ input: jaw, left: 20, top: 16 }]),
    await writeRects(dir, "eye_L.png", [{ x: 30, y: 35, w: 12, h: 8 }]),
    await writeRects(dir, "eye_R.png", [{ x: 58, y: 35, w: 12, h: 8 }]),
    await writeRects(dir, "iris_L.png", [{ x: 33, y: 36, w: 6, h: 6 }]),
    await writeRects(dir, "iris_R.png", [{ x: 61, y: 36, w: 6, h: 6 }]),
    await writeRects(dir, "nose.png", [
      { x: 40, y: 40, w: 18, h: 18, alpha: 0.3 },
      { x: 46, y: 44, w: 8, h: 8 },
    ]),
    await writeRects(dir, "mouth.png", [{ x: 42, y: 60, w: 16, h: 8 }]),
    await writeRects(dir, "hair_front.png", [
      { x: 10, y: 25, w: 18, h: 31, rgb: ink },
      { x: 72, y: 25, w: 18, h: 31, rgb: ink },
    ]),
  ];
}

/** What the app's canvas reads back: a decoded bitmap's size and pixels. */
interface FakeBitmap {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/**
 * Stub `document` so every canvas the app creates reads back, through
 * `getImageData`, the RGBA of the last bitmap drawn on it — the bytes sharp
 * decoded. Undone after each test.
 */
function stubCanvas(): void {
  vi.stubGlobal("document", {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`unexpected element <${tag}>`);
      let drawn: FakeBitmap | undefined;
      const context = {
        drawImage(bitmap: FakeBitmap, x: number, y: number) {
          if (x !== 0 || y !== 0) throw new Error("drawn off the origin");
          drawn = bitmap;
        },
        getImageData(x: number, y: number, w: number, h: number) {
          if (
            drawn === undefined ||
            x !== 0 ||
            y !== 0 ||
            w !== drawn.width ||
            h !== drawn.height
          ) {
            throw new Error("read back other than the drawn bitmap");
          }
          return { data: drawn.rgba };
        },
      };
      return {
        width: 0,
        height: 0,
        getContext: (kind: string) => (kind === "2d" ? context : null),
      };
    },
  });
}

/** The app's side: decode each file to the same RGBA sharp gives this
 *  package, as a bitmap the stubbed canvas reads back. */
async function decodeForApp(
  paths: string[],
): Promise<{ fileName: string; bitmap: ImageBitmap }[]> {
  const decoded: { fileName: string; bitmap: ImageBitmap }[] = [];
  for (const p of paths) {
    const png = await decodePng(p);
    const bitmap: FakeBitmap = {
      width: png.width,
      height: png.height,
      rgba: new Uint8ClampedArray(png.rgba),
    };
    decoded.push({
      fileName: path.basename(p),
      bitmap: bitmap as unknown as ImageBitmap,
    });
  }
  return decoded;
}

/**
 * A model with the atlas taken off: `textures`, each part's `texture`, and
 * each mesh's `uvs` — the only fields `EditorDocument.applyAtlas` writes, which
 * the app applies after the rig and this package before writing it. Parsed and
 * JSON round-tripped first, as the written model was.
 */
function withoutAtlas(model: unknown): unknown {
  const parsed = JSON.parse(JSON.stringify(parseIkiModel(model))) as IkiModel;
  const { textures: _textures, ...rest } = parsed;
  return {
    ...rest,
    parts: parsed.parts.map(({ texture: _texture, mesh, ...part }) => {
      if (mesh === undefined) return part;
      const { uvs: _uvs, ...geometry } = mesh;
      return { ...part, mesh: geometry };
    }),
  };
}

describe("the editor app's layer import and auto_rig_from_layers", () => {
  it("rig the same decoded RGBA identically", async () => {
    const dir = tmpDir();
    const paths = await writeLayerSet(dir);
    const out = path.join(dir, "model.iki");

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: out,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written: unknown = JSON.parse(fs.readFileSync(out, "utf8"));

    stubCanvas();
    const decoded = await decodeForApp(paths);
    const measured = buildLayerInputs(decoded);
    const { layers, turnOptions } = measured;
    let report: TurnSolveReport | undefined;
    // The store's call, plus a hook for the turn report.
    const model = generateIkiFromLayerSet(
      layers,
      { width: layers[0].canvasW, height: layers[0].canvasH },
      {
        ...turnOptions,
        onTurnSolved: (r) => {
          report = r;
        },
      },
    );

    // The fixture exercises every field the measurement hands the rig.
    expect(result.headHalfWidthApplied).toBe(true);
    expect(result.strandEdges?.left).toBeDefined();
    expect(result.strandEdges?.right).toBeDefined();
    expect(result.noseCore).toBeDefined();
    expect(result.turn).toBeDefined();
    const face = layers.find((l) => l.role === "face")!;
    expect(new Set(face.rowHalfWidths).size).toBeGreaterThan(1);

    // The app measured what this package measured...
    expect(measured.headHalfWidth).toBe(result.headHalfWidth);
    expect(measured.headHalfWidthApplied).toBe(result.headHalfWidthApplied);
    expect(turnOptions.headEdges).toEqual(result.headEdges);
    expect(turnOptions.strandEdges).toEqual(result.strandEdges);
    expect(layers.find((l) => l.role === "nose")!.denseCore).toEqual(
      result.noseCore,
    );
    // ...solved the same turn...
    expect(report).toEqual(result.turn);
    // ...and rigged the same model, but for the atlas.
    expect(withoutAtlas(model)).toEqual(withoutAtlas(written));

    // Negative control: the app's import before it measured — the same crops,
    // without the face profile, the nose core or the turn options — rigs a
    // different model, so the comparison above can tell them apart.
    const unmeasured = layers.map(
      ({ rowHalfWidths: _rows, denseCore: _core, ...layer }): LayerInput =>
        layer,
    );
    const before = generateIkiFromLayerSet(unmeasured, {
      width: CANVAS,
      height: CANVAS,
    });
    expect(withoutAtlas(before)).not.toEqual(withoutAtlas(written));
  });
});
