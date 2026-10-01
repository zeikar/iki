import type { IkiMesh } from "@ikijs/format";
import type { LayerInput } from "./types";

/** An axis-aligned box in model space (origin canvas centre, +y up). */
export interface Box {
  x0: number;
  x1: number;
  /** Bottom edge (smaller y). */
  y0: number;
  /** Top edge (larger y). */
  y1: number;
}

export function boxOfLayer(layer: LayerInput): Box {
  return boxOfPixels(layer.bbox, layer.canvasW, layer.canvasH);
}

export function boxOfPixels(
  b: { x: number; y: number; w: number; h: number },
  canvasW: number,
  canvasH: number,
): Box {
  return {
    x0: b.x - canvasW / 2,
    x1: b.x + b.w - canvasW / 2,
    y0: canvasH / 2 - (b.y + b.h),
    y1: canvasH / 2 - b.y,
  };
}

export const cx = (b: Box): number => (b.x0 + b.x1) / 2;
export const cy = (b: Box): number => (b.y0 + b.y1) / 2;
export const bw = (b: Box): number => b.x1 - b.x0;
export const bh = (b: Box): number => b.y1 - b.y0;

export function unionBoxes(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export function smoothstep(e0: number, e1: number, v: number): number {
  if (e1 === e0) return v < e0 ? 0 : 1;
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const DEG = Math.PI / 180;

/** Round for the written model: every number the rig emits goes through one
 *  of these, so the file stays small and a re-rig is byte-stable. */
export const roundTo = (v: number, step: number): number => {
  const r = Math.round(v / step) * step;
  // Normalise -0 and float noise from the multiply (0.30000000000000004).
  return r === 0
    ? 0
    : Number(r.toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
};

/** How finely a mesh or grid is cut: about `px` per cell, `min`…`max` cells
 *  a side. */
export interface Cells {
  /** Target cell size, px. */
  px: number;
  min: number;
  max: number;
}

/** Cells for a span of `size` px at about `cell` px each. */
export function cellsFor(
  size: number,
  cell: number,
  min: number,
  max: number,
): number {
  return clamp(Math.ceil(size / cell), min, max);
}

/**
 * A regular grid mesh in part-local ±0.5 space, row 0 on top — the layout of
 * `createGridMesh`, with vertex coordinates rounded so the file stays small.
 */
export function gridMesh(cols: number, rows: number): IkiMesh {
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      vertices.push(
        roundTo(c / cols - 0.5, 1e-5),
        roundTo(0.5 - r / rows, 1e-5),
      );
      uvs.push(roundTo(c / cols, 1e-5), roundTo(r / rows, 1e-5));
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = r * (cols + 1) + c;
      const tr = tl + 1;
      const bl = tl + cols + 1;
      const br = bl + 1;
      indices.push(bl, br, tl, tl, br, tr);
    }
  }
  return { vertices, uvs, indices };
}

/** Model-space position of each mesh vertex of a part laid over `box`. */
export function meshPoints(mesh: IkiMesh, box: Box): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    out.push([
      cx(box) + mesh.vertices[i] * bw(box),
      cy(box) + mesh.vertices[i + 1] * bh(box),
    ]);
  }
  return out;
}
