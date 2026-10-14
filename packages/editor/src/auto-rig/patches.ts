/**
 * The rig patch layer: each `RigPatch` adds a displacement to one existing
 * keyform stop of a feature grid or of a mesh part's warp, on the rig just
 * generated, weighted by where the target's points sit at REST against a
 * region of a role's rest box (`types.ts` has the units and axes).
 *
 * Every op is checked and its deltas collected, unrounded, before any keyform
 * changes; each touched offset then adds their sum, taken in sorted order,
 * and is rounded once, as the generator rounds it. So op order never changes
 * the model, and a refused op leaves the rig as generated.
 */

import {
  StandardParameter as P,
  type IkiParameter,
  type IkiPart,
  type IkiWarp,
} from "@ikijs/format";
import { X_STOPS, Y_STOPS, type Lattice } from "./grid";
import { bh, bw, meshPoints, roundTo, smoothstep, type Box } from "./layout";
import { roleOfPart, SHUT_BY } from "./roles";
import { checkedKeys, checkedNumber } from "./solve";
import {
  PatchError,
  TurnTargetError,
  type PatchReport,
  type RigPatch,
} from "./types";

export interface PatchContext {
  /** The feature grids by warp id; their keyforms are patched in place. */
  grids: Map<string, { lattice: Lattice; keyforms: number[][] }>;
  /** Every part; a mesh part's warp keyforms are patched in place. */
  parts: IkiPart[];
  /** A role's rest layer box, `undefined` for a role the set lacks. */
  boxOf: (role: string) => Box | undefined;
  /** The `face` layer's crop width: the unit of `by` and `falloff`. */
  faceWidth: number;
  parameters: IkiParameter[];
}

const OP_KEYS = ["target", "at", "region", "by", "falloff", "why"];
const REGION_KEYS = ["role", "x", "y"];
const BY_KEYS = ["dx", "dy"];

// The parameters that rotate the deformers a part hangs under (`generate.ts`'s
// head and body roll); a part offset at one of their stops is turned by it.
const ROLLS = new Set<string>([P.AngleZ, P.BodyAngleZ]);

const REST_IS_ART =
  "rest is the drawn art, which no patch changes (change it with the layout or by regenerating the layer)";

/** The keyform an op patches, and the target's rest points it weighs. */
interface Stop {
  offsets: number[];
  points: [number, number][];
  /** Model px per stored unit, x and y: 1 on a grid, the part's w and h. */
  scale: [number, number];
  /** The generator's rounding of that keyform (`bake`, `localWarp`). */
  step: number;
  /** A grid's points per lattice row; a part has none. */
  stride?: number;
}

/** One keyform's collected deltas, and how its offsets store them. */
interface Sum {
  /** Per offset entry, each op's delta, model px. Float addition is not
   *  associative, so they are summed in sorted order: the same deltas give
   *  the same rounded offset whatever order the ops came in. */
  terms: number[][];
  scale: [number, number];
  step: number;
}

/** Replays `patches` onto `ctx`'s grids and parts. Throws `PatchError`,
 *  before changing anything, on the first op that is malformed or misses. */
export function applyPatches(
  patches: RigPatch[],
  ctx: PatchContext,
): PatchReport[] {
  if (!Array.isArray(patches)) {
    throw new PatchError(
      `patches must be an array, got ${patches === null ? "null" : typeof patches}`,
    );
  }
  const sums = new Map<number[], Sum>();
  const reports = patches.map((op, i) => replay(op, i, ctx, sums));
  for (const [offsets, s] of sums) {
    s.terms.forEach((t, k) => {
      if (t.length === 0) return;
      const d = t.sort((a, b) => a - b).reduce((a, b) => a + b, 0);
      offsets[k] = roundTo(offsets[k] + d / s.scale[k % 2], s.step);
    });
  }
  return reports;
}

