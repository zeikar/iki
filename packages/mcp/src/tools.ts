import fs from "node:fs";
import path from "node:path";
import {
  parseIkiModel,
  loadIkiModel,
  IkiFormatError,
  StandardParameter,
  type IkiModel,
  type IkiDeformer,
} from "@iki/format";
import {
  EditorDocument,
  packAtlas,
  uvRectFor,
  generateIkiFromLayerSet,
  parseLayerRoles,
  type LayerInput,
  type AtlasAssignment,
} from "@iki/editor-core";
import {
  decodePng,
  detectAlphaBbox,
  cropToBuffer,
  renderAtlasToDataUri,
  type AtlasCrop,
} from "./node-images";
import {
  AutoRigInputError,
  MAX_LAYERS,
  MAX_LAYER_DIM,
  MAX_CANVAS_DIM,
  MAX_ATLAS_AREA,
  MAX_TOTAL_PIXELS,
  MAX_OUTPUT_BYTES,
  resolveInputPath,
  resolveOutputPath,
} from "./limits";

export type ValidateResult = { ok: true } | { ok: false; error: string };

export interface IkiSummary {
  name: string;
  canvas: { width: number; height: number };
  parameters: { id: string; min: number; max: number; default: number }[];
  parts: { id: string; order: number; deformer?: string }[];
  deformers: DeformerSummary[];
}

export interface DeformerSummary {
  id: string;
  kind: "matrix" | "warp";
  parent?: string;
  warp?:
    | { mode: "1d"; parameters: string[] }
    | {
        mode: "2d";
        parameterX: string;
        parameterY: string;
        gridX: number;
        gridY: number;
      };
}

export type DescribeResult =
  | { ok: true; summary: IkiSummary }
  | { ok: false; error: string };

export interface StandardParameterInfo {
  id: string;
  description: string;
}

function coerceModel(
  model: unknown,
): { ok: true; model: IkiModel } | { ok: false; error: string } {
  try {
    const parsed =
      typeof model === "string" ? loadIkiModel(model) : parseIkiModel(model);
    return { ok: true, model: parsed };
  } catch (e) {
    if (e instanceof IkiFormatError) return { ok: false, error: e.message };
    throw e;
  }
}

