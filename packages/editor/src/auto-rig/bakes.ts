/**
 * The `bakes` generator input, in two steps. `parseBakes` checks the whole
 * input before anything is applied, so a refusal changes nothing; each
 * message starts at the path of the field (`bakes.targets[2].stops["30"][7]`).
 * `applyBakes` then re-meshes the named parts and writes their warps, solved
 * in closed form through the head's chain.
 */

import type { IkiDeformer, IkiParameter, IkiPart } from "@ikijs/format";
import { matrixWorldAt, type Affine } from "./chain";
import {
  boxOfPixels,
  bh,
  bw,
  clamp,
  columnMesh,
  gridMesh,
  roundTo,
} from "./layout";
import { checkedKeys, checkedNumber } from "./solve";
import { BakeError, type BakeReport, type CustomPart } from "./types";

const TARGET_KEYS = [
  "id",
  "param",
  "parts",
  "box",
  "grid",
  "stops",
  "mirror",
  "why",
];
const BOX_KEYS = ["x", "y", "w", "h"];

/** The format's per-mesh vertex limit. `@ikijs/format` exports no constant:
 *  it is hard-coded in `packages/format/src/validate.ts` (about line 75), so
 *  change the two together. */
const MAX_VERTICES = 65536;

/** Mesh limits, from the experiment's tool (`iki-char/ai-rig-c/lib/apply.mjs`):
 *  `cellPx` under 4 or over 400 is a grid too dense to bake or one cell wide;
 *  `cols` over 64 and `rows` over 400 entries are a typo, not a mesh, and
 *  stay far inside MAX_VERTICES. */
const CELL_PX = [4, 400] as const;
const MAX_MESH_COLS = 64;
const MAX_MESH_ROWS = 400;

/** Grown around the parts' union when a target gives no box. */
const DEFAULT_BOX_MARGIN = 2;

/** Two stop values this close are one value, so float error in a mirrored
 *  key (`2 * rest - v`) cannot make a second keyform beside a written one. */
const SAME_STOP = 1e-9;

const PLAIN_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const show = (v: unknown) =>
  typeof v === "number" ? String(v) : (JSON.stringify(v) ?? String(v));

type Box = { x: number; y: number; w: number; h: number };
type Point = [number, number];
type MeshChoice = { rows: number[]; cols: number } | { cellPx: number };

/** A target after the parse: every default filled, every mirrored stop made. */
export interface ParsedBakeTarget {
  id: string;
  param: string;
  /** The parameter's default, clamped into its range. */
  rest: number;
  parts: string[];
  box: Box;
  cols: number;
  rows: number;
  /** Stop value -> `(cols + 1) * (rows + 1)` points, after mirroring. */
  stops: Map<number, Point[]>;
}

export interface ParsedBakes {
  targets: ParsedBakeTarget[];
  meshes: Map<string, MeshChoice>;
}

function mirrorLattice(lattice: Point[], cols: number, rows: number): Point[] {
  const out: Point[] = new Array(lattice.length);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const [dx, dy] = lattice[r * (cols + 1) + (cols - c)];
      out[r * (cols + 1) + c] = [-dx, dy];
    }
  }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

const findStop = (stops: Map<number, Point[]>, v: number) =>
  [...stops.keys()].find((k) => Math.abs(k - v) <= SAME_STOP);

/** A target's `grid`: integers 1 to 32. */
function checkGrid(at: string, grid: unknown) {
  if (!isObject(grid)) {
    throw new BakeError(`${at}.grid must be { cols, rows }, got ${show(grid)}`);
  }
  checkedKeys(`${at}.grid`, grid, ["cols", "rows"], BakeError);
  const out = { cols: 0, rows: 0 };
  for (const key of ["cols", "rows"] as const) {
    const v = checkedNumber(
      `${at}.grid.${key}`,
      grid[key],
      1,
      32,
      false,
      BakeError,
    );
    if (!Number.isInteger(v)) {
      throw new BakeError(`${at}.grid.${key} must be an integer, got ${v}`);
    }
    out[key] = v;
  }
  return out;
}