/** Checks op `i`, adds its deltas to `sums` and reports what it moves. */
function replay(
  op: unknown,
  i: number,
  ctx: PatchContext,
  sums: Map<number[], Sum>,
): PatchReport {
  const name = `patches[${i}]`;
  const o = fields(name, op, OP_KEYS);
  const target = text(`${name}.target`, o.target);
  const at = numbers(`${name}.at`, o.at);
  const region = fields(`${name}.region`, o.region, REGION_KEYS);
  const role = text(`${name}.region.role`, region.role);
  const x = span(`${name}.region.x`, region.x);
  const y = span(`${name}.region.y`, region.y);
  const by = fields(`${name}.by`, o.by, BY_KEYS);
  const dx = finite(`${name}.by.dx`, by.dx);
  const dy = finite(`${name}.by.dy`, by.dy);
  const falloff =
    o.falloff === undefined ? 0 : finite(`${name}.falloff`, o.falloff, 0);
  if (o.why !== undefined) text(`${name}.why`, o.why);

  const box = ctx.boxOf(role);
  if (box === undefined) {
    const roles = [...new Set(ctx.parts.map((p) => roleOfPart(p.id)))].filter(
      (r) => ctx.boxOf(r) !== undefined,
    );
    throw new PatchError(
      `${name}.region.role "${role}" is not a layer of this set (roles: ${roles.join(", ")})`,
    );
  }

  const stop = resolveStop(name, target, at, ctx);
  const { points } = stop;
  const weights = regionWeights(points, box, x, y, falloff * ctx.faceWidth);
  const hit = weights.flatMap((w, k) => (w > 0 ? [k] : []));
  if (hit.length === 0) {
    const fx = points.map(([px]) => (px - box.x0) / bw(box));
    const fy = points.map(([, py]) => (box.y1 - py) / bh(box));
    const range = (v: number[]) =>
      `[${roundTo(Math.min(...v), 0.01)}, ${roundTo(Math.max(...v), 0.01)}]`;
    throw new PatchError(
      `${name}.region (falloff ${falloff}) catches none of ${target}'s ${points.length} points; at rest they span x ${range(fx)}, y ${range(fy)} of ${role}'s box`,
    );
  }

  let sum = sums.get(stop.offsets);
  if (sum === undefined) {
    sum = {
      terms: stop.offsets.map(() => []),
      scale: stop.scale,
      step: stop.step,
    };
    sums.set(stop.offsets, sum);
  }
  // Screen axes to model: +dy is down on screen, up in the model.
  const ddx = dx * ctx.faceWidth;
  const ddy = -dy * ctx.faceWidth;
  for (const k of hit) {
    sum.terms[2 * k].push(ddx * weights[k]);
    sum.terms[2 * k + 1].push(ddy * weights[k]);
  }

  const maxW = Math.max(...hit.map((k) => weights[k]));
  const report: PatchReport = {
    index: i,
    target,
    at,
    moved: hit.length,
    of: points.length,
    maxPx: roundTo(maxW * Math.hypot(dx, dy) * ctx.faceWidth, 0.1),
  };
  if (stop.stride !== undefined) {
    const { stride } = stop;
    const cols = hit.map((k) => k % stride);
    const rows = hit.map((k) => Math.floor(k / stride));
    report.cols = [Math.min(...cols), Math.max(...cols)];
    report.rows = [Math.min(...rows), Math.max(...rows)];
  }
  return report;
}

/** The keyform `at` names on `target` — a feature grid, or a mesh part with
 *  warps and a layer box — and the target's rest points. */
