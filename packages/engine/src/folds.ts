import {
  type IkiDeformer,
  type IkiMesh,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiWarpDeformer,
  StandardParameter as P,
} from "@ikijs/format";
import { type Affine, multiply, rotate, scale, translate } from "./affine";
import {
  type ResolvedDeformers,
  type ResolvedTransform,
  evaluateTransform,
  resolveDeformers,
} from "./deform";
import { ParameterStore } from "./parameter-store";
import { applyWarps } from "./warp";
import {
  applyWarpToChild,
  deformWarpGrid,
  transformGridPoints,
} from "./warp-grid";

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
  /** One per warp deformer, then one per mesh part, each in model order. */
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
 * parameter moves. Its matrix worlds place a rest location, and a part's
 * baseline, in model space.
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

/** Doubled signed area of each of a mesh's triangles, at its triangle index. */
function triangleAreas(
  points: ArrayLike<number>,
  indices: number[],
): Float64Array {
  const out = new Float64Array(indices.length / 3);
  for (let t = 0; t < out.length; t++) {
    const i = t * 3;
    out[t] = doubledArea(points, indices[i], indices[i + 1], indices[i + 2]);
  }
  return out;
}

/** A part's placement as `player.ts` drawPart builds it: translate · rotate · scale(size). */
function placement(part: IkiPart, t: ResolvedTransform): Affine {
  return multiply(
    multiply(translate(t.x, t.y), rotate(t.rotation)),
    scale(part.width * t.scaleX, part.height * t.scaleY),
  );
}

/** A target's least ratio so far over one class of poses. */
interface Least {
  ratio: number;
  /** Its index into the target's areas: `cell * 4 + corner`, or the triangle. */
  at: number;
  pose: FoldPose;
}

/** What a target keeps across the poses. */
interface Sweep {
  target: FoldTarget["target"];
  restAreas: Float64Array;
  /** Rest areas below this have no ratio. */
  tiny: number;
  worst?: Least;
  expected?: Least;
}

interface GridSweep extends Sweep {
  deformer: IkiWarpDeformer;
}

interface PartSweep extends Sweep {
  part: IkiPart;
  indices: number[];
  /** The warp deformer it hangs from, which lands it instead of a matrix. */
  warpDeformer?: IkiWarpDeformer;
  /** The mesh as the renderer holds it: part-local, float32. */
  vertices: Float32Array;
  /** Per-pose scratch: the mesh after its keyforms, then where it lands. */
  local: Float32Array;
  landed: Float32Array;
  /** The baseline's points: the mesh on the static chain, model space. */
  restPoints: Float64Array;
}

/**
 * Merges one pose's `areas` into `sweep`: each ratio to its rest area goes to
 * the class `expected` puts the pose in, which keeps its least.
 */
function keepLeast(
  sweep: Sweep,
  areas: Float64Array,
  pose: FoldPose,
  expected: (target: FoldTarget["target"]) => boolean,
): void {
  const slot = expected(sweep.target) ? "expected" : "worst";
  for (let i = 0; i < areas.length; i++) {
    const rest = sweep.restAreas[i];
    if (Math.abs(rest) < sweep.tiny) continue;
    const ratio = areas[i] / rest;
    if (ratio < (sweep[slot]?.ratio ?? Infinity)) {
      sweep[slot] = { ratio, at: i, pose };
    }
  }
}

/**
 * A mesh part's sweep, its baseline set once: the authored mesh through the
 * part's base transform and the static world it hangs from — its matrix
 * deformer's, or its warp's PARENT's (identity at a root). The grid never
 * enters it, so a vertex the grid pins to its edge is measured, not
 * cancelled.
 */
function partSweep(
  part: IkiPart,
  mesh: IkiMesh,
  deformers: IkiDeformer[],
  worlds: Map<string, Affine>,
  store: ParameterStore,
): PartSweep {
  // Found as drawPart finds it: a part hung from a warp is that warp's child.
  const warpDeformer = deformers.find(
    (d): d is IkiWarpDeformer => d.kind === "warp" && d.id === part.deformer,
  );
  const frame = warpDeformer ? warpDeformer.parent : part.deformer;
  const placed = placement(
    part,
    evaluateTransform(part.transform, undefined, store),
  );
  // Float64: a triangle authored degenerate stays exactly so, under `tiny`.
  const restPoints = transformGridPoints(
    mesh.vertices,
    frame === undefined ? placed : multiply(worlds.get(frame)!, placed),
    new Float64Array(mesh.vertices.length),
  );
  return {
    target: { kind: "part", id: part.id },
    restAreas: triangleAreas(restPoints, mesh.indices),
    tiny: 1e-9 * part.width * part.height,
    part,
    indices: mesh.indices,
    warpDeformer,
    vertices: Float32Array.from(mesh.vertices),
    local: new Float32Array(mesh.vertices.length),
    landed: new Float32Array(mesh.vertices.length),
    restPoints,
  };
}

/**
 * Where `sweep`'s part lands at a pose, model space, by drawPart's three
 * branches: a warp child bound to its RAW rest grid and sampled on the
 * resolved one, a matrix child through its deformer's world, a free part by
 * its placement alone.
 */
