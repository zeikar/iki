import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  IKI_FORMAT_VERSION,
  StandardParameter,
  parseIkiModel,
} from "@ikijs/format";
import {
  validateIki,
  describeIki,
  listStandardParameters,
  autoRigFromLayers,
  type AutoRigTurnTargets,
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
  it("returns exactly 15 entries", () => {
    expect(listStandardParameters()).toHaveLength(16);
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
    rect: {
      x: number;
      y: number;
      w: number;
      h: number;
      rgb?: { r: number; g: number; b: number };
      /** Fraction 0..1; defaults to fully opaque. */
      alpha?: number;
    } | null,
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
          background: {
            ...(rect.rgb ?? { r: 200, g: 120, b: 60 }),
            alpha: rect.alpha ?? 1,
          },
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

  // The same, but painted at alpha 100/255 — above detectAlphaBbox's own
  // ALPHA_BBOX_THRESHOLD (8), but below the opaque-union rule (128) the head
  // half-width measurement uses. `withNose` also adds the role that gates the
  // turn solve, to check the fallback holds even when a turn is being fitted.
  async function writeTranslucentLayers(
    dir: string,
    withNose = false,
  ): Promise<string[]> {
    const alpha = 100 / 255;
    return [
      await writeLayerPng(dir, "face.png", {
        x: 20,
        y: 20,
        w: 60,
        h: 60,
        alpha,
      }),
      await writeLayerPng(dir, "eye_L.png", {
        x: 30,
        y: 35,
        w: 12,
        h: 8,
        alpha,
      }),
      await writeLayerPng(dir, "eye_R.png", {
        x: 58,
        y: 35,
        w: 12,
        h: 8,
        alpha,
      }),
      await writeLayerPng(dir, "mouth.png", {
        x: 42,
        y: 60,
        w: 16,
        h: 8,
        alpha,
      }),
      ...(withNose
        ? [
            await writeLayerPng(dir, "nose.png", {
              x: 46,
              y: 44,
              w: 8,
              h: 8,
              alpha,
            }),
          ]
        : []),
    ];
  }

  // Temp dirs live UNDER cwd (node_modules is gitignored) so they satisfy the
  // tool's output-path confinement to the working directory; cleaned up after.
  const createdDirs: string[] = [];
  function tmpDir(): string {
    const d = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules", ".iki-mcp-autorig-"),
    );
    createdDirs.push(d);
    return d;
  }
  afterAll(() => {
    for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  // A noisy face so the lossless atlas has real entropy to shrink.
  async function writeNoisyLayers(dir: string): Promise<string[]> {
    const noisy = await sharp({
      create: {
        width: 60,
        height: 60,
        channels: 4,
        background: { r: 200, g: 120, b: 60, alpha: 1 },
        noise: { type: "gaussian", mean: 128, sigma: 40 },
      },
    })
      .png()
      .toBuffer();
    const face = path.join(dir, "face.png");
    await sharp({
      create: {
        width: CANVAS,
        height: CANVAS,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: noisy, left: 20, top: 20 }])
      .png()
      .toFile(face);
    return [
      face,
      await writeLayerPng(dir, "eye_L.png", { x: 30, y: 35, w: 12, h: 8 }),
      await writeLayerPng(dir, "eye_R.png", { x: 58, y: 35, w: 12, h: 8 }),
      await writeLayerPng(dir, "mouth.png", { x: 42, y: 60, w: 16, h: 8 }),
    ];
  }

  it("quantizeColors shrinks the atlas and still writes a valid PNG-textured model", async () => {
    const dir = tmpDir();
    const paths = await writeNoisyLayers(dir);
    const layers = paths.map((p) => ({ path: p }));

    const lossless = await autoRigFromLayers({
      layers,
      outputPath: path.join(dir, "lossless.iki"),
    });
    const quantized = await autoRigFromLayers({
      layers,
      outputPath: path.join(dir, "quantized.iki"),
      quantizeColors: 16,
    });
    expect(lossless.ok && quantized.ok).toBe(true);
    if (!lossless.ok || !quantized.ok) return;
    expect(quantized.atlasBytes).toBeLessThan(lossless.atlasBytes);

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "quantized.iki"), "utf8"),
    );
    const model = parseIkiModel(written);
    const source = model.textures[0].source;
    expect(source.startsWith("data:image/png;base64,")).toBe(true);
    // It decodes as a palette PNG with at most the requested colours.
    const meta = await sharp(
      Buffer.from(source.slice("data:image/png;base64,".length), "base64"),
    ).metadata();
    expect(meta.format).toBe("png");
    expect(meta.paletteBitDepth).toBeDefined();
    expect(meta.paletteBitDepth!).toBeLessThanOrEqual(4);
  });

  it("rejects a quantizeColors outside 2..256 or non-integer as ok:false", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    for (const bad of [1, 257, 0, 12.5, -8]) {
      const result = await autoRigFromLayers({
        layers: paths.map((p) => ({ path: p })),
        outputPath: path.join(dir, "model.iki"),
        quantizeColors: bad,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/quantizeColors/);
    }
  });

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

  // A directory genuinely OUTSIDE the working tree, for confinement tests.
  function outsideDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-outside-"));
    createdDirs.push(d);
    return d;
  }

  it("rejects an absolute output path outside the working directory", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outside = outsideDir();
    const outPath = path.join(outside, "escape.iki");

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: outPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/escapes the working directory/);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("rejects an output path whose parent is a symlink pointing outside cwd", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outside = outsideDir();
    // A symlink UNDER cwd that points outside the working tree.
    const linkDir = path.join(dir, "link");
    fs.symlinkSync(outside, linkDir);
    const outPath = path.join(linkDir, "model.iki");

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: outPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/escapes the working directory/);
    expect(fs.existsSync(path.join(outside, "model.iki"))).toBe(false);
  });

  it("does not follow an existing .iki symlink at the output path (atomic replace)", async () => {
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outside = outsideDir();
    const outsideTarget = path.join(outside, "target.iki");
    // out.iki lives UNDER cwd (parent passes confinement) but is a symlink to
    // an external target; the atomic rename must replace the link, not follow it.
    const outPath = path.join(dir, "out.iki");
    fs.symlinkSync(outsideTarget, outPath);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: outPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // External target was NOT written; the symlink was replaced by a real file.
    expect(fs.existsSync(outsideTarget)).toBe(false);
    expect(fs.lstatSync(outPath).isSymbolicLink()).toBe(false);
    const model = parseIkiModel(JSON.parse(fs.readFileSync(outPath, "utf8")));
    expect(model.textures[0].source.startsWith("data:image/png;base64,")).toBe(
      true,
    );
  });
  // ── the head turn ────────────────────────────────────────────────────────

  // The required roles plus the `nose` that gates the turn solve. At the eye row
  // the widest thing here is the face plate itself — the hairless case.
  async function writeNoseLayers(dir: string): Promise<string[]> {
    return [
      ...(await writeRequiredLayers(dir)),
      await writeLayerPng(dir, "nose.png", { x: 46, y: 44, w: 8, h: 8 }),
    ];
  }

  // The same set under near-black bangs wider than that plate: the head the
  // turn's shifts are fractions of is the one the hair draws, and its ink only
  // counts as silhouette under the alpha rule.
  async function writeTurnLayers(dir: string): Promise<string[]> {
    return [
      ...(await writeNoseLayers(dir)),
      await writeLayerPng(dir, "hair_front.png", {
        x: 10,
        y: 25,
        w: 80,
        h: 31,
        rgb: { r: 8, g: 6, b: 10 },
      }),
    ];
  }

  /** The eye's turn slide in a written model: the `from` end of its AngleX
   *  translateX binding, i.e. where it sits at the turn's own limit. */
  function eyeSlide(filePath: string): number {
    const model = parseIkiModel(JSON.parse(fs.readFileSync(filePath, "utf8")));
    const binding = (
      model.parts.find((p) => p.id === "eye_L")!.bindings ?? []
    ).find(
      (b) =>
        b.parameter === StandardParameter.AngleX && b.channel === "translateX",
    );
    return binding!.from;
  }

  it("falls back to the face plate, and still rigs, when the layers are translucent (alpha below the opaque-union threshold)", async () => {
    const dir = tmpDir();
    const paths = await writeTranslucentLayers(dir);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Alpha 100 clears detectAlphaBbox's own floor (8), so every layer still
    // has a real bbox — it is only the opaque-union span (alpha >= 128) that
    // reads empty at the eye row, and the tool falls back instead of refusing.
    expect(result.headHalfWidth).toBeUndefined();
    expect(result.headHalfWidthApplied).toBe(false);
  });

  it("falls back to the face plate on translucent layers with a nose too, and still solves the turn", async () => {
    const dir = tmpDir();
    const paths = await writeTranslucentLayers(dir, true);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headHalfWidth).toBeUndefined();
    expect(result.headHalfWidthApplied).toBe(false);
    expect(result.turn).toBeDefined();
  });

  it("measures the head half-width off the layers' alpha, ink included", async () => {
    const dir = tmpDir();
    const paths = await writeTurnLayers(dir);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bangs span 10..89 at the eye row; the face plate alone reads 30, so
    // this is also the proof that near-black pixels count as silhouette.
    expect(result.headHalfWidth).toBe(40);
    expect(result.headHalfWidthApplied).toBe(true);
    // And it is the head the solve ran on: the silhouette hold pivots on that
    // very distance, which the face plate would have made 31.
    expect(result.turn!.holdBase).toBe(40);
  });

  // writeTurnLayers()'s bangs (10..89) plus a back-hair layer that reaches
  // further out on the LEFT (0) but not as far on the RIGHT (69): each side's
  // outermost opaque pixel in the eye-row band belongs to a different layer.
  async function writeMixedHairLayers(dir: string): Promise<string[]> {
    return [
      ...(await writeTurnLayers(dir)),
      await writeLayerPng(dir, "hair_back.png", {
        x: 0,
        y: 20,
        w: 69,
        h: 40,
        rgb: { r: 8, g: 6, b: 10 },
      }),
    ];
  }

  it("reports which layer owns each side's outermost opaque pixel, when they differ", async () => {
    const dir = tmpDir();
    const paths = await writeMixedHairLayers(dir);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // hair_back spans 0..69, hair_front 10..89 (canvas px; model x is canvas x
    // minus half the CANVAS=100 canvas): hair_back's own left edge (0 -> -50)
    // is further out than hair_front's (10 -> -40), hair_front's own right
    // edge (89 -> 39) further out than hair_back's (69 -> 19). Every role with
    // SOME opaque pixel in the band is listed (face, the eyes, the nose too),
    // so this checks the two that matter rather than the whole array.
    expect(result.headHalfWidthApplied).toBe(true);
    expect(result.headEdges?.left).toContainEqual({
      role: "hair_back",
      x: -50,
    });
    expect(result.headEdges?.right).toContainEqual({
      role: "hair_front",
      x: 39,
    });
  });

  it("a head no wider than the face plate falls back to the plate, and still rigs", async () => {
    const dir = tmpDir();
    const paths = await writeNoseLayers(dir);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
    });

    // A hairless set measures a head no wider than the plate it is drawn on,
    // which the generator refuses as a head — so the tool keeps the number for
    // the caller and lets the plate stand in, rather than refusing the rig.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headHalfWidth).toBe(30);
    expect(result.headHalfWidthApplied).toBe(false);
    expect(result.turn).toBeDefined();
    expect(result.turn!.holdBase).not.toBe(30);
  });

  it("ignores a caller-supplied headHalfWidth smuggled into turnTargets (a JS caller, unchecked by the TS type)", async () => {
    const dir = tmpDir();
    const paths = await writeNoseLayers(dir);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
      // headHalfWidth is excluded from AutoRigTurnTargets' own type, so this
      // is only reachable from plain JS / a cast — exactly what a spread
      // instead of a destructure would let through untouched.
      turnTargets: { headHalfWidth: 99999 } as AutoRigTurnTargets,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // headHalfWidthApplied is false here (same fixture as the test above), so
    // the smuggled value must NOT reach the generator: holdBase falls back to
    // the plate, not the caller's 99999.
    expect(result.headHalfWidthApplied).toBe(false);
    expect(result.turn!.holdBase).not.toBe(99999);
  });

  it("reports what the turn solve settled on — and nothing when there is no nose", async () => {
    const dir = tmpDir();
    const turnPaths = await writeTurnLayers(dir);

    const rigged = await autoRigFromLayers({
      layers: turnPaths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "turn.iki"),
    });
    expect(rigged.ok).toBe(true);
    if (!rigged.ok) return;
    expect(rigged.turn).toBeDefined();
    expect(Array.isArray(rigged.turn!.clamped)).toBe(true);
    expect(rigged.turn!.achieved.eyeShift).toBeTypeOf("number");
    expect(rigged.turn!.achieved.farEyeRatio).toBeTypeOf("number");
    expect(rigged.turn!.radius).toBeGreaterThan(0);

    const noseless = await autoRigFromLayers({
      layers: turnPaths
        .filter((p) => !p.endsWith("nose.png"))
        .map((p) => ({ path: p })),
      outputPath: path.join(dir, "noseless.iki"),
    });
    expect(noseless.ok).toBe(true);
    if (!noseless.ok) return;
    expect(noseless.turn).toBeUndefined();
  });

  it("a bigger eyeShift target slides the eyes further", async () => {
    const dir = tmpDir();
    const layers = (await writeTurnLayers(dir)).map((p) => ({ path: p }));
    const smallPath = path.join(dir, "small.iki");
    const bigPath = path.join(dir, "big.iki");

    // Both targets are reachable here and neither is cut down — 0.15/0.25 sit
    // in the band this fixture rigs with `clamped: []`, so what changes
    // between them is the eye's own depth and not the solve's character. The
    // floor they clear is measured, not guessed: eyeShift 0.01 comes back
    // "attainable 0.06609…0.36505".
    const small = await autoRigFromLayers({
      layers,
      outputPath: smallPath,
      turnTargets: { eyeShift: 0.15 },
    });
    const big = await autoRigFromLayers({
      layers,
      outputPath: bigPath,
      turnTargets: { eyeShift: 0.25 },
    });
    expect(small.ok && big.ok).toBe(true);
    if (!small.ok || !big.ok) return;
    // Both targets are inside what this layer set can do, so neither was cut
    // down: what eyeSlide compares below is the depth each target asked for
    // on top of that shared plate slide, not a clamp.
    expect(small.turn!.clamped).not.toContain("eyeShift");
    expect(big.turn!.clamped).not.toContain("eyeShift");
    expect(small.turn!.achieved.eyeShift).toBeCloseTo(0.15, 2);
    expect(big.turn!.achieved.eyeShift).toBeCloseTo(0.25, 2);
    // Both were fractions of the head measured off the layers (40), not of the
    // face plate (31) — the hold pivots on the one the solve used.
    expect(small.turn!.holdBase).toBe(small.headHalfWidth);
    expect(big.turn!.holdBase).toBe(big.headHalfWidth);
    expect(Math.abs(eyeSlide(bigPath))).toBeGreaterThan(
      Math.abs(eyeSlide(smallPath)),
    );
  });

  it("returns { ok:false } for a turn target this layer set cannot reach", async () => {
    const dir = tmpDir();
    const paths = await writeTurnLayers(dir);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
      // Half the head half-width would slide the far eye off the face plate.
      turnTargets: { eyeShift: 0.5 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/turnTargets\.eyeShift/);
    expect(result.error).toMatch(/unreachable/);
    expect(result.error).toMatch(/attainable/);
  });

  it("returns { ok:false } for a non-finite turn target, naming the field", async () => {
    const dir = tmpDir();
    const paths = await writeTurnLayers(dir);

    const result = await autoRigFromLayers({
      layers: paths.map((p) => ({ path: p })),
      outputPath: path.join(dir, "model.iki"),
      turnTargets: { farEyeRatio: Number.NaN },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/turnTargets\.farEyeRatio/);
  });
});
