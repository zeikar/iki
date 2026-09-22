/**
 * Test-only render oracle: lands a part's vertices exactly as the engine does
 * in `packages/engine/src/player.ts` drawPart — the warp-child branch
 * (`if (pm.warpDeformer)`, :734–764), the matrix-child branch
 * (`else if (part.deformer !== undefined)`, :687–697) and the no-deformer
 * `else` (:698–701). It runs the engine's own math, never a second copy of it:
 * `ParameterStore` and the affine helpers are `@ikijs/engine`'s public exports,
 * while `deform`, `warp` and `warp-grid` are unexported internals imported by
 * relative path. Tests read WHERE geometry renders through this instead of
 * asserting bindings or grid columns.
 *
 * The pipeline mirrored per part:
 *   1. part-local mesh warps summed onto the rest mesh (`applyWarps`);
 *   2. the part's live TRS from `evaluateTransform` — bindings are ADDITIVE
 *      (scale starts at 1 and adds each value, rotate and translate sum,
 *      opacity moves nothing) — as translate · rotate · scale(width·sx,
 *      height·sy): the PRE-BIND model-space positions;
 *   3. a warp child binds those to its deformer's RAW rest grid and samples
 *      the RESOLVED grid (`resolveWarpGrids`: keyform offsets first, then the
 *      parent matrix deformer's world affine folded in — so a landed position
 *      carries headDeformer's own translate/rotate too, as the render does);
 *      a matrix child, or a part with no deformer, rides dWorld · partAffine.
 *
 * Positions come back as Float32Array, the precision the engine renders at.
 * `@ikijs/engine` resolves to the engine's source through the vitest root
 * alias although `@ikijs/editor` declares no dependency on it — this file is
 * a test helper, never shipped.
 */
import {
  type Affine,
  ParameterStore,
  multiply,
  rotate,
  scale,
  translate,
} from "@ikijs/engine";
import type { IkiModel, IkiPart } from "@ikijs/format";
import {
  evaluateTransform,
  resolveDeformerWorlds,
} from "../../../engine/src/deform";
import { applyWarps } from "../../../engine/src/warp";
import {
  applyWarpToChild,
  resolveWarpGrids,
  type ResolvedWarpGrid,
} from "../../../engine/src/warp-grid";

/** Parameter values by id; every parameter not named rests at the model's
 *  declared default, the way a freshly loaded `ParameterStore` does. A value
 *  has to be finite and inside its parameter's declared range:
 *  `ParameterStore.set` clamps into the range and drops a non-finite value
 *  (`parameter-store.ts:47–51`), so `storeFor` refuses both rather than let a
 *  test that asked for −45 read −30. */
export type ParamValues = Record<string, number>;

/** The implicit quad's corners laid out as a 1 × 1 `createPixelGridMesh`
 *  lattice (row 0 at the top): the same four points, and the same TL→BR
 *  diagonal, as the strip the engine draws a mesh-less part with. */
const UNIT_QUAD = [-0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5];

function storeFor(model: IkiModel, params: ParamValues): ParameterStore {
  const store = new ParameterStore(model.parameters);
  for (const [id, value] of Object.entries(params)) {
    // ParameterStore drops an unknown id silently and clamps a value into its
    // range (it is a host boundary); a test that misspells an id or overshoots
    // a range has to fail loudly instead.
    const param = model.parameters.find((p) => p.id === id);
    if (!param) throw new Error(`render-oracle: unknown parameter "${id}"`);
    if (!Number.isFinite(value) || value < param.min || value > param.max) {
      throw new Error(
        `render-oracle: ${id} = ${value} is outside its range [${param.min}, ${param.max}]`,
      );
    }
    store.set(id, value);
  }
  return store;
}

function partOf(model: IkiModel, partId: string): IkiPart {
  const part = model.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`render-oracle: no part "${partId}"`);
  return part;
}

