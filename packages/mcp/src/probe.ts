/**
 * `probe_rig`: measuring a rigged model without rendering it. Where a point of
 * a part lands in a pose, how far that is from where it rests, and the opaque
 * runs of a layer PNG — the numbers a rigging program (or an agent checking
 * a custom part) needs and a picture cannot give exactly.
 *
 * The landing is the engine's own `landParts`, so it is what the player draws.
 * Frame: canvas px, origin top-left, x right, y down — the frame of the layer
 * PNGs and of `describe_iki`'s boxes.
 */

import { readFileSync } from "node:fs";
import { IkiFormatError, loadIkiModel, type IkiModel } from "@ikijs/format";
import { landParts } from "@ikijs/engine";
import {
  AutoRigInputError,
  MAX_PROBE_POINTS,
  MAX_PROBE_QUERIES,
  confineToWorkingDirectory,
  resolveInputPath,
  resolveOutputPath,
  writeFileAtomic,
} from "./limits";
import { decodePng, type DecodedPng } from "./node-images";

export type ProbePoint = [number, number];

export type ProbeQuery =
  | { op: "paint"; path: string }
  | {
      op: "land" | "displacement";
      part: string;
      points: ProbePoint[];
      pose?: Record<string, number>;
    };

export interface ProbeInput {
  /** The rigged `.iki` to measure (resolved against cwd, under it). */
  modelPath: string;
  queries: ProbeQuery[];
  /** A `.probe.json` under the working directory to write the results to. */
  outputPath?: string;
}

/**
 * The opaque (alpha >= 128) runs of a layer per canvas row. `rows[i]` holds
 * the `[x0, x1)` runs (`x1` exclusive) of canvas row `y0 + i`; a row inside the
 * painted range with none is `[]`. A layer with no opaque pixel gives
 * `{ y0: 0, rows: [] }`.
 */
export interface PaintRuns {
  y0: number;
  rows: [number, number][][];
}

export type ProbeQueryResult =
  | ({ op: "paint" } & PaintRuns)
  | {
      op: "land" | "displacement";
      part: string;
      /** One per input point; `null` for a point outside the part's mesh. */
      points: (ProbePoint | null)[];
    };

export type ProbeResult =
  | { ok: true; results: ProbeQueryResult[] }
  | { ok: true; outputPath: string; lines: string[] }
  | { ok: false; error: string };

/** What a probe's `outputPath` must end in: never a name another tool or a config file owns. */
const OUTPUT_SUFFIX = ".probe.json";

/** The threshold the auto-rig's own layer measure uses. */
const OPAQUE = 128;

/** Opaque runs per canvas row of a decoded layer. */
export function paintRuns(png: DecodedPng): PaintRuns {
  const { width, height, rgba } = png;
  const rows: [number, number][][] = [];
  let y0 = -1;
  for (let y = 0; y < height; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x < width; x++) {
      const on = rgba[(y * width + x) * 4 + 3] >= OPAQUE;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        runs.push([start, x]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, width]);
    if (runs.length > 0 && y0 < 0) y0 = y;
    if (y0 >= 0) rows.push(runs);
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows.length === 0 ? { y0: 0, rows: [] } : { y0, rows };
}

/** Model space (x right, y up, origin at the canvas centre) to canvas px. */
export function toCanvas(model: IkiModel, pts: Float32Array): Float64Array {
  const hw = model.canvas.width / 2;
  const hh = model.canvas.height / 2;
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = hw + pts[i];
    out[i + 1] = hh - pts[i + 1];
  }
  return out;
}

/** A millipixel is far below what a render shows, and keeps the text short. `+ 0` drops a -0. */
const round = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** The barycentric weights of (x, y) in a triangle of `vertices` (canvas px, rest or posed), or null outside it. */
export function locate(
  vertices: Float64Array,
  tri: [number, number, number],
  x: number,
  y: number,
): [number, number, number] | null {
  const [a, b, c] = tri;
  const ax = vertices[a * 2];
  const ay = vertices[a * 2 + 1];
  const bx = vertices[b * 2];
  const by = vertices[b * 2 + 1];
  const cx = vertices[c * 2];
  const cy = vertices[c * 2 + 1];
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const l3 = 1 - l1 - l2;
  const eps = 1e-9;
  return l1 >= -eps && l2 >= -eps && l3 >= -eps ? [l1, l2, l3] : null;
}

/** A part without a mesh draws its unit quad. */
const QUAD_INDICES = [0, 1, 2, 1, 3, 2];

