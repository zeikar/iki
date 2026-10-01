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
import { measureTurnReference, formatTurnReport } from "./measure-turn";

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
            "Palette-quantize the atlas PNG to this many colours (2..256). Flat-shaded art keeps its look at 256 and the model shrinks to about a quarter; omit for lossless. A `nose` layer stays lossless on a second atlas page of its own, since the palette rims a soft-shaded nose's feather; the nose's own lossless page adds a content-dependent amount, since splitting it off also changes how page 0 re-quantizes without it; the result's `atlasBytes` sums both pages.",
          ),
        turnTargets: z
          .object({
            eyeShift: z.number().optional(),
            farEyeRatio: z.number().optional(),
            silhouetteRatio: z.number().optional(),
            noseShift: z.number().optional(),
            mouthShift: z.number().optional(),
          })
          .passthrough()
          .optional()
          .describe(
            "What the head turn is fitted to, as `measure_turn_reference` reports it off a front/turned reference pair. `eyeShift` (and the optional `noseShift`/`mouthShift`) is how far that feature slides across the head at full turn, as a fraction of the head's half-width — a MAGNITUDE: the rig turns both ways, so the sign is ignored. `farEyeRatio` is the far/near eye width at full turn over that same ratio at rest, `silhouetteRatio` the head's half-width turned over at rest. The half-width the shifts are fractions of is measured off the layers themselves, so it is not an input. An omitted field leaves that part of the turn at the Live2D profile the rig defaults to. A passed `eyeShift` is fitted by the turn's amount and clamped to the room the art leaves the far eye — the face plate's edge, or the bangs' side strand over the far iris (the result's `turn.clamped` lists every clamped field, `turn.achieved` what the rig reaches, and `turn.strandOverlap` how much of a far iris the bangs still cover). Any other passed target this layer set cannot reach comes back as `INVALID: …` naming the field and the attainable range, since it is a measurement rather than a preference. A field not named here is refused the same way.",
          ),
        style: z
          .object({
            turn: z.number().optional(),
            featureLead: z.number().optional(),
            hairFollow: z.number().optional(),
            outlineFollow: z.number().optional(),
            blink: z.number().optional(),
            sway: z.number().optional(),
          })
          .passthrough()
          .optional()
          .describe(
            "Per-character tuning from the Live2D profile the rig defaults to — only what the Live2D samples themselves disagree on: `turn` scales the whole head turn (plate, features, hair and the eyes' foreshortening; 0..3, 1 = the profile; ignored when `turnTargets.eyeShift` is given), `featureLead` how far the features lead the face plate (0..3, 1 = the profile), `hairFollow` the front hair's share of the face's turn (0..2, profile 1.1), `outlineFollow` its outer edge's share where the front hair draws the head's outline (0..2, profile 0: the outline holds), `blink` how far the upper lid comes down over the eye's height (0.1..1, profile 0.58), `sway` the hair sway amplitude (0..5, 1 = the profile). A value out of range, or a knob not named here, comes back as `INVALID: …`.",
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
        "Composes AI-generated part PNGs into canvas-aligned, role-named PNG layers on disk, ready for auto_rig_from_layers (the eyewhite split, alpha-trim/white-key, and placement pipeline the character-generation skill needs), with the same geometry report measure_layers returns standalone included inline. face, mouth, eyewhite, iris, brow, hair_front are required; hair_back, body, mouth_open, nose are optional — without a nose layer the head still turns on the rig's Live2D profile, but it has no nose to lead the turn, and `auto_rig_from_layers` fits no turn to the art (`turnTargets` is inert, no `turn` report). A nose whose dense core is a speck — under a quarter of its trimmed part's width or height, such as a lone nostril mark or highlight — is sized and placed whole, and the inline report warns of it. A light mark drawn detached above the eye white, such as a double-eyelid crease, is dropped from the sclera (the iris's clip), so it does not appear in the composed eye.",
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
            "Per-role override merged over the built-in defaults, keyed by role — hair_back, body, face, nose, mouth, mouth_open, eye_L, eye_R, iris_L, iris_R, lash_L, lash_R, brow_L, brow_R, hair_front — e.g. `{ eye_L: { cx: 660 } }`. `w` and `h` are integers in 1..1100; omit `h` to keep the part's own aspect, set it to stretch. The nose is sized and placed by its dense core (its pixels at alpha >= 128, the drawing inside a soft nose's feather), not its whole part: `w`/`h` size the core, `cx` centres it, and a set `cy` centres its rows. A nose whose core is a speck — under a quarter of the trimmed part's width or height, such as a lone nostril mark or highlight — is sized and placed whole instead, and the report warns of it. Its `cy` defaults to unset, which lands the core's bottom row (the tip) 0.86 of the way from the eye row down to the mouth's, so the nose follows a retuned eye or mouth row. eye_L/lash_L and eye_R/lash_R are cut from one eyewhite into one frame, so each pair must land on the same frame — a pair set to land apart is rejected.",
          ),
        mirrorParts: z
          .array(z.string())
          .optional()
          .describe(
            "Part files to flip left-right as they are read, e.g. `[\"eyewhite.png\"]`. The composer reads eyewhite.png as the eye on the screen LEFT (lash wing at the image's left end, lash-free tear duct at its right) and brow.png as the brow on the screen RIGHT (thick head at the image's left end, tail at its right); a part drawn the other way round is fixed here for free. It flips the source, so every role cut from it flips together and an eye's sclera and lash stay in one frame.",
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
        "Reports read-only geometry checks over an already-composed layers directory — the same checks compose_layers_from_parts returns inline (iris ratio/offset, eye aspect, cropped/cut edges, a nose whose dense core is a speck of its crop, missing optional roles). Use to re-check a layers dir without recomposing. Its nose check reads the composed file against its crop, which is what auto_rig_from_layers acts on. Compose's inline report does the same unless the composer found the source part's core a speck, which it reports instead — so a speck that resampling erased from the layer shows there and not here.",
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

  server.registerTool(
    "measure_turn_reference",
    {
      description:
        "Measures how far a head turns between two images of the same character — a front view and a turned one, at the SAME scale — as three ratios, so a rigged turn can be compared to a reference turn (or to an earlier rig) without registering the images: farEyeRatio (turned far/near iris width over the same ratio at rest), eyeShift (how far the eye pair slides across the head, in units of the FRONT head half-width; NEGATIVE = toward the image's left), silhouetteRatio (head half-width, turned over front). The ratios divide out crop and position, not scale, so the pair must already share framing and head size; since a yaw never changes iris height, a pair whose mean iris height differs by more than 10% is refused instead of measured as a turn. Reads engine renders (transparent backdrop) and opaque reference art alike.",
      inputSchema: {
        front: z
          .string()
          .describe("Front-facing PNG file path (resolved against cwd)."),
        turned: z
          .string()
          .describe("The same character turned, as a PNG file path."),
        iris: z
          .object({
            hueMin: z.number().min(0).max(360),
            hueMax: z.number().min(0).max(360),
            satMin: z.number().min(0).max(1),
          })
          .partial()
          .optional()
          .describe(
            "Iris colour window override merged over the violet default (hue 230..300, sat > 0.22) — set it for a character whose eyes are another colour.",
          ),
        debugDir: z
          .string()
          .optional()
          .describe(
            "Existing directory (resolved against cwd; confined to the working directory) to write `front-<name>.debug.png` / `turned-<name>.debug.png` overlays into, with the iris boxes and head edges drawn.",
          ),
      },
    },
    async (args) => {
      try {
        const r = await measureTurnReference(args);
        const text = r.ok ? formatTurnReport(r) : `INVALID: ${r.error}`;
        // Spread into a fresh object: the ok:true arm is an intersection with
        // the TurnMeasurement interface, which TS won't accept directly against
        // the SDK's Record<string, unknown> structuredContent.
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
