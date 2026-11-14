/**
 * A gate that throws after the file is written: the tool still answers with the
 * path, and the text ends with the failed gate.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createIkiMcpServer } from "../src/server";

vi.mock("../src/custom-gate", async (original) => ({
  ...(await original<typeof import("../src/custom-gate")>()),
  checkCustomGate: () => {
    throw new Error("boom");
  },
}));

const createdDirs: string[] = [];
afterAll(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function writeLayer(
  dir: string,
  name: string,
  r: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const file = path.join(dir, name);
  await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: r.w,
            height: r.h,
            channels: 4,
            background: { r: 200, g: 120, b: 60, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
        left: r.x,
        top: r.y,
      },
    ])
    .png()
    .toFile(file);
  return file;
}

describe("auto_rig_from_layers when the custom gate throws", () => {
  it("returns the written path and ends with CUSTOM GATE FAIL: gate error", async () => {
    const dir = fs.mkdtempSync(
      path.join(process.cwd(), "node_modules", ".iki-mcp-gate-error-"),
    );
    createdDirs.push(dir);
    const layers = [
      await writeLayer(dir, "face.png", { x: 20, y: 20, w: 60, h: 60 }),
      await writeLayer(dir, "eye_L.png", { x: 30, y: 35, w: 12, h: 8 }),
      await writeLayer(dir, "eye_R.png", { x: 58, y: 35, w: 12, h: 8 }),
      await writeLayer(dir, "mouth.png", { x: 42, y: 60, w: 16, h: 8 }),
    ];
    const tail = await writeLayer(dir, "tail.png", {
      x: 40,
      y: 40,
      w: 20,
      h: 30,
    });
    const out = path.join(dir, "model.iki");

    const server = createIkiMcpServer();
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({
      name: "auto_rig_from_layers",
      arguments: {
        layers: layers.map((p) => ({ path: p })),
        outputPath: out,
        customParts: [
          {
            id: "tail",
            path: tail,
            anchor: "face",
            tie: [50, 50],
            after: "face",
          },
        ],
      },
    });
    await client.close();

    expect(fs.existsSync(out)).toBe(true);
    const sc = result.structuredContent as {
      ok: boolean;
      path: string;
      customParts: { gate: { ok: boolean; failed: string[] } };
    };
    expect(sc.ok).toBe(true);
    expect(sc.path).toBe(out);
    expect(sc.customParts.gate.ok).toBe(false);
    expect(sc.customParts.gate.failed).toEqual(["gate error: boom"]);
    const lines = (
      result.content as { type: string; text: string }[]
    )[0].text.split("\n");
    expect(lines[0]).toBe(out);
    expect(lines.at(-1)).toBe("CUSTOM GATE FAIL: gate error: boom");
  }, 60_000);
});