function transformAll(verts: Float32Array, m: Affine): Float32Array {
  const out = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 2) {
    const x = verts[i];
    const y = verts[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}

/** Steps 1–2: the part's warped local mesh and the affine that places it. */
function prepare(model: IkiModel, partId: string, params: ParamValues) {
  const part = partOf(model, partId);
  const store = storeFor(model, params);
  const rest = Float32Array.from(part.mesh?.vertices ?? UNIT_QUAD);
  const local = new Float32Array(rest.length);
  applyWarps(rest, part.warps, store, local);
  const trs = evaluateTransform(part.transform, part.bindings, store);
  const partAffine = multiply(
    multiply(translate(trs.x, trs.y), rotate(trs.rotation)),
    scale(part.width * trs.scaleX, part.height * trs.scaleY),
  );
  return { part, store, local, partAffine };
}

/** A part's vertices after its own warps and TRS, in model space — the
 *  positions `applyWarpToChild` binds to the rest grid (and clamps), before
 *  any deformer has moved them. */
export function preBindVertices(
  model: IkiModel,
  partId: string,
  params: ParamValues = {},
): Float32Array {
  const { local, partAffine } = prepare(model, partId, params);
  return transformAll(local, partAffine);
}

/** Where a part's vertices render, in model space. */
export function landVertices(
  model: IkiModel,
  partId: string,
  params: ParamValues = {},
): Float32Array {
  const { part, store, local, partAffine } = prepare(model, partId, params);
  const deformers = model.deformers ?? [];
  const deformer =
    part.deformer === undefined
      ? undefined
      : deformers.find((d) => d.id === part.deformer);
  if (part.deformer !== undefined && deformer === undefined) {
    throw new Error(
      `render-oracle: part "${partId}" references unknown deformer "${part.deformer}"`,
    );
  }
  const worlds = resolveDeformerWorlds(deformers, store);
  if (deformer?.kind === "warp") {
    const grid = resolveWarpGrids(deformers, store, worlds).get(deformer.id)!;
    const out = new Float32Array(local.length);
    applyWarpToChild(local, partAffine, deformer.grid, grid, out);
    return out;
  }
  const m =
    deformer === undefined
      ? partAffine
      : multiply(worlds.get(deformer.id)!, partAffine);
  return transformAll(local, m);
}

/** A warp deformer's resolved control grid: rest + keyform offsets, then the
 *  parent's world affine — what its children sample. */
export function deformedGrid(
  model: IkiModel,
  deformerId: string,
  params: ParamValues = {},
): ResolvedWarpGrid {
  const store = storeFor(model, params);
  const deformers = model.deformers ?? [];
  const grid = resolveWarpGrids(
    deformers,
    store,
    resolveDeformerWorlds(deformers, store),
  ).get(deformerId);
  if (!grid) {
    throw new Error(
      `render-oracle: "${deformerId}" is not a warp deformer of this model`,
    );
  }
  return grid;
}

/**
 * The `createPixelGridMesh` lattice a part's rest mesh is — cols × rows cells
 * over w × h in part-local units, row 0 at the top — read back off its
 * vertices; the implicit quad is a 1 × 1 lattice over the unit square. Anything
 * else throws: the triangle split `landedXAt` interpolates over is only known
 * for this one mesh family.
 */
function latticeOf(part: IkiPart) {
  const v = part.mesh?.vertices ?? UNIT_QUAD;
  const n = v.length / 2;
  let cols = 0;
  while (cols + 1 < n && v[(cols + 1) * 2 + 1] === v[1]) cols++;
  const stride = cols + 1;
  const rows = n / stride - 1;
  const left = v[0];
  const top = v[1];
  const w = v[cols * 2] - left;
  const h = top - v[rows * stride * 2 + 1];
  const malformed = (why: string) =>
    new Error(
      `render-oracle: part "${part.id}" is not a createPixelGridMesh lattice (${why})`,
    );
  if (!Number.isInteger(rows) || rows < 1 || cols < 1 || w <= 0 || h <= 0) {
    throw malformed(`${n} vertices, ${cols} columns`);
  }
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const i = (r * stride + c) * 2;
      if (
        Math.abs(v[i] - (left + (c / cols) * w)) > 1e-6 ||
        Math.abs(v[i + 1] - (top - (r / rows) * h)) > 1e-6
      ) {
        throw malformed(`vertex ${i / 2} off its lattice position`);
      }
    }
  }
  // Every cell is split [BL, BR, TL] then [TL, BR, TR]; check it on the first.
  const idx = part.mesh?.indices;
  if (
    idx &&
    (idx[0] !== stride ||
      idx[1] !== stride + 1 ||
      idx[2] !== 0 ||
      idx[3] !== 0 ||
      idx[4] !== stride + 1 ||
      idx[5] !== 1)
  ) {
    throw malformed("unexpected triangle split");
  }
  return { cols, rows, stride, left, top, w, h };
}

/**
 * The rendered x of the point that sits at model-space `(restX, restY)` on the
 * part's REST geometry: barycentric over the landed vertices of the mesh
 * triangle containing it (`createPixelGridMesh`'s TL→BR split — the GPU is
 * linear over a triangle, never bilinear over a cell). A point outside the mesh
 * reads the end row / column with its fraction clamped, i.e. the landing of
 * the nearest boundary point, the same answer the solver gives a silhouette
 * point past the bangs' own crop.
 */
export function landedXAt(
  model: IkiModel,
  partId: string,
  restX: number,
  restY: number,
  params: ParamValues = {},
): number {
  const part = partOf(model, partId);
  const t = part.transform;
  // The rest point is taken back into the mesh's local frame through the
  // part's rest placement, which the generator writes as a translate alone.
  if (
    (t.rotation ?? 0) !== 0 ||
    (t.scaleX ?? 1) !== 1 ||
    (t.scaleY ?? 1) !== 1
  ) {
    throw new Error(
      `render-oracle: landedXAt reads a part placed by translate alone; "${partId}" rests rotated or scaled`,
    );
  }
  const g = latticeOf(part);
  // Lattice fractions: u along the columns (0 at the left edge), v down the
  // rows (0 at the top).
  const u = (((restX - t.x) / part.width - g.left) / g.w) * g.cols;
  const v = ((g.top - (restY - t.y) / part.height) / g.h) * g.rows;
  const col = Math.max(0, Math.min(g.cols - 1, Math.floor(u)));
  const row = Math.max(0, Math.min(g.rows - 1, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - col));
  const fy = Math.max(0, Math.min(1, v - row));
  const landed = landVertices(model, partId, params);
  const at = (r: number, c: number) => landed[(r * g.stride + c) * 2];
  const tl = at(row, col);
  const br = at(row + 1, col + 1);
  // The cell's diagonal runs TL→BR, so the lower-left triangle [BL, BR, TL]
  // is the one with fx <= fy.
  if (fx <= fy) {
    const bl = at(row + 1, col);
    return tl + fy * (bl - tl) + fx * (br - bl);
  }
  const tr = at(row, col + 1);
  return tl + fx * (tr - tl) + fy * (br - tr);
}

/** Mean rendered x of a part's vertices. */
export function landedCentroidX(
  model: IkiModel,
  partId: string,
  params: ParamValues = {},
): number {
  const landed = landVertices(model, partId, params);
  let sum = 0;
  for (let i = 0; i < landed.length; i += 2) sum += landed[i];
  return sum / (landed.length / 2);
}
