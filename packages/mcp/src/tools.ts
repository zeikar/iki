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
  generateIkiFromLayerSet,
  parseLayerRoles,
  TurnTargetError,
  type IrisStrand,
  type LayerInput,
  type AtlasAssignment,
  type TurnTargets,
  type TurnSolveReport,
} from "@ikijs/editor";
import {
  decodePng,
  detectAlphaBbox,
  cropToBuffer,
  renderAtlasToDataUri,
  type AtlasCrop,
} from "./node-images";
import {
  ALPHA_OPAQUE,
  HEAD_BAND,
  foregroundSpan,
  headHalfOf,
} from "./measure-turn";
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
   *  Omitted = lossless. See renderAtlasToDataUri for the size/quality trade. */
  quantizeColors?: number;
  /** Head-turn cues to fit the rig to, as `measure_turn_reference` reports
   *  them. */
  turnTargets?: AutoRigTurnTargets;
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
       *  A side is absent only when its iris has no opaque pixel on that row,
       *  or when no run covers the pixel on that side of the iris's centre or
       *  lies outward of it; the whole field only when neither side has one. */
      strandEdges?: { left?: IrisStrand; right?: IrisStrand };
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
 * The row the head's width is measured at: the mean of the iris centres, or of
 * the eye centres when the layer set has no irises. `measure_turn_reference`
 * picks the same row off a render — it finds the irises themselves — so the
 * head it spans there is the head spanned here.
 */
function eyeRowOf(layers: LayerInput[]): number {
  const centreY = (role: string): number | undefined => {
    const layer = layers.find((l) => l.role === role);
    return layer && layer.bbox.y + layer.bbox.h / 2;
  };
  const pairRow = (left: string, right: string): number | undefined => {
    const a = centreY(left);
    const b = centreY(right);
    return a === undefined || b === undefined ? undefined : (a + b) / 2;
  };
  const row = pairRow("iris_L", "iris_R") ?? pairRow("eye_L", "eye_R");
  if (row === undefined) {
    // eye_L/eye_R are required roles, so parseLayerRoles refused this set long
    // before here — a miss is an invariant break, not caller input.
    throw new Error("auto-rig: no eye pair to measure the head width at");
  }
  return Math.round(row);
}

/**
 * `foregroundSpan`, but over one layer's own already-reduced per-row
 * left/right (see `rowSpansByRole` in `autoRigFromLayers`) instead of a
 * pixel mask — the same row-band reduction, without re-scanning pixels.
 */
function foregroundSpanOfRows(
  rowLeft: Int32Array,
  rowRight: Int32Array,
  rowLo: number,
  rowHi: number,
): { left: number; right: number } {
  let left = Infinity;
  let right = -Infinity;
  for (
    let y = Math.max(0, rowLo);
    y <= Math.min(rowLeft.length - 1, rowHi);
    y++
  ) {
    if (rowLeft[y] < left) left = rowLeft[y];
    if (rowRight[y] > right) right = rowRight[y];
  }
  return { left, right };
}

/** The face plate's half-width, derived the way generateIkiFromLayerSet derives
 *  it — off the `face` layer's cropped width — so the two agree on which head
 *  is the wider one. */
function facePlateHalfOf(layers: LayerInput[]): number {
  const face = layers.find((l) => l.role === "face");
  if (face === undefined) {
    // `face` is a required role; parseLayerRoles refused this set long before.
    throw new Error("auto-rig: no face layer to measure the plate against");
  }
  return face.cropW / 2;
}

