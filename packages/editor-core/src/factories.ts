import type {
  IkiMatrixDeformer,
  IkiModel,
  IkiPart,
  IkiWarpDeformer,
} from "@iki/format";

/**
 * Pure, DOM-free factory helpers for creating new model objects from scratch.
 * Kept separate from `commands.ts` (which is edit-only) so that the "add item"
 * use-case has a dedicated, testable home with no mutation concerns.
 *
 * All factories accept the live model so they can derive a collision-free id and
 * a sensible draw-order / grid span without hard-coding sample assumptions.
 */

/**
 * Return the first collision-free id in the shared part+deformer namespace.
 * Parts and deformers share a flat id namespace (validate.ts:692-706), so we
 * scan both arrays. Returns `base` if unused; otherwise tries `${base}_2`,
 * `${base}_3`, … until a free slot is found.
 *
 * Parameters are a separate namespace and are NOT included in the scan.
 */
function generateUniqueId(model: IkiModel, base: string): string {
  const used = new Set<string>();
  for (const p of model.parts) {
    used.add(p.id);
  }
  for (const d of model.deformers ?? []) {
    used.add(d.id);
  }

  if (!used.has(base)) return base;

  let n = 2;
  while (true) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
    n++;
  }
}

/**
 * Generate the flat `[x0,y0, x1,y1, …]` rest-grid control points for a
 * regular axis-aligned lattice with `(cols+1)*(rows+1)` points, row-major.
 *
 * Row 0 is the TOP (y = maxY); y strictly decreases with row index.
 * Column 0 is left (x = minX); x strictly increases with column index.
 * This ordering satisfies the `IkiWarpGrid` rest-grid invariant
 * (packages/format/src/types.ts:178-196) required by the validator and
 * the engine's grid-sampling code.
 */
function generateRegularGridPoints(
  cols: number,
  rows: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): number[] {
  const pts: number[] = [];
  for (let row = 0; row <= rows; row++) {
    const t = row / rows;
    const y = maxY - t * (maxY - minY); // maxY at row 0, minY at row `rows`
    for (let col = 0; col <= cols; col++) {
      const s = col / cols;
      const x = minX + s * (maxX - minX); // minX at col 0, maxX at col `cols`
      pts.push(x, y);
    }
  }
  return pts;
}

/**
 * Create a minimal valid part with a collision-free id and a paint order one
 * above the current top-most part so it is immediately visible in the viewport.
 * Uses a distinct non-white blue tint so it is distinguishable from the canvas
 * background without requiring a texture.
 *
 * No optional keys (`texture`, `mesh`, `deformer`, `bindings`, `warps`) are set
 * — the format treats all of them as absent by default.
 */
export function createDefaultPart(model: IkiModel): IkiPart {
  const order = model.parts.length
    ? Math.max(...model.parts.map((p) => p.order)) + 1
    : 0;

  return {
    id: generateUniqueId(model, "part"),
    color: [0.45, 0.6, 0.85, 1],
    width: 150,
    height: 150,
    transform: { x: 0, y: 0 },
    order,
  };
}

/**
 * Create a minimal valid matrix deformer rooted at the canvas origin.
 * `kind` is omitted because the format treats its absence as "matrix" (the
 * default), keeping the serialised model compact.
 */
export function createDefaultMatrixDeformer(
  model: IkiModel,
): IkiMatrixDeformer {
  return {
    id: generateUniqueId(model, "deformer"),
    pivot: { x: 0, y: 0 },
  };
}

/**
 * Create a 4×4-cell warp deformer whose rest grid spans a quarter of the
 * canvas in each direction (`±canvas.width/4` × `±canvas.height/4`). For the
 * 1000-unit sample canvas this gives x,y ∈ [−250, 250], which is large enough
 * to cover a typical face part without spilling to the edge.
 *
 * `warps` is omitted — the format treats its absence as "rest grid only", so
 * the deformer is immediately usable without authored keyforms.
 * `parent` is omitted — the deformer is placed at root; the caller may
 * reparent it via `SetDeformerParent` after creation.
 */
export function createDefaultWarpDeformer(model: IkiModel): IkiWarpDeformer {
  const hx = model.canvas.width / 4;
  const hy = model.canvas.height / 4;

  return {
    kind: "warp",
    id: generateUniqueId(model, "warp"),
    grid: {
      cols: 4,
      rows: 4,
      points: generateRegularGridPoints(4, 4, -hx, hx, -hy, hy),
    },
  };
}