/** A part's rest triangles with their boxes, computed once per call. */
export interface RestMesh {
  indices: number[];
  rest: Float64Array;
  /** minX, minY, maxX, maxY per triangle. */
  boxes: Float64Array;
}

export function restMesh(
  model: IkiModel,
  cache: Map<string, RestMesh>,
  partId: string,
): RestMesh {
  let m = cache.get(partId);
  if (m) return m;
  const part = model.parts.find((p) => p.id === partId)!;
  const indices = part.mesh ? part.mesh.indices : QUAD_INDICES;
  const rest = toCanvas(model, landParts(model, {}, [partId]).get(partId)!);
  const boxes = new Float64Array((indices.length / 3) * 4);
  for (let t = 0; t < indices.length / 3; t++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      x0 = Math.min(x0, rest[v * 2]);
      x1 = Math.max(x1, rest[v * 2]);
      y0 = Math.min(y0, rest[v * 2 + 1]);
      y1 = Math.max(y1, rest[v * 2 + 1]);
    }
    boxes.set([x0, y0, x1, y1], t * 4);
  }
  m = { indices, rest, boxes };
  cache.set(partId, m);
  return m;
}

/** Where a rest point sits in a part's mesh: a triangle and its weights. */
export interface Located {
  tri: [number, number, number];
  w: [number, number, number];
}

/** Each point's triangle at rest (the first that holds it), or null off the mesh. */
export function locatePoints(
  mesh: RestMesh,
  points: ProbePoint[],
): (Located | null)[] {
  const { indices, rest, boxes } = mesh;
  // A little slack, so the box test does not reject a point sitting on a
  // triangle's edge. `locate`'s own tolerance is in barycentric weight and
  // reaches a few 1e-6 px past the outline of a very large triangle; a point
  // that far outside the mesh reads off it here, which is what it is.
  const slack = 1e-6;
  return points.map(([x, y]) => {
    for (let t = 0; t < indices.length / 3; t++) {
      const b = t * 4;
      if (
        x < boxes[b] - slack ||
        x > boxes[b + 2] + slack ||
        y < boxes[b + 1] - slack ||
        y > boxes[b + 3] + slack
      ) {
        continue;
      }
      const tri: [number, number, number] = [
        indices[t * 3],
        indices[t * 3 + 1],
        indices[t * 3 + 2],
      ];
      const w = locate(rest, tri, x, y);
      if (w) return { tri, w };
    }
    return null;
  });
}

/** A located point on a part's posed vertices (canvas px). */
export function landLocated(
  posed: Float64Array,
  at: Located | null,
): ProbePoint | null {
  if (at === null) return null;
  let px = 0;
  let py = 0;
  for (let k = 0; k < 3; k++) {
    px += at.w[k] * posed[at.tri[k] * 2];
    py += at.w[k] * posed[at.tri[k] * 2 + 1];
  }
  return [px, py];
}

function landPoints(
  model: IkiModel,
  cache: Map<string, RestMesh>,
  partId: string,
  points: ProbePoint[],
  pose: Record<string, number>,
): (ProbePoint | null)[] {
  const located = locatePoints(restMesh(model, cache, partId), points);
  const posed = toCanvas(model, landParts(model, pose, [partId]).get(partId)!);
  return located.map((at) => landLocated(posed, at));
}

function invalid(i: number, field: string, what: string): AutoRigInputError {
  return new AutoRigInputError(`queries[${i}].${field} ${what}`);
}

function checkPoints(i: number, points: unknown): ProbePoint[] {
  if (!Array.isArray(points) || points.length === 0) {
    throw invalid(i, "points", "must be a non-empty list of [x, y]");
  }
  if (points.length > MAX_PROBE_POINTS) {
    throw invalid(
      i,
      "points",
      `has ${points.length} points; at most ${MAX_PROBE_POINTS} per query`,
    );
  }
  points.forEach((pt, k) => {
    if (
      !Array.isArray(pt) ||
      pt.length !== 2 ||
      !pt.every((v) => Number.isFinite(v))
    ) {
      throw invalid(i, `points[${k}]`, "must be [x, y] with finite numbers");
    }
  });
  return points as ProbePoint[];
}

function checkPose(
  model: IkiModel,
  i: number,
  pose: Record<string, number> | undefined,
): Record<string, number> {
  const declared = new Set(model.parameters.map((p) => p.id));
  for (const [id, v] of Object.entries(pose ?? {})) {
    if (!declared.has(id)) {
      throw invalid(i, `pose.${id}`, "is not a parameter the model declares");
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw invalid(i, `pose.${id}`, "must be a finite number");
    }
  }
  return pose ?? {};
}

