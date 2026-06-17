import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  IKI_FORMAT_VERSION,
  StandardParameter,
  parseIkiModel,
} from "@iki/format";
import {
  validateIki,
  describeIki,
  listStandardParameters,
  autoRigFromLayers,
} from "../src/tools";

// Minimal valid model used across several tests.
function validModel() {
  return {
    version: IKI_FORMAT_VERSION,
    name: "test-model",
    canvas: { width: 800, height: 600 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    parts: [
      {
        id: "part1",
        color: [1, 1, 1, 1] as [number, number, number, number],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
      },
    ],
  };
}

// Warp deformer grid helpers (cols=2, rows=1 → 6 control points)
const WARP_GRID_POINTS = [-10, 10, 0, 10, 10, 10, -10, -10, 0, -10, 10, -10];

function warpChildMesh() {
  return {
    vertices: [0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  };
}

describe("validateIki", () => {
  it("returns {ok:true} for a valid model object", () => {
    expect(validateIki(validModel())).toEqual({ ok: true });
  });

  it("returns {ok:false} for invalid model (parts[0].order = NaN)", () => {
    const invalidModel = {
      ...validModel(),
      parts: [{ ...validModel().parts[0], order: NaN }],
    };

    // Capture the exact error message thrown by parseIkiModel.
    let exactMessage: string;
    try {
      parseIkiModel(invalidModel);
      throw new Error("expected parseIkiModel to throw");
    } catch (e) {
      exactMessage = (e as Error).message;
    }

    expect(validateIki(invalidModel)).toEqual({
      ok: false,
      error: exactMessage,
    });
  });

  it("returns {ok:true} for a valid JSON string", () => {
    expect(validateIki(JSON.stringify(validModel()))).toEqual({ ok: true });
  });

  it("returns {ok:false} for invalid JSON string with error starting 'invalid JSON:'", () => {
    const result = validateIki("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^invalid JSON:/);
    }
  });
});

describe("describeIki", () => {
  it("returns {ok:false,error} for invalid model", () => {
    const result = describeIki({ version: IKI_FORMAT_VERSION });
    expect(result.ok).toBe(false);
  });

  it("summarises a model with a matrix deformer parent and a 1D-warp child deformer", () => {
    const model = {
      ...validModel(),
      deformers: [
        // root matrix deformer
        {
          kind: undefined,
          id: "head",
          pivot: { x: 0, y: 0 },
        },
        // warp deformer child of head with 1D warp
        {
          kind: "warp",
          id: "faceWarp",
          parent: "head",
          grid: { cols: 2, rows: 1, points: WARP_GRID_POINTS },
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: -1, offsets: Array(12).fill(0) },
                { value: 1, offsets: Array(12).fill(0.5) },
              ],
            },
          ],
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };

    const result = describeIki(model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { summary } = result;
    expect(summary.name).toBe("test-model");
    expect(summary.canvas).toEqual({ width: 800, height: 600 });
    expect(summary.parameters).toEqual([
      { id: "ParamA", min: -1, max: 1, default: 0 },
    ]);
    expect(summary.parts).toEqual([
      { id: "part1", order: 0, deformer: "faceWarp" },
    ]);

    expect(summary.deformers).toHaveLength(2);

    const matDef = summary.deformers.find((d) => d.id === "head")!;
    expect(matDef.kind).toBe("matrix");
    expect(matDef.parent).toBeUndefined();
    expect(matDef.warp).toBeUndefined();

    const warpDef = summary.deformers.find((d) => d.id === "faceWarp")!;
    expect(warpDef.kind).toBe("warp");
    expect(warpDef.parent).toBe("head");
    expect(warpDef.warp).toEqual({ mode: "1d", parameters: ["ParamA"] });
  });

  it("summarises a model with a 2D-warp deformer", () => {
    // Need two parameters for the 2D warp axes.
    const model = {
      ...validModel(),
      parameters: [
        { id: "ParamX", min: -30, max: 30, default: 0 },
        { id: "ParamY", min: -30, max: 30, default: 0 },
      ],
      deformers: [
        {
          kind: "warp",
          id: "face2D",
          grid: { cols: 2, rows: 1, points: WARP_GRID_POINTS },
          warp2d: {
            parameter: "ParamX",
            parameterY: "ParamY",
            valuesX: [-30, 0, 30],
            valuesY: [-30, 30],
            // 3 * 2 = 6 keyforms, each with 12 offsets (6 points * 2)
            keyforms2d: Array(6).fill({ offsets: Array(12).fill(0) }),
          },
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "face2D",
          mesh: warpChildMesh(),
        },
      ],
    };

    const result = describeIki(model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { summary } = result;
    expect(summary.deformers).toHaveLength(1);
    const warpDef = summary.deformers[0];
    expect(warpDef.kind).toBe("warp");
    expect(warpDef.parent).toBeUndefined();
    expect(warpDef.warp).toEqual({
      mode: "2d",
      parameterX: "ParamX",
      parameterY: "ParamY",
      gridX: 2,
      gridY: 1,
    });
  });
});

describe("listStandardParameters", () => {
  it("returns exactly 14 entries", () => {
    expect(listStandardParameters()).toHaveLength(14);
  });

  it("ids match the full set of StandardParameter values", () => {
    const ids = listStandardParameters().map((p) => p.id);
    expect(new Set(ids)).toEqual(new Set(Object.values(StandardParameter)));
  });

  it("every entry has a non-empty description", () => {
    for (const p of listStandardParameters()) {
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe("autoRigFromLayers", () => {
  const CANVAS = 100;

  // Write a full-canvas transparent PNG with one opaque rect (so the layer has a
  // real alpha bbox). `dims` overrides the canvas size for the mismatch test.
  async function writeLayerPng(
    dir: string,
    name: string,
    rect: { x: number; y: number; w: number; h: number } | null,
    dims: { w: number; h: number } = { w: CANVAS, h: CANVAS },
  ): Promise<string> {
    const filePath = path.join(dir, name);
    let page = sharp({
      create: {
        width: dims.w,
        height: dims.h,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    });
    if (rect !== null) {
      const overlay = await sharp({
        create: {
          width: rect.w,
          height: rect.h,
          channels: 4,
          background: { r: 200, g: 120, b: 60, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      page = page.composite([{ input: overlay, left: rect.x, top: rect.y }]);
    }
    await page.png().toFile(filePath);
    return filePath;
  }

  // The four required roles at distinct locations.
  async function writeRequiredLayers(dir: string): Promise<string[]> {
    return [
      await writeLayerPng(dir, "face.png", { x: 20, y: 20, w: 60, h: 60 }),
      await writeLayerPng(dir, "eye_L.png", { x: 30, y: 35, w: 12, h: 8 }),
      await writeLayerPng(dir, "eye_R.png", { x: 58, y: 35, w: 12, h: 8 }),
      await writeLayerPng(dir, "mouth.png", { x: 42, y: 60, w: 16, h: 8 }),
    ];
  }

  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "iki-mcp-autorig-"));
  }

  it("produces a renderable validated .iki with an embedded base64 PNG atlas", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outPath = path.join(dir, "model.iki");

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: outPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(outPath);
    expect(result.canvas).toEqual({ width: CANVAS, height: CANVAS });
    expect(result.partCount).toBeGreaterThan(0);
    expect(result.atlasBytes).toBeGreaterThan(0);

    // The written file re-validates and carries a base64 PNG data-URI texture.
    const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const model = parseIkiModel(written);
    expect(model.textures.length).toBe(1);
    expect(model.textures[0].source.startsWith("data:image/png;base64,")).toBe(
      true,
    );
    expect(model.parts.length).toBeGreaterThan(0);
  });

  it("returns { ok:false } (not a throw) for a missing input path", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    paths[1] = path.join(dir, "does-not-exist.png");

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/);
    expect(fs.existsSync(path.join(dir, "model.iki"))).toBe(false);
  });

  it("returns { ok:false } for a non-PNG file (jpeg)", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    // Overwrite eye_R.png with JPEG bytes.
    await sharp({
      create: {
        width: CANVAS,
        height: CANVAS,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .jpeg()
      .toFile(paths[2]);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/non-PNG/);
  });

  it("returns { ok:false } for mismatched canvas sizes, naming the layer", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    // Re-write mouth.png at a different canvas size.
    await writeLayerPng(
      dir,
      "mouth.png",
      { x: 5, y: 5, w: 10, h: 10 },
      { w: 80, h: 80 },
    );

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/mouth\.png/);
    expect(result.error).toMatch(/differs from canvas/);
  });

  it("returns { ok:false } for a fully-transparent layer", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    // Re-write mouth.png as fully transparent (no opaque rect).
    await writeLayerPng(dir, "mouth.png", null);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/empty after alpha threshold/);
    expect(result.error).toMatch(/mouth/);
  });

  it("returns { ok:false } for an unknown role filename", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const banana = await writeLayerPng(dir, "banana.png", {
      x: 10,
      y: 10,
      w: 8,
      h: 8,
    });

    const result = await autoRigFromLayers({
      layers: [...paths, banana].map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("returns { ok:false } when the output directory does not exist (no file written)", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outPath = path.join(dir, "nope", "model.iki");

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: outPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/output directory does not exist/);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("returns { ok:false } when the layer count exceeds the limit", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    // 65 entries (> MAX_LAYERS = 64) all pointing at the valid face layer.
    const many = Array.from({ length: 65 }, () => ({ path: paths[0] }));

    const result = await autoRigFromLayers({
      layers: many,
      outputPath: path.join(dir, "model.iki"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too many layers/);
  });

  it("returns { ok:false } when the output path does not end in .iki", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outPath = path.join(dir, "model.json");

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: outPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/must end in \.iki/);
    expect(fs.existsSync(outPath)).toBe(false);
  });
});
