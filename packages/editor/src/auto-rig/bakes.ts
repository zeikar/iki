/**
 * The `bakes` generator input. The whole input is checked before anything is
 * applied, so a refusal changes nothing; each message starts at the path of
 * the field (`bakes.targets[2].stops["30"][7]`).
 */

import type { IkiParameter } from "@ikijs/format";
import { checkedKeys, checkedNumber } from "./solve";
import { BakeError, type CustomPart } from "./types";

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
