import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PatchReport, RigBakes, RigPatch } from "@ikijs/editor";
import {
  validateIki,
  describeIki,
  describeIkiAt,
  listStandardParameters,
  describeRigPlan,
  formatRigPlanReport,
  autoRigFromLayers,
  type AutoRigCustomPartInput,
  type CustomPartReport,
  type BakeCheck,
} from "./tools";
import { composeLayersFromParts } from "./compose";
import { formatFoldReport } from "./fold-report";
import { formatCustomGate } from "./custom-gate";
import { formatHairSideReport } from "./hair-side-report";
import { formatPhysicsReport } from "./physics-report";
import { formatNodReport, formatSweepReport } from "./sweep-report";
import { SWEEP_PRESETS } from "./sweep";
import { measureLayers, formatMeasureReport } from "./measure";
import { measureTurnReference, formatTurnReport } from "./measure-turn";
import { renderPoses } from "./render-poses";
import { probeRig, type ProbeInput } from "./probe";

/** Injected by tsup (and vitest) from this package's package.json version. */
declare const __MCP_VERSION__: string;

/** One `PATCH` line per op `auto_rig_from_layers` replayed. */
function formatPatchReports(reports: PatchReport[]): string[] {
  return reports.map((r) => {
    const at = Object.keys(r.at)
      .sort()
      .map((p) => `${p}=${r.at[p]}`)
      .join(" ");
    const where =
      r.cols !== undefined && r.rows !== undefined
        ? `cols ${r.cols[0]}-${r.cols[1]}, rows ${r.rows[0]}-${r.rows[1]}`
        : "vertices";
    return `PATCH ${r.index} ${r.target} at ${at}: ${r.moved} of ${r.of} points (${where}), largest move ${r.maxPx} model px`;
  });
}

/** One `CUSTOM` line per custom part `auto_rig_from_layers` put in the model. */
function formatCustomPartReports(parts: CustomPartReport[]): string[] {
  return parts.map((p) => {
    const line = `CUSTOM ${p.id}: box ${p.box.x},${p.box.y} ${p.box.w}x${p.box.h} px, mesh ${p.mesh.vertices} vertices ${p.mesh.triangles} triangles, order ${p.order}, atlas page ${p.page}`;
    if (p.occlusion === undefined) return line;
    const { by, parameter, stops } = p.occlusion;
    return `${line}, hidden by ${by.join(",")} on ${parameter} at ${stops.map((s) => `${s.value}:${s.amount}`).join(" ")}`;
  });
}