/** A query whose shape has been checked, ready to run. */
type CheckedQuery =
  | { op: "paint"; path: string }
  | {
      op: "land" | "displacement";
      part: string;
      points: ProbePoint[];
      pose: Record<string, number>;
    };

/** Every refusal that needs no file: shape, op, part, points, pose. */
function checkQuery(model: IkiModel, q: ProbeQuery, i: number): CheckedQuery {
  if (q.op === "paint") return { op: "paint", path: q.path };
  if (q.op !== "land" && q.op !== "displacement") {
    throw invalid(i, "op", `must be paint, land or displacement`);
  }
  if (!model.parts.some((p) => p.id === q.part)) {
    throw invalid(i, "part", `names no part of the model: ${String(q.part)}`);
  }
  return {
    op: q.op,
    part: q.part,
    points: checkPoints(i, q.points),
    pose: checkPose(model, i, q.pose),
  };
}

async function runQuery(
  model: IkiModel,
  cache: Map<string, RestMesh>,
  q: CheckedQuery,
  i: number,
): Promise<ProbeQueryResult> {
  if (q.op === "paint") {
    // Its message is already qualified by the noun it is given.
    const file = resolveInputPath(q.path, `queries[${i}].path`);
    let png: DecodedPng;
    try {
      png = await decodePng(file);
    } catch (e) {
      if (e instanceof AutoRigInputError) throw invalid(i, "path", e.message);
      throw e;
    }
    const { width, height } = model.canvas;
    if (png.width !== width || png.height !== height) {
      throw invalid(
        i,
        "path",
        `is ${png.width}x${png.height}, not the model's canvas ${width}x${height}: ${q.path}`,
      );
    }
    return { op: "paint", ...paintRuns(png) };
  }
  const { points } = q;
  const landed = landPoints(model, cache, q.part, points, q.pose);
  return {
    op: q.op,
    part: q.part,
    points: landed.map((l, k) =>
      l === null
        ? null
        : q.op === "land"
          ? [round(l[0]), round(l[1])]
          : [round(l[0] - points[k][0]), round(l[1] - points[k][1])],
    ),
  };
}

/** One line per query for the text a `outputPath` call returns. */
function summarize(r: ProbeQueryResult, i: number): string {
  if (r.op === "paint") {
    return `${i} paint: ${r.rows.length} rows from y ${r.y0}`;
  }
  const off = r.points.filter((p) => p === null).length;
  return `${i} ${r.op} ${r.part}: ${r.points.length} points, ${off} off the mesh`;
}

/**
 * Measure the model. Only caller-input failures (`AutoRigInputError`,
 * `IkiFormatError`) come back as `{ ok: false, error }`. With `outputPath` the
 * results go to that file and the return carries a line per query instead.
 */
export async function probeRig(input: ProbeInput): Promise<ProbeResult> {
  try {
    // First, so a refused path costs nothing.
    const outFile =
      input.outputPath !== undefined
        ? resolveOutputPath(input.outputPath, OUTPUT_SUFFIX)
        : undefined;
    const modelFile = confineToWorkingDirectory(
      process.cwd(),
      resolveInputPath(input.modelPath, "model"),
      "model path",
      input.modelPath,
    );
    const model = loadIkiModel(readFileSync(modelFile, "utf8"));
    if (!Array.isArray(input.queries) || input.queries.length === 0) {
      throw new AutoRigInputError("queries must be a non-empty list");
    }
    if (input.queries.length > MAX_PROBE_QUERIES) {
      throw new AutoRigInputError(
        `queries has ${input.queries.length} entries; at most ${MAX_PROBE_QUERIES} per call`,
      );
    }
    const checked = input.queries.map((q, i) => checkQuery(model, q, i));
    const cache = new Map<string, RestMesh>();
    const results: ProbeQueryResult[] = [];
    for (const [i, q] of checked.entries()) {
      results.push(await runQuery(model, cache, q, i));
    }
    if (outFile === undefined) return { ok: true, results };
    writeFileAtomic(outFile, JSON.stringify(results));
    return {
      ok: true,
      outputPath: outFile,
      lines: results.map(summarize),
    };
  } catch (e) {
    if (e instanceof AutoRigInputError || e instanceof IkiFormatError) {
      return { ok: false, error: e.message };
    }
    throw e;
  }
}