export function validateIki(model: unknown): ValidateResult {
  const result = coerceModel(model);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

export function describeIki(model: unknown): DescribeResult {
  const result = coerceModel(model);
  if (!result.ok) return { ok: false, error: result.error };

  const m = result.model;

  const parameters = m.parameters.map((p) => ({
    id: p.id,
    min: p.min,
    max: p.max,
    default: p.default,
  }));

  const parts = m.parts.map((p) => {
    const entry: { id: string; order: number; deformer?: string } = {
      id: p.id,
      order: p.order,
    };
    if (p.deformer !== undefined) entry.deformer = p.deformer;
    return entry;
  });

  const deformers = (m.deformers ?? []).map(
    (d: IkiDeformer): DeformerSummary => {
      const kind = d.kind === "warp" ? "warp" : "matrix";
      const entry: DeformerSummary = { id: d.id, kind };
      if (d.parent !== undefined) entry.parent = d.parent;

      if (d.kind === "warp") {
        if (d.warp2d !== undefined) {
          entry.warp = {
            mode: "2d",
            parameterX: d.warp2d.parameter,
            parameterY: d.warp2d.parameterY,
            gridX: d.grid.cols,
            gridY: d.grid.rows,
          };
        } else if (d.warps !== undefined && d.warps.length > 0) {
          entry.warp = {
            mode: "1d",
            parameters: d.warps.map((w) => w.parameter),
          };
        }
      }

      return entry;
    },
  );

  const summary: IkiSummary = {
    name: m.name,
    canvas: { width: m.canvas.width, height: m.canvas.height },
    parameters,
    parts,
    deformers,
  };

  return { ok: true, summary };
}

// Static map of standard parameter ids to human-readable descriptions,
// sourced from JSDoc comments in parameters.ts (including range hints).
const STANDARD_PARAMETER_INFO: StandardParameterInfo[] = [
  {
    id: StandardParameter.MouthOpen,
    description: "Mouth open amount for lip-sync (0 closed .. 1 open).",
  },
  {
    id: StandardParameter.MouthForm,
    description: "Mouth form / smile (-1 .. 1).",
  },
  {
    id: StandardParameter.EyeOpenLeft,
    description:
      "Left eye open (0 closed .. 1 open). Drive with the right eye for a blink.",
  },
  {
    id: StandardParameter.EyeOpenRight,
    description: "Right eye open (0 closed .. 1 open).",
  },
  {
    id: StandardParameter.EyeballX,
    description: "Eyeball gaze, horizontal (-1 .. 1).",
  },
  {
    id: StandardParameter.EyeballY,
    description: "Eyeball gaze, vertical (-1 .. 1).",
  },
  {
    id: StandardParameter.AngleX,
    description: "Head angle, horizontal degrees.",
  },
  {
    id: StandardParameter.AngleY,
    description: "Head angle, vertical degrees.",
  },
  {
    id: StandardParameter.AngleZ,
    description: "Head tilt / roll degrees.",
  },
  {
    id: StandardParameter.Breath,
    description: "Idle breath (0 .. 1), cycled by the host.",
  },
  {
    id: StandardParameter.BrowLeftY,
    description: "Left brow raise/lower (-1 .. 1).",
  },
  {
    id: StandardParameter.BrowRightY,
    description: "Right brow raise/lower (-1 .. 1).",
  },
  {
    id: StandardParameter.BrowLeftAngle,
    description: "Left brow tilt/angle (-1 .. 1).",
  },
  {
    id: StandardParameter.BrowRightAngle,
    description: "Right brow tilt/angle (-1 .. 1).",
  },
];

export function listStandardParameters(): StandardParameterInfo[] {
  return STANDARD_PARAMETER_INFO.map((p) => ({ ...p }));
}

// ── auto_rig_from_layers ──────────────────────────────────────────────────────

/** One role-named PNG layer; role is derived from `fileName ?? basename(path)`. */
export interface AutoRigLayerInput {
  fileName?: string;
  path: string;
}

export interface AutoRigInput {
  layers: AutoRigLayerInput[];
  /** Output `.iki` path (relative paths resolve against the process cwd). */
  outputPath?: string;
}

export type AutoRigResult =
  | {
      ok: true;
      path: string;
      canvas: { width: number; height: number };
      partCount: number;
      atlasBytes: number;
    }
  | { ok: false; error: string };

/**
 * Run a fallible input/environment-boundary call, re-tagging any throw as an
 * AutoRigInputError with context so the tool reports it as `{ ok:false }` rather
 * than an unexpected `isError`. Use ONLY around true caller-input / filesystem
 * boundaries — never around internal pipeline math (a throw there is a bug).
 */
function expectInput<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new AutoRigInputError(
      `${label}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Decode role-named PNG file paths, auto-rig a model from them, atlas + embed
 * the textures (Node sharp), validate, and write the renderable `.iki` to disk.
 * Returns the output path + summary stats (the multi-MB model is never inlined).
 *
 * Re-host of examples/editor/src/store.ts `importLayerSet` with the three DOM
 * pixel functions swapped for the sharp-backed ./node-images helpers; the pure
 * model math is reused from @iki/editor-core.
 *
 * Error boundary: ONLY AutoRigInputError (caller input / filesystem) → `{ ok:false }`;
 * any other throw (invariant break, programmer bug) propagates to `isError`.
 */
export async function autoRigFromLayers(
  input: AutoRigInput,
): Promise<AutoRigResult> {
  try {
    const layers = input.layers;
    if (!Array.isArray(layers) || layers.length === 0) {
      throw new AutoRigInputError("layers must be a non-empty array");
    }
    if (layers.length > MAX_LAYERS) {
      throw new AutoRigInputError(
        `too many layers: ${layers.length} > ${MAX_LAYERS}`,
      );
    }

    // Resolve the output path FIRST (fail-fast): reject a bad/escaping/non-.iki
    // target before spending the image-decode budget on a request that can't
    // be written anyway.
    const outPath = resolveOutputPath(
      input.outputPath ?? "auto-rigged-model.iki",
    );

    // Resolve paths + role-map up front (input boundary; no decode needed).
    // parseLayerRoles throws on unknown/duplicate/missing-required roles.
    const resolvedLayers = layers.map((layer) => {
      const resolved = resolveInputPath(layer.path);
      return { resolved, fileName: layer.fileName ?? path.basename(resolved) };
    });
    const rolePairs = expectInput("role parsing", () =>
      parseLayerRoles(resolvedLayers.map((r) => r.fileName)),
    );
    const roleByFileName = new Map(rolePairs.map((p) => [p.fileName, p.role]));

    // Decode + alpha-bbox + crop SEQUENTIALLY: only ONE full-canvas RGBA buffer
    // is live at a time (a Promise.all over all layers would hold every decoded
    // buffer at once, allowing a multi-GB spike on inputs that each pass
    // MAX_LAYER_DIM). MAX_TOTAL_PIXELS bounds the aggregate work. Canvas size =
    // the first layer's full PNG dims (parity with buildLayerInputs in
    // examples/editor/src/auto-rig-image.ts); all layers must match it.
    let canvasW = 0;
    let canvasH = 0;
    let totalPixels = 0;
    const layerInputs: LayerInput[] = [];
    const crops: AtlasCrop[] = [];
    for (let i = 0; i < resolvedLayers.length; i++) {
      const { resolved, fileName } = resolvedLayers[i];
      const png = await decodePng(resolved);
      if (png.width > MAX_LAYER_DIM || png.height > MAX_LAYER_DIM) {
        throw new AutoRigInputError(
          `layer ${resolved} dimension ${png.width}x${png.height} exceeds ${MAX_LAYER_DIM}`,
        );
      }
      totalPixels += png.width * png.height;
      if (totalPixels > MAX_TOTAL_PIXELS) {
        throw new AutoRigInputError(
          `total decoded pixels exceed ${MAX_TOTAL_PIXELS}`,
        );
      }
      if (i === 0) {
        canvasW = png.width;
        canvasH = png.height;
        if (canvasW > MAX_CANVAS_DIM || canvasH > MAX_CANVAS_DIM) {
          throw new AutoRigInputError(
            `canvas ${canvasW}x${canvasH} exceeds ${MAX_CANVAS_DIM}`,
          );
        }
      } else if (png.width !== canvasW || png.height !== canvasH) {
        throw new AutoRigInputError(
          `layer "${fileName}" size ${png.width}x${png.height} differs from canvas ${canvasW}x${canvasH}`,
        );
      }

      const role = roleByFileName.get(fileName);
      if (role === undefined) {
        throw new AutoRigInputError(`no role resolved for "${fileName}"`);
      }
      let bbox: { x: number; y: number; w: number; h: number };
      try {
        bbox = detectAlphaBbox(png.rgba, png.width, png.height);
      } catch (e) {
        // Enrich the empty-layer error with role + file context.
        const msg = e instanceof Error ? e.message : String(e);
        throw new AutoRigInputError(
          `role "${role}" file "${fileName}": ${msg}`,
        );
      }
      const buffer = await cropToBuffer(png.rgba, png.width, png.height, bbox);
      // png.rgba (full-canvas) is dropped at the next iteration — GC reclaims it
      // before the next decode, so peak memory stays ~one canvas + the crops.
      layerInputs.push({
        role,
        fileName,
        canvasW,
        canvasH,
        bbox,
        cropW: bbox.w,
        cropH: bbox.h,
      });
      crops.push({ id: role, buffer, width: bbox.w, height: bbox.h });
    }

    // Internal pipeline — direct calls. By here roles + bboxes are validated, so
    // a throw is an invariant break / bug and must propagate to `isError`.
    const model = generateIkiFromLayerSet(layerInputs, {
      width: canvasW,
      height: canvasH,
    });
    const doc = new EditorDocument(model);

    const layout = packAtlas(
      crops.map((c) => ({ id: c.id, width: c.width, height: c.height })),
    );
    if (layout.pageWidth * layout.pageHeight > MAX_ATLAS_AREA) {
      throw new AutoRigInputError(
        `atlas page ${layout.pageWidth}x${layout.pageHeight} exceeds max area ${MAX_ATLAS_AREA}`,
      );
    }

    const dataUri = await renderAtlasToDataUri(crops, layout);
    if (dataUri.length > MAX_OUTPUT_BYTES) {
      throw new AutoRigInputError(
        `atlas data URI ${dataUri.length} bytes exceeds ${MAX_OUTPUT_BYTES}`,
      );
    }

    const partTextureAssignments: AtlasAssignment[] = crops.map((crop) => {
      const placement = layout.placements.find((p) => p.id === crop.id);
      if (placement === undefined) {
        throw new Error(`auto-rig: no atlas placement for "${crop.id}"`);
      }
      return {
        partId: crop.id,
        uv: uvRectFor(placement, {
          width: layout.pageWidth,
          height: layout.pageHeight,
        }),
      };
    });

    doc.applyAtlas({ textures: [{ source: dataUri }], partTextureAssignments });
    // Validate the patched model before writing — never persist an invalid model.
    const finalModel = parseIkiModel(doc.getModel());

    expectInput("write", () =>
      fs.writeFileSync(outPath, JSON.stringify(finalModel)),
    );

    return {
      ok: true,
      path: outPath,
      canvas: { width: canvasW, height: canvasH },
      partCount: finalModel.parts.length,
      atlasBytes: dataUri.length,
    };
  } catch (err) {
    if (err instanceof AutoRigInputError)
      return { ok: false, error: err.message };
    throw err;
  }
}
