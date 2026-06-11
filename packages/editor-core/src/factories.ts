import type {
  IkiMatrixDeformer,
  IkiMesh,
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
 * Create a regular grid mesh in part LOCAL space (±0.5 unit frame).
 *
 * Vertices span x ∈ [-0.5, 0.5] and y ∈ [-0.5, 0.5] (+y up, engine convention).
 * Row 0 is the TOP of the grid (y = +0.5); row index increases downward.
 * UVs are unit-square base coordinates: u = col/cols (0..1 left→right),
 * v = row/rows (0..1 top→bottom). The top row maps to v=0 because v and y
 * run in opposite directions — keeps textures upright without a post-flip.
 * The UV-to-texture remap (atlas rect) is applied later in SetPartMesh, not here.
 *
 * Index winding per cell: [BL, BR, TL] then [TL, BR, TR], matching the engine's
 * implicit-quad convention (see examples/editor/src/mesh-generator.ts).
 *
 * Bounds are validated BEFORE any array allocation because this factory runs
 * before SetPartMesh's parseIkiModel — an unbounded count would freeze the
 * editor before the format-level 65536 limit is ever reached.
 */
export function createGridMesh(cols: number, rows: number): IkiMesh {
  // Guard: cols/rows must be integers ≥1 and the vertex count must fit within
  // the format limit of 65536 vertices (packages/format/src/validate.ts parseMesh).
  if (
    !Number.isInteger(cols) ||
    cols < 1 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    (cols + 1) * (rows + 1) > 65536
  ) {
    throw new Error(
      "createGridMesh: cols and rows must be integers >= 1 with (cols+1)*(rows+1) <= 65536",
    );
  }

  const colVerts = cols + 1;
  const rowVerts = rows + 1;

  const vertices: number[] = [];
  const uvs: number[] = [];

  // Row 0 is TOP (y = +0.5). Row `rows` is BOTTOM (y = -0.5).
  // Column 0 is left (x = -0.5). Column `cols` is right (x = +0.5).
  for (let row = 0; row < rowVerts; row++) {
    const t = row / rows;
    const y = 0.5 - t; // +0.5 at row 0, -0.5 at row `rows`
    const v = t; // 0 at top row, 1 at bottom row

    for (let col = 0; col < colVerts; col++) {
      const s = col / cols;
      const x = -0.5 + s; // -0.5 at col 0, +0.5 at col `cols`
      const u = s; // 0 at left col, 1 at right col

      vertices.push(x, y);
      uvs.push(u, v);
    }
  }

  // Two triangles per cell: [BL, BR, TL] then [TL, BR, TR].
  const indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tl = row * colVerts + col;
      const tr = row * colVerts + col + 1;
      const bl = (row + 1) * colVerts + col;
      const br = (row + 1) * colVerts + col + 1;

      indices.push(bl, br, tl);
      indices.push(tl, br, tr);
    }
  }

  return { vertices, uvs, indices };
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