/** One `BAKE` line per custom part and parameter a bake moved, after the `CUSTOM` lines. */
function formatBakeChecks(bakes: BakeCheck[]): string[] {
  return bakes.map(
    (b) =>
      `BAKE ${b.part} ${b.param}: ${b.vertices} vertices, stops ${b.stops.join(",")}, error ${Math.round(b.errorPx * 1000) / 1000} px`,
  );
}

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
        "Summarizes a valid model's canvas/params/parts/deformers and its expressions and motion clips (with the descriptions a host picks them by); returns an error for an invalid model. It is also the patch writer's view of a rigged model: each part's rest box in model px and in bust-render px, each part's warp stops, each warp2d's stops, and faceWidth, which is what an auto_rig_from_layers `patches` op is aimed with. Pass exactly one of model or modelPath; prefer modelPath for a written rig so a large model never crosses your context.",
      inputSchema: {
        model: z
          .unknown()
          .optional()
          .describe("Raw .iki model JSON (object or JSON string)"),
        modelPath: z
          .string()
          .optional()
          .describe(
            "Path to a written .iki model (relative to the working directory, inside it)",
          ),
      },
    },
    async ({ model, modelPath }) => {
      try {
        if ((model === undefined) === (modelPath === undefined)) {
          const error = "pass model or modelPath";
          return {
            content: [{ type: "text", text: `INVALID: ${error}` }],
            structuredContent: { ok: false, error },
          };
        }
        const r =
          modelPath !== undefined
            ? describeIkiAt(modelPath)
            : describeIki(model);
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
    "describe_rig_plan",
    {
      description:
        "Lists the fields of the `rigPlan` input of auto_rig_from_layers: each one's path, default, range, recommended span, step, unit, the poses it shows at, the report reading that shows it and the `turnTargets` cue that fits it when given. The one source of those numbers.",
      inputSchema: {},
    },
    async () => {
      const { fields } = describeRigPlan();
      const text = fields
        .map(
          (f) =>
            `${f.path} default ${f.default} range ${f.range[0]}..${f.range[1]} recommended ${f.recommended[0]}..${f.recommended[1]} step ${f.step} ${f.unit} — ${f.what}; shows at ${f.poses.map((p) => JSON.stringify(p)).join(" ")}; cue ${f.cue ?? "none"}; fitted by ${f.fitBy ?? "none"}${f.provisional ? "; provisional" : ""}`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { fields },
      };
    },
  );

  server.registerTool(
    "auto_rig_from_layers",
    {
      description:
        "Auto-rigs role-named PNG layers (face, eye_L/eye_R and either mouth or the lip set (mouth_inner + lip_lower + lip_upper, a mouth that folds open instead of crossfading) required; iris_L/R, brow_L/R, hair_front, body, arm_L/arm_R, forearm_pose_L/forearm_pose_R, hair_side_L/hair_side_R, mouth_tongue/mouth_teeth (only with the lip set: drawn under its lips and clipped to mouth_inner), etc. optional; an arm needs the body, a pose forearm needs its arm, a side lock needs hair_front, and a partial lip set, one mixed with mouth/mouth_open, or mouth_tongue/mouth_teeth without it is refused) into a renderable .iki written to disk. Pass full-canvas PNG file paths; returns the output path + summary (the model is NOT inlined). Filenames map to roles unless `fileName` is given. The result's `folds` is the written rig's fold report, printed after the path the way render_poses prints it, and report-only: a fold never refuses the rig. The `RIGPLAN:` line (the result's `rigPlan`: `effective`, `clamped`, `overriddenBy`) follows the path and precedes the `PATCH` lines. The `PHYSICS` lines follow the fold report (the result's `physics`), one per physics rig output — a spring's, or each chain segment's — reading ok, frozen or unstable with the step and idle amplitudes, or `PHYSICS: no rigs`; report-only too. With side locks and a `nose` (which `turn` needs) the `HAIRSIDE` lines follow the `PHYSICS` lines (the result's `turn.hairSide`), each naming the lock's role, report-only as well. `patches` (see its field) adds displacements to existing keyform stops of the freshly generated rig; each op then prints one line between the path and the fold report — `PATCH <i> <target> at <Param=v …>: <moved> of <of> points (cols a-b, rows c-d), largest move <maxPx> model px`, with `(vertices)` in place of the columns and rows for a mesh part — and the result's `patches` carries the same reports (`index`, `target`, `at`, `moved`, `of`, `cols`/`rows` for a grid, `maxPx`), present whenever `patches` was passed, `[]` included. An op the input schema accepts but the rig refuses comes back as `INVALID: patches[i]…` and nothing is written; an op with a missing field or a field of the wrong type is the SDK's input validation error. `customParts` adds parts the rig has no role for (a twin tail, a hairpin), each from a canvas-sized PNG of its own, as an unrigged mesh on `headDeformer` after its `after` role's parts; it needs @ikijs/mcp 0.34.0, and an older server drops the field and returns no `customParts`. A part can declare `occlusion` (hidden where named roles' paint covers it, by an amount keyed on a parameter; it needs 0.35.0, and an older server refuses the key as `INVALID: customParts[i]…`); its `CUSTOM <id>:` line then ends `, hidden by <id>,<id>… on <parameter> at <value>:<amount> <value>:<amount>…`, and the result's part carries `occlusion` (`by` as the part ids written, `parameter`, `stops`). The result's `customParts` (`parts`: `id`, rest `box`, `mesh`, `order`, atlas `page`) is present whenever the input was passed, `[]` included, and one `CUSTOM <id>: …` line per part follows the `HAIRSIDE` lines. `bakes` (see its field) moves the custom parts with a parameter and needs `customParts`; each part and parameter it moves then prints one `BAKE <part> <param>: <n> vertices, stops <values>, error <px> px` line after the `CUSTOM` lines (the result's `customParts.bakes`: `part`, `param`, `vertices`, `stops`, `errorPx`), the written model having been landed through the engine, and a stop off by 0.1 px or more comes back as `INVALID: BAKE ERROR <part> <param>=<value>: …`, and a part the bake moves at rest as `INVALID: BAKE ERROR <part> at rest: …`, with nothing written (the rig and the engine disagree: report it as a bug in the packages). Whenever `customParts` was passed, the written model is also measured per custom part (the result's `customParts.gate`: `ok`, `limits`, `parts`, `failed`) and the text ends with its lines, `CUSTOM <id> FOLDS|TIE|SLIDE|EXPOSED|RIGID|TIP: …` then `CUSTOM GATE pass` or `CUSTOM GATE FAIL: <part LINE, …>`, always the last line: a part's least triangle area ratio, its tie's displacement against the anchor where the head does not turn and where it does, the hidden art showing, how far a rigid part bends and where its free end lands, each in px and face widths with its worst pose; `TIP` never fails the gate and the other lines do. The model is written either way; from 0.34.0 on `customParts` always carries `gate` (a gate that throws still writes the file and ends the text `CUSTOM GATE FAIL: gate error: <message>`), so a result without `customParts` is from an older server and was never gated. The custom layers are not role layers: they are left out of the head's width and turn measurements, and an empty or wrong-size one, or an entry the rig refuses, comes back as `INVALID: customParts[i]…` with nothing written. A missing field or one of the wrong type (a `tie` that is not two numbers, say) is refused by the schema itself, as the SDK's input validation error.",
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
            "What the head turn is fitted to, as `measure_turn_reference` reports it off a front/turned reference pair. `eyeShift` (and the optional `noseShift`/`mouthShift`) is how far that feature slides across the head at full turn, as a fraction of the head's half-width — a MAGNITUDE: the rig turns both ways, so the sign is ignored. `farEyeRatio` is the far/near eye width at full turn over that same ratio at rest, `silhouetteRatio` the head's half-width turned over at rest. The half-width the shifts are fractions of is measured off the layers themselves, so it is not an input. An omitted field leaves that part of the turn at the profile the rig defaults to. A passed `eyeShift` is fitted by the turn's amount and clamped to the room the art leaves the far eye — the face plate's edge, or the bangs' side strand over the far iris (the result's `turn.clamped` lists every clamped field, `turn.achieved` what the rig reaches, and `turn.strandOverlap` how much of a far iris the bangs still cover). A passed `silhouetteRatio` is clamped too, only on a face drawn without hair and with ear islands, where narrowing the head that far would no longer cover the far ear's slide. Any other passed target this layer set cannot reach comes back as `INVALID: …` naming the field and the attainable range, since it is a measurement rather than a preference. A field not named here is refused the same way. A pair that shows a custom part crossing the eye row reads a wider head than the rig fits to, since the rig measures the role layers alone: measure a pair drawn without the custom parts.",
          ),
        style: z
          .unknown()
          .optional()
          .describe(
            "Removed in @ikijs/mcp 0.30.0: pass `rigPlan`. Any value here is refused with the field map.",
          ),
        rigPlan: z
          .object({
            turn: z
              .object({
                amount: z.number().optional(),
                featureLead: z.number().optional(),
                eyeForeshorten: z.number().optional(),
                noseLead: z.number().optional(),
              })
              .passthrough()
              .optional(),
            hair: z
              .object({
                follow: z.number().optional(),
                outlineFollow: z.number().optional(),
                sway: z.number().optional(),
              })
              .passthrough()
              .optional(),
            eyes: z
              .object({ blink: z.number().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional()
          .describe(
            "Per-character tuning from the profile the rig defaults to, in three groups: `turn` (`amount`, `featureLead`, `eyeForeshorten`, `noseLead`: the last two turn only, the nod untouched, and fitted by `turnTargets.farEyeRatio` / `turnTargets.noseShift` when those are given, which the `RIGPLAN:` line then reports as overridden), `hair` (`follow`, `outlineFollow`, `sway`) and `eyes` (`blink`). `describe_rig_plan` lists every field's default, range, recommended span, step and poses. A value out of range, or a group or key not named there, comes back as `INVALID: rigPlan.<path> …`; an object left out or `{}` is the profile. The result reports what the rig built with as `rigPlan` and a `RIGPLAN:` line.",
          ),
        customParts: z
          .array(
            z
              .object({
                id: z
                  .string()
                  .describe(
                    "The part's id: a plain identifier, not a role's name or a part id.",
                  ),
                path: z
                  .string()
                  .describe(
                    "The part's own PNG, the same size as the role layers (resolved against cwd), drawn alone and whole on a transparent ground.",
                  ),
                anchor: z
                  .string()
                  .describe("The role whose layer the part is fixed against."),
                tie: z
                  .array(z.number())
                  .length(2)
                  .describe(
                    "[x, y] in canvas px where the part meets the anchor: inside both the part's alpha box and the anchor layer's.",
                  ),
                after: z
                  .string()
                  .describe(
                    "A role of the set: the part is drawn right after that role's last part.",
                  ),
                deformer: z
                  .string()
                  .optional()
                  .describe(
                    "The matrix deformer it hangs on; only `headDeformer` (the default) is accepted.",
                  ),
                rigid: z
                  .boolean()
                  .optional()
                  .describe(
                    "The art does not bend (a hairpin, a ribbon): a bake that bends it by more than 0.0025 face widths at a stop, from its best-fit rotation and translation, is refused as `INVALID: bakes…` with nothing written. Give a rigid part one displacement for every control point, or a rotation.",
                  ),
                occlusion: z
                  .object({
                    by: z
                      .array(z.string())
                      .describe(
                        "Roles of the set whose paint hides the part (an arm role is its three parts); a non-empty list with no role repeated, each a role of the set. A role with a clipped or meshless part (`iris_L`, `forearm_pose_L`) is refused.",
                      ),
                    parameter: z
                      .string()
                      .describe(
                        "Any declared parameter but a physics output (a spring's or a chain segment's).",
                      ),
                    stops: z
                      .array(
                        z
                          .object({
                            value: z.number(),
                            amount: z
                              .number()
                              .describe(
                                "0 to 1: 1 hides the part wherever the roles' paint lies over it.",
                              ),
                          })
                          .passthrough(),
                      )
                      .describe(
                        "At least one, `value` strictly ascending and inside the parameter's range. The amount is linear between stops and held before the first and after the last.",
                      ),
                  })
                  .passthrough()
                  .optional()
                  .describe(
                    "Hide the part where the named roles' paint covers it, by an amount keyed on a parameter: `{ by, parameter, stops: [{ value, amount }] }`. Cover is where a role's drawn alpha at that pose is at least 0.5, a hard edge; a role that fades (`mouth_open`, a blush, a pose forearm) covers only while drawn at half strength or more. Use the stops as a short switch starting a degree or more past the idle sway, the hiding's progress coming from the part's baked motion. Needs @ikijs/mcp 0.35.0; an older server refuses the key as an unknown key (`INVALID: customParts[i]…`). An unknown key, a bad stop or a part the key cannot be written for comes back as `INVALID: customParts[i].occlusion…` with nothing written.",
                  ),
              })
              .passthrough(),
          )
          .optional()
          .describe(
            "Parts the auto-rigger has no role for, each `{ id, path, anchor, tie, after, deformer?, rigid?, occlusion? }`. A custom layer is read apart from `layers`: never role-parsed or measured, so its name is free and it does not widen the head the turn is fitted to; it counts toward the layer and pixel limits. All custom parts share one extra atlas page, the last, quantized on a palette of its own, so the other pages keep their bytes. An entry the rig refuses (an unknown key, a bad tie) comes back as `INVALID: customParts[i]…` with nothing written; a missing field or one of the wrong type (a `tie` that is not two numbers, say) is refused by the schema itself, as the SDK's input validation error. `[]` is the same rig as leaving the field out, plus an empty `customParts` in the result.",
          ),
        bakes: z
          .object({
            targets: z.array(
              z
                .object({
                  id: z.string().optional(),
                  param: z.string(),
                  parts: z.array(z.string()),
                  box: z
                    .object({
                      x: z.number(),
                      y: z.number(),
                      w: z.number(),
                      h: z.number(),
                    })
                    .passthrough()
                    .optional(),
                  grid: z
                    .object({ cols: z.number(), rows: z.number() })
                    .passthrough(),
                  stops: z.record(
                    z.string(),
                    z.array(z.array(z.number()).length(2)),
                  ),
                  mirror: z.boolean().optional(),
                  why: z.string().optional(),
                })
                .passthrough(),
            ),
            meshes: z
              .record(
                z.string(),
                z
                  .object({
                    rows: z.array(z.number()).optional(),
                    cols: z.number().optional(),
                    cellPx: z.number().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional()
          .describe(
            "Lattices that move the CUSTOM parts when a parameter does, which an unrigged custom part otherwise does not: `{ targets, meshes? }`; it needs `customParts` and names no other part. A target `{ id?, param, parts, box?, grid: { cols, rows }, stops, mirror?, why? }` is `(cols + 1) x (rows + 1)` control points laid evenly over `box` (canvas px; absent, the union of the parts' rest boxes grown by 2 px), listed row-major from the top-left; `stops` is `{ \"<value>\": [[dx, dy], … one per control point] }`. FRAME: every position and displacement is in canvas px, origin top-left, x right, y DOWN, the frame of the layer PNGs and of `describe_iki`'s boxes and `probe_rig`. A STOP is the part's TOTAL landed displacement from rest when `param` alone is at that value and every other parameter is at its default: the head's own carry is inside it, so a neighbour's displacement as `probe_rig` measures it is written as it is. Stop keys are values of `param` inside its range, never its default (rest is implicit). The landing is exact at rest, at each stop and at one end key at the range end on a side whose outermost stop is inside the range (it holds that stop's displacement); a side with no stop is not moved by the target. Between keys the offsets blend linearly, so under the head's roll (ParamAngleZ) the path bows off the line, about 1 px midway over 15°: put a stop where the path matters. Each vertex takes the bilinear value of the lattice at its REST position, and a vertex outside `box` takes the nearest edge's value. `mirror: true` fills a missing stop from the one at the value mirrored about the rest value, when that value is inside the parameter's range: the lattice reflected about the box's vertical centre line, `dx` negated; a stop you wrote is never overwritten. Targets that name the same part and parameter SUM; a part in targets on two parameters gets one warp per parameter, and the two add in the head's frame, so under a roll a sway tilts with the head. `meshes` re-meshes a custom part before the bake, `{ <id>: { rows: [canvas-px y, …], cols } }` (the first row at the part's top and the last at its bottom, within 0.5 px) or `{ <id>: { cellPx } }`; the rest picture is unchanged. The written model is then landed through the engine at every stop and at the range end each side holds its outermost stop to, and refused when one is off by 0.1 px or more. An input the rig refuses comes back as `INVALID: bakes…` (`bakes.targets[2].stops[\"30\"][7]…`) and nothing is written; a field of the wrong type is refused by the schema itself, as the SDK's input validation error. A bake is measured on one rig: after a retune of the layout or `rigPlan`, a regenerated anchor, a changed custom layer or an accepted patch batch, measure the stops again.",
          ),
        patches: z
          .array(
            z
              .object({
                target: z.string(),
                at: z.record(z.string(), z.number()),
                region: z
                  .object({
                    role: z.string(),
                    // Not z.tuple: its JSON Schema is the array-form `items`
                    // draft 2020-12 forbids. The rig checks the pair's order.
                    x: z.array(z.number()).length(2),
                    y: z.array(z.number()).length(2),
                  })
                  .passthrough(),
                by: z.object({ dx: z.number(), dy: z.number() }).passthrough(),
                falloff: z.number().optional(),
                why: z.string().optional(),
              })
              .passthrough(),
          )
          .optional()
          .describe(
            "Displacements ADDED to EXISTING keyform stops of the freshly generated rig, each op `{ target, at, region, by, falloff?, why? }`. They are replayed on every rig of these inputs, over whatever the rig now bakes, so they hold through a layout or `rigPlan` retune; ops on one stop add up, whatever their order. `target` is a feature grid — `eyeWarp_L`, `eyeWarp_R`, `browWarp_L`, `browWarp_R`, `noseWarp`, `mouthWarp`, whose `at` names both `ParamAngleX` and `ParamAngleY`, each -30, 0 or 30, never both 0 — or a mesh part with warps (`face`, `hair_front`, …), whose `at` names exactly one parameter at one of that part's warp keyform values, never the parameter's default nor the stop where the rig shuts the part on purpose (`eye_*` and `lash_lower_*` at their `ParamEye*Open` 0, the lip set and its tongue and teeth at `ParamMouthOpenY` 0), which the fold check exempts, nor a `ParamAngleZ` or `ParamBodyAngleZ` stop (they roll the deformers the part hangs under, so a displacement there is turned off the screen axes). The rest pose is the drawn art and no patch changes it. `bodyWarp` and the matrix deformers are not targets, and a patch adds no stop and changes no parameter range. `region` `{ role, x: [from, to], y: [from, to] }` is a rectangle in fractions of the REST layer box (the opaque crop) of `role`, origin top-left, x right, y DOWN, and may reach past the box: the target's points whose REST position lies inside take the whole of `by`, those within `falloff` of it a smooth share, the rest nothing. `by` `{ dx, dy }` and `falloff` are in face widths (the `face` layer's crop width), on screen axes: +dx toward the viewer's right (a character's `_L` side), +dy DOWN. Between stops the engine blends linearly, so a fix at ParamAngleX -30 shows at half strength at -15 and none at rest. `why` is a note the rig ignores. An op this schema accepts but the rig refuses — an unknown key, target, role or stop, the rest stop or a shut stop, a region running backwards or catching none of the target's points — comes back as `INVALID: patches[i]…`, listing the keys, targets, stops or roles there are, or where the target's points lie in the role's box, and nothing is written; a missing field or one of the wrong type is refused by the schema itself, as the SDK's input validation error.",
          ),
      },
    },
    async (args) => {
      try {
        const r = await autoRigFromLayers({
          ...args,
          // `.length(2)` makes each region span a pair, which its inferred
          // `number[]` cannot say.
          patches: args.patches as RigPatch[] | undefined,
          customParts: args.customParts as AutoRigCustomPartInput[] | undefined,
          // Each stop's `.length(2)` makes it a pair, which its inferred
          // `number[]` cannot say.
          bakes: args.bakes as RigBakes | undefined,
        });
        const text = r.ok
          ? [
              r.path,
              formatRigPlanReport(r.rigPlan),
              ...formatPatchReports(r.patches ?? []),
              ...formatFoldReport(r.folds, r.canvas),
              ...formatPhysicsReport(r.physics),
              ...formatHairSideReport(r.turn?.hairSide, r.canvas),
              ...formatCustomPartReports(r.customParts?.parts ?? []),
              ...formatBakeChecks(r.customParts?.bakes ?? []),
              ...(r.customParts ? formatCustomGate(r.customParts.gate) : []),
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
    "compose_layers_from_parts",
    {
      description:
        "Composes AI-generated part PNGs into canvas-aligned, role-named PNG layers on disk, ready for auto_rig_from_layers (the eyewhite split, alpha-trim/white-key, and placement pipeline the character-generation skill needs), with the same geometry report measure_layers returns standalone included inline. face, eyewhite, iris, brow, hair_front are required, with mouth.png — or the lip set's mouth_keyed.png (the open mouth, its inside painted flat #00FF00) + mouth_interior.png (the cavity, teeth and tongue alone), which the composer keys and splits into mouth_inner / lip_lower / lip_upper on one frame so auto_rig_from_layers folds the mouth open like the eyelid, the interior's light paint (luma 100 and over) written as mouth_tongue and mouth_teeth on the same frame, riding the opening's bottom and the upper line and clipped to the cavity (listed in `skipped` when the interior has none); the two routes cannot be mixed, one keyed file without the other is refused, and a key that fails (no green, green outside the opening, an outline not closed round it, more than one opening, no skin under the opening, an interior that is only lips, or one drawn opaque on a non-white or noisy ground) is refused naming the regeneration; with the lip set neither mouth nor mouth_open is written and preview.png shows the mouth closed, as the rig draws the rest pose. hair_back, body, mouth_open (legacy route only), blush (one blush.png makes the blush_L/blush_R pair), hair_side (one hair_side.png makes the hair_side_L/hair_side_R pair) and nose are optional — without a nose layer the head still turns on the rig's default profile, but it has no nose to lead the turn, and `auto_rig_from_layers` fits no turn to the art (`turnTargets` is inert, no `turn` report). The hair_side.png is the front side lock on the screen LEFT, hanging beside the ear with its root at the image's top: hair_side_R is as drawn and hair_side_L mirrored, both drawn over the face, brows and lashes and under hair_front, and without the file both are listed in `skipped`. One arm.png — the arm on the screen LEFT, drawn hanging with its shoulder at the top — makes both arms of a full body: arm_R takes it as drawn and arm_L mirrored. The arms are opt-in: without arm.png the compose is a bust's and `skipped` never lists them. arm.png needs body.png, and each arm is hung on the body's shoulder by default (see `layout`). One forearm_pose.png — the arm's forearm raised, on the screen LEFT, standing up from its elbow with the hand at the top — makes both pose forearms (forearm_pose_R as drawn, forearm_pose_L mirrored): each is scaled so its elbow end is as wide as its arm's elbow run and pinned on that arm's elbow (see `layout`), and it needs arm.png. With one, preview-pose.png shows the switch at 1 as the rig draws it (the hanging forearms hidden below the elbow, the pose forearms over everything) while preview.png stays the rest pose; without one it is removed. The inline report carries the full-body checks too: a body whose feet a tall canvas's bottom cuts off, an arm without a body, an arm whose shoulder cap does not reach under the torso's edge, and a pose forearm without its arm or off its arm's elbow in pivot, width or length. A nose whose dense core is a speck — under a quarter of its trimmed part's width or height, such as a lone nostril mark or highlight — is sized and placed whole, and the inline report warns of it. A light mark drawn detached above the eye white, such as a double-eyelid crease, is dropped from the sclera (the iris's clip); dark strokes there stay lash ink. The eyewhite's dark lower lid — its line and lashes — becomes lash_lower_L/lash_lower_R, drawn over the iris; a white with none writes none and lists them in `skipped`.",
      inputSchema: {
        partsDir: z
          .string()
          .describe(
            "Directory of the source part PNGs (resolved against cwd).",
          ),
        outDir: z
          .string()
          .describe(
            "Existing directory to write the role layer PNGs + preview.png (and preview-pose.png when there is a forearm_pose.png) into (resolved against cwd; must already exist; confined to the working directory). Reused across runs: a role this run does not write — one it skips, or an arm or pose forearm once arm.png or forearm_pose.png is gone, preview-pose.png included — has its stale PNG from an earlier run deleted.",
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
            "Per-role override merged over the built-in defaults, keyed by role — hair_back, body, arm_L, arm_R, face, blush_L, blush_R, nose, mouth, mouth_open, mouth_inner, eye_L, eye_R, iris_L, iris_R, lash_L, lash_R, brow_L, brow_R, hair_side_L, hair_side_R, hair_front, forearm_pose_L, forearm_pose_R — e.g. `{ eye_L: { cx: 660 } }`. `w` is an integer in 1..1100 (the canvas width) and `h` in 1..canvasHeight; omit `h` to keep the part's own aspect, set it to stretch. The defaults of the face's features — blush, nose, mouth, mouth_open, mouth_inner, eyes, irises, lashes, brows, side locks — are proportions of the face: an override of face.cx, face.cy or face.w carries them with it (scaled by the width; face.h stretches the face alone), while a feature's own override names canvas px. The nose is sized and placed by its dense core (its pixels at alpha >= 128, the drawing inside a soft nose's feather), not its whole part: `w`/`h` size the core, `cx` centres it, and a set `cy` centres its rows. A nose whose core is a speck — under a quarter of the trimmed part's width or height, such as a lone nostril mark or highlight — is sized and placed whole instead, and the report warns of it. Its `cy` defaults to unset, which lands the core's bottom row (the tip) 0.66 of the way from the eye row down to the mouth's, so the nose follows a retuned eye or mouth row. eye_L/lash_L and eye_R/lash_R are cut from one eyewhite into one frame, so each pair must land on the same frame — a pair set to land apart is rejected. lash_lower_L/lash_lower_R are cut from it too and have no key: they land on their eye's frame. mouth_inner is the lip set's one frame (mouth_open's place by default; lip_lower, lip_upper, mouth_tongue and mouth_teeth have no key and land on it, so a retune moves them together), and with the lip set the nose's tip rule reads layout.mouth_inner.cy. arm_L/arm_R have no cx/cy/w defaults: an unset `w` is 0.4 of the placed body's width, and an unset `cx` or `cy` hangs the arm's shoulder pivot — the one auto_rig_from_layers turns it about — on the body box's shoulder corner on that axis: its left edge for arm_R, its right edge for arm_L, 0.12 of its height under its top. A set one centres the arm as for every other role. forearm_pose_L/forearm_pose_R have no cx/cy/w defaults either: an unset `w` scales the forearm so its elbow end (the shoulder rule run from its bottom) is as wide as the placed arm's elbow run, and an unset `cx` or `cy` pins that elbow end's pivot on the arm's elbow — the one auto_rig_from_layers hangs it from.",
          ),
        mirrorParts: z
          .array(z.string())
          .optional()
          .describe(
            "Part files to flip left-right as they are read, e.g. `[\"eyewhite.png\"]`. The composer reads eyewhite.png as the eye on the screen LEFT (lash wing at the image's left end, lash-free tear duct at its right), brow.png as the brow on the screen RIGHT (thick head at the image's left end, tail at its right), blush.png as the blush on the screen LEFT (outer end, toward the face's edge, at the image's left end, inner end at its right), hair_side.png as the front side lock on the screen LEFT (hanging, its root at the image's top), arm.png as the arm on the screen LEFT (the character's right, hanging, its shoulder at the image's top), and forearm_pose.png as the raised forearm on the screen LEFT (standing up from its elbow, the hand at the image's top, the thumb toward the body at the image's right); a part drawn the other way round is fixed here for free. It flips the source, so every role cut from it flips together and an eye's sclera and lash stay in one frame.",
          ),
        canvasHeight: z
          .number()
          .optional()
          .describe(
            "The canvas's height in px: an even integer in 1100..4096, default 1100 (a square bust canvas; at 1100 every output is byte-identical to leaving it out). The width stays 1100. The canvas grows downward: every default and every override keeps its canvas px from the top-left, so the head lands where it does on a bust and a full body gets room below. An odd height is refused — model space is centred on the canvas, so it would put the head on a half pixel — and it is checked before any part decodes.",
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
        "Reports read-only geometry checks over an already-composed layers directory — the same checks compose_layers_from_parts returns inline (iris ratio/offset, eye aspect, cropped/cut edges, a nose whose dense core is a speck of its crop, missing optional roles, a body whose feet a tall canvas's bottom cuts off, an arm without a body, an arm whose shoulder cap does not reach under the torso's edge on its shoulder pivot's row, a pose forearm without its arm or whose elbow end is off its arm's elbow in pivot, width or length, a front side lock without hair_front, one whose top row shows past the bangs at rest, one covering the eye white's outer corner at rest, one whose lean on the turn away from it would bare columns neither hair_back nor the face paints, a hair_side.png drawing two locks, and the lip set: a partial one or one beside mouth/mouth_open, the fold's contract per column of the opening, an opening too narrow or short, a line too thin, green left, an interior with holes, and of mouth_tongue/mouth_teeth: one with no lip set, one on another canvas, one whose box leaves mouth_inner's — with the opening's size and the MouthOpen below which no slit shows). Every preview*.png is skipped. Use to re-check a layers dir without recomposing. Its nose check reads the composed file against its crop, which is what auto_rig_from_layers acts on. Compose's inline report does the same unless the composer found the source part's core a speck, which it reports instead — so a speck that resampling erased from the layer shows there and not here.",
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
        "Measures how far a head turns between two images of the same character — a front view and a turned one, at the SAME scale — as three ratios, so a rigged turn can be compared to a reference turn (or to an earlier rig) without registering the images: farEyeRatio (turned far/near iris width over the same ratio at rest), eyeShift (how far the eye pair slides across the head, in units of the FRONT head half-width; NEGATIVE = toward the image's left), silhouetteRatio (head half-width, turned over front). The ratios divide out crop and position, not scale, so the pair must already share framing and head size; since a yaw never changes iris height, a pair whose mean iris height differs by more than 10% is refused instead of measured as a turn. Reads engine renders (transparent backdrop) and opaque reference art alike. A pair that shows a custom part crossing the eye row reads a wider head than the rig fits to, so measure a pair drawn without the custom parts.",
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

  server.registerTool(
    "render_poses",
    {
      description:
        "Renders a rigged .iki into the character loop's pose PNGs with the real engine, through the installed Chrome, Edge or Chromium run headless (set CHROME_PATH to pick one). The model decides the set: a bust gets 560x560 shots (rest, turns, nod, blinks, gaze, combined — ParamAngleX/Y/Z all at 30 — and stress: ParamAngleX/Y/Z all at -30, ParamMouthOpenY 1, both eyes at 0.5, the brows at opposite extremes (ParamBrowLY -1, ParamBrowRY 1, ParamBrowLAngle 1, ParamBrowRAngle -1) and each body angle the model declares at -10); a mouth adds 720x480 mouth crops; a full body (taller than wide) adds the full-canvas body, arm and elbow poses on a 1400-wide canvas, and a model with a pose forearm adds the full-pose-* shots. Given `poses` (see its field), the standard set is not rendered: only those poses are, each crop clamped to the model's canvas. Writes <pose>.png files into outDir, overwriting same-named files in place; returns the written paths one per line, then the model's fold report (the result's `folds`), checked by the engine over its own pose set plus any `poses`, each of which a `FOLD` line names by its settings, not its PNG name: a `FOLD` line per warp deformer or mesh part that flips (ratio <= 0) or collapses (under 0.1) at some pose — its cell or triangle, the ratio of its area there to at rest, the pose as its parameter settings (`rest` for none) and where it rests, in model space and in model px from the top-left (the layer PNGs' own pixels, not a render's) — or `FOLDS: none over N poses`, then a `FOLDS expected:` line naming the closures the rig draws on purpose (an eye or the mouth shut), each by part id, ratio and the parameter that shuts it. Report-only: a fold never fails the render. The `PHYSICS` lines follow the fold report (the result's `physics`), one per physics rig output of the model's own rigs — `poses` do not enter it — reading ok, frozen or unstable with the step and idle amplitudes, or `PHYSICS: no rigs`; report-only too. Given `sweep`, also renders an eased turn of the head (see its field) and prints its paths and `SWEEP` lines (and, with `sweeps`, the turn-and-nod box). Fails with INVALID when no browser is found or an input is refused; a browser that cannot start is a tool error.",
      inputSchema: {
        modelPath: z
          .string()
          .describe(
            "Rigged .iki file path (resolved against cwd; must sit under the working directory).",
          ),
        outDir: z
          .string()
          .describe(
            "Existing directory to write the pose PNGs into (resolved against cwd; must already exist; confined to the working directory).",
          ),
        poses: z
          .array(
            z.object({
              name: z.string(),
              values: z.record(z.string(), z.number()),
              crop: z
                .object({
                  x: z.number(),
                  y: z.number(),
                  w: z.number(),
                  h: z.number(),
                })
                .optional(),
            }),
          )
          .optional()
          .describe(
            "Caller-named poses rendered INSTEAD of the standard set, each `{ name, values, crop? }`, in order. `name` becomes `<outDir>/<name>.png` and the result's pose name: letters, digits, `_`, `.` and `-` only, unique in the list ignoring case. `values` are parameter settings (every other parameter at its default; an id the model lacks is ignored). `crop` `{ x, y, w, h }` is a rectangle in model px from the top-left — the frame of describe_iki's boxes and of the `FOLD` lines — clamped to the model's canvas, then drawn 720 px wide at its own aspect; without one a pose is framed as the standard shots (560x560, the middle square on a full body). Each pose is also added to the fold sweep, after the engine's own poses. An empty list, a bad or repeated name, a non-finite value, or a crop that misses the canvas or would draw under 1 or over 8192 px tall comes back as `INVALID: poses…` and nothing is rendered.",
          ),
        sweep: z
          .object({
            name: z.string(),
            preset: z.literal("turn"),
            crop: z
              .object({
                x: z.number(),
                y: z.number(),
                w: z.number(),
                h: z.number(),
              })
              .optional(),
          })
          .optional()
          .describe(
            "A turn sweep rendered IN ADDITION to the poses, `{ name, preset: \"turn\", crop? }`: an eased `ParamAngleX` turn (0 to -30 to +30 to 0 over 3 s, sinusoidal) at 30 fps on a 60 Hz physics clock, with the hair physics running and the idle off, every other parameter at its default. `crop` is a rectangle in model px as a pose's, fixed for every frame; without one the frames are framed as the standard shots. Written into `<outDir>/<name>/` (created; `name` starts with a letter or digit, then letters, digits, `_`, `.`, `-`): `fNNN.png` (90 frames), `manifest.json` (each frame's time, angle and effective values), `sheet.png` (nine frames of the -30 to +30 leg, labelled with angle and time, at most 2000 px a side), `kymograph.png` (the eye row of every frame stacked over time), `index.html` (a flipbook to open from disk; add `?b=<relative dir of another sweep>` for two side by side). The text then lists the paths and, after the `PHYSICS` lines, a `SWEEP turn` line per landmark (eyes, nose) from the engine's geometry: amplitude in face widths, the kink of x and of the eye width through angle 0, the lead over the local face plate at each end, and the pop — report-only, like `FOLD` and `PHYSICS`. `sweeps` renders more sweeps beside this one. The `SWEEP nod` and `SWEEP corner` lines follow the `SWEEP turn` ones.",
          ),
        sweeps: z
          .array(
            z.object({
              name: z.string(),
              preset: z.enum(SWEEP_PRESETS),
              crop: z
                .object({
                  x: z.number(),
                  y: z.number(),
                  w: z.number(),
                  h: z.number(),
                })
                .optional(),
            }),
          )
          .optional()
          .describe(
            "More sweeps rendered after `sweep`, each `{ name, preset, crop? }` into its own `<outDir>/<name>/` (files and `crop` as `sweep`'s). Names are distinct from `sweep`'s and from each other's ignoring case, and presets are distinct (at most one of each). `turn` is `sweep`'s. `roll` is the same eased curve on `ParamAngleZ` (0 to -30 to +30 to 0 over 3 s, 90 frames, physics running, idle off); its `sheet.png` is the nine frames nearest the turn sheet's angles on the -30 to +30 leg, labelled with the angle (Z) and time, and it has no kymograph (the eye row moves with the roll). `turn-nod` is the box (0,0) -> (0,-30) -> (-30,-30) -> (-30,+30) -> (+30,+30) -> (+30,-30) -> (0,-30) -> (0,0) of `ParamAngleX` x `ParamAngleY`, each leg eased, 6 s, 180 frames; its `sheet.png` is a 3 x 3 grid BY ANGLE (columns AngleX -30/0/+30, rows AngleY +30/0/-30, rest in the centre, cells labelled X, Y and t) and it has no kymograph. `manifest.json` is version 2 (`parameters`, and per frame `t` and `values`). A sweep dir's earlier frames, sheet, kymograph, manifest and flipbook are cleared first. An empty list, a repeated name or preset, or a bad crop comes back as `INVALID: sweeps...`. A server before 0.32.0 strips `sweeps` and renders the rest. The `SWEEP nod` lines (the eye-pair and iris-pair gap range and the mouth width range along the nod at each turn, in face widths) and `SWEEP corner` lines (the additivity residual per landmark at the four corners, the rest term included; 0 on an additive rig) print once per call whenever `sweep` or `sweeps` was asked for, report-only like `FOLD` and `PHYSICS`. A `roll` adds no `SWEEP` line of its own and changes none: they are read from the model. `roll` needs @ikijs/mcp 0.34.0; an older server refuses it as an input validation error.",
          ),
        hideParts: z
          .array(z.string())
          .optional()
          .describe(
            "Part ids left out of the drawn frames (poses and sweeps); the fold, physics and sweep reports still read the whole model. Use it to render a character without its custom parts, so `measure_turn_reference` reads the rig's own head (a custom part crossing the eye row widens the head it measures, as it does on a drawn reference). An id the model lacks, or one that is the clip mask of a part that stays, or one a part that stays names in its `occlusion.by` (hide that part too), comes back as `INVALID: hideParts[i] …` and nothing is rendered. Needs @ikijs/mcp 0.34.0; an older server drops the field and draws every part.",
          ),
      },
    },
    async (args) => {
      try {
        const r = await renderPoses(args);
        const text = r.ok
          ? [
              ...r.poses.map((p) => p.path),
              ...[...(r.sweep ? [r.sweep] : []), ...(r.sweeps ?? [])].flatMap(
                (w) => [
                  w.dir,
                  w.sheet,
                  ...(w.kymograph ? [w.kymograph] : []),
                  w.flipbook,
                  w.manifest,
                ],
              ),
              ...formatFoldReport(r.folds, r.modelCanvas),
              ...formatPhysicsReport(r.physics),
              ...((r.sweep ?? r.sweeps?.[0])
                ? [
                    ...formatSweepReport((r.sweep ?? r.sweeps![0]).report),
                    ...formatNodReport((r.sweep ?? r.sweeps![0]).nod),
                  ]
                : []),
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
    "probe_rig",
    {
      description:
        "Measures a rigged .iki without rendering it, through the engine's own landing. Each query is one of: `paint` (the opaque runs, alpha 128 and over, of a layer PNG, per canvas row, as `{ y0, rows }` with `[x0, x1)` runs; read from the PNG you give, not the atlas, so a quantized model reads the same, and the PNG must be the model's canvas size), `land` (where each canvas-px point of a part lands in a pose) or `displacement` (the landing minus the point). The frame is canvas px, origin top-left, x right, y down — the frame of the layer PNGs and describe_iki's boxes. A point is `[x, y]` and must lie on the part at rest, inside one of its mesh triangles (a part without a mesh, its unit quad); its landing is then found by barycentric interpolation inside that triangle. A point outside the part's mesh comes back as `null`, never an extrapolation. `pose` is parameter settings: every parameter it does not name is at its default, a value outside the parameter's range is clamped as the player does, and an id the model does not declare or a non-finite value is refused. The text is the results as JSON, one entry per query in order. With `outputPath` (a `.probe.json` under the working directory, its folder existing) the results are written there as the same JSON and the text is the path and one line per query, so a part's paint stays out of your context for a rigging program to read. A query's refusal comes back as `INVALID: queries[i].<field> …`, any refusal writes nothing.",
      inputSchema: {
        modelPath: z
          .string()
          .describe(
            "Rigged .iki file path (resolved against cwd; must sit under the working directory).",
          ),
        queries: z
          .array(
            z.discriminatedUnion("op", [
              z.object({
                op: z.literal("paint"),
                path: z
                  .string()
                  .describe(
                    "Canvas-sized layer PNG (resolved against cwd), the drawing the part was built from.",
                  ),
              }),
              z.object({
                op: z.enum(["land", "displacement"]),
                part: z.string().describe("A part id of the model."),
                points: z
                  .array(z.array(z.number()).length(2))
                  .describe(
                    "Canvas-px points `[x, y]`, at most 5000, each on the part at rest.",
                  ),
                pose: z
                  .record(z.string(), z.number())
                  .optional()
                  .describe(
                    "Parameter id to value; the others stay at their defaults.",
                  ),
              }),
            ]),
          )
          .describe("The queries, answered in order; at most 64 per call."),
        outputPath: z
          .string()
          .optional()
          .describe(
            "A path ending in `.probe.json` (resolved against cwd, under it; its folder must exist) to write the results to.",
          ),
      },
    },
    async (args) => {
      try {
        // `points` is a plain number array in the schema (no tuple, see the
        // patches'); probeRig checks each is a [x, y] pair.
        const r = await probeRig(args as ProbeInput);
        const text = !r.ok
          ? `INVALID: ${r.error}`
          : "results" in r
            ? JSON.stringify(r.results)
            : [r.outputPath, ...r.lines].join("\n");
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

  return server;
}
