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
  type IkiBinding,
  type IkiGridWarp,
  type IkiMesh,
  type IkiModel,
  type IkiPart,
  type IkiWarp,
  type IkiWarpGrid,
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
  // hair_back stays rigid (silhouette behind the face); per-layer front/back
  // depth parallax is a later slice.
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
  // Upper lashes: an OPTIONAL separate layer ABOVE the iris that folds down to
  // the closed-eye seam (the same crease the white folds to), covering the cut
  // eyeball cleanly. When absent, the white's own fold is the only closed line.
  lash_L: { deformer: "faceWarp", order: 34, mesh: true, eyeSide: "L" },
  lash_R: { deformer: "faceWarp", order: 34, mesh: true, eyeSide: "R" },
  brow_L: { deformer: "faceWarp", order: 40, mesh: true },
  brow_R: { deformer: "faceWarp", order: 40, mesh: true },
  // Front hair rides faceWarp (mesh) so it follows the head-turn curvature with
  // the face instead of detaching as a rigid blob; its bbox joins the faceWarp
  // grid union so the grid covers it.
  hair_front: { deformer: "faceWarp", order: 50, mesh: true },
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

// ── bakeHeadTurnGridWarpCentered ──────────────────────────────────────────────

/**
 * Bake a cylinder head-turn grid warp for ParamAngleX, center-relative.
 *
 * WHY a cylinder: rotating a flat face mesh looks right head-on but the
 * silhouette doesn't narrow at the sides; projecting each point onto a
 * cylinder and rotating makes the face foreshorten naturally as it turns.
 *
 * HOW (center-relative): the cylinder axis sits at `centerX` (the face center
 * in model space). Each grid point at absolute x has local x = x - centerX,
 * which maps onto the cylinder. After rotating by theta, the new absolute x is:
 *   xPrime = centerX + RADIUS * sin(asin(localX/RADIUS) + theta)
 *   dx = xPrime - x,  dy = 0
 *
 * At theta=0 the center keyform is all-zero (xPrime === x by identity).
 *
 * RADIUS is derived from the grid's own half-width (same 0.6/0.5 margin ratio
 * as bakeHeadTurnGridWarp in the editor example) so asin stays clear of ±1.
 *
 * NOTE: Copy (not import) of the example's bakeHeadTurnGridWarp — editor-core
 * must not depend on the examples directory.
 */
export function bakeHeadTurnGridWarpCentered(
  grid: IkiWarpGrid,
  parameter: string,
  centerX: number,
): IkiGridWarp {
  // Keyform stops (degrees) match ParamAngleX's −30..30 range.
  const ANGLES = [-30, 0, 30] as const;
  // Cylinder radius in MODEL units, derived from the grid's symmetric half-width.
  // Same 0.6/0.5 margin ratio as the local mesh bake — keeps asin clear of ±1.
  const halfWidth = (grid.points[grid.cols * 2] - grid.points[0]) / 2;
  const RADIUS = halfWidth * (0.6 / 0.5);

  const pointCount = grid.points.length / 2;
  const DEG_TO_RAD = Math.PI / 180;

  const keyforms = ANGLES.map((angleDeg) => {
    const theta = angleDeg * DEG_TO_RAD;
    const offsets: number[] = [];

    for (let i = 0; i < pointCount; i++) {
      const x = grid.points[i * 2];
      const localX = x - centerX;
      // Clamp localX/RADIUS to [-1,1] to keep asin defined at boundary points.
      const alpha = Math.asin(Math.max(-1, Math.min(1, localX / RADIUS)));
      const xPrime = centerX + RADIUS * Math.sin(alpha + theta);
      const dx = xPrime - x;
      // dy is zero — cylinder bend only deforms horizontal position.
      offsets.push(dx, 0);
    }

    return { value: angleDeg, offsets };
  });

  // keyforms are sorted ascending by construction (ANGLES = [-30, 0, 30]).
  return { parameter, keyforms };
}

// ── bindingsForRole ───────────────────────────────────────────────────────────

// Role prefixes that belong to the eye stack (blink + optional gaze bindings).
// Hoisted to module scope so it is not reallocated on every bindingsForRole call.
const EYE_STACK_PREFIXES = ["eye_", "iris_", "pupil_", "highlight_"] as const;