/** A target's `box`, given or the parts' union grown by DEFAULT_BOX_MARGIN. */
function checkBox(at: string, box: unknown, partBoxes: Box[]): Box {
  if (box === undefined) {
    const x0 = Math.min(...partBoxes.map((b) => b.x)) - DEFAULT_BOX_MARGIN;
    const y0 = Math.min(...partBoxes.map((b) => b.y)) - DEFAULT_BOX_MARGIN;
    const x1 =
      Math.max(...partBoxes.map((b) => b.x + b.w)) + DEFAULT_BOX_MARGIN;
    const y1 =
      Math.max(...partBoxes.map((b) => b.y + b.h)) + DEFAULT_BOX_MARGIN;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (!isObject(box)) {
    throw new BakeError(`${at}.box must be { x, y, w, h }, got ${show(box)}`);
  }
  checkedKeys(`${at}.box`, box, BOX_KEYS, BakeError);
  const [x, y] = ["x", "y"].map((k) =>
    checkedNumber(
      `${at}.box.${k}`,
      box[k],
      -Infinity,
      Infinity,
      false,
      BakeError,
    ),
  );
  const [w, h] = ["w", "h"].map((k) =>
    checkedNumber(`${at}.box.${k}`, box[k], 0, Infinity, true, BakeError),
  );
  return { x, y, w, h };
}

/** A target's `stops`, with `mirror` applied: a written stop is kept as it is. */
function checkStops(
  at: string,
  t: Record<string, unknown>,
  info: IkiParameter,
  rest: number,
  cols: number,
  rows: number,
): Map<number, Point[]> {
  if (!isObject(t.stops)) {
    throw new BakeError(
      `${at}.stops must be an object keyed by a ${info.id} value, got ${show(t.stops)}`,
    );
  }
  const n = (cols + 1) * (rows + 1);
  const stops = new Map<number, Point[]>();
  for (const [key, list] of Object.entries(t.stops)) {
    const sat = `${at}.stops["${key}"]`;
    if (!PLAIN_DECIMAL.test(key)) {
      throw new BakeError(`${sat} must be keyed by a plain decimal number`);
    }
    const v = Number(key);
    if (!Number.isFinite(v) || v < info.min || v > info.max) {
      throw new BakeError(
        `${sat} is outside ${info.id}'s range ${info.min} to ${info.max}`,
      );
    }
    if (Math.abs(v - rest) <= SAME_STOP) {
      throw new BakeError(
        `${sat} is ${info.id}'s rest value ${rest}: rest is implicit, leave it out`,
      );
    }
    if (findStop(stops, v) !== undefined) {
      throw new BakeError(`${sat} repeats an earlier stop`);
    }
    if (!Array.isArray(list) || list.length !== n) {
      throw new BakeError(
        `${sat} must be ${n} points [dx, dy] (${cols + 1} x ${rows + 1}), got ${Array.isArray(list) ? `${list.length} points` : show(list)}`,
      );
    }
    list.forEach((pt: unknown, k) => {
      if (!Array.isArray(pt) || pt.length !== 2) {
        throw new BakeError(`${sat}[${k}] must be [dx, dy], got ${show(pt)}`);
      }
      pt.forEach((c: unknown, j) => {
        if (!finite(c)) {
          throw new BakeError(
            `${sat}[${k}][${j}] must be a finite number, got ${String(c)}`,
          );
        }
      });
    });
    stops.set(v, list as Point[]);
  }
  if (stops.size === 0) {
    throw new BakeError(`${at}.stops must have at least one stop`);
  }
  if (t.mirror === true) {
    for (const [v, lattice] of [...stops]) {
      const m = 2 * rest - v;
      if (m < info.min - SAME_STOP || m > info.max + SAME_STOP) continue;
      if (Math.abs(m - rest) <= SAME_STOP || findStop(stops, m) !== undefined) {
        continue;
      }
      stops.set(
        Math.min(info.max, Math.max(info.min, m)),
        mirrorLattice(lattice, cols, rows),
      );
    }
  }
  return stops;
}

function checkTarget(
  t: unknown,
  i: number,
  customParts: readonly CustomPart[],
  paramById: Map<string, IkiParameter>,
): ParsedBakeTarget {
  const at = `bakes.targets[${i}]`;
  if (!isObject(t)) {
    throw new BakeError(`${at} must be a plain object, got ${show(t)}`);
  }
  checkedKeys(at, t, TARGET_KEYS, BakeError);
  if (t.id !== undefined && typeof t.id !== "string") {
    throw new BakeError(`${at}.id must be a string, got ${show(t.id)}`);
  }
  if (t.why !== undefined && typeof t.why !== "string") {
    throw new BakeError(`${at}.why must be a string, got ${show(t.why)}`);
  }
  const info = typeof t.param === "string" ? paramById.get(t.param) : undefined;
  if (info === undefined) {
    throw new BakeError(
      `${at}.param must be a parameter the model declares, got ${show(t.param)}`,
    );
  }
  const rest = Math.min(info.max, Math.max(info.min, info.default));

  const customIds = customParts.map((c) => c.id);
  if (!Array.isArray(t.parts) || t.parts.length === 0) {
    throw new BakeError(
      `${at}.parts must be a non-empty array of part ids, got ${show(t.parts)}`,
    );
  }
  const parts = t.parts as unknown[];
  parts.forEach((id, k) => {
    if (typeof id !== "string" || !customIds.includes(id)) {
      throw new BakeError(
        `${at}.parts[${k}] must be a custom part id (${customIds.join(", ")}): a bake moves custom parts only, got ${show(id)}`,
      );
    }
    if (parts.indexOf(id) !== k) {
      throw new BakeError(`${at}.parts[${k}] repeats "${id}"`);
    }
  });

  const { cols, rows } = checkGrid(at, t.grid);
  const partBoxes = (parts as string[]).map(
    (id) => customParts.find((c) => c.id === id)!.layer.bbox,
  );
  const box = checkBox(at, t.box, partBoxes);
  if (t.mirror !== undefined && typeof t.mirror !== "boolean") {
    throw new BakeError(
      `${at}.mirror must be true or false, got ${show(t.mirror)}`,
    );
  }
  const stops = checkStops(at, t, info, rest, cols, rows);
  return {
    id: typeof t.id === "string" ? t.id : `target${i}`,
    param: info.id,
    rest,
    parts: parts as string[],
    box,
    cols,
    rows,
    stops,
  };
}

function checkMesh(at: string, choice: unknown, box: Box): MeshChoice {
  if (!isObject(choice)) {
    throw new BakeError(
      `${at} must be { rows, cols } or { cellPx }, got ${show(choice)}`,
    );
  }
  checkedKeys(at, choice, ["rows", "cols", "cellPx"], BakeError);
  if (choice.cellPx !== undefined) {
    if (choice.rows !== undefined || choice.cols !== undefined) {
      throw new BakeError(`${at} takes { cellPx } or { rows, cols }, not both`);
    }
    const cell = checkedNumber(
      `${at}.cellPx`,
      choice.cellPx,
      CELL_PX[0],
      CELL_PX[1],
      false,
      BakeError,
    );
    const count =
      (Math.max(1, Math.round(box.w / cell)) + 1) *
      (Math.max(1, Math.round(box.h / cell)) + 1);
    if (count > MAX_VERTICES) {
      throw new BakeError(
        `${at}.cellPx ${cell} makes ${count} vertices, over the format's ${MAX_VERTICES} limit`,
      );
    }
    return { cellPx: cell };
  }
  const cols = checkedNumber(
    `${at}.cols`,
    choice.cols,
    1,
    MAX_MESH_COLS,
    false,
    BakeError,
  );
  if (!Number.isInteger(cols)) {
    throw new BakeError(`${at}.cols must be an integer, got ${cols}`);
  }
  const ys = choice.rows;
  if (!Array.isArray(ys) || ys.length < 2 || ys.length > MAX_MESH_ROWS) {
    throw new BakeError(
      `${at}.rows must be an array of 2 to ${MAX_MESH_ROWS} canvas-px y values, got ${Array.isArray(ys) ? `${ys.length} values` : show(ys)}`,
    );
  }
  ys.forEach((y: unknown, k) => {
    if (!finite(y)) {
      throw new BakeError(
        `${at}.rows[${k}] must be a finite number, got ${String(y)}`,
      );
    }
    if (k > 0 && !(y > (ys[k - 1] as number))) {
      throw new BakeError(
        `${at}.rows[${k}] must be below the row before it (rows are strictly increasing), got ${y} after ${String(ys[k - 1])}`,
      );
    }
  });
  const last = ys.length - 1;
  if (Math.abs((ys[0] as number) - box.y) > 0.5) {
    throw new BakeError(
      `${at}.rows[0] must be the part's box top ${r1(box.y)} (within 0.5 px), got ${String(ys[0])}`,
    );
  }
  if (Math.abs((ys[last] as number) - (box.y + box.h)) > 0.5) {
    throw new BakeError(
      `${at}.rows[${last}] must be the part's box bottom ${r1(box.y + box.h)} (within 0.5 px), got ${String(ys[last])}`,
    );
  }
  return { rows: ys as number[], cols };
}

/**
 * Checks `bakes` against the custom parts (their ids and rest boxes: a
 * custom part's box is its layer's bbox) and the model's declared parameters.
 * The canvas is not needed: nothing here reads a position outside a box.
 */
export function parseBakes(
  bakes: unknown,
  customParts: readonly CustomPart[] | undefined,
  parameters: readonly IkiParameter[],
): ParsedBakes {
  if (customParts === undefined || customParts.length === 0) {
    throw new BakeError(
      "bakes needs customParts: a bake moves custom parts only, and none were given",
    );
  }
  if (!isObject(bakes)) {
    throw new BakeError(`bakes must be a plain object, got ${show(bakes)}`);
  }
  checkedKeys("bakes", bakes, ["targets", "meshes"], BakeError);
  const { targets, meshes } = bakes;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new BakeError("bakes.targets must be a non-empty array");
  }
  const paramById = new Map(parameters.map((p) => [p.id, p]));
  const parsedTargets = targets.map((t: unknown, i) =>
    checkTarget(t, i, customParts, paramById),
  );

  const parsedMeshes: ParsedBakes["meshes"] = new Map();
  if (meshes !== undefined) {
    if (!isObject(meshes)) {
      throw new BakeError(
        `bakes.meshes must be an object keyed by part id, got ${show(meshes)}`,
      );
    }
    for (const [id, choice] of Object.entries(meshes)) {
      const at = `bakes.meshes.${id}`;
      const part = customParts.find((c) => c.id === id);
      if (part === undefined) {
        throw new BakeError(
          `${at}: "${id}" is not a custom part (${customParts.map((c) => c.id).join(", ")}): only a custom part is re-meshed`,
        );
      }
      parsedMeshes.set(id, checkMesh(at, choice, part.layer.bbox));
    }
  }
  return { targets: parsedTargets, meshes: parsedMeshes };
}

