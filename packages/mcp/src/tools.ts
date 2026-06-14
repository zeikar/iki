import {
  parseIkiModel,
  loadIkiModel,
  IkiFormatError,
  StandardParameter,
  type IkiModel,
  type IkiDeformer,
} from "@iki/format";

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
    | { mode: "2d"; parameterX: string; parameterY: string; gridX: number; gridY: number };
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
];

export function listStandardParameters(): StandardParameterInfo[] {
  return STANDARD_PARAMETER_INFO;
}