/**
 * Decode role-named PNG file paths, auto-rig a model from them, atlas + embed
 * the textures (Node sharp), validate, and write the renderable `.iki` to disk.
 * Returns the output path + summary stats (the multi-MB model is never inlined).
 *
 * The head turn is fitted to `input.turnTargets`, on the head half-width this
 * measures off the layers themselves; what the solve settled on comes back in
 * `turn`. The face layer alone also gets its per-row painted half-widths
 * (`LayerInput.rowHalfWidths`), which bend the face plate on a row-dependent
 * radius: the generator reads no other role's, so measuring any other layer's
 * would only hand it bytes it discards. Each iris's opaque span and the bangs'
 * run it would slide under are measured on the iris's own centre row too
 * (`strandEdges`), so the turn keeps the far iris from sliding under the bangs
 * any further than it is painted.
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
    // Union of EVERY layer's opaque pixels — the silhouette the head half-width
    // is measured off below. Every layer folds in, so a body or an accessory
    // crossing the eye band widens the span; that is deliberate, because a rest
    // render of the finished rig shows the same union and measures the same.
    // Sized once the first layer gives the canvas.
    let opaque = new Uint8Array(0);
    const layerInputs: LayerInput[] = [];
    const crops: AtlasCrop[] = [];
    // Per layer, per row: its OWN leftmost/rightmost opaque column (canvasW /
    // -1 where it has none that row) — recorded in the SAME pass as the union
    // fold, while the layer's decoded pixels are still live, rather than a
    // second decode pass. Reduced to a single left/right owner per side once
    // the eye row is known, below: which layer's own deformation actually
    // carries the union's outermost pixel through the turn.
    const rowSpansByRole: {
      role: string;
      rowLeft: Int32Array;
      rowRight: Int32Array;
    }[] = [];
    // hair_front's own opaque pixels (alpha >= ALPHA_OPAQUE, the union's rule),
    // kept from its pass for the strand edges below: the run an iris would
    // slide under is read off it on that iris's own row. The irises need no
    // mask of their own — their per-row extremes are in rowSpansByRole.
    let hairFrontMask: Uint8Array | undefined;
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
        opaque = new Uint8Array(canvasW * canvasH);
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
      // Fold this layer into the silhouette AND record its own per-row extent
      // while its pixels are still here — one pass over the same pixels.
      const rowLeft = new Int32Array(canvasH).fill(canvasW);
      const rowRight = new Int32Array(canvasH).fill(-1);
      const ownMask =
        role === "hair_front" ? new Uint8Array(canvasW * canvasH) : undefined;
      for (let y = 0; y < canvasH; y++) {
        for (let x = 0; x < canvasW; x++) {
          const p = y * canvasW + x;
          if (png.rgba[p * 4 + 3] < ALPHA_OPAQUE) continue;
          opaque[p] = 1;
          if (ownMask !== undefined) ownMask[p] = 1;
          if (x < rowLeft[y]) rowLeft[y] = x;
          if (x > rowRight[y]) rowRight[y] = x;
        }
      }
      rowSpansByRole.push({ role, rowLeft, rowRight });
      if (ownMask !== undefined) hairFrontMask = ownMask;
      // png.rgba (full-canvas) is dropped at the next iteration — GC reclaims it
      // before the next decode, so peak memory stays ~one canvas + the crops.
      const layer: LayerInput = {
        role,
        fileName,
        canvasW,
        canvasH,
        bbox,
        cropW: bbox.w,
        cropH: bbox.h,
      };
      if (role === "face") {
        // The plate's painted half-width on each of its crop rows — the same
        // alpha rule and halving as the head's own span, row by row (0 for a
        // row with no opaque pixel; a single opaque pixel IS a half-px row
        // here, where the head-span reads below treat a one-column band as
        // no span) — so the face plate can turn on a radius that tapers with
        // the jaw. The bbox admits alpha down to 8 while the span counts
        // alpha >= 128 only, so a row's span sits inside the crop and its
        // half never exceeds cropW / 2, the generator's bound.
        const rowHalfWidths: number[] = [];
        for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
          rowHalfWidths.push(
            rowRight[y] >= rowLeft[y]
              ? headHalfOf({ left: rowLeft[y], right: rowRight[y] })
              : 0,
          );
        }
        layer.rowHalfWidths = rowHalfWidths;
      }
      layerInputs.push(layer);
      crops.push({ id: role, buffer, width: bbox.w, height: bbox.h });
    }

    // The head's own half-width at the eye row, in canvas px, taken off the
    // layers' opaque union the way measure_turn_reference takes it off a render
    // (alpha rule, same row band, same halving) — so a rest render of this rig
    // measures the same span back. It is what the turn's shift targets are
    // fractions of; the generator's own fallback is the face plate, which is
    // narrower than the head the hair draws, and every shift then lands short.
    const eyeRow = eyeRowOf(layerInputs);
    const span = foregroundSpan(
      opaque,
      canvasW,
      canvasH,
      eyeRow - HEAD_BAND,
      eyeRow + HEAD_BAND,
    );
    // A layer set painted below the ALPHA_OPAQUE threshold (translucent art —
    // still above detectAlphaBbox's own, much lower, floor) has no confident
    // span here. That is not the same as having no head: fall back to the face
    // plate, same as a span that measures narrower than it below, rather than
    // refuse the whole rig over a union that is merely non-opaque.
    const headHalfWidth = span.right > span.left ? headHalfOf(span) : undefined;
    // ...but only when it IS wider than the plate. A hairless set, one whose
    // face plate is what the eye row is widest at, or one with no confident
    // span at all, measures a head the generator refuses (the silhouette
    // hold's zone would sit inside the plate) — and the right answer there is
    // the plate it falls back to, not no rig at all.
    const headHalfWidthApplied =
      headHalfWidth !== undefined &&
      headHalfWidth > facePlateHalfOf(layerInputs);

    // Every layer's own opaque extent in the same band — a companion to
    // headHalfWidth, only meaningful once it is actually applied (the
    // fallback path has no measured edge to report at all). The generator
    // lands each candidate through its OWN deformation and takes the
    // outermost LANDING, not just the outermost REST pixel, since which part
    // ends up furthest out after the turn can differ from which one drew
    // furthest out at rest. Model x (canvas x minus half the canvas width),
    // matching bboxToTransform's own convention.
    let headEdges:
      | {
          left: { role: string; x: number }[];
          right: { role: string; x: number }[];
        }
      | undefined;
    if (headHalfWidthApplied) {
      const bandLo = eyeRow - HEAD_BAND;
      const bandHi = eyeRow + HEAD_BAND;
      const left: { role: string; x: number }[] = [];
      const right: { role: string; x: number }[] = [];
      for (const { role, rowLeft, rowRight } of rowSpansByRole) {
        const own = foregroundSpanOfRows(rowLeft, rowRight, bandLo, bandHi);
        if (own.right <= own.left) continue; // no opaque pixel here at all
        left.push({ role, x: own.left - canvasW / 2 });
        right.push({ role, x: own.right - canvasW / 2 });
      }
      headEdges = { left, right };
    }

    // Each iris against the bangs' run it would slide under on the turn, on
    // ONE row — the one holding the iris's centre — under ONE rule (alpha >=
    // ALPHA_OPAQUE). The iris's alpha-bbox (alpha >= 8, grown by a pixel) only
    // gives that row and where to start scanning, never an edge: every number
    // is the pixel boundary facing the neighbouring clear pixel, less half the
    // canvas, so each is the painted edge the way bboxToTransform's crop edges
    // are. The scan decides with the very crop centres the generator validates
    // these edges against (bboxToTransform's), so what it measures is always
    // accepted, on either side. A side's iris is whichever sits on that side,
    // the two paired by x rather than by role name. Measured whether or not
    // headHalfWidth is applied: the bound it feeds is the far iris against its
    // own strand, not the head's width.
    let strandEdges: { left?: IrisStrand; right?: IrisStrand } | undefined;
    const irisLayers = layerInputs
      .filter((l) => l.role === "iris_L" || l.role === "iris_R")
      .sort((a, b) => a.bbox.x + a.bbox.w / 2 - (b.bbox.x + b.bbox.w / 2));
    if (hairFrontMask !== undefined && irisLayers.length === 2) {
      const mask = hairFrontMask;
      const half = canvasW / 2;
      const strandOn = (
        iris: LayerInput,
        other: LayerInput,
        side: -1 | 1,
      ): IrisStrand | undefined => {
        const r = Math.floor(iris.bbox.y + iris.bbox.h / 2);
        // The iris's crop centre, canvas x (a pixel boundary for an even
        // width, a pixel's middle for an odd one), and the other's in model
        // x — bboxToTransform's placement of each.
        const centre = iris.bbox.x + iris.bbox.w / 2;
        const otherX = other.bbox.x + other.bbox.w / 2 - half;
        // The pixel just on THIS side of that centre: a run covering it
        // reaches outward past the centre, so its outer end is strictly
        // outward of it on either side, which a pixel chosen by one rounding
        // for both sides would not give.
        const c = side < 0 ? Math.ceil(centre) - 1 : Math.floor(centre);
        const span = rowSpansByRole.find((s) => s.role === iris.role)!;
        // An iris with no opaque pixel on its own centre row has no edge.
        if (span.rowRight[r] < span.rowLeft[r]) return undefined;
        const opaqueAt = (x: number) =>
          x >= 0 && x < canvasW && mask[r * canvasW + x] === 1;
        // The boundary between pixel x and its neighbour one step outward.
        const outerBoundary = (x: number) => (side < 0 ? x : x + 1) - half;
        let x = c;
        let runFace: number | null;
        if (!opaqueAt(c)) {
          // A clear centre: the first opaque pixel outward starts the run,
          // and its face-side boundary is runFace.
          while (x >= 0 && x < canvasW && !opaqueAt(x)) x += side;
          if (x < 0 || x >= canvasW) return undefined; // no run outward
          runFace = outerBoundary(x - side);
        } else {
          // A covered centre: the run's face-side end is where it clears on
          // the face side — when that is strictly on this side of the other
          // iris's centre. A run still opaque there is a fringe spanning the
          // face, which has no face-side end on this side.
          let f = c - side;
          while (opaqueAt(f)) f -= side;
          const face = outerBoundary(f);
          runFace = side * (face - otherX) > 0 ? face : null;
        }
        // Outward to the run's outer end: its last opaque pixel's boundary
        // with the first clear one after it, or with the crop's edge.
        while (opaqueAt(x)) x += side;
        return {
          y: canvasH / 2 - (r + 0.5),
          irisOuter: (side < 0 ? span.rowLeft[r] : span.rowRight[r] + 1) - half,
          irisInner: (side < 0 ? span.rowRight[r] + 1 : span.rowLeft[r]) - half,
          runOuter: outerBoundary(x - side),
          runFace,
        };
      };
      const [low, high] = irisLayers;
      const left = strandOn(low, high, -1);
      const right = strandOn(high, low, 1);
      if (left !== undefined || right !== undefined) {
        strandEdges = {
          ...(left === undefined ? {} : { left }),
          ...(right === undefined ? {} : { right }),
        };
      }
    }

    // Internal pipeline — direct calls. By here roles + bboxes are validated, so
    // a throw is an invariant break / bug and must propagate to `isError` —
    // except from the turn solve, the one part of the generator that reads
    // CALLER input. It marks those with TurnTargetError (a field that is not a
    // number, a target this layer set cannot reach), which is a fact about the
    // request, not a bug.
    let turn: TurnSolveReport | undefined;
    let model: IkiModel;
    try {
      // Destructured, not spread: a JS caller (unchecked by AutoRigTurnTargets'
      // own `Omit<TurnTargets, "headHalfWidth">`) could otherwise smuggle its
      // OWN headHalfWidth through untouched whenever headHalfWidthApplied is
      // false — headHalfWidth is measured off the layers, never accepted from
      // the caller, so only these five fields cross the boundary.
      const { eyeShift, farEyeRatio, silhouetteRatio, noseShift, mouthShift } =
        input.turnTargets ?? {};
      model = generateIkiFromLayerSet(
        layerInputs,
        { width: canvasW, height: canvasH },
        {
          turnTargets: {
            eyeShift,
            farEyeRatio,
            silhouetteRatio,
            noseShift,
            mouthShift,
            ...(headHalfWidthApplied ? { headHalfWidth } : {}),
          },
          onTurnSolved: (report) => {
            turn = report;
          },
          ...(headEdges === undefined ? {} : { headEdges }),
          ...(strandEdges === undefined ? {} : { strandEdges }),
        },
      );
    } catch (e) {
      if (!(e instanceof TurnTargetError)) throw e;
      throw new AutoRigInputError(e.message);
    }
    const doc = new EditorDocument(model);

    const layout = packAtlas(
      crops.map((c) => ({ id: c.id, width: c.width, height: c.height })),
    );
    if (layout.pageWidth * layout.pageHeight > MAX_ATLAS_AREA) {
      throw new AutoRigInputError(
        `atlas page ${layout.pageWidth}x${layout.pageHeight} exceeds max area ${MAX_ATLAS_AREA}`,
      );
    }

    const dataUri = await renderAtlasToDataUri(crops, layout, quantizeColors);
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

    // Write to a fresh temp file in the verified directory, then atomically
    // rename over the target — see writeFileAtomic for why an existing `.iki`
    // symlink at outPath cannot redirect the write outside the working tree.
    writeFileAtomic(outPath, JSON.stringify(finalModel));

    return {
      ok: true,
      path: outPath,
      canvas: { width: canvasW, height: canvasH },
      partCount: finalModel.parts.length,
      atlasBytes: dataUri.length,
      ...(headHalfWidth === undefined ? {} : { headHalfWidth }),
      headHalfWidthApplied,
      ...(headEdges === undefined ? {} : { headEdges }),
      ...(strandEdges === undefined ? {} : { strandEdges }),
      ...(turn === undefined ? {} : { turn }),
    };
  } catch (err) {
    if (err instanceof AutoRigInputError)
      return { ok: false, error: err.message };
    throw err;
  }
}
