/**
 * Input checks. A malformed layer is a host bug and throws a plain `Error`;
 * malformed turn options come from a caller and throw `TurnTargetError`, and
 * art the rig cannot build on (a body's hips, `body.ts`) throws
 * `LayerGeometryError`. `@ikijs/mcp` reports either as `{ ok: false }` rather
 * than a crash.
 */

import { boxOfLayer, cx, type Box } from "./layout";
import {
  checkArmsHaveBody,
  checkPosesHaveArms,
  REQUIRED_ROLES,
  roleSpec,
} from "./roles";
import {
  TurnTargetError,
  type GenerateOptions,
  type HeadEdges,
  type LayerInput,
} from "./types";

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** The face plate's mesh has at most 24 cells a side; at this size each is
 *  still a pixel, so none collapses to nothing. */
const MIN_FACE_PX = 24;

export function checkLayers(
  layers: LayerInput[],
  canvas: { width: number; height: number },
): void {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error(
      "auto-rig: generateIkiFromLayerSet: layers must be a non-empty array",
    );
  }
  if (!(finite(canvas?.width) && canvas.width > 0)) {
    throw new Error("auto-rig: canvas.width must be a positive number");
  }
  if (!(finite(canvas?.height) && canvas.height > 0)) {
    throw new Error("auto-rig: canvas.height must be a positive number");
  }
  const seen = new Set<string>();
  for (const l of layers) {
    roleSpec(l.role);
    if (seen.has(l.role)) {
      throw new Error(`auto-rig: role "${l.role}" appears twice`);
    }
    seen.add(l.role);
    const at = `auto-rig: layer "${l.fileName}"`;
    const { x, y, w, h } = l.bbox ?? {};
    if (
      ![x, y, w, h].every(finite) ||
      w <= 0 ||
      h <= 0 ||
      x < 0 ||
      y < 0 ||
      x + w > canvas.width ||
      y + h > canvas.height
    ) {
      throw new Error(
        `${at} has a bbox outside its ${canvas.width}x${canvas.height} canvas`,
      );
    }
    if (l.canvasW !== canvas.width || l.canvasH !== canvas.height) {
      throw new Error(
        `${at} was measured on a ${l.canvasW}x${l.canvasH} canvas, not ${canvas.width}x${canvas.height}`,
      );
    }
    // The crop the atlas holds is the bbox: the part is sized off one, the
    // plate's stand-in half-width off the other.
    if (l.cropW !== w || l.cropH !== h) {
      throw new Error(
        `${at}: crop ${l.cropW}x${l.cropH} is not its bbox ${w}x${h}`,
      );
    }
    if (l.role === "face" && (w < MIN_FACE_PX || h < MIN_FACE_PX)) {
      throw new Error(
        `${at}: the face is ${w}x${h} px; the face plate needs at least ${MIN_FACE_PX} px each way to be meshed`,
      );
    }
    if (l.rowHalfWidths !== undefined) {
      const rows = l.rowHalfWidths;
      if (!Array.isArray(rows) || rows.length !== h) {
        throw new Error(
          `${at}: rowHalfWidths must have one entry per crop row (${h})`,
        );
      }
      rows.forEach((v, i) => {
        if (!finite(v) || v < 0 || v > w / 2 + 0.5) {
          throw new Error(
            `${at}: rowHalfWidths[${i}] ${v} is not a half-width inside its crop`,
          );
        }
      });
    }
    if (l.rowRuns !== undefined) {
      const rows = l.rowRuns;
      if (!Array.isArray(rows) || rows.length !== h) {
        throw new Error(
          `${at}: rowRuns must have one entry per crop row (${h})`,
        );
      }
      rows.forEach((runs, i) => {
        if (
          !Array.isArray(runs) ||
          runs.length % 2 !== 0 ||
          !runs.every(
            (c, k) =>
              Number.isInteger(c) &&
              c >= x &&
              c <= x + w &&
              (k === 0 || c > runs[k - 1]),
          )
        ) {
          throw new Error(
            `${at}: rowRuns[${i}] ${JSON.stringify(runs)} is not an even-length, strictly increasing list of columns inside its crop (${x}..${x + w})`,
          );
        }
      });
    }
    if (l.jawRows !== undefined) {
      const cols = l.jawRows;
      if (!Array.isArray(cols) || cols.length !== w) {
        throw new Error(
          `${at}: jawRows must have one entry per crop column (${w})`,
        );
      }
      cols.forEach((v, i) => {
        if (!Number.isInteger(v) || (v !== -1 && (v < y || v >= y + h))) {
          throw new Error(
            `${at}: jawRows[${i}] ${v} is neither -1 nor a row of its crop`,
          );
        }
      });
    }
    if (l.denseCore !== undefined) {
      const c = l.denseCore;
      if (
        ![c.x, c.y, c.w, c.h].every(finite) ||
        c.w <= 0 ||
        c.h <= 0 ||
        c.x < x - 1 ||
        c.y < y - 1 ||
        c.x + c.w > x + w + 1 ||
        c.y + c.h > y + h + 1
      ) {
        throw new Error(`${at}: denseCore is not a box inside its crop`);
      }
    }
  }
  const missing = REQUIRED_ROLES.filter((r) => !seen.has(r));
  if (missing.length > 0) {
    throw new Error(`auto-rig: missing required role(s) ${missing.join(", ")}`);
  }
  // `parseLayerRoles` refuses it too; a direct caller may not have run it.
  checkArmsHaveBody(seen);
  checkPosesHaveArms(seen);
}