/**
 * Derive the IkiBinding[] for a part from its role spec and crop dimensions.
 *
 * - face, hair_back, blush, nose → no bindings
 * - brow_L/R: BrowLeftY/RightY translateY (raise/lower) + BrowLeftAngle/RightAngle rotate
 *     (each brow rotates its own, CCW-positive)
 * - eye-stack:
 *     iris_/pupil_/highlight_ → gaze translateX + translateY (no blink binding)
 *     eye_ (white) → none here; its blink is a fold warp attached in assembly,
 *       and iris/pupil/highlight clip to it so the closing white CUTS them away
 * - mouth: MouthOpen scaleY (0 to 3) + MouthForm scaleX (-0.2 to 0.4)
 *
 * Returns [] when the role has no bindings (callers skip the bindings key when
 * the array is empty).
 */
export function bindingsForRole(
  spec: RoleSpec,
  role: string,
  cropW: number,
  cropH: number,
): IkiBinding[] {
  const isEyeStack = EYE_STACK_PREFIXES.some((p) => role.startsWith(p));

  if (isEyeStack && spec.eyeSide !== undefined) {
    // Only iris/pupil/highlight move with gaze; the white (eye_) gets nothing.
    const isGazeRole =
      role.startsWith("iris_") ||
      role.startsWith("pupil_") ||
      role.startsWith("highlight_");
    if (!isGazeRole) return [];

    // Gaze range: proportional to crop size, capped to avoid over-travel.
    const gx = Math.min(cropW * 0.18, 22);
    const gy = Math.min(cropH * 0.18, 16);
    return [
      {
        parameter: StandardParameter.EyeballX,
        channel: "translateX",
        from: -gx,
        to: gx,
      },
      {
        parameter: StandardParameter.EyeballY,
        channel: "translateY",
        from: -gy,
        to: gy,
      },
    ];
  }

  if (role === "mouth") {
    return [
      // Mouth open: scaleY from 0 (closed, param=0) to 3 (wide open, param=1).
      {
        parameter: StandardParameter.MouthOpen,
        channel: "scaleY",
        from: 0,
        to: 3,
      },
      // Mouth form: scaleX from -0.2 (pursed, param=-1) to 0.4 (wide, param=1).
      {
        parameter: StandardParameter.MouthForm,
        channel: "scaleX",
        from: -0.2,
        to: 0.4,
      },
    ];
  }

  if (role === "brow_L" || role === "brow_R") {
    // Raise/lower capped to avoid over-travel; tilt is a fixed ±12° range.
    const ty = Math.min(cropH * 0.8, 18);
    const deg = 12;
    if (role === "brow_L") {
      return [
        {
          parameter: StandardParameter.BrowLeftY,
          channel: "translateY",
          from: -ty,
          to: ty,
        },
        {
          parameter: StandardParameter.BrowLeftAngle,
          channel: "rotate",
          from: -deg,
          to: deg,
        },
      ];
    } else {
      return [
        {
          parameter: StandardParameter.BrowRightY,
          channel: "translateY",
          from: -ty,
          to: ty,
        },
        {
          parameter: StandardParameter.BrowRightAngle,
          channel: "rotate",
          from: -deg,
          to: deg,
        },
      ];
    }
  }

  // face, blush_*, nose, hair_* → no bindings
  return [];
}

// ── bakeEyelidFoldWarp ─────────────────────────────────────────────────────

/** Crease sits this fraction of the eye height BELOW the white's center, and the
 *  white keeps this fraction of its height when fully closed (a thin band, not 0
 *  so the lash texture in the white art doesn't crush to a single aliased row). */
const EYELID_FOLD_CREASE = 0.15;
const EYELID_FOLD_K = 0.04;
/** The lash keeps a thicker band than the white when closed, so it reads as a
 *  visible dark closed-eye line and covers the cut eyeball/seam. */
const LASH_FOLD_K = 0.2;

/**
 * Live2D-style eyelid FOLD blink for the eye-white. Two EyeOpen keyforms collapse
 * the white toward a crease line `creaseOffsetY` below its center while scaling
 * its height by `k`: as EyeOpen → 0 the white folds shut. Because iris/pupil/
 * highlight CLIP to the white, the closing clip region CUTS the (static, round)
 * iris away instead of squashing it — unlike the old scaleY-collapse blink.
 * EyeOpen=1 → rest (zero offsets = the authored open art); =0 → folded.
 *
 * Offsets are authored in the mesh's own pixel frame (+y up, centered), matching
 * `createPixelGridMesh`, so the SAME mesh must be passed that the part renders.
 */
export function bakeEyelidFoldWarp(
  mesh: IkiMesh,
  parameter: string,
  creaseOffsetY: number,
  k: number,
): IkiWarp {
  const closed: number[] = [];
  const zeros: number[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    const vy = mesh.vertices[i + 1];
    // closed y = creaseOffsetY + vy*k  →  dy added to the rest vertex vy.
    closed.push(0, creaseOffsetY - (1 - k) * vy);
    zeros.push(0, 0);
  }
  return {
    parameter,
    keyforms: [
      { value: 0, offsets: closed },
      { value: 1, offsets: zeros },
    ],
  };
}

