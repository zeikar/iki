import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { IKI_FORMAT_VERSION } from "@ikijs/format";
import { createIkiMcpServer } from "../src/server";
import { writeLipParts, writePartsSet } from "./helpers/parts";
import { FAR_IRIS_W, IRIS_W, writeTurnPair } from "./helpers/turn-pair";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Write a 100x100 transparent PNG with one opaque rect (so the layer has a bbox).
async function writeLayer(
  dir: string,
  name: string,
  rect: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const filePath = path.join(dir, name);
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
  await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: overlay, left: rect.x, top: rect.y }])
    .png()
    .toFile(filePath);
  return filePath;
}

async function writeRequiredLayers(dir: string): Promise<string[]> {
  return [
    await writeLayer(dir, "face.png", { x: 20, y: 20, w: 60, h: 60 }),
    await writeLayer(dir, "eye_L.png", { x: 30, y: 35, w: 12, h: 8 }),
    await writeLayer(dir, "eye_R.png", { x: 58, y: 35, w: 12, h: 8 }),
    await writeLayer(dir, "mouth.png", { x: 42, y: 60, w: 16, h: 8 }),
  ];
}

// The same set plus the `nose` that gates the turn solve and bangs wider than
// the face plate — the head the turn's shift targets are fractions of.
async function writeTurnLayers(dir: string): Promise<string[]> {
  return [
    ...(await writeRequiredLayers(dir)),
    await writeLayer(dir, "nose.png", { x: 46, y: 44, w: 8, h: 8 }),
    await writeLayer(dir, "hair_front.png", { x: 10, y: 25, w: 80, h: 31 }),
  ];
}

// Minimal valid model matching the shape used in tools.test.ts.
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

type Pair = {
  server: McpServer;
  client: Client;
  cleanup: () => Promise<void>;
};

async function createPair(): Promise<Pair> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createIkiMcpServer();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const cleanup = async () => {
    await client.close();
    await server.close();
  };

  return { server, client, cleanup };
}