/** Offsets are written to this fraction of the part's own size: the
 *  generator's usual 1e-4 is 0.08 px on an 830 px tail, the whole error
 *  budget of a bake. */
const OFFSET_STEP = 1e-6;

/** A rigid part may bend by this many face widths at a stop (1 px on a
 *  400 px face): a hairpin that is only translated or turned stays under it,
 *  a bent one does not. */
const RIGID_BEND = 0.0025;

/**
 * The largest distance, over the point set, from where `moved` puts a point
 * to where the least-squares rigid fit of `rest` puts it: 0 for a rigid
 * motion, the bend of anything else. The fit is a rotation and a translation,
 * no scale and no reflection, and it minimises the summed squares, not the
 * largest distance (so the result can exceed the minimax one). Both lists
 * hold the same points in the same order, in one frame, so their lengths must
 * be equal.
 */
export function rigidResidual(
  rest: readonly Point[],
  moved: readonly Point[],
): number {
  const n = rest.length;
  if (moved.length !== n) {
    throw new Error(
      `rigidResidual: ${n} rest points but ${moved.length} moved points`,
    );
  }
  if (n === 0) return 0;
  let pcx = 0;
  let pcy = 0;
  let qcx = 0;
  let qcy = 0;
  for (let i = 0; i < n; i++) {
    pcx += rest[i][0];
    pcy += rest[i][1];
    qcx += moved[i][0];
    qcy += moved[i][1];
  }
  pcx /= n;
  pcy /= n;
  qcx /= n;
  qcy /= n;
  let dot = 0;
  let cross = 0;
  for (let i = 0; i < n; i++) {
    const px = rest[i][0] - pcx;
    const py = rest[i][1] - pcy;
    const qx = moved[i][0] - qcx;
    const qy = moved[i][1] - qcy;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
  }
  const theta = Math.atan2(cross, dot);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const px = rest[i][0] - pcx;
    const py = rest[i][1] - pcy;
    const ex = qcx + c * px - s * py - moved[i][0];
    const ey = qcy + s * px + c * py - moved[i][1];
    worst = Math.max(worst, Math.hypot(ex, ey));
  }
  return worst;
}

