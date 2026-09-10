import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  validateIki,
  describeIki,
  listStandardParameters,
  autoRigFromLayers,
} from "./tools";
import { composeLayersFromParts } from "./compose";
import { measureLayers, formatMeasureReport } from "./measure";

/** Injected by tsup (and vitest) from this package's package.json version. */
declare const __MCP_VERSION__: string;

export function createIkiMcpServer(): McpServer {
  const server = new McpServer({ name: "iki", version: __MCP_VERSION__ });

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
      const params = listStandardParameters();
      const text = params.map((p) => `${p.id} — ${p.description}`).join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { parameters: params },
      };
    },
  );

  server.registerTool(
    "auto_rig_from_layers",
    {
      description:
        "Auto-rigs role-named PNG layers (face, eye_L/eye_R, mouth required; iris_L/R, brow_L/R, hair_front, etc. optional) into a renderable .iki written to disk. Pass full-canvas PNG file paths; returns the output path + summary (the model is NOT inlined). Filenames map to roles unless `fileName` is given.",
      inputSchema: {
        layers: z
          .array(
            z.object({
              fileName: z
                .string()
                .optional()
                .describe(
                  "Role-bearing filename; defaults to the basename of `path`.",
                ),
              path: z
                .string()
                .describe("PNG file path (resolved against cwd)."),
            }),
          )
          .describe("Full-canvas PNG layers; all must share the same size."),
        outputPath: z
          .string()
          .optional()
          .describe(
            "Output .iki path (resolved against cwd; parent dir must exist).",
          ),
        quantizeColors: z
          .number()
          .int()
          .min(2)
          .max(256)
          .optional()
          .describe(
            "Palette-quantize the atlas PNG to this many colours (2..256). Flat-shaded art keeps its look at 256 and the model shrinks to about a quarter; omit for lossless.",
          ),
      },
    },
    async (args) => {
      try {
        const r = await autoRigFromLayers(args);
        const text = r.ok ? r.path : `INVALID: ${r.error}`;
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
    "compose_layers_from_parts",
    {
      description:
        "Composes AI-generated part PNGs into canvas-aligned, role-named PNG layers on disk, ready for auto_rig_from_layers (the eyewhite split, alpha-trim/white-key, and placement pipeline the character-generation skill needs), with the same geometry report measure_layers returns standalone included inline. face, mouth, eyewhite, iris, brow, hair_front are required; hair_back, body, mouth_open are optional.",
      inputSchema: {
        partsDir: z
          .string()
          .describe(
            "Directory of the source part PNGs (resolved against cwd).",
          ),
        outDir: z
          .string()
          .describe(
            "Existing directory to write the role layer PNGs + preview.png into (resolved against cwd; must already exist; confined to the working directory). Reused across runs: a role this run skips has its stale PNG from an earlier run deleted.",
          ),
        layout: z
          .record(
            z.string(),
            z
              .object({
                cx: z.number(),
                cy: z.number(),
                w: z.number(),
                h: z.number(),
              })
              .partial(),
          )
          .optional()
          .describe(
            "Per-role override merged over the built-in defaults, keyed by role — hair_back, body, face, mouth, mouth_open, eye_L, eye_R, iris_L, iris_R, lash_L, lash_R, brow_L, brow_R, hair_front — e.g. `{ eye_L: { cx: 660 } }`. `w` and `h` are integers in 1..1100; omit `h` to keep the part's own aspect, set it to stretch (set it on a sclera and its lash together, or the blink fold tears).",
          ),
      },
    },
    async (args) => {
      try {
        const r = await composeLayersFromParts(args);
        const text = r.ok
          ? [
              ...r.layers.map((l) => l.path),
              formatMeasureReport({ ...r.measure, layersDir: r.outDir }),
            ].join("\n")
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
    "measure_layers",
    {
      description:
        "Reports read-only geometry checks over an already-composed layers directory — the same checks compose_layers_from_parts returns inline (iris ratio/offset, eye aspect, cropped/cut edges, missing optional roles). Use to re-check a layers dir without recomposing.",
      inputSchema: {
        layersDir: z
          .string()
          .describe(
            "Directory of role-named layer PNGs (resolved against cwd).",
          ),
      },
    },
    async ({ layersDir }) => {
      try {
        const r = await measureLayers({ layersDir });
        const text = r.ok ? formatMeasureReport(r) : `INVALID: ${r.error}`;
        // Spread into a fresh object: MeasureResult's ok:true arm is an
        // intersection with the MeasureReport interface, which TS won't accept
        // directly against the SDK's `Record<string, unknown>` structuredContent
        // — spreading drops that nominal interface identity, same value.
        return {
          content: [{ type: "text", text }],
          structuredContent: { ...r },
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
