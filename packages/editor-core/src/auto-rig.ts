/**
 * Role table, role parsing, bbox→transform math, and model assembly for the
 * AI auto-rig generator. All pure functions — no DOM, no canvas, no
 * crypto.randomUUID.
 *
 * L/R = CHARACTER frame: *_L is the character's left = screen right.
 */

import {
  IKI_FORMAT_VERSION,
  StandardParameter,
  parseIkiModel,
  type IkiMesh,
  type IkiModel,
  type IkiPart,
} from "@iki/format";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoleSpec {
  /** Which deformer the part is attached to in the generated rig. */
  deformer: "faceWarp" | "headDeformer";
  /** Back-to-front draw order. Higher = in front. */
  order: number;
  /** Whether this part gets a warp mesh (true) or is a static quad (false). */
  mesh: boolean;
  /** Present only for eye-family roles. */
  eyeSide?: "L" | "R";
}

/**
 * Input contract from the host app to editor-core's auto-rig functions.
 * Passed in after the host has decoded PNGs, computed alpha bboxes, and
 * mapped filenames to canonical roles.
 */
export interface LayerInput {
  /** Canonical role, e.g. "eye_L". */
  role: string;
  /** Original file name — used in error messages and as a stable id. */
  fileName: string;
  /** Shared canvas width (all layers have the same canvas size). */
  canvasW: number;
  /** Shared canvas height. */
  canvasH: number;
  /** Alpha-tight bounding box, top-left origin, +y down (image coords). */
  bbox: { x: number; y: number; w: number; h: number };
  /** Cropped image width = bbox.w. */
  cropW: number;
  /** Cropped image height = bbox.h. */
  cropH: number;
}

// ── Role table ───────────────────────────────────────────────────────────────

/**
 * Single source of truth for every role the auto-rig generator understands.
 * Order values define back-to-front compositing (higher = in front).
 *
 * Eye-family roles use eyeSide to pair blink/gaze bindings correctly:
 *   eye_L = character's left eye = screen right side.
 *   eye_R = character's right eye = screen left side.
 */
export const ROLE_TABLE: Record<string, RoleSpec> = {
  hair_back: { deformer: "headDeformer", order: 0, mesh: false },
  face: { deformer: "faceWarp", order: 10, mesh: true },
  nose: { deformer: "faceWarp", order: 15, mesh: true },
  blush_L: { deformer: "faceWarp", order: 20, mesh: true },
  blush_R: { deformer: "faceWarp", order: 20, mesh: true },
  mouth: { deformer: "faceWarp", order: 25, mesh: true },
  eye_L: { deformer: "faceWarp", order: 30, mesh: true, eyeSide: "L" },
  eye_R: { deformer: "faceWarp", order: 30, mesh: true, eyeSide: "R" },
  iris_L: { deformer: "faceWarp", order: 31, mesh: true, eyeSide: "L" },
  iris_R: { deformer: "faceWarp", order: 31, mesh: true, eyeSide: "R" },
  pupil_L: { deformer: "faceWarp", order: 32, mesh: true, eyeSide: "L" },
  pupil_R: { deformer: "faceWarp", order: 32, mesh: true, eyeSide: "R" },
  highlight_L: { deformer: "faceWarp", order: 33, mesh: true, eyeSide: "L" },
  highlight_R: { deformer: "faceWarp", order: 33, mesh: true, eyeSide: "R" },
  brow_L: { deformer: "faceWarp", order: 40, mesh: true },
  brow_R: { deformer: "faceWarp", order: 40, mesh: true },
  hair_front: { deformer: "headDeformer", order: 50, mesh: false },
};

/**
 * Roles the generator requires. BOTH eyes are mandatory because the rig pairs
 * left/right blink parameters — a one-eyed rig would produce mismatched bindings.
 */
export const REQUIRED_ROLES = ["face", "eye_L", "eye_R", "mouth"] as const;

// ── Alias map ────────────────────────────────────────────────────────────────

/**
 * Minimal spelling-variant aliases → canonical role.
 * Only covers real-world variants; grow this only when you have evidence.
 */