/** The bilinear lattice value at canvas point (x, y); outside the box, the
 *  nearest edge's. */
function latticeAt(
  t: ParsedBakeTarget,
  lattice: Point[],
  x: number,
  y: number,
) {
  const { cols, rows, box } = t;
  const u = clamp((x - box.x) / box.w, 0, 1) * cols;
  const v = clamp((y - box.y) / box.h, 0, 1) * rows;
  const c = Math.min(Math.floor(u), cols - 1);
  const r = Math.min(Math.floor(v), rows - 1);
  const fx = u - c;
  const fy = v - r;
  const at = (rr: number, cc: number) => lattice[rr * (cols + 1) + cc];
  const mix = (k: 0 | 1) => {
    const top = at(r, c)[k] + (at(r, c + 1)[k] - at(r, c)[k]) * fx;
    const bot = at(r + 1, c)[k] + (at(r + 1, c + 1)[k] - at(r + 1, c)[k]) * fx;
    return top + (bot - top) * fy;
  };
  return [mix(0), mix(1)] as Point;
}

/** A target's displacement at value `v` as a function of canvas point (x, y):
 *  linear from rest through the stops on `v`'s side, held past the outermost,
 *  zero on a side with none. The knots are read once, not per vertex. */
function targetField(t: ParsedBakeTarget, v: number) {
  const side = Math.sign(v - t.rest);
  const knots = [...t.stops.keys()]
    .filter((k) => Math.sign(k - t.rest) === side)
    .sort((a, b) => Math.abs(a - t.rest) - Math.abs(b - t.rest));
  const a = Math.abs(v - t.rest);
  return (x: number, y: number): Point => {
    if (knots.length === 0) return [0, 0];
    const at = (k: number) => latticeAt(t, t.stops.get(k)!, x, y);
    let lo = 0;
    let loVal: Point = [0, 0];
    for (const k of knots) {
      const hi = Math.abs(k - t.rest);
      const hiVal = at(k);
      if (a <= hi + SAME_STOP) {
        const f = hi - lo > 0 ? Math.min(1, (a - lo) / (hi - lo)) : 1;
        return [
          loVal[0] + (hiVal[0] - loVal[0]) * f,
          loVal[1] + (hiVal[1] - loVal[1]) * f,
        ];
      }
      lo = hi;
      loVal = hiVal;
    }
    return loVal;
  };
}