// ── generateIkiFromLayerSet ───────────────────────────────────────────────────

/**
 * Auto-rig: given decoded layer inputs and the shared canvas size, produce a
 * valid IkiModel ready for parseIkiModel.
 *
 *   - Validate all inputs before deriving anything.
 *   - Place parts at source-derived positions (bboxToTransform, unshifted).
 *   - Emit the 12 standard parameters verbatim (same ids/ranges as sample-model.ts).
 *   - Build headDeformer (matrix, neck pivot, AngleX+Breath bindings) and faceWarp
 *     (warp, 4×4, baked cylinder warp center-relative on faceCenterX).
 *   - Mesh parts (spec.mesh===true) → width:1, height:1, pixel grid mesh 4×4 + role bindings.
 *   - Static parts (spec.mesh===false) → width:cropW, height:cropH, no mesh.
 *   - Part ids equal the role string (deterministic, no crypto.randomUUID).
 *   - Return parseIkiModel(structuredClone(model)) — every caller gets a
 *     validated model; bad assembly fails loudly.
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
    {
      id: StandardParameter.BrowLeftY,
      name: "Brow L Y",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.BrowRightY,
      name: "Brow R Y",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.BrowLeftAngle,
      name: "Brow L Angle",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.BrowRightAngle,
      name: "Brow R Angle",
      min: -1,
      max: 1,
      default: 0,
    },
  ];

  // ── Face layer: derive center and crop for pivot + grid ───────────────────
  const faceLayers = layers.filter((l) => l.role === "face");
  // validateLayerInputs guarantees "face" is present — safe to assert here.
  const faceLayer = faceLayers[0]!;
  const faceTransform = bboxToTransform(
    faceLayer.bbox,
    faceLayer.canvasW,
    faceLayer.canvasH,
    "face",
  );
  // faceCenterX: source-placed face center in model space (unshifted).
  const faceCenterX = faceTransform.x;
  const faceCropH = faceLayer.cropH;

  // ── Union bbox of all faceWarp-child layers (model space) ─────────────────
  // All faceWarp-assigned roles have spec.mesh===true (validated by ROLE_TABLE).
  // Each child's model-space extent: transform.{x,y} ± cropW/2, cropH/2
  // (centered pixel mesh convention — part.transform is the crop center).
  const faceWarpLayers = layers.filter(
    (l) => ROLE_TABLE[l.role].deformer === "faceWarp",
  );

  // Fall back to a full-canvas box only when no faceWarp layers exist (shouldn't
  // happen given required roles, but guards against future role-table changes).
  let unionMinX = -canvas.width / 2;
  let unionMaxX = canvas.width / 2;
  let unionMinY = -canvas.height / 2;
  let unionMaxY = canvas.height / 2;

  if (faceWarpLayers.length > 0) {
    const transforms = faceWarpLayers.map((l) =>
      bboxToTransform(l.bbox, l.canvasW, l.canvasH, l.role),
    );

    unionMinX = Math.min(
      ...transforms.map((t, i) => t.x - faceWarpLayers[i].cropW / 2),
    );
    unionMaxX = Math.max(
      ...transforms.map((t, i) => t.x + faceWarpLayers[i].cropW / 2),
    );
    unionMinY = Math.min(
      ...transforms.map((t, i) => t.y - faceWarpLayers[i].cropH / 2),
    );
    unionMaxY = Math.max(
      ...transforms.map((t, i) => t.y + faceWarpLayers[i].cropH / 2),
    );

    // Expand by 12% margin on each side so no child vertex lands on the grid
    // boundary and gets clamped by bindPointToRestGrid.
    const spanX = unionMaxX - unionMinX;
    const spanY = unionMaxY - unionMinY;
    const MARGIN = 0.12;
    unionMinX -= spanX * MARGIN;
    unionMaxX += spanX * MARGIN;
    unionMinY -= spanY * MARGIN;
    unionMaxY += spanY * MARGIN;
  }

  // ── faceWarp grid: symmetric about faceCenterX, spanning the margined union ─
  // Symmetric x so the cylinder axis aligns exactly with the face center.
  // halfW is the larger of the two distances from faceCenterX to the union edges,
  // ensuring the symmetric range [faceCenterX-halfW, faceCenterX+halfW] encloses
  // every child. y-range uses the margined union directly (not symmetric).
  const halfW = Math.max(faceCenterX - unionMinX, unionMaxX - faceCenterX);
  const faceGridMinX = faceCenterX - halfW;
  const faceGridMaxX = faceCenterX + halfW;

  const faceGrid = {
    cols: 4,
    rows: 4,
    points: generateGridPoints(
      4,
      4,
      faceGridMinX,
      faceGridMaxX,
      unionMinY,
      unionMaxY,
    ),
  };

  // ── headDeformer pivot (neck): slightly below the face bottom ─────────────
  // faceBottom is the model-space y of the bottom edge of the face crop.
  // The neck pivot sits 15% of the face crop height below the face bottom.
  const faceBottom = faceTransform.y - faceCropH / 2;
  const neckPivot = {
    x: faceCenterX,
    y: faceBottom - faceCropH * 0.15, // 15% below face bottom = neck
  };

  // ── Bake center-relative head-turn cylinder warp ──────────────────────────
  const faceWarpBake = bakeHeadTurnGridWarpCentered(
    faceGrid,
    StandardParameter.AngleX,
    faceCenterX,
  );

  // ── Deformers ─────────────────────────────────────────────────────────────
  const deformers = [
    // headDeformer: rigid matrix rotating/translating the whole head about the
    // neck pivot; bindings mirror sample-model.ts exactly.
    {
      id: "headDeformer",
      pivot: neckPivot,
      bindings: [
        {
          parameter: StandardParameter.AngleX,
          channel: "rotate" as const,
          from: 6,
          to: -6,
        },
        {
          parameter: StandardParameter.AngleX,
          channel: "translateX" as const,
          from: -50,
          to: 50,
        },
        {
          parameter: StandardParameter.Breath,
          channel: "translateY" as const,
          from: 0,
          to: -12,
        },
      ],
    },
    // faceWarp: cylinder-bend warp parented to headDeformer; grid is symmetric
    // about faceCenterX so the bake's cylinder axis aligns with the face center.
    {
      kind: "warp" as const,
      id: "faceWarp",
      parent: "headDeformer",
      grid: faceGrid,
      warps: [faceWarpBake],
    },
  ];

  // ── Shared closed-eye crease per side ─────────────────────────────────────
  // The white AND the lash fold to the SAME seam (derived from the eye-white
  // center), so the lash lands on top of the cut eyeball and covers it.
  const eyeCreaseBySide: Partial<Record<"L" | "R", number>> = {};
  for (const layer of layers) {
    const side = ROLE_TABLE[layer.role].eyeSide;
    if ((layer.role === "eye_L" || layer.role === "eye_R") && side) {
      const ey = bboxToTransform(
        layer.bbox,
        layer.canvasW,
        layer.canvasH,
        layer.role,
      ).y;
      eyeCreaseBySide[side] = ey - EYELID_FOLD_CREASE * layer.cropH;
    }
  }

  // ── Parts ─────────────────────────────────────────────────────────────────
  const parts: IkiPart[] = layers.map((layer) => {
    const { role, bbox, cropW, cropH, canvasW, canvasH } = layer;
    const spec = ROLE_TABLE[role];
    const t = bboxToTransform(bbox, canvasW, canvasH, role);
    const roleBindings = bindingsForRole(spec, role, cropW, cropH);

    if (spec.mesh) {
      // Warp-deformer child: width:1, height:1 with a pixel grid mesh centered
      // at the crop center. The engine applies the part transform to position it.
      const mesh = createPixelGridMesh(4, 4, cropW, cropH);
      const part: IkiPart = {
        id: role,
        color: [1, 1, 1, 1] as [number, number, number, number],
        width: 1,
        height: 1,
        order: spec.order,
        transform: t,
        deformer: spec.deformer,
        mesh,
      };
      if (roleBindings.length > 0) {
        part.bindings = roleBindings;
      }
      // Eye blink = fold: the white (eye_) and the lash (lash_) fold shut via a
      // warp toward the shared crease; iris/pupil/highlight clip to the white, so
      // the closing white CUTS them away (round, not squashed) and the lash lands
      // on top to cover the seam. The white is a required role (clip mask exists).
      if (spec.eyeSide !== undefined) {
        const isLash = role.startsWith("lash_");
        if (role.startsWith("eye_") || isLash) {
          const openParam =
            spec.eyeSide === "L"
              ? StandardParameter.EyeOpenLeft
              : StandardParameter.EyeOpenRight;
          const creaseWorldY =
            eyeCreaseBySide[spec.eyeSide] ?? t.y - EYELID_FOLD_CREASE * cropH;
          part.warps = [
            bakeEyelidFoldWarp(
              mesh,
              openParam,
              creaseWorldY - t.y,
              isLash ? LASH_FOLD_K : EYELID_FOLD_K,
            ),
          ];
        } else {
          part.clip = { masks: [`eye_${spec.eyeSide}`] };
        }
      }
      return part;
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