const ALIAS_MAP: Record<string, string> = {
  eyebrow_L: "brow_L",
  eyebrow_R: "brow_R",
  eye_white_L: "eye_L",
  eye_white_R: "eye_R",
};

// ── normalizeRole ─────────────────────────────────────────────────────────────

/**
 * Convert a raw filename to a canonical role key:
 *   1. Strip file extension.
 *   2. Lowercase.
 *   3. Collapse hyphens and spaces to underscores.
 *   4. Uppercase a trailing `_l` or `_r` side suffix → `_L` / `_R`.
 *   5. Apply alias map for known spelling variants.
 *
 * Examples:
 *   "Eye-L.png"     → "eye_L"
 *   "Brow_R.png"    → "brow_R"
 *   "eyebrow_L.png" → "brow_L"
 */
export function normalizeRole(raw: string): string {
  // Strip extension
  const noExt = raw.replace(/\.[^.]+$/, "");
  // Lowercase, then collapse hyphens/spaces → underscores
  const collapsed = noExt.toLowerCase().replace(/[-\s]+/g, "_");
  // Uppercase trailing _l / _r side suffix
  const sided = collapsed.replace(
    /_([lr])$/,
    (_, s: string) => `_${s.toUpperCase()}`,
  );
  // Alias map
  return ALIAS_MAP[sided] ?? sided;
}

// ── assertRoleSet ─────────────────────────────────────────────────────────────

/**
 * Single home for the unknown/duplicate/required role contract. Takes CANONICAL
 * role names (already normalized). Throws on:
 *   - Unknown role (not in ROLE_TABLE)
 *   - Duplicate role
 *   - Missing required role
 *
 * The "unknown role" message from this function is fileName-free. That is
 * intentional: callers that lack a fileName (e.g. a future Task 2
 * `validateLayerInputs` that receives pre-normalized roles) get a useful error
 * without needing to pre-check. Callers that DO have the original fileName
 * (e.g. `parseLayerRoles`) pre-check unknown roles themselves so they can embed
 * the fileName in the message — but that pre-check is an enrichment, not a
 * requirement for correctness.
 */
export function assertRoleSet(roles: string[]): void {
  const seen = new Set<string>();
  for (const role of roles) {
    if (!(role in ROLE_TABLE)) {
      throw new Error(`auto-rig: unknown role "${role}"`);
    }
    if (seen.has(role)) {
      throw new Error(`auto-rig: duplicate role "${role}"`);
    }
    seen.add(role);
  }
  for (const required of REQUIRED_ROLES) {
    if (!seen.has(required)) {
      throw new Error(`auto-rig: missing required role "${required}"`);
    }
  }
}

// ── parseLayerRoles ───────────────────────────────────────────────────────────

/**
 * Map an array of raw filenames to canonical `{ role, fileName }` pairs.
 *
 * Steps:
 *   1. Normalize each filename → role (normalizeRole).
 *   2. Eagerly check each role against ROLE_TABLE — unknown roles throw early
 *      with the offending fileName included in the message.
 *   3. Call assertRoleSet to check duplicates + required roles.
 *
 * Throws a path-qualified Error on any contract violation.
 */
export function parseLayerRoles(
  fileNames: string[],
): { role: string; fileName: string }[] {
  const pairs = fileNames.map((fileName) => {
    const role = normalizeRole(fileName);
    if (!(role in ROLE_TABLE)) {
      throw new Error(
        `auto-rig: unknown role "${role}" from file "${fileName}"`,
      );
    }
    return { role, fileName };
  });

  assertRoleSet(pairs.map((p) => p.role));
  return pairs;
}

// ── bboxToTransform ───────────────────────────────────────────────────────────

/**
 * Convert an alpha bounding box (image coordinates, +y down, top-left origin)
 * to a model-space translation (model coordinates, +y up, canvas-center origin).
 *
 * x = bbox.x + bbox.w/2 - canvasW/2   (center of bbox relative to canvas center)
 * y = canvasH/2 - (bbox.y + bbox.h/2) (flip axis: image +y down → model +y up)
 *
 * Result is NOT rounded — fractional .5 values must be preserved to avoid
 * sub-pixel jitter in blink/gaze animations when the eye center falls between
 * two canvas pixels.
 *
 * @param partLabel Optional label for error messages (role or part id).
 */