function resolveStop(
  name: string,
  target: string,
  at: Record<string, number>,
  ctx: PatchContext,
): Stop {
  const grid = ctx.grids.get(target);
  if (grid !== undefined) {
    const l = grid.lattice.points;
    const points: [number, number][] = [];
    for (let k = 0; k < l.length; k += 2) points.push([l[k], l[k + 1]]);
    return {
      offsets: gridStop(name, at, target, grid.keyforms),
      points,
      scale: [1, 1],
      step: 0.1,
      stride: grid.lattice.cols + 1,
    };
  }
  const part = ctx.parts.find((p) => p.id === target);
  const b = ctx.boxOf(target);
  if (part?.mesh === undefined || part.warps === undefined || b === undefined) {
    const parts = ctx.parts.filter(
      (p) =>
        p.mesh !== undefined &&
        p.warps !== undefined &&
        ctx.boxOf(p.id) !== undefined,
    );
    throw new PatchError(
      `${name}.target "${target}" is neither a feature grid (${[...ctx.grids.keys()].join(", ")}) nor a mesh part with warps (${parts.map((p) => p.id).join(", ")}); bodyWarp and the matrix deformers are not patchable`,
    );
  }
  return {
    offsets: partStop(name, at, part, part.warps, ctx),
    points: meshPoints(part.mesh, b),
    scale: [bw(b), bh(b)],
    step: 1e-4,
  };
}

/** The grid keyform `at` names: both angles, each one of the stops, never
 *  the rest stop. */
function gridStop(
  name: string,
  at: Record<string, number>,
  id: string,
  keyforms: number[][],
): number[] {
  const i = X_STOPS.indexOf(at[P.AngleX]);
  const j = Y_STOPS.indexOf(at[P.AngleY]);
  if (Object.keys(at).length !== 2 || i < 0 || j < 0) {
    throw new PatchError(
      `${name}.at must name ${P.AngleX} in [${X_STOPS.join(", ")}] and ${P.AngleY} in [${Y_STOPS.join(", ")}] for the grid ${id}, got ${JSON.stringify(at)}`,
    );
  }
  if (X_STOPS[i] === 0 && Y_STOPS[j] === 0) {
    throw new PatchError(
      `${name}.at ${P.AngleX}=0 ${P.AngleY}=0 is ${id}'s rest stop: ${REST_IS_ART}; patch a stop with ${P.AngleX} or ${P.AngleY} at ±30 instead`,
    );
  }
  return keyforms[j * X_STOPS.length + i];
}

/** The part keyform `at` names: one parameter at one of its warp stops, never
 *  the parameter's default (rest) nor the part's by-design closure. */
function partStop(
  name: string,
  at: Record<string, number>,
  part: IkiPart,
  warps: IkiWarp[],
  ctx: PatchContext,
): number[] {
  const keys = Object.keys(at);
  const [param] = keys;
  const value = at[param];
  // Two warps on one parameter sum, so either keyform at the value will do:
  // the first is the one patched.
  const keyform =
    keys.length === 1
      ? warps
          .filter((w) => w.parameter === param)
          .flatMap((w) => w.keyforms)
          .find((k) => k.value === value)
      : undefined;
  if (keyform === undefined) {
    throw new PatchError(
      `${name}.at must name one parameter at one of ${part.id}'s warp stops (${listStops(warps, () => true)}), got ${JSON.stringify(at)}`,
    );
  }
  if (ROLLS.has(param)) {
    throw new PatchError(
      `${name}.at ${param}: that parameter rolls ${part.id}'s deformer chain, so a displacement at its stop is not on screen axes; patch another of its stops (${listStops(warps, (p) => !ROLLS.has(p))}) or its feature grid instead`,
    );
  }
  const isRest = (p: string, v: number) =>
    v === ctx.parameters.find((q) => q.id === p)?.default;
  const isShut = (p: string, v: number) =>
    SHUT_BY.get(part.id) === p && v === 0;
  if (!isRest(param, value) && !isShut(param, value)) return keyform.offsets;

  // Where to patch instead: the part's other stops, and the feature grid it
  // hangs from — an eye white's only stops are its rest and its closure.
  const open = listStops(warps, (p, v) => !isRest(p, v) && !isShut(p, v));
  const grid =
    part.deformer !== undefined && ctx.grids.has(part.deformer)
      ? `its feature grid ${part.deformer} at a ${P.AngleX} × ${P.AngleY} stop`
      : "";
  const instead = [open && `another of its stops (${open})`, grid]
    .filter((s) => s !== "")
    .join(" or ");
  const hint = instead === "" ? "" : `; patch ${instead} instead`;
  throw new PatchError(
    isRest(param, value)
      ? `${name}.at ${param}=${value} is that parameter's default, ${part.id}'s rest stop: ${REST_IS_ART}${hint}`
      : `${name}.at ${param}=0 is where the rig shuts ${part.id} on purpose, a closure the fold check exempts, so a fold a patch made there would never be reported${hint}`,
  );
}

