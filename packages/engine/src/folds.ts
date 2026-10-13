import {
  type IkiDeformer,
  type IkiModel,
  type IkiParameter,
  type IkiWarpDeformer,
  StandardParameter as P,
} from "@ikijs/format";
import type { Affine } from "./affine";
import { resolveDeformers } from "./deform";
import { ParameterStore } from "./parameter-store";
import { deformWarpGrid } from "./warp-grid";

/** A parameter setting to check the rig at; every other parameter rests at its default. */
export interface FoldPose {
  /** Its sorted `id=value` pairs joined by one space; `rest` when empty. */
  name: string;
  values: Record<string, number>;
}

/** Where and when a target comes nearest to folding over one class of poses. */
export interface FoldHit {
  /** Doubled signed area at the pose over the same at rest. */
  ratio: number;
  /** The warp grid's cell, or the part mesh's triangle (its index into `mesh.indices` / 3). */
  where: { col: number; row: number } | { triangle: number };
  pose: FoldPose;
  /** Where it sits at rest, model space, through the static matrix chain. */
  rest: { x: number; y: number };
}

export interface FoldTarget {
  target: { kind: "deformer" | "part"; id: string };
  /** Read off `worst` alone; `ok` when it is absent. */
  kind: "flip" | "collapse" | "ok";
  /** Least ratio over the poses `expected` rejects (every pose without it). */
  worst?: FoldHit;
  /** Least ratio over the poses `expected` accepts. */
  expected?: FoldHit;
}

export interface FoldOptions {
  /** The poses to check; `foldPoses(model)` when absent. */
  poses?: FoldPose[];
  /**
   * Whether `target` closes by design at `pose` (a mouth shut), which keeps a
   * fold there out of `worst`. `value(id)` is the parameter's effective value
   * at the pose: its override, else the clamped default — a pose carries only
   * overrides, so a closure at a default shows only through `value`.
   */
  expected?: (
    target: FoldTarget["target"],
    pose: FoldPose,
    value: (id: string) => number,
  ) => boolean;
}

export interface FoldReport {
  /** How many poses were checked. */
  poses: number;
  thresholds: { flip: 0; collapse: 0.1 };
  /** One per warp deformer, in model order. */
  targets: FoldTarget[];
  /** The targets that are not `ok`, worst first. */
  offenders: FoldTarget[];
}

const FLIP = 0;
const COLLAPSE = 0.1;

const ANGLES = [
  P.AngleX,
  P.AngleY,
  P.AngleZ,
  P.BodyAngleX,
  P.BodyAngleY,
  P.BodyAngleZ,
];

/** Crossed with every angle corner, each group's parameters at min then at max together. */
const CROSSES = [
  [P.EyeOpenLeft, P.EyeOpenRight],
  [P.MouthOpen],
  [P.ArmLeft, P.ArmRight],
  [P.ElbowLeft, P.ElbowRight],
];

/**
 * The poses `checkFolds` checks by default: `rest`; every movable parameter
 * alone at its min and at its max; and, on a model declaring any head or body
 * angle, every min/max corner of those angles crossed with the eyes, the
 * mouth, the arms and the elbows shut/open — 2⁶ · 2⁴ = 1024 at most — where
 * moves no single extreme shows stack up. Deduplicated by `name`.
 */
export function foldPoses(model: IkiModel): FoldPose[] {
  const byId = new Map(
    model.parameters.filter((p) => p.min !== p.max).map((p) => [p.id, p]),
  );
  const declared = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []);

  const poses: FoldPose[] = [];
  const names = new Set<string>();
  const add = (values: Record<string, number>) => {
    const name = poseName(values);
    if (names.has(name)) return;
    names.add(name);
    poses.push({ name, values });
  };

  add({});
  for (const p of byId.values()) {
    add({ [p.id]: p.min });
    add({ [p.id]: p.max });
  }

  const angles = declared(ANGLES);
  if (angles.length === 0) return poses;
  const groups: IkiParameter[][] = [
    ...angles.map((p) => [p]),
    ...CROSSES.map(declared).filter((g) => g.length > 0),
  ];
  let corners: Record<string, number>[] = [{}];
  for (const group of groups) {
    corners = corners.flatMap((values) =>
      (["min", "max"] as const).map((end) => {
        const next = { ...values };
        for (const p of group) next[p.id] = p[end];
        return next;
      }),
    );
  }
  for (const values of corners) add(values);
  return poses;
}

function poseName(values: Record<string, number>): string {
  const ids = Object.keys(values).sort();
  if (ids.length === 0) return "rest";
  return ids.map((id) => `${id}=${values[id]}`).join(" ");
}

/**
 * The model's deformers with every binding and keyform removed: the rig no
 * parameter moves. Its matrix worlds place a rest location in model space.
 */
function staticDeformers(model: IkiModel): IkiDeformer[] {
  return (model.deformers ?? []).map((d) =>
    d.kind === "warp"
      ? { ...d, warps: undefined, warp2d: undefined }
      : { ...d, bindings: undefined },
  );
}

/**
 * Doubled signed area of each cell's four corner triangles — the corner, then
 * its two neighbours counter-clockwise (y up), as the auto-rig's body fold
 * refusal takes them — at index `cell * 4 + k`. Positive on a rest lattice.
 */
