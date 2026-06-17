import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { IKI_FORMAT_VERSION } from "@iki/format";
import { createIkiMcpServer } from "../src/server";
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

  afterEach(async () => {
    if (pair) {
      await pair.cleanup();
      pair = undefined;
    }
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

  it("list_standard_parameters returns 14 entries under structuredContent.parameters", async () => {
    pair = await createPair();
    const result = await pair.client.callTool({
      name: "list_standard_parameters",
      arguments: {},
    });

    const sc = result.structuredContent as {
      parameters: { id: string; description: string }[];
    };
    expect(sc.parameters).toHaveLength(14);
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iki-mcp-server-"));
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
    expect(texts[0].text).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("auto_rig_from_layers returns ok:false + INVALID: (not isError) for a bad path", async () => {
    pair = await createPair();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iki-mcp-server-"));
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
});