/** `warps`' stops that `keep` passes, as `parameter@v,v` per parameter. */
function listStops(
  warps: IkiWarp[],
  keep: (parameter: string, value: number) => boolean,
): string {
  const stops = new Map<string, Set<number>>();
  for (const w of warps) {
    for (const k of w.keyforms) {
      if (!keep(w.parameter, k.value)) continue;
      const s = stops.get(w.parameter) ?? new Set();
      s.add(k.value);
      stops.set(w.parameter, s);
    }
  }
  return [...stops]
    .map(([p, s]) => `${p}@${[...s].sort((a, b) => a - b).join(",")}`)
    .join(" ");
}

/** Each point's share of `by`: 1 at rest inside the region (`x`, `y` in
 *  fractions of `box`), easing to 0 over `fall` model px outside it — a hard
 *  edge at 0. */
function regionWeights(
  points: [number, number][],
  box: Box,
  x: [number, number],
  y: [number, number],
  fall: number,
): number[] {
  const x0 = box.x0 + x[0] * bw(box);
  const x1 = box.x0 + x[1] * bw(box);
  // Model y runs up; the region's fractions run down from the box's top.
  const top = box.y1 - y[0] * bh(box);
  const bottom = box.y1 - y[1] * bh(box);
  return points.map(([px, py]) => {
    const d = Math.hypot(
      Math.max(x0 - px, 0, px - x1),
      Math.max(bottom - py, 0, py - top),
    );
    return d === 0 ? 1 : d < fall ? smoothstep(fall, 0, d) : 0;
  });
}

/** A `solve.ts` check, its refusal rethrown as a patch's. */
function asPatch<T>(check: () => T): T {
  try {
    return check();
  } catch (e) {
    throw e instanceof TurnTargetError ? new PatchError(e.message) : e;
  }
}

/** `v`, a plain object naming only `known` (`checkedKeys`), and present. */
function fields(
  name: string,
  v: unknown,
  known: readonly string[],
): Record<string, unknown> {
  if (v === undefined) throw new PatchError(`${name} is missing`);
  asPatch(() => checkedKeys(name, v, known));
  return v as Record<string, unknown>;
}

/** `v`, a present plain object of finite numbers under any keys. */
function numbers(name: string, v: unknown): Record<string, number> {
  // Its own keys as the known ones leave `checkedKeys` the plain-object check.
  const o = fields(name, v, Object.keys(v ?? {}));
  return Object.fromEntries(
    Object.entries(o).map(([k, n]) => [k, finite(`${name}.${k}`, n)]),
  );
}

const finite = (name: string, v: unknown, lo = -Infinity): number =>
  asPatch(() => checkedNumber(name, v, lo, Infinity));

function text(name: string, v: unknown): string {
  if (typeof v !== "string") {
    throw new PatchError(`${name} must be a string, got ${String(v)}`);
  }
  return v;
}

/** A `[from, to]` pair of fractions, in order. */
function span(name: string, v: unknown): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) {
    throw new PatchError(
      `${name} must be [from, to], got ${JSON.stringify(v)}`,
    );
  }
  const lo = finite(`${name}[0]`, v[0]);
  const hi = finite(`${name}[1]`, v[1]);
  if (lo > hi) {
    throw new PatchError(
      `${name} [${lo}, ${hi}] runs backwards: ${name}[0] must not exceed ${name}[1]`,
    );
  }
  return [lo, hi];
}