export function bboxToTransform(
  bbox: { x: number; y: number; w: number; h: number },
  canvasW: number,
  canvasH: number,
  partLabel?: string,
): { x: number; y: number } {
  if (bbox.w <= 0 || bbox.h <= 0) {
    throw new Error(`auto-rig: empty bbox for ${partLabel ?? "layer"}`);
  }
  const x = bbox.x + bbox.w / 2 - canvasW / 2;
  const y = canvasH / 2 - (bbox.y + bbox.h / 2); // flip: image +y-down → model +y-up
  return { x, y };
}

// ── validateLayerInputs ───────────────────────────────────────────────────────

/**
 * Validate a LayerInput array before assembly. Called first inside
 * `generateIkiFromLayerSet` — the public API validates before deriving anything.
 *
 * Checks (in order):
 *   1. Non-empty layer list.
 *   2. Unknown/duplicate/required role contract via `assertRoleSet` (single home).
 *   3. Non-positive bbox.w, bbox.h, cropW, cropH per layer.
 *   4. Per-layer canvas size vs. the supplied `canvas` argument.
 *      Matching every layer to the `canvas` arg inherently guarantees all layers
 *      agree with each other — no separate peer-comparison loop is needed.
 *
 * Validates `layer.role` DIRECTLY (not via fileName). A caller could supply
 * `fileName:"face.png"` with `role:"bad_role"` — a filename check would miss it.
 *
 * Throws a plain `Error` with a path-qualified message on the first violation.
 */
export function validateLayerInputs(
  layers: LayerInput[],
  canvas: { width: number; height: number },
): void {
  if (layers.length === 0) {
    throw new Error("auto-rig: validateLayerInputs: layers must not be empty");
  }

  // Unknown / duplicate / required — single home for this contract
  assertRoleSet(layers.map((l) => l.role));

  for (const layer of layers) {
    const { role, bbox, cropW, cropH, canvasW, canvasH } = layer;
    if (bbox.w <= 0) {
      throw new Error(
        `auto-rig: validateLayerInputs: role "${role}" has non-positive bbox.w (${bbox.w})`,
      );
    }
    if (bbox.h <= 0) {
      throw new Error(
        `auto-rig: validateLayerInputs: role "${role}" has non-positive bbox.h (${bbox.h})`,
      );
    }
    if (cropW <= 0) {
      throw new Error(
        `auto-rig: validateLayerInputs: role "${role}" has non-positive cropW (${cropW})`,
      );
    }
    if (cropH <= 0) {
      throw new Error(
        `auto-rig: validateLayerInputs: role "${role}" has non-positive cropH (${cropH})`,
      );
    }
    if (canvasW !== canvas.width || canvasH !== canvas.height) {
      throw new Error(
        `auto-rig: validateLayerInputs: role "${role}" canvas size (${canvasW}×${canvasH}) does not match canvas arg (${canvas.width}×${canvas.height})`,
      );
    }
  }
}

// ── generateGridPoints ────────────────────────────────────────────────────────

/**
 * Generate the flat `[x0,y0, x1,y1, …]` rest-grid control points for a
 * regular axis-aligned lattice with `(cols+1)*(rows+1)` points, row-major.
 *
 * Row 0 is the TOP (y = maxY); y strictly decreases with row index.
 * Column 0 is left (x = minX); x strictly increases with column index.
 * This ordering satisfies `checkGridRegularity` in the format validator.
 *
 * Local copy — do NOT import the private `generateRegularGridPoints` from
 * factories.ts; that helper is private to editor-core's factory layer.
 */