describe("MCP server integration", () => {
  let pair: Pair | undefined;

  // Temp dirs under cwd (node_modules is gitignored) so auto-rig output paths
  // satisfy the tool's working-directory confinement; cleaned up after.
  const createdDirs: string[] = [];
  function tmpDir(): string {
    const d = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules", ".iki-mcp-server-"),
    );
    createdDirs.push(d);
    return d;
  }

  afterEach(async () => {
    if (pair) {
      await pair.cleanup();
      pair = undefined;
    }
  });

  afterAll(() => {
    for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("validate_iki returns ok:true and text 'OK' for a valid model", async () => {
    pair = await createPair();
    const result = await pair.client.callTool({
      name: "validate_iki",
      arguments: { model: validModel() },
    });

    expect(result.structuredContent).toEqual({ ok: true });
    expect(result.isError).toBeFalsy();
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    expect(texts[0].text).toBe("OK");
  });

  it("validate_iki returns ok:false and text starting with INVALID: for invalid model", async () => {
    pair = await createPair();
    const result = await pair.client.callTool({
      name: "validate_iki",
      arguments: { model: { version: IKI_FORMAT_VERSION } },
    });

    expect((result.structuredContent as { ok: boolean }).ok).toBe(false);
    // Validation failure is a normal result — isError must be falsy
    expect(result.isError).toBeFalsy();
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    expect(texts[0].text).toMatch(/^INVALID:/);
  });

  it("describe_iki returns ok:true with summary for a valid model", async () => {
    pair = await createPair();
    const result = await pair.client.callTool({
      name: "describe_iki",
      arguments: { model: validModel() },
    });

    expect((result.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      ok: true;
      summary: { name: string };
    };
    expect(sc.summary).toBeDefined();
    expect(sc.summary.name).toBe("test-model");
  });

  it("describe_iki { modelPath } returns the patch writer's view of a written rig", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outPath = path.join(dir, "model.iki");
    await pair.client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: paths.map((p) => ({ path: p })),
        outputPath: outPath,
      },
    });

    const result = await pair.client.callTool({
      name: "describe_iki",
      arguments: { modelPath: outPath },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      ok: true;
      summary: {
        faceWidth: number;
        bustScale: number;
        parts: { id: string; box: { w: number }; bustBox: { w: number } }[];
      };
    };
    expect(sc.ok).toBe(true);
    const face = sc.summary.parts.find((p) => p.id === "face")!;
    expect(sc.summary.faceWidth).toBe(face.box.w);
    expect(face.bustBox.w).toBeCloseTo(face.box.w * sc.summary.bustScale, 0);
  });

  it("describe_iki with neither or both of model and modelPath is INVALID text, not isError", async () => {
    pair = await createPair();
    for (const args of [{}, { model: validModel(), modelPath: "model.iki" }]) {
      const result = await pair.client.callTool({
        name: "describe_iki",
        arguments: args,
      });
      expect(result.isError).toBeFalsy();
      const texts = (result.content as { type: string; text: string }[]).filter(
        (c) => c.type === "text",
      );
      expect(texts[0].text).toBe("INVALID: pass model or modelPath");
    }
  });

  it("list_standard_parameters returns 30 entries under structuredContent.parameters", async () => {
    pair = await createPair();
    const result = await pair.client.callTool({
      name: "list_standard_parameters",
      arguments: {},
    });

    const sc = result.structuredContent as {
      parameters: { id: string; description: string }[];
    };
    expect(sc.parameters).toHaveLength(30);
    expect(result.isError).toBeFalsy();
  });

  it("registers auto_rig_from_layers among the server's tools", async () => {
    pair = await createPair();
    const { tools } = await pair.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("auto_rig_from_layers");
  });

  it("auto_rig_from_layers writes a renderable .iki and returns its path", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outPath = path.join(dir, "model.iki");

    const result = await pair.client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: paths.map((p) => ({ path: p })),
        outputPath: outPath,
      },
    });

    expect((result.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(result.isError).toBeFalsy();
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    // The path, then the fold report, then the physics report.
    const [first, ...tail] = texts[0].text.split("\n");
    expect(first).toBe(outPath);
    const folds = tail.filter((line) => /^FOLDS?[ :]/.test(line));
    const physics = tail.filter((line) => /^PHYSICS[ :]/.test(line));
    expect(tail).toEqual([...folds, ...physics]);
    expect(folds.length).toBeGreaterThan(0);
    // The required layers have no hair_front, so the rig has no physics.
    expect(physics).toEqual(["PHYSICS: no rigs"]);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("auto_rig_from_layers accepts quantizeColors through the tool schema", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    const outPath = path.join(dir, "model.iki");

    const result = await pair.client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: paths.map((p) => ({ path: p })),
        outputPath: outPath,
        quantizeColors: 16,
      },
    });

    expect((result.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("auto_rig_from_layers accepts turnTargets through the tool schema", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const paths = await writeTurnLayers(dir);
    const outPath = path.join(dir, "model.iki");

    const result = await pair.client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: paths.map((p) => ({ path: p })),
        outputPath: outPath,
        turnTargets: { eyeShift: 0.1 },
      },
    });

    const sc = result.structuredContent as {
      ok: boolean;
      turn?: { achieved: { eyeShift: number } };
    };
    expect(sc.ok).toBe(true);
    expect(result.isError).toBeFalsy();
    // The target reached the solver, not just the schema.
    expect(sc.turn!.achieved.eyeShift).toBeCloseTo(0.1, 2);
  });

  it("auto_rig_from_layers accepts patches through the tool schema and prints a PATCH line per op between the path and the folds", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const paths = await writeTurnLayers(dir);
    const outPath = path.join(dir, "model.iki");

    const result = await pair.client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: paths.map((p) => ({ path: p })),
        outputPath: outPath,
        patches: [
          {
            target: "eyeWarp_R",
            at: { ParamAngleY: 0, ParamAngleX: -30 },
            region: { role: "eye_R", x: [0, 1], y: [0, 1] },
            by: { dx: 0.05, dy: 0 },
            why: "far eye a little out",
          },
          {
            target: "face",
            at: { ParamAngleX: -30 },
            region: { role: "face", x: [0, 0.5], y: [0, 1] },
            by: { dx: 0, dy: 0.01 },
          },
        ],
      },
    });

    const sc = result.structuredContent as {
      ok: boolean;
      patches?: { moved: number }[];
    };
    expect(sc.ok).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(sc.patches).toHaveLength(2);
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    const [first, grid, part, ...tail] = texts[0].text.split("\n");
    expect(first).toBe(outPath);
    // `at` sorted by parameter id, whatever order it was passed in; the
    // moves are face widths of the 62 px face crop (the 60 px rect and the
    // alpha bbox's 1 px margin each side).
    expect(grid).toMatch(
      /^PATCH 0 eyeWarp_R at ParamAngleX=-30 ParamAngleY=0: [1-9]\d* of \d+ points \(cols \d+-\d+, rows \d+-\d+\), largest move 3\.1 model px$/,
    );
    expect(part).toMatch(
      /^PATCH 1 face at ParamAngleX=-30: [1-9]\d* of \d+ points \(vertices\), largest move 0\.6 model px$/,
    );
    const folds = tail.filter((line) => /^FOLDS?[ :]/.test(line));
    const physics = tail.filter((line) => /^PHYSICS[ :]/.test(line));
    expect(tail).toEqual([...folds, ...physics]);
    expect(folds.length).toBeGreaterThan(0);
    expect(physics.length).toBeGreaterThan(0);
  });

  it("auto_rig_from_layers lets an unknown patch key through the tool schema to the rig, which refuses it as INVALID: patches[0].<key> (not isError)", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const paths = await writeTurnLayers(dir);
    const outPath = path.join(dir, "model.iki");

    const result = await pair.client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: paths.map((p) => ({ path: p })),
        outputPath: outPath,
        patches: [
          {
            target: "eyeWarp_R",
            at: { ParamAngleX: -30, ParamAngleY: 0 },
            region: { role: "eye_R", x: [0, 1], y: [0, 1] },
            by: { dx: 0.05, dy: 0 },
            foo: 1,
          },
        ],
      },
    });

    const sc = result.structuredContent as { ok: boolean; error?: string };
    expect(sc.ok).toBe(false);
    expect(result.isError).toBeFalsy();
    expect(sc.error).toMatch(/^patches\[0\]\.foo /);
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    // The refusal lists the keys an op takes.
    expect(texts[0].text).toMatch(
      /^INVALID: patches\[0\]\.foo is not one of target, at, region, by, falloff, why$/,
    );
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("auto_rig_from_layers returns ok:false + INVALID: (not isError) for a bad path", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const paths = await writeRequiredLayers(dir);
    paths[0] = path.join(dir, "missing.png");

    const result = await pair.client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: paths.map((p) => ({ path: p })),
        outputPath: path.join(dir, "model.iki"),
      },
    });

    expect((result.structuredContent as { ok: boolean }).ok).toBe(false);
    // Expected caller-input failure is a normal result, NOT a protocol error.
    expect(result.isError).toBeFalsy();
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    expect(texts[0].text).toMatch(/^INVALID:/);
  });

  it("auto_rig_from_layers leaves a malformed turnTargets, style or patches op to the tool schema, which the SDK answers with isError", async () => {
    pair = await createPair();
    const dir = tmpDir();
    const layers = (await writeTurnLayers(dir)).map((p) => ({ path: p }));

    const cases = [
      ["turnTargets", null],
      ["turnTargets", []],
      ["turnTargets", { eyeShift: "0.1" }],
      ["style", null],
      ["style", []],
      ["style", { turn: "1" }],
      [
        "patches",
        [
          {
            target: "eyeWarp_R",
            at: { ParamAngleX: -30, ParamAngleY: 0 },
            region: { role: "eye_R", x: [0, 1], y: [0, 1] },
            by: { dx: "1", dy: 0 },
          },
        ],
      ],
      [
        "patches",
        [
          {
            target: "eyeWarp_R",
            at: { ParamAngleX: -30, ParamAngleY: 0 },
            region: { role: "eye_R", x: [0, 0.5, 1], y: [0, 1] },
            by: { dx: 0.05, dy: 0 },
          },
        ],
      ],
    ] as const;
    for (const [i, [field, value]] of cases.entries()) {
      const outPath = path.join(dir, `malformed-${i}.iki`);
      const result = await pair.client.callTool({
        name: "auto_rig_from_layers",
        arguments: { layers, outputPath: outPath, [field]: value },
      });

      // The README documents this split: the schema refuses a non-object or a
      // named field that is not a number before the handler runs, so there is
      // no `INVALID:` result to return.
      expect(result.isError, `${field}: ${JSON.stringify(value)}`).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const texts = (result.content as { type: string; text: string }[]).filter(
        (c) => c.type === "text",
      );
      expect(texts[0].text).toMatch(/Input validation error/);
      expect(texts[0].text).toContain(field);
      expect(fs.existsSync(outPath)).toBe(false);
    }
  });

  it("registers compose_layers_from_parts, measure_layers, measure_turn_reference and render_poses among the server's tools", async () => {
    pair = await createPair();
    const { tools } = await pair.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("compose_layers_from_parts");
    expect(names).toContain("measure_layers");
    expect(names).toContain("measure_turn_reference");
    expect(names).toContain("render_poses");
  });

  it("render_poses refuses an outDir outside the working directory", async () => {
    pair = await createPair();
    const result = await pair.client.callTool({
      name: "render_poses",
      arguments: { modelPath: "package.json", outDir: os.tmpdir() },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: false });
    const [text] = result.content as { type: string; text: string }[];
    expect(text.text).toMatch(/^INVALID: output dir escapes the working/);
  });

  it("render_poses takes poses through the tool schema: a well-formed list reaches the handler, a malformed one is the SDK's input validation error", async () => {
    pair = await createPair();
    const { client } = pair;
    const call = (poses: unknown) =>
      client.callTool({
        name: "render_poses",
        arguments: { modelPath: "package.json", outDir: os.tmpdir(), poses },
      });

    const parsed = await call([
      {
        name: "eyeWarp_R-stop",
        values: { ParamAngleX: -30, ParamAngleY: 0 },
        crop: { x: 400, y: 300, w: 220, h: 160 },
      },
      { name: "rest", values: {} },
    ]);
    expect(parsed.isError).toBeFalsy();
    const [text] = parsed.content as { type: string; text: string }[];
    expect(text.text).toMatch(/^INVALID: output dir escapes the working/);

    // A schema without the field would strip it and answer as above.
    const malformed = await call([
      { name: "a", values: {}, crop: [400, 300, 220, 160] },
    ]);
    expect(malformed.isError).toBe(true);
    const [error] = malformed.content as { type: string; text: string }[];
    expect(error.text).toMatch(/Input validation error/);
    expect(error.text).toContain("poses");
  });

  it("compose_layers_from_parts composes the parts fixture and returns layers + measure", async () => {
    pair = await createPair();
    const partsDir = tmpDir();
    await writePartsSet(partsDir);
    const outDir = tmpDir();

    const result = await pair.client.callTool({
      name: "compose_layers_from_parts",
      arguments: { partsDir, outDir },
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      ok: boolean;
      layers?: { role: string; path: string }[];
      measure?: { warnings: string[] };
    };
    expect(sc.ok).toBe(true);
    expect(sc.layers).toBeDefined();
    expect(sc.measure).toBeDefined();
    for (const layer of sc.layers ?? []) {
      expect(fs.existsSync(layer.path)).toBe(true);
    }

    // Text must list every written path, in order, then the geometry report —
    // a regression in the join order/separator or a dropped report would
    // otherwise pass CI silently (structuredContent alone can't catch it).
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    const paths = (sc.layers ?? []).map((l) => l.path);
    const lines = texts[0].text.split("\n");
    expect(lines.slice(0, paths.length)).toEqual(paths);
    expect(lines[paths.length]).toBe(`# layers  (${outDir})`);
  });

  it("compose_layers_from_parts composes the lip set in place of mouth", async () => {
    pair = await createPair();
    const partsDir = tmpDir();
    await writeLipParts(partsDir);
    const outDir = tmpDir();

    const result = await pair.client.callTool({
      name: "compose_layers_from_parts",
      arguments: { partsDir, outDir },
    });

    expect(result.isError).toBeFalsy();
    const roles = (
      result.structuredContent as { layers: { role: string }[] }
    ).layers.map((l) => l.role);
    expect(roles).toEqual(
      expect.arrayContaining([
        "mouth_inner",
        "mouth_tongue",
        "mouth_teeth",
        "lip_lower",
        "lip_upper",
      ]),
    );
    expect(roles).not.toContain("mouth");
  });

  it("compose_layers_from_parts passes canvasHeight through the tool schema", async () => {
    pair = await createPair();
    const partsDir = tmpDir();
    await writePartsSet(partsDir);
    const outDir = tmpDir();

    // Zod strips a key the schema does not declare, so an undeclared
    // canvasHeight would compose the square default without complaint.
    const result = await pair.client.callTool({
      name: "compose_layers_from_parts",
      arguments: { partsDir, outDir, canvasHeight: 1200 },
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      ok: boolean;
      layers?: { path: string }[];
    };
    expect(sc.ok).toBe(true);
    expect(sc.layers?.length).toBeGreaterThan(0);
    for (const layer of sc.layers ?? []) {
      const meta = await sharp(layer.path).metadata();
      expect([meta.width, meta.height]).toEqual([1100, 1200]);
    }
  });

  it("compose_layers_from_parts returns ok:false + INVALID: (not isError) for a missing partsDir", async () => {
    pair = await createPair();
    const missing = path.join(
      process.cwd(),
      "node_modules",
      ".does-not-exist-parts",
    );
    const outDir = tmpDir();

    const result = await pair.client.callTool({
      name: "compose_layers_from_parts",
      arguments: { partsDir: missing, outDir },
    });

    expect((result.structuredContent as { ok: boolean }).ok).toBe(false);
    expect(result.isError).toBeFalsy();
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    expect(texts[0].text).toMatch(/^INVALID:/);
  });

  it("measure_layers reports on a composed layers dir", async () => {
    pair = await createPair();
    const partsDir = tmpDir();
    await writePartsSet(partsDir);
    const outDir = tmpDir();
    await pair.client.callTool({
      name: "compose_layers_from_parts",
      arguments: { partsDir, outDir },
    });

    const result = await pair.client.callTool({
      name: "measure_layers",
      arguments: { layersDir: outDir },
    });

    expect(result.isError).toBeFalsy();
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    expect(texts[0].text).toMatch(/^# layers/);
  });

  it("measure_turn_reference reports the turn ratios of an image pair", async () => {
    pair = await createPair();
    const { front, turned } = await writeTurnPair(tmpDir());

    const result = await pair.client.callTool({
      name: "measure_turn_reference",
      arguments: { front, turned },
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      ok: boolean;
      farEyeRatio: number;
      turnSign: number;
    };
    expect(sc.ok).toBe(true);
    // The fixture's turned far iris is FAR_IRIS_W wide against a near one of
    // IRIS_W, on a front pair that is symmetric.
    expect(sc.farEyeRatio).toBeCloseTo(FAR_IRIS_W / IRIS_W, 2);
    expect(sc.turnSign).toBe(-1);
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    expect(texts[0].text).toMatch(/^farEyeRatio/);
  });

  it("measure_layers returns ok:false + INVALID: (not isError) for a missing dir", async () => {
    pair = await createPair();
    const missing = path.join(process.cwd(), "node_modules", ".does-not-exist");

    const result = await pair.client.callTool({
      name: "measure_layers",
      arguments: { layersDir: missing },
    });

    expect((result.structuredContent as { ok: boolean }).ok).toBe(false);
    expect(result.isError).toBeFalsy();
    const texts = (result.content as { type: string; text: string }[]).filter(
      (c) => c.type === "text",
    );
    expect(texts[0].text).toMatch(/^INVALID:/);
  });
});