const apply = (m: Affine, x: number, y: number): Point => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Replaces the mesh of a part with the chosen grid over its rest box: the
 *  same box and the same UV map, so the rest picture is as it was. */
function remesh(
  part: IkiPart,
  entry: CustomPart,
  choice: MeshChoice,
  canvas: { width: number; height: number },
) {
  const b = boxOfPixels(entry.layer.bbox, canvas.width, canvas.height);
  if ("cellPx" in choice) {
    part.mesh = gridMesh(
      Math.max(1, Math.round(bw(b) / choice.cellPx)),
      Math.max(1, Math.round(bh(b) / choice.cellPx)),
    );
    return;
  }
  const xs = Array.from(
    { length: choice.cols + 1 },
    (_, c) => b.x0 + (bw(b) * c) / choice.cols,
  );
  part.mesh = columnMesh(b, {
    xs,
    ys: choice.rows.map((y) => canvas.height / 2 - y),
  });
}

/**
 * Writes the parsed bakes into the built custom `parts` (in place): re-meshes
 * the parts named in `meshes`, then one warp per part and parameter, keyforms
 * at the parameter's rest (zeros) and at every stop its targets use.
 *
 * A stop's value is the part's TOTAL landed displacement in canvas px, so the
 * head's own carry is inside it. The part's local offsets that land it there
 * are solved in closed form: with W0 the head's world at rest and W its world
 * with the parameter at the stop, a vertex's local position is
 * W⁻¹ · (W0 · rest + wanted), and its offset is that minus its rest position.
 */
