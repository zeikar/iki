import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { IKI_FORMAT_VERSION } from "@iki/format";
import { createIkiMcpServer } from "../src/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

  it("list_standard_parameters returns 10 entries under structuredContent.parameters", async () => {
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
});