/** Each entry names a layer of this set; the outermost left edge lies left
 *  of the face, the outermost right edge right of it. */
export function checkHeadEdges(
  edges: HeadEdges | undefined,
  byRole: Map<string, LayerInput>,
): void {
  if (edges === undefined) return;
  if (!isObject(edges))
    throw new TurnTargetError("headEdges must be an object");
  for (const side of ["left", "right"] as const) {
    const list: unknown = edges[side];
    if (!Array.isArray(list)) {
      throw new TurnTargetError(`headEdges.${side} must be an array`);
    }
    list.forEach((e: unknown, i) => {
      if (!isObject(e) || typeof e.role !== "string" || !byRole.has(e.role)) {
        throw new TurnTargetError(
          `headEdges.${side}[${i}].role is not a layer in this set`,
        );
      }
      if (!finite(e.x)) {
        throw new TurnTargetError(
          `headEdges.${side}[${i}].x must be a finite number`,
        );
      }
    });
  }
  if (edges.left.length > 0 && edges.right.length > 0) {
    const axis = cx(boxOfLayer(byRole.get("face")!));
    const left = Math.min(...edges.left.map((e) => e.x));
    const right = Math.max(...edges.right.map((e) => e.x));
    if (!(left < axis && axis < right)) {
      throw new TurnTargetError(
        `headEdges: the left edge ${left} and the right edge ${right} do not bracket the face (x ${axis})`,
      );
    }
  }
}

/** Strand edges describe the irises this set has, against bangs it has, on
 *  a row both cover: each side's iris span inside its crop, outer edge
 *  strictly outward; the run inside the bangs' crop, its outer end strictly
 *  outward of the iris's centre and of its face-side end, and that end short
 *  of the other iris's centre (a run reaching it is a fringe: `null`). */
export function checkStrandEdges(
  strand: GenerateOptions["strandEdges"],
  irises: { left?: Box; right?: Box },
  hair: Box | undefined,
): void {
  if (strand === undefined) return;
  if (!isObject(strand)) {
    throw new TurnTargetError("strandEdges must be an object");
  }
  for (const side of ["left", "right"] as const) {
    const s: unknown = strand[side];
    if (s === undefined) continue;
    const at = `strandEdges.${side}`;
    if (!isObject(s)) throw new TurnTargetError(`${at} must be an object`);
    if (hair === undefined) {
      throw new TurnTargetError(
        `${at} names a bangs' run, but this layer set has no hair_front`,
      );
    }
    for (const k of ["y", "irisOuter", "irisInner", "runOuter"] as const) {
      if (!finite(s[k])) {
        throw new TurnTargetError(`${at}.${k} must be a finite number`);
      }
    }
    if (s.runFace !== null && !finite(s.runFace)) {
      throw new TurnTargetError(
        `${at}.runFace must be a finite number or null`,
      );
    }
    const iris = irises[side];
    const other = irises[side === "left" ? "right" : "left"];
    if (iris === undefined || other === undefined) {
      throw new TurnTargetError(
        `${at} names an iris this layer set does not have`,
      );
    }
    const y = s.y as number;
    const outer = s.irisOuter as number;
    const inner = s.irisInner as number;
    const runOuter = s.runOuter as number;
    const runFace = s.runFace as number | null;
    // Outward is −x on the left side, +x on the right.
    const sign = side === "left" ? -1 : 1;
    if (y < iris.y0 || y > iris.y1 || y < hair.y0 || y > hair.y1) {
      throw new TurnTargetError(
        `${at}.y ${y} is not on a row of both its iris and hair_front`,
      );
    }
    for (const [k, x] of [
      ["irisOuter", outer],
      ["irisInner", inner],
    ] as const) {
      if (x < iris.x0 || x > iris.x1) {
        throw new TurnTargetError(`${at}.${k} ${x} is off its iris's crop`);
      }
    }
    if (sign * (outer - inner) <= 0) {
      throw new TurnTargetError(
        `${at}.irisOuter ${outer} is not strictly outward of irisInner ${inner}`,
      );
    }
    for (const [k, x] of [
      ["runOuter", runOuter],
      ["runFace", runFace],
    ] as const) {
      if (x !== null && (x < hair.x0 || x > hair.x1)) {
        throw new TurnTargetError(`${at}.${k} ${x} is off hair_front's crop`);
      }
    }
    if (sign * (runOuter - cx(iris)) <= 0) {
      throw new TurnTargetError(
        `${at}.runOuter ${runOuter} is not strictly outward of its iris's centre`,
      );
    }
    if (runFace !== null && sign * (runOuter - runFace) <= 0) {
      throw new TurnTargetError(
        `${at}.runOuter ${runOuter} is not strictly outward of runFace ${runFace}`,
      );
    }
    if (runFace !== null && sign * (runFace - cx(other)) <= 0) {
      throw new TurnTargetError(
        `${at}.runFace ${runFace} reaches the other iris's centre; a run that does is a fringe, runFace null`,
      );
    }
  }
}
