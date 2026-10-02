import path from "node:path";
import {
  parseIkiModel,
  loadIkiModel,
  IkiFormatError,
  StandardParameter,
  type IkiModel,
  type IkiDeformer,
} from "@ikijs/format";
import {
  EditorDocument,
  packAtlas,
  uvRectFor,
  createLayerSetMeasurer,
  generateIkiFromLayerSet,
  parseLayerRoles,
  TurnTargetError,
  type IrisStrand,
  type LayerSetMeasurer,
  type AtlasAssignment,
  type AtlasLayout,
  type RigStyle,
  type TurnTargets,
  type TurnSolveReport,
} from "@ikijs/editor";
import {
  decodePng,
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
  writeFileAtomic,
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
    description:
      "Head tilt / roll degrees; positive tilts the top of the head toward the viewer's right (clockwise), as in Live2D.",
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
  {
    id: StandardParameter.HairSwayX,
    description:
      "Horizontal hair-sway driver. Physics OUTPUT — driven by the spring, hosts should not set it directly.",
  },
  {
    id: StandardParameter.HairSwayZ,
    description:
      "Hair-sway driver behind a head tilt. Physics OUTPUT — driven by the spring, hosts should not set it directly.",
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
  /** Palette-quantize the atlas PNG to this many colours (integer, 2..256).
   *  Omitted = lossless. See renderAtlasToDataUri for the size/quality trade.
   *  A `nose` layer is left out of the quantized page, on a second, lossless
   *  page of its own, because the palette rims a soft-shaded nose's feather. */
  quantizeColors?: number;
  /** Head-turn cues to fit the rig to, as `measure_turn_reference` reports
   *  them. */
  turnTargets?: AutoRigTurnTargets;
  /** Per-character tuning from the Live2D profile's defaults (see
   *  @ikijs/editor's `RigStyle`). */
  style?: RigStyle;
}

/** The turn cues a caller may pass, which is every one but `headHalfWidth`:
 *  the pixels the shift fractions are fractions of are measured off the layers
 *  themselves, not accepted from the caller. */
export type AutoRigTurnTargets = Omit<TurnTargets, "headHalfWidth">;

export type AutoRigResult =
  | {
      ok: true;
      path: string;
      canvas: { width: number; height: number };
      partCount: number;
      /** The atlas's embedded size: its data URI's length, summed over both
       *  pages when a quantized rig puts the nose on a page of its own. */
      atlasBytes: number;
      /** The head's half-width at the eye row, measured off the layers.
       *  Absent when the opaque (alpha >= 128) union has no span there — a
       *  layer set painted translucent below that threshold — in which case
       *  the face plate stands in for it, same as a span that measures
       *  narrower than the plate. */
      headHalfWidth?: number;
      /** Whether the measured value was handed to the generator; the
       *  face-half fallback applies otherwise, which is what happens when it
       *  is no wider than the face plate, or absent entirely. */
      headHalfWidthApplied: boolean;
      /** Every role with an opaque pixel in the same eye-row band as
       *  `headHalfWidth`, per side, each with its own rest x there (canvas px)
       *  — present only when `headHalfWidthApplied` is true, since the
       *  fallback path has no measured edge to report at all. Passed to the
       *  generator so it can land each candidate through its OWN motion
       *  (hair_front's silhouette hold, a turn group's grid for the face and
       *  its features, the body's own turn translate; `hair_back` holds the
       *  outline and lands where it rests, and a role outside that table is
       *  refused) and take the outermost LANDING, not just the outermost
       *  REST pixel. */
      headEdges?: {
        left: { role: string; x: number }[];
        right: { role: string; x: number }[];
      };
      /** Each side's iris and the `hair_front` run it would slide under on
       *  the turn, as pixel edges on the row holding that iris's centre, in
       *  model coordinates (`IrisStrand`: canvas x minus half the canvas
       *  width) — measured whenever the layer set has `hair_front`, `iris_L`
       *  and `iris_R`, and passed to the generator as `options.strandEdges`.
       *  A run narrower than half that iris's painted width on the row is
       *  hair detail, not a strand, and is skipped as if clear. A side is
       *  absent only when its iris has no opaque pixel on that row, or when no
       *  run it keeps covers the pixel on that side of the iris's centre or
       *  lies outward of it; the whole field only when neither side has one. */
      strandEdges?: { left?: IrisStrand; right?: IrisStrand };
      /** The nose's dense core, canvas px — its pixels at alpha >= 128, not
       *  grown — the box handed to the generator as the nose layer's
       *  `denseCore` and, there, its turn landmark. Absent without a `nose`
       *  layer, when the nose has no pixel at that threshold (painted wholly
       *  translucent), or when its core is a speck of its crop
       *  (`isSpeckCore`: a lone nostril mark or highlight); the crop stands
       *  in for it in both cases. */
      noseCore?: { x: number; y: number; w: number; h: number };
      /** What the turn solve settled on — the cues the rig reaches, the
       *  targets it had to cut down (`clamped`) and, per side whose far iris
       *  the bangs' run still covers at some far stop, how much of it
       *  (`strandOverlap`). Absent for a layer set with no nose, which solves
       *  no turn at all. */
      turn?: TurnSolveReport;
    }
  | { ok: false; error: string };

export type { TurnSolveReport };

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
 * The role that keeps a lossless atlas page of its own under `quantizeColors`.
 * At 256 colours a soft nose's feather took the hair edge's lavender palette
 * entries and drew a rim around the nose; changing the dither, the effort, the
 * alpha floor or the alpha curve did not fix it. A lossless page for the nose
 * alone did, and the hero's model came to about 1.28 MB, against 3.18 MB with
 * the whole atlas lossless.
 */
const LOSSLESS_PAGE_ROLE = "nose";

/** Pack `crops` onto one atlas page, refused over MAX_ATLAS_AREA, and render
 *  it — palette-quantized to `quantizeColors` when that is set. */
async function renderAtlasPage(
  crops: AtlasCrop[],
  quantizeColors: number | undefined,
): Promise<{ crops: AtlasCrop[]; layout: AtlasLayout; dataUri: string }> {
  const layout = packAtlas(
    crops.map((c) => ({ id: c.id, width: c.width, height: c.height })),
  );
  if (layout.pageWidth * layout.pageHeight > MAX_ATLAS_AREA) {
    throw new AutoRigInputError(
      `atlas page ${layout.pageWidth}x${layout.pageHeight} exceeds max area ${MAX_ATLAS_AREA}`,
    );
  }
  const dataUri = await renderAtlasToDataUri(crops, layout, quantizeColors);
  return { crops, layout, dataUri };
}

/**
 * Decode role-named PNG file paths, auto-rig a model from them, atlas + embed
 * the textures (Node sharp), validate, and write the renderable `.iki` to disk.
 * Returns the output path + summary stats (the multi-MB model is never inlined).
 *
 * The head turn is fitted to `input.turnTargets`, on what @ikijs/editor's
 * `createLayerSetMeasurer` measures off the decoded layers (the head
 * half-width, `headEdges`, `strandEdges`, the face's `rowHalfWidths`, the hair
 * layers' opaque runs and the nose's dense core, returned as `noseCore`); what
 * the solve settled on comes back in `turn`. Under `quantizeColors` the nose
 * is atlased alone on a second, lossless page, which the palette would
 * otherwise rim; `atlasBytes` sums both pages.
 *
 * Re-host of examples/editor/src/store.ts `importLayerSet` with the three DOM
 * pixel functions swapped for the sharp-backed ./node-images helpers; the pure
 * model math is reused from @ikijs/editor.
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
    const quantizeColors = input.quantizeColors;
    if (
      quantizeColors !== undefined &&
      (!Number.isInteger(quantizeColors) ||
        quantizeColors < 2 ||
        quantizeColors > 256)
    ) {
      throw new AutoRigInputError(
        `quantizeColors must be an integer in 2..256, got ${String(quantizeColors)}`,
      );
    }
    // Checked before the generator call spreads it: a spread turns null or an
    // array into {}, which would rig on the defaults instead of refusing.
    const turnTargets: unknown = input.turnTargets;
    if (turnTargets !== undefined) {
      if (
        typeof turnTargets !== "object" ||
        turnTargets === null ||
        Array.isArray(turnTargets)
      ) {
        throw new AutoRigInputError("turnTargets must be a plain object");
      }
      // Excluded from AutoRigTurnTargets, but a JS caller can still pass one:
      // the half-width is measured off the layers below, so a caller's own is
      // refused rather than silently dropped.
      if ((turnTargets as TurnTargets).headHalfWidth !== undefined) {
        throw new AutoRigInputError(
          "turnTargets.headHalfWidth is measured off the layers, not accepted as input",
        );
      }
    }

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
    // Measures each layer while its decoded pixels are live, keeping none of
    // them (see createLayerSetMeasurer). Created once the first layer gives the
    // canvas.
    let measurer: LayerSetMeasurer | undefined;
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
        measurer = createLayerSetMeasurer({ width: canvasW, height: canvasH });
      } else if (png.width !== canvasW || png.height !== canvasH) {
        throw new AutoRigInputError(
          `layer "${fileName}" size ${png.width}x${png.height} differs from canvas ${canvasW}x${canvasH}`,
        );
      }

      const role = roleByFileName.get(fileName);
      if (role === undefined) {
        throw new AutoRigInputError(`no role resolved for "${fileName}"`);
      }
      // Created at i === 0 above.
      const layer = measurer!.add({ role, fileName, rgba: png.rgba });
      if (layer === null) {
        throw new AutoRigInputError(
          `role "${role}" file "${fileName}": layer is empty after alpha threshold`,
        );
      }
      const { bbox } = layer;
      const buffer = await cropToBuffer(png.rgba, png.width, png.height, bbox);
      // png.rgba (full-canvas) is dropped at the next iteration — GC reclaims it
      // before the next decode, so peak memory stays ~one canvas + the crops.
      crops.push({ id: role, buffer, width: bbox.w, height: bbox.h });
    }
    // `layers` is non-empty (checked above), so the loop created the measurer.
    const measurement = measurer!.finish();
    const { headHalfWidth, headHalfWidthApplied, turnOptions } = measurement;
    const { headEdges, strandEdges } = turnOptions;

    // The nose layer's own denseCore, for the result — undefined without a
    // `nose` layer, or when the measurer's denseCoreOf found no pixel at
    // ALPHA_OPAQUE or a speck of the crop.
    const noseCore = measurement.layers.find(
      (l) => l.role === "nose",
    )?.denseCore;

    // Internal pipeline — direct calls. By here roles + bboxes are validated, so
    // a throw is an invariant break / bug and must propagate to `isError` —
    // except from the turn solve, the one part of the generator that reads
    // CALLER input. It marks those with TurnTargetError (a field that is not a
    // number, a target this layer set cannot reach), which is a fact about the
    // request, not a bug.
    let turn: TurnSolveReport | undefined;
    let model: IkiModel;
    try {
      // The caller's fields cross as passed (a headHalfWidth was refused
      // above), so the generator refuses a misspelt one; the measured
      // headHalfWidth, when applied, is merged in after them.
      model = generateIkiFromLayerSet(
        measurement.layers,
        { width: canvasW, height: canvasH },
        {
          turnTargets: {
            ...input.turnTargets,
            ...turnOptions.turnTargets,
          },
          onTurnSolved: (report) => {
            turn = report;
          },
          ...(input.style === undefined ? {} : { style: input.style }),
          ...(headEdges === undefined ? {} : { headEdges }),
          ...(strandEdges === undefined ? {} : { strandEdges }),
        },
      );
    } catch (e) {
      if (!(e instanceof TurnTargetError)) throw e;
      throw new AutoRigInputError(e.message);
    }
    const doc = new EditorDocument(model);

    // Under quantizeColors the nose is page 1, alone and lossless (see
    // LOSSLESS_PAGE_ROLE), and page 0 every other crop; otherwise one page.
    const losslessCrop =
      quantizeColors === undefined
        ? undefined
        : crops.find((c) => c.id === LOSSLESS_PAGE_ROLE);
    const pages =
      losslessCrop === undefined
        ? [await renderAtlasPage(crops, quantizeColors)]
        : [
            await renderAtlasPage(
              crops.filter((c) => c !== losslessCrop),
              quantizeColors,
            ),
            await renderAtlasPage([losslessCrop], undefined),
          ];
    const atlasBytes = pages.reduce((sum, p) => sum + p.dataUri.length, 0);
    if (atlasBytes > MAX_OUTPUT_BYTES) {
      throw new AutoRigInputError(
        `atlas data URI ${atlasBytes} bytes exceeds ${MAX_OUTPUT_BYTES}`,
      );
    }

    // Each crop's uv is on its own page, normalised to that page's size.
    const partTextureAssignments: AtlasAssignment[] = pages.flatMap(
      ({ crops: pageCrops, layout }) =>
        pageCrops.map((crop) => {
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
        }),
    );

    // applyAtlas takes a single page: it sets every part's index to 0 and
    // remaps each mesh's uvs into its rect, which for the nose is already in
    // page 1's space — so the nose only needs its index, set on a clone
    // because getModel() hands back the document's live model, read-only.
    doc.applyAtlas({
      textures: [{ source: pages[0].dataUri }],
      partTextureAssignments,
    });
    let patched = doc.getModel();
    if (losslessCrop !== undefined) {
      patched = structuredClone(patched);
      patched.textures = pages.map((p) => ({ source: p.dataUri }));
      patched.parts.find((p) => p.id === losslessCrop.id)!.texture!.index = 1;
    }
    // Validate the patched model before writing — never persist an invalid model.
    const finalModel = parseIkiModel(patched);

    // Write to a fresh temp file in the verified directory, then atomically
    // rename over the target — see writeFileAtomic for why an existing `.iki`
    // symlink at outPath cannot redirect the write outside the working tree.
    writeFileAtomic(outPath, JSON.stringify(finalModel));

    return {
      ok: true,
      path: outPath,
      canvas: { width: canvasW, height: canvasH },
      partCount: finalModel.parts.length,
      atlasBytes,
      ...(headHalfWidth === undefined ? {} : { headHalfWidth }),
      headHalfWidthApplied,
      ...(headEdges === undefined ? {} : { headEdges }),
      ...(strandEdges === undefined ? {} : { strandEdges }),
      ...(noseCore === undefined ? {} : { noseCore }),
      ...(turn === undefined ? {} : { turn }),
    };
  } catch (err) {
    if (err instanceof AutoRigInputError)
      return { ok: false, error: err.message };
    throw err;
  }
}