export function generateGridPoints(
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

// ── createPixelGridMesh ───────────────────────────────────────────────────────

/**
 * Create a regular grid mesh in PIXEL space, with the local origin at the
 * crop center (matching the `feature(...)` convention in sample-model.ts).
 *
 * Callers set `part.width=1, part.height=1` so the engine's scale pipeline is
 * bypassed — the pixel coordinates ARE the final geometry, positioned only by
 * `part.transform`. scaleX/scaleY bindings then scale about each part's own
 * center without an additional unit-to-pixel conversion step.
 *
 * Vertices span x ∈ [-w/2, w/2] and y ∈ [-h/2, h/2] (+y up, engine convention).
 * Row 0 is the TOP of the grid (y = +h/2); row index increases downward.
 *
 * UVs are base unit-square coordinates: u = col/cols (0..1 left→right),
 * v = row/rows (0..1 top→bottom). Top row maps to v=0 (v and y run in
 * opposite directions — keeps textures upright). Atlas remapping is the
 * caller's responsibility (e.g. applyAtlas), not done here.
 *
 * Index winding per cell: [BL, BR, TL] then [TL, BR, TR] — same as
 * `createGridMesh` in factories.ts so the engine's implicit-quad convention
 * is preserved.
 */
export function createPixelGridMesh(
  cols: number,
  rows: number,
  w: number,
  h: number,
): IkiMesh {
  const colVerts = cols + 1;
  const rowVerts = rows + 1;

  const vertices: number[] = [];
  const uvs: number[] = [];

  // Row 0 = TOP (y = +h/2). Row `rows` = BOTTOM (y = -h/2).
  // Col 0 = left (x = -w/2). Col `cols` = right (x = +w/2).
  for (let row = 0; row < rowVerts; row++) {
    const t = row / rows;
    const y = h / 2 - t * h; // +h/2 at row 0, -h/2 at row `rows`
    const v = t; // 0 at top, 1 at bottom

    for (let col = 0; col < colVerts; col++) {
      const s = col / cols;
      const x = -w / 2 + s * w; // -w/2 at col 0, +w/2 at col `cols`
      const u = s; // 0 at left, 1 at right

      vertices.push(x, y);
      uvs.push(u, v);
    }
  }

  // Two triangles per cell: [BL, BR, TL] then [TL, BR, TR]
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

// ── generateIkiFromLayerSet ───────────────────────────────────────────────────

/**
 * First-pass auto-rig: given decoded layer inputs and the shared canvas size,
 * produce a valid IkiModel ready for parseIkiModel.
 *
 * Scope of this first pass:
 *   - Validate all inputs before deriving anything.
 *   - Place parts at source-derived positions (bboxToTransform, unshifted).
 *   - Emit the 8 standard parameters verbatim (same ids/ranges as sample-model.ts).
 *   - Build minimal-valid headDeformer (matrix) and faceWarp (warp, 4×4) deformers.
 *   - Mesh parts (spec.mesh===true) → width:1, height:1, pixel grid mesh 4×4.
 *   - Static parts (spec.mesh===false) → width:cropW, height:cropH, no mesh.
 *   - Part ids equal the role string (deterministic, no crypto.randomUUID).
 *   - Return parseIkiModel(structuredClone(model)) — every caller gets a
 *     validated model; bad assembly fails loudly.
 *
 * Full grid pivot, bake, and parameter bindings are added in Task 3.
 */
export function generateIkiFromLayerSet(
  layers: LayerInput[],
  canvas: { width: number; height: number },
): IkiModel {
  // Validate first — never derive anything from unchecked input.
  validateLayerInputs(layers, canvas);

  // ── Standard parameters — verbatim from sample-model.ts ──────────────────
  const parameters = [
    {
      id: StandardParameter.MouthOpen,
      name: "Mouth Open",
      min: 0,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.MouthForm,
      name: "Mouth Form",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.EyeOpenLeft,
      name: "Eye L",
      min: 0,
      max: 1,
      default: 1,
    },
    {
      id: StandardParameter.EyeOpenRight,
      name: "Eye R",
      min: 0,
      max: 1,
      default: 1,
    },
    {
      id: StandardParameter.EyeballX,
      name: "Gaze X",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.EyeballY,
      name: "Gaze Y",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.AngleX,
      name: "Head Angle",
      min: -30,
      max: 30,
      default: 0,
    },
    {
      id: StandardParameter.Breath,
      name: "Breath",
      min: 0,
      max: 1,
      default: 0,
    },
  ];

  // ── Compute faceWarp grid bounds ──────────────────────────────────────────
  // Collect all faceWarp-assigned layers so the warp grid spans a generous
  // box that encloses all children. Warp children require a mesh — all
  // faceWarp-assigned roles in ROLE_TABLE have spec.mesh===true.
  const faceWarpLayers = layers.filter(
    (l) => ROLE_TABLE[l.role].deformer === "faceWarp",
  );

  // If for some reason no faceWarp layers exist, fall back to a generous box.
  let gridMinX = -canvas.width / 2;
  let gridMaxX = canvas.width / 2;
  let gridMinY = -canvas.height / 2;
  let gridMaxY = canvas.height / 2;

  if (faceWarpLayers.length > 0) {
    const transforms = faceWarpLayers.map((l) =>
      bboxToTransform(l.bbox, l.canvasW, l.canvasH, l.role),
    );
    const halfWs = faceWarpLayers.map((l) => l.cropW / 2);
    const halfHs = faceWarpLayers.map((l) => l.cropH / 2);

    // Compute tight bbox in model space, then add a 20% margin.
    const tightMinX = Math.min(...transforms.map((t, i) => t.x - halfWs[i]));
    const tightMaxX = Math.max(...transforms.map((t, i) => t.x + halfWs[i]));
    const tightMinY = Math.min(...transforms.map((t, i) => t.y - halfHs[i]));
    const tightMaxY = Math.max(...transforms.map((t, i) => t.y + halfHs[i]));

    const marginX = (tightMaxX - tightMinX) * 0.2;
    const marginY = (tightMaxY - tightMinY) * 0.2;
    gridMinX = tightMinX - marginX;
    gridMaxX = tightMaxX + marginX;
    gridMinY = tightMinY - marginY;
    gridMaxY = tightMaxY + marginY;
  }

  // ── Deformers ─────────────────────────────────────────────────────────────
  const deformers = [
    // headDeformer: rigid matrix; no bindings in this first pass
    {
      id: "headDeformer",
      pivot: { x: 0, y: 0 },
    },
    // faceWarp: warp child of headDeformer; grid spans all faceWarp children
    // Task 3 replaces: real union grid + center-relative bake
    {
      kind: "warp" as const,
      id: "faceWarp",
      parent: "headDeformer",
      grid: {
        cols: 4,
        rows: 4,
        points: generateGridPoints(
          4,
          4,
          gridMinX,
          gridMaxX,
          gridMinY,
          gridMaxY,
        ),
      },
    },
  ];

  // ── Parts ─────────────────────────────────────────────────────────────────
  const parts: IkiPart[] = layers.map((layer) => {
    const { role, bbox, cropW, cropH, canvasW, canvasH } = layer;
    const spec = ROLE_TABLE[role];
    const t = bboxToTransform(bbox, canvasW, canvasH, role);

    if (spec.mesh) {
      // Warp-deformer child: width:1, height:1 with a pixel grid mesh centered
      // at the crop center. The engine applies the part transform to position it.
      return {
        id: role,
        color: [1, 1, 1, 1] as [number, number, number, number],
        width: 1,
        height: 1,
        order: spec.order,
        transform: t,
        deformer: spec.deformer,
        mesh: createPixelGridMesh(4, 4, cropW, cropH),
      };
    } else {
      // Static quad: no mesh, sized to the crop. Placed on headDeformer.
      return {
        id: role,
        color: [1, 1, 1, 1] as [number, number, number, number],
        width: cropW,
        height: cropH,
        order: spec.order,
        transform: t,
        deformer: spec.deformer,
      };
    }
  });

  const model = {
    version: IKI_FORMAT_VERSION,
    name: "Auto-Rigged Model",
    canvas: { width: canvas.width, height: canvas.height },
    textures: [],
    parameters,
    deformers,
    parts,
  };

  // Gate: run through parseIkiModel so bad assembly fails loudly at the source.
  // structuredClone prevents the validator's normalizing output from aliasing
  // the local object, and ensures the returned model is fully independent.
  return parseIkiModel(structuredClone(model));
}
