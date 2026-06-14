import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateIki, describeIki, listStandardParameters } from "./tools";

export function createIkiMcpServer(): McpServer {
  const server = new McpServer({ name: "iki", version: "0.0.0" });

  server.registerTool(
    "validate_iki",
    {
      description:
        "Validates a raw .iki model (object or JSON string); fail-fast — returns at most ONE error, so fix one, re-run.",
      inputSchema: {
        model: z
          .unknown()
          .describe("Raw .iki model JSON (object or JSON string)"),
      },
    },
    async ({ model }) => {
      try {
        const r = validateIki(model);
        const text = r.ok ? "OK" : `INVALID: ${r.error}`;
        return { content: [{ type: "text", text }], structuredContent: r };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Unexpected error: ${error}` }],
          structuredContent: { ok: false, error },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "describe_iki",
    {
      description:
        "Summarizes a valid model's canvas/params/parts/deformers; returns an error for an invalid model.",
      inputSchema: {
        model: z
          .unknown()
          .describe("Raw .iki model JSON (object or JSON string)"),
      },
    },
    async ({ model }) => {
      try {
        const r = describeIki(model);
        const text = r.ok
          ? JSON.stringify(r.summary, null, 2)
          : `INVALID: ${r.error}`;
        return { content: [{ type: "text", text }], structuredContent: r };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Unexpected error: ${error}` }],
          structuredContent: { ok: false, error },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_standard_parameters",
    {
      description:
        "Lists the recommended standard parameter ids a host can drive without per-model wiring.",
      inputSchema: {},
    },
    async () => {
      try {
        const params = listStandardParameters();
        const text = params.map((p) => `${p.id} — ${p.description}`).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { parameters: params },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Unexpected error: ${error}` }],
          structuredContent: { ok: false, error },
          isError: true,
        };
      }
    },
  );

  return server;
}