function landPart(
  sweep: PartSweep,
  store: ParameterStore,
  { worlds, grids }: ResolvedDeformers,
): Float32Array {
  const { part, warpDeformer, local, landed } = sweep;
  applyWarps(sweep.vertices, part.warps, store, local);
  const placed = placement(
    part,
    evaluateTransform(part.transform, part.bindings, store),
  );
  if (warpDeformer) {
    const grid = grids.get(warpDeformer.id)!;
    applyWarpToChild(local, placed, warpDeformer.grid, grid, landed);
  } else if (part.deformer !== undefined) {
    const world = worlds.get(part.deformer)!;
    transformGridPoints(local, multiply(world, placed), landed);
  } else {
    transformGridPoints(local, placed, landed);
  }
  return landed;
}

/**
 * Checks every warp deformer's grid cells and every mesh part's triangles for
 * folds over `options.poses` (`foldPoses(model)` by default) and reports, per
 * target, the least ratio of a triangle's doubled signed area at a pose to
 * the same at rest: `<= 0` a flip, `< 0.1` a collapse. Cells are measured on
 * the deformer's LOCAL grid, so a parent matrix's scale, which multiplies
 * every area alike, never reads as a fold. A part's triangles land as
 * drawPart lands them — its keyforms, its live transform, then its warp's
 * resolved grid or its matrix deformer's world — against its authored mesh on
 * the static matrix chain: a static scale or reflection cancels, a bound one
 * counts, and a vertex its warp grid pins to the edge shows already at
 * `rest` (a triangle wholly past the edge flattens, one across it thins).
 * Report-only: nothing is refused.
 */
export function checkFolds(
  model: IkiModel,
  options: FoldOptions = {},
): FoldReport {
  const poses = options.poses ?? foldPoses(model);
  const deformers = model.deformers ?? [];
  const restStore = new ParameterStore(model.parameters);
  const { worlds } = resolveDeformers(staticDeformers(model), restStore);

  const gridSweeps: GridSweep[] = [];
  for (const d of deformers) {
    if (d.kind !== "warp") continue;
    const { cols, rows, points } = d.grid;
    // Row 0's x and column 0's y bound the lattice (the validator's own read).
    const width = points[cols * 2] - points[0];
    const height = points[1] - points[rows * (cols + 1) * 2 + 1];
    gridSweeps.push({
      deformer: d,
      target: { kind: "deformer", id: d.id },
      restAreas: cornerAreas(points, cols, rows),
      // The validator tolerates 1e-6 of jitter, which can zero a corner's area.
      tiny: 1e-9 * width * height,
    });
  }
  const partSweeps = model.parts.flatMap((part) =>
    part.mesh ? [partSweep(part, part.mesh, deformers, worlds, restStore)] : [],
  );

  for (const pose of poses) {
    const store = new ParameterStore(model.parameters);
    for (const [id, v] of Object.entries(pose.values)) store.set(id, v);
    const value = (id: string) => store.get(id);
    const expected = (target: FoldTarget["target"]) =>
      options.expected?.(target, pose, value) === true;
    for (const sweep of gridSweeps) {
      const { cols, rows } = sweep.deformer.grid;
      const areas = cornerAreas(
        deformWarpGrid(sweep.deformer, store),
        cols,
        rows,
      );
      keepLeast(sweep, areas, pose, expected);
    }
    const resolved = resolveDeformers(deformers, store);
    for (const sweep of partSweeps) {
      const areas = triangleAreas(
        landPart(sweep, store, resolved),
        sweep.indices,
      );
      keepLeast(sweep, areas, pose, expected);
    }
  }

  const targets = [
    ...gridSweeps.map((sweep) => {
      const { parent } = sweep.deformer;
      const world = parent === undefined ? undefined : worlds.get(parent);
      return foldTarget(sweep, (least) =>
        cellHit(sweep.deformer, least, world),
      );
    }),
    ...partSweeps.map((sweep) =>
      foldTarget(sweep, (least) => triangleHit(sweep, least)),
    ),
  ];
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

/** A sweep's two minima, each located by `hit`, and the kind they make. */
function foldTarget(sweep: Sweep, hit: (least: Least) => FoldHit): FoldTarget {
  const worst = sweep.worst && hit(sweep.worst);
  const expected = sweep.expected && hit(sweep.expected);
  return { target: sweep.target, kind: classify(worst), worst, expected };
}

/** `least` located: its cell and that cell's rest centre through `parent`. */
function cellHit(
  d: IkiWarpDeformer,
  least: Least,
  parent: Affine | undefined,
): FoldHit {
  const { cols, points } = d.grid;
  const cell = Math.floor(least.at / 4);
  const col = cell % cols;
  const row = Math.floor(cell / cols);
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

/** `least` located: its triangle and that triangle's centroid on the static chain. */
function triangleHit(sweep: PartSweep, least: Least): FoldHit {
  const { indices, restPoints } = sweep;
  let x = 0;
  let y = 0;
  for (let k = 0; k < 3; k++) {
    const i = indices[least.at * 3 + k];
    x += restPoints[i * 2] / 3;
    y += restPoints[i * 2 + 1] / 3;
  }
  return {
    ratio: least.ratio,
    where: { triangle: least.at },
    pose: least.pose,
    rest: { x, y },
  };
}

function classify(worst: FoldHit | undefined): FoldTarget["kind"] {
  if (worst === undefined) return "ok";
  if (worst.ratio <= FLIP) return "flip";
  if (worst.ratio < COLLAPSE) return "collapse";
  return "ok";
}