function cornerAreas(
  points: ArrayLike<number>,
  cols: number,
  rows: number,
): Float64Array {
  const stride = cols + 1;
  const out = new Float64Array(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = r * stride + c;
      const [tr, bl, br] = [tl + 1, tl + stride, tl + stride + 1];
      const i = (r * cols + c) * 4;
      out[i] = doubledArea(points, bl, br, tl);
      out[i + 1] = doubledArea(points, br, tr, bl);
      out[i + 2] = doubledArea(points, tr, tl, br);
      out[i + 3] = doubledArea(points, tl, bl, tr);
    }
  }
  return out;
}

function doubledArea(
  points: ArrayLike<number>,
  p: number,
  q: number,
  s: number,
): number {
  const ax = points[q * 2] - points[p * 2];
  const ay = points[q * 2 + 1] - points[p * 2 + 1];
  const bx = points[s * 2] - points[p * 2];
  const by = points[s * 2 + 1] - points[p * 2 + 1];
  return ax * by - ay * bx;
}

/** A target's least ratio so far over one class of poses. */
interface Least {
  ratio: number;
  /** Cell index, `row * cols + col`. */
  cell: number;
  pose: FoldPose;
}

interface GridSweep {
  deformer: IkiWarpDeformer;
  target: FoldTarget["target"];
  restAreas: Float64Array;
  /** Rest areas below this have no ratio. */
  tiny: number;
  worst?: Least;
  expected?: Least;
}

/**
 * Checks every warp deformer's grid cells for folds over `options.poses`
 * (`foldPoses(model)` by default) and reports, per deformer, the least ratio
 * of a cell's corner triangle to its rest area: `<= 0` a flip, `< 0.1` a
 * collapse. Cells are measured on the deformer's LOCAL grid, so a parent
 * matrix's scale, which multiplies every area alike, never reads as a fold.
 * Report-only: nothing is refused.
 */
export function checkFolds(
  model: IkiModel,
  options: FoldOptions = {},
): FoldReport {
  const poses = options.poses ?? foldPoses(model);
  const { worlds } = resolveDeformers(
    staticDeformers(model),
    new ParameterStore(model.parameters),
  );

  const sweeps: GridSweep[] = [];
  for (const d of model.deformers ?? []) {
    if (d.kind !== "warp") continue;
    const { cols, rows, points } = d.grid;
    // Row 0's x and column 0's y bound the lattice (the validator's own read).
    const width = points[cols * 2] - points[0];
    const height = points[1] - points[rows * (cols + 1) * 2 + 1];
    sweeps.push({
      deformer: d,
      target: { kind: "deformer", id: d.id },
      restAreas: cornerAreas(points, cols, rows),
      // The validator tolerates 1e-6 of jitter, which can zero a corner's area.
      tiny: 1e-9 * width * height,
    });
  }

  for (const pose of poses) {
    const store = new ParameterStore(model.parameters);
    for (const [id, v] of Object.entries(pose.values)) store.set(id, v);
    const value = (id: string) => store.get(id);
    for (const sweep of sweeps) {
      const { cols, rows } = sweep.deformer.grid;
      const areas = cornerAreas(
        deformWarpGrid(sweep.deformer, store),
        cols,
        rows,
      );
      const slot =
        options.expected?.(sweep.target, pose, value) === true
          ? "expected"
          : "worst";
      for (let i = 0; i < areas.length; i++) {
        const rest = sweep.restAreas[i];
        if (Math.abs(rest) < sweep.tiny) continue;
        const ratio = areas[i] / rest;
        if (ratio < (sweep[slot]?.ratio ?? Infinity)) {
          sweep[slot] = { ratio, cell: Math.floor(i / 4), pose };
        }
      }
    }
  }

  const targets = sweeps.map((sweep): FoldTarget => {
    const parent =
      sweep.deformer.parent === undefined
        ? undefined
        : worlds.get(sweep.deformer.parent);
    const worst = sweep.worst && cellHit(sweep.deformer, sweep.worst, parent);
    const expected =
      sweep.expected && cellHit(sweep.deformer, sweep.expected, parent);
    return { target: sweep.target, kind: classify(worst), worst, expected };
  });
  const offenders = targets
    .filter((t) => t.kind !== "ok")
    .sort((a, b) => a.worst!.ratio - b.worst!.ratio);
  return {
    poses: poses.length,
    thresholds: { flip: FLIP, collapse: COLLAPSE },
    targets,
    offenders,
  };
}

/** `least` located: its cell and that cell's rest centre through `parent`. */
function cellHit(
  d: IkiWarpDeformer,
  least: Least,
  parent: Affine | undefined,
): FoldHit {
  const { cols, points } = d.grid;
  const col = least.cell % cols;
  const row = Math.floor(least.cell / cols);
  const stride = cols + 1;
  let x = 0;
  let y = 0;
  for (const i of [
    row * stride + col,
    row * stride + col + 1,
    (row + 1) * stride + col,
    (row + 1) * stride + col + 1,
  ]) {
    x += points[i * 2] / 4;
    y += points[i * 2 + 1] / 4;
  }
  const rest = parent
    ? {
        x: parent[0] * x + parent[2] * y + parent[4],
        y: parent[1] * x + parent[3] * y + parent[5],
      }
    : { x, y };
  return { ratio: least.ratio, where: { col, row }, pose: least.pose, rest };
}

function classify(worst: FoldHit | undefined): FoldTarget["kind"] {
  if (worst === undefined) return "ok";
  if (worst.ratio <= FLIP) return "flip";
  if (worst.ratio < COLLAPSE) return "collapse";
  return "ok";
}