export function applyBakes(
  parsed: ParsedBakes,
  parts: IkiPart[],
  entries: readonly CustomPart[],
  ctx: {
    canvas: { width: number; height: number };
    deformers: IkiDeformer[];
    parameters: IkiParameter[];
    faceWidth: number;
  },
): BakeReport[] {
  const { canvas, deformers, parameters, faceWidth } = ctx;
  const partOf = (id: string) => parts.find((p) => p.id === id)!;
  const entryOf = (id: string) => entries.find((e) => e.id === id)!;

  for (const [id, choice] of parsed.meshes) {
    remesh(partOf(id), entryOf(id), choice, canvas);
  }

  const ids = [...new Set(parsed.targets.flatMap((t) => t.parts))];
  const reports: BakeReport[] = [];
  for (const id of ids) {
    const part = partOf(id);
    const n = part.mesh!.vertices.length / 2;
    const own = parsed.targets.filter((t) => t.parts.includes(id));
    const w0 = matrixWorldAt(deformers, parameters, part.deformer!);
    // A vertex's place in the part's own model-space frame, and where it
    // rests in the canvas.
    const local: Point[] = [];
    const restModel: Point[] = [];
    const restCanvas: Point[] = [];
    for (let i = 0; i < n; i++) {
      const p: Point = [
        part.transform.x + part.mesh!.vertices[i * 2] * part.width,
        part.transform.y + part.mesh!.vertices[i * 2 + 1] * part.height,
      ];
      const r = apply(w0, p[0], p[1]);
      local.push(p);
      restModel.push(r);
      restCanvas.push([r[0] + canvas.width / 2, canvas.height / 2 - r[1]]);
    }

    for (const param of [...new Set(own.map((t) => t.param))]) {
      const targets = own.filter((t) => t.param === param);
      const rest = targets[0].rest;
      const stops: number[] = [];
      for (const v of targets
        .flatMap((t) => [...t.stops.keys()])
        .sort((a, b) => a - b)) {
        if (stops.length === 0 || v - stops[stops.length - 1] > SAME_STOP) {
          stops.push(v);
        }
      }

      const keyforms = [{ value: rest, offsets: new Array(2 * n).fill(0) }];
      const wanted: number[][] = [];
      for (const v of stops) {
        const disp = new Array<number>(2 * n).fill(0);
        const fields = targets.map((t) => targetField(t, v));
        for (let i = 0; i < n; i++) {
          for (const field of fields) {
            const [dx, dy] = field(restCanvas[i][0], restCanvas[i][1]);
            disp[i * 2] += dx;
            disp[i * 2 + 1] += dy;
          }
        }
        wanted.push(disp);

        if (entryOf(id).rigid === true) {
          const moved = restCanvas.map(
            (p, i) => [p[0] + disp[i * 2], p[1] + disp[i * 2 + 1]] as Point,
          );
          const bend = rigidResidual(restCanvas, moved);
          if (bend > RIGID_BEND * faceWidth) {
            const names = targets
              .map(
                (t) =>
                  `bakes.targets[${parsed.targets.indexOf(t)}] ("${t.id}")`,
              )
              .join(", ");
            throw new BakeError(
              `${names}: "${id}" is rigid, but at ${param} ${v} these targets together bend it by ${bend.toFixed(2)} px, over the ${(RIGID_BEND * faceWidth).toFixed(2)} px a rigid part may bend (${RIGID_BEND} face widths): give every control point one displacement, or a rotation`,
            );
          }
        }

        const inv = invert(
          matrixWorldAt(deformers, parameters, part.deformer!, { [param]: v }),
        );
        const offsets: number[] = [];
        for (let i = 0; i < n; i++) {
          const [px, py] = apply(
            inv,
            restModel[i][0] + disp[i * 2],
            restModel[i][1] - disp[i * 2 + 1],
          );
          offsets.push(
            roundTo((px - local[i][0]) / part.width, OFFSET_STEP),
            roundTo((py - local[i][1]) / part.height, OFFSET_STEP),
          );
        }
        keyforms.push({ value: v, offsets });
      }
      keyforms.sort((a, b) => a.value - b.value);
      part.warps = [...(part.warps ?? []), { parameter: param, keyforms }];
      reports.push({ part: id, param, stops, vertexCount: n, wanted });
    }
  }
  return reports;
}
