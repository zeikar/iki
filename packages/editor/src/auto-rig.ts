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
  type IkiGrid2DWarp,
  type IkiGridWarp,
  type IkiMesh,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiWarp,
  type IkiWarpGrid,
} from "@ikijs/format";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoleSpec {
  /**
   * Which deformer the part is attached to in the generated rig. `"none"`
   * attaches it to nothing, so it holds still in world space; no shipped
   * role uses it.
   */
  deformer: "faceWarp" | "headDeformer" | "bodyDeformer" | "none";
  /** Back-to-front draw order. Higher = in front. */
  order: number;
  /** Whether this part gets a warp mesh (true) or is a static quad (false). */
  mesh: boolean;
  /** Present only for eye-family roles. */
  eyeSide?: "L" | "R";
}

/**
 * Input contract from the host app to this package's auto-rig functions.
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
  // The silhouette behind the face. It rides the rigid head (not faceWarp,
  // whose grid it would stretch across the shoulders) as a MESH: it bends on
  // the turn through its own part warp (bakeHairBackTurnWarp) and swings its
  // ends on the hair-sway warps.
  hair_back: { deformer: "headDeformer", order: 0, mesh: true },
  // The torso. It rides its own rigid deformer, not the head's: the head turns
  // about the neck pivot while the shoulders follow at BODY_TURN_FOLLOW and
  // follow the head's breath bob, which is what keeps the character from
  // reading as a floating head. Drawn over the back hair so long hair falls
  // behind the shoulders.
  body: { deformer: "bodyDeformer", order: 5, mesh: false },
  face: { deformer: "faceWarp", order: 10, mesh: true },
  nose: { deformer: "faceWarp", order: 15, mesh: true },
  blush_L: { deformer: "faceWarp", order: 20, mesh: true },
  blush_R: { deformer: "faceWarp", order: 20, mesh: true },
  mouth: { deformer: "faceWarp", order: 25, mesh: true },
  // An OPTIONAL second mouth drawing, open. When present the two cross-fade on
  // MouthOpen instead of the closed one being stretched, which is the
  // difference between a portrait rig and one that can lip-sync.
  mouth_open: { deformer: "faceWarp", order: 26, mesh: true },
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
 * intentional: callers that lack a fileName (e.g. a future
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
 * factories.ts; that helper is private to this package's factory layer.
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

// ── Mesh density ─────────────────────────────────────────────────────────────

/** Target size of one mesh cell. A part's vertices sample the face-warp grid
 *  (and its own per-vertex warps) at this spacing; the GPU is linear between
 *  them, so the spacing bounds how smooth a bend can render. 64 px puts two
 *  vertices per FACE_GRID_CELLS cell on the hero and eight rows on the back
 *  hair for the sway curl. */
const MESH_CELL_PX = 64;
/** Cell-count floor / ceiling per axis: small parts stay at 4×4 (their
 *  bakes fold/collapse them, they never bend), a canvas-spanning layer is
 *  capped at 81 vertices so per-vertex warps stay cheap. */
const MESH_CELLS_MIN = 4;
const MESH_CELLS_MAX = 8;

/** Cell counts for a pixel-grid mesh of a `w`×`h` crop: `round(size / MESH_CELL_PX)`
 *  per axis, clamped to [MESH_CELLS_MIN, MESH_CELLS_MAX]. Exported for tests. */
export function meshCellsFor(
  w: number,
  h: number,
): { cols: number; rows: number } {
  const cells = (px: number) =>
    Math.max(
      MESH_CELLS_MIN,
      Math.min(MESH_CELLS_MAX, Math.round(px / MESH_CELL_PX)),
    );
  return { cols: cells(w), rows: cells(h) };
}

/** Cells per axis of the face-warp grid. Bilinear cells render the cylinder
 *  bend as a chord: on the hero (821 px across) 4 cells = 205 px chords with
 *  a 12 px worst-case sag at full turn on the bangs, 6 cells halve it for
 *  ~10 KB of keyforms. The fold guard is the cylinder's own bound and does
 *  not depend on this. */
const FACE_GRID_CELLS = 6;

// ── Head-turn cylinder constants ─────────────────────────────────────────────

/** Margin between a cylinder's radius and the reach it has to cover: at
 *  |local|/radius <= 1/1.2 the asin stays clear of +/-1 and asin(1/1.2) + 30°
 *  is still under 90°, so the bend never folds. The nod radius is derived from
 *  the grid's vertical reach this way; the turn radius is an input, and
 *  radius/factor is the bound `boundedCylinderBend` clamps `local` to. */
const HEAD_CYLINDER_RADIUS_FACTOR = 0.6 / 0.5;
/** Outer keyform stop of the head-turn bake, matching ParamAngleX's range. */
const HEAD_TURN_MAX_DEG = 30;

/** Keyform stops of the head-turn / nod bakes, degrees. The engine blends
 *  parameter-LINEARLY between stops but the cylinder bend is sin-based, so the
 *  stops must be dense enough that the chord stays near the arc: at 15° spacing
 *  the worst mid-stop error on the hero's grid is ≈4 px at the outer column
 *  (3.7 px at 7.5°, 4.0 px at 22.5°) against 15.5 px with stops at ±30 only.
 *  The bake is analytic, so extra stops cost only model bytes. Ascending,
 *  symmetric, includes 0 (the rest cell). */
const HEAD_TURN_STOPS = [-30, -15, 0, 15, 30] as const;

/**
 * Sideways slide, at full head turn, of a surface sitting one full cylinder
 * radius in front of the rotation axis — the unit of depth parallax.
 *
 * This is exactly the bulk `axisShift` the cylinder bake subtracts back out of
 * the face warp. Pinning it there was right: applied to the face it shoved the
 * head off the shoulders. But it is also the whole depth cue, so layers that
 * do NOT sit on the cylinder's axis have to get their own share of it back,
 * scaled by how far in front of (or behind) the axis they sit — the hair
 * (HAIR_FRONT_DEPTH, HAIR_BACK_DEPTH) and the features on the face (the solved
 * TurnDepths). `headNodParallaxUnit` is the same quantity on the nod axis.
 *
 * Takes the cylinder radius the face warp was baked with, so the two cannot
 * drift apart: the unit IS that bake's pinned-out `axisShift`.
 */
export function headTurnParallaxUnit(radius: number): number {
  return radius * Math.sin(HEAD_TURN_MAX_DEG * (Math.PI / 180));
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
 *   xPrime = centerX + radiusX * sin(asin(localX/radiusX) + theta)
 *   dx = xPrime - x,  dy = 0
 *
 * At theta=0 the center keyform is all-zero (xPrime === x by identity).
 *
 * The axis column is pinned: the bulk sideways slide a cylinder rotation
 * produces is subtracted out, leaving only the foreshortening. See the comment
 * at the subtraction for why.
 *
 * `radiusX` is the caller's: how round the head reads is a modelling choice,
 * not a property of how far the grid happens to reach. Columns beyond what the
 * radius can carry ride along rigidly — see `boundedCylinderBend`.
 *
 * No production caller since faceWarp moved to the 2D bake; kept as the 1D
 * reference that the 2D bake's tests compare their AngleY = 0 row against,
 * keyed on the same `HEAD_TURN_STOPS`.
 */
export function bakeHeadTurnGridWarpCentered(
  grid: IkiWarpGrid,
  parameter: string,
  centerX: number,
  radiusX: number,
): IkiGridWarp {
  // Keyform stops (degrees), matching ParamAngleX's −30..30 range.
  const ANGLES = HEAD_TURN_STOPS;

  const pointCount = grid.points.length / 2;
  const DEG_TO_RAD = Math.PI / 180;

  const keyforms = ANGLES.map((angleDeg) => {
    const theta = angleDeg * DEG_TO_RAD;
    const offsets: number[] = [];
    for (let i = 0; i < pointCount; i++) {
      const dx = boundedCylinderBend(
        grid.points[i * 2] - centerX,
        radiusX,
        theta,
      );
      // dy is zero — cylinder bend only deforms horizontal position.
      offsets.push(dx, 0);
    }
    return { value: angleDeg, offsets };
  });

  // keyforms are sorted ascending by construction (HEAD_TURN_STOPS).
  return { parameter, keyforms };
}

/** Farthest grid point from `center` along one axis (0 = x, 1 = y): the nod
 *  radius scales from this so no point's |local|/radius exceeds 1/1.2, the
 *  no-fold bound. The turn's radius is its caller's. */
function gridReach(grid: IkiWarpGrid, axis: 0 | 1, center: number): number {
  let reach = 0;
  for (let i = axis; i < grid.points.length; i += 2) {
    reach = Math.max(reach, Math.abs(grid.points[i] - center));
  }
  return reach;
}

/**
 * Displacement of a point at signed distance `local` from the cylinder axis
 * after the cylinder rotates by `theta`, with the axis column pinned.
 *
 * Rotating a cylinder slides its whole visible surface sideways by
 * RADIUS*sin(theta) — 170px on a 430px-wide face at 30 degrees — on top of the
 * foreshortening. That bulk slide is what shoves the head off the shoulders and
 * detaches the back hair; the foreshortening alone is what reads as a turn.
 * Subtracting it leaves the differential and keeps the offsets monotonic, so no
 * cell folds. Deliberate bulk head motion stays on headDeformer's own translate
 * bindings, where it can be tuned independently, and the hair layers get their
 * depth-scaled share of it back through `headTurnParallaxUnit`.
 */
function pinnedCylinderBend(
  local: number,
  radius: number,
  theta: number,
): number {
  // Clamp local/radius to [-1,1] to keep asin defined at boundary points.
  const alpha = Math.asin(Math.max(-1, Math.min(1, local / radius)));
  return radius * Math.sin(alpha + theta) - local - radius * Math.sin(theta);
}

/**
 * `pinnedCylinderBend` with the surface bounded to the part of the cylinder it
 * can actually carry: |local| is clamped to radius/HEAD_CYLINDER_RADIUS_FACTOR
 * and the overshoot rides along unchanged.
 *
 * Beyond that bound the surface has wrapped past the cylinder's side and the
 * bend turns back on itself: once alpha + theta passes 90° a point further out
 * lands NEARER the axis than the one inside it, and once the asin saturates
 * every remaining point piles onto the SAME x (the `- local` term cancels).
 * Either way the grid folds. Holding the bound's displacement and adding the
 * overshoot back gives those columns slope 1: they follow the silhouette
 * rigidly, keeping their order and their spacing. Inside the bound nothing
 * changes — a radius scaled from the grid's own reach puts the bound exactly
 * on the outer columns, so the generated rig never leaves the surface.
 */
function boundedCylinderBend(
  local: number,
  radius: number,
  theta: number,
): number {
  const bound = radius / HEAD_CYLINDER_RADIUS_FACTOR;
  const onSurface = Math.max(-bound, Math.min(bound, local));
  // The return is a DISPLACEMENT, so `local + dx` already carries the
  // overshoot: holding the bound's dx is what makes the outside rigid.
  return pinnedCylinderBend(onSurface, radius, theta);
}

/**
 * Bake the head turn AND nod as one 2D grid warp over AngleX × AngleY.
 *
 * The same pinned cylinder bend as `bakeHeadTurnGridWarpCentered`, applied per
 * axis: dx from the horizontal bend at valuesX[i], dy from a vertical bend at
 * valuesY[j] about `centerY`. The axes are independent (dx depends only on x
 * and the yaw, dy only on y and the pitch), which is the same separable
 * convention the playground's 2D bake ships; the row at AngleY=0 is exactly the
 * 1D bake.
 *
 * The turn takes the caller's `radiusX`; the nod takes its radius from the
 * grid's vertical reach about `centerY`, with the margin factor, so its
 * |local|/radius stays ≤ 1/1.2 and asin(1/1.2) + 30° < 90° whether or not the
 * grid is symmetric about the axis. The turn holds the same no-fold guarantee
 * at any radius through `boundedCylinderBend`. The pitch itself is scaled by
 * NOD_BEND — see that constant for why a full nod is not a full 30° bend.
 *
 * Layout is the format's row-major `k(i, j) = j * valuesX.length + i`.
 */
export function bakeHeadTurnGridWarp2DCentered(
  grid: IkiWarpGrid,
  parameterX: string,
  parameterY: string,
  centerX: number,
  centerY: number,
  radiusX: number,
): IkiGrid2DWarp {
  const STOPS = [...HEAD_TURN_STOPS];
  const RADIUS_Y = gridReach(grid, 1, centerY) * HEAD_CYLINDER_RADIUS_FACTOR;
  const pointCount = grid.points.length / 2;

  const DEG_TO_RAD = Math.PI / 180;
  const keyforms2d: { offsets: number[] }[] = [];
  for (const angleY of STOPS) {
    const thetaY = angleY * NOD_BEND * DEG_TO_RAD;
    for (const angleX of STOPS) {
      const thetaX = angleX * DEG_TO_RAD;
      const offsets: number[] = [];
      for (let i = 0; i < pointCount; i++) {
        offsets.push(
          boundedCylinderBend(grid.points[i * 2] - centerX, radiusX, thetaX),
          pinnedCylinderBend(
            grid.points[i * 2 + 1] - centerY,
            RADIUS_Y,
            thetaY,
          ),
        );
      }
      keyforms2d.push({ offsets });
    }
  }

  return {
    parameter: parameterX,
    parameterY,
    valuesX: STOPS,
    valuesY: STOPS,
    keyforms2d,
  };
}

// ── turnColumnMap ─────────────────────────────────────────────────────────────

/** Where the head turn sends each column of a face-warp grid, and back. */
export interface TurnColumnMap {
  /** Rest x of every grid column, ascending — row 0 of `grid.points`. */
  restX: number[];
  /** Where the turn puts each of those columns: strictly increasing whenever
   *  `restX` is, since the bound and the capped angle rule out a fold. */
  warpedX: number[];
  /** Rest x → turned x, for anything riding the grid. */
  mapX(x: number): number;
  /** The inverse: which rest x lands on `X`. */
  invertX(X: number): number;
}

/**
 * The head turn as a 1D map on x: where the face-warp grid puts a point at
 * `angleX`, in the WARP'S OWN rest frame — before headDeformer's rigid
 * ±HEAD_TURN_TRAVEL translate, which the engine applies on top.
 *
 * It equals the shipped bake AT the `HEAD_TURN_STOPS`, which is where callers
 * should key: between stops the engine blends the keyforms parameter-linearly
 * (the chord the HEAD_TURN_STOPS comment measures), while this is analytic, so
 * off-stop the two differ by that chord error.
 *
 * The bend depends only on a point's x, so a single row of columns describes
 * the whole grid, and the engine's sampling of it is piecewise-linear:
 * `bindPointToRestGrid` puts a point in the cell its rest x falls in and
 * `sampleWarpGrid` lerps between that cell's deformed corners — so between two
 * columns the map is a straight line, and outside the outer columns the
 * clamped (s, t) pin it to the edge column's warped x. `mapX` reproduces that
 * clamp rather than extrapolating, because a caller measuring a silhouette
 * needs where the geometry lands, not where an extended cylinder would put it.
 *
 * `invertX` answers the other direction — "which rest x has to be here for the
 * turn to land it there" — which is how a target silhouette becomes grid
 * geometry. It clamps `X` to the warped column range, the only place the
 * inverse is defined.
 *
 * Both directions need the warped columns to stay ordered, which holds while
 * asin(1/HEAD_CYLINDER_RADIUS_FACTOR) + |theta| < 90°, i.e. |angleX| ≲ 33.6°.
 * Past that the outer columns fold and `invertX`'s cell scan would silently
 * pick the wrong cell, so the range is capped at the parameter's own
 * HEAD_TURN_MAX_DEG rather than left to produce a quiet wrong answer.
 */
export function turnColumnMap(
  grid: IkiWarpGrid,
  faceCenterX: number,
  radiusX: number,
  angleX: number,
): TurnColumnMap {
  if (Math.abs(angleX) > HEAD_TURN_MAX_DEG) {
    throw new Error(
      `auto-rig: turnColumnMap: angleX ${angleX}° is outside the turn's ±${HEAD_TURN_MAX_DEG}° range`,
    );
  }
  const theta = angleX * (Math.PI / 180);
  const restX: number[] = [];
  const warpedX: number[] = [];
  for (let col = 0; col <= grid.cols; col++) {
    const x = grid.points[col * 2];
    restX.push(x);
    warpedX.push(x + boundedCylinderBend(x - faceCenterX, radiusX, theta));
  }

  // Same scan as bindPointToRestGrid: the first cell whose right edge is past
  // x, else the last one, with the within-cell fraction clamped to [0,1].
  const cellFor = (v: number, edges: number[]) => {
    for (let c = 0; c < grid.cols; c++) {
      if (v < edges[c + 1]) return c;
    }
    return grid.cols - 1;
  };

  return {
    restX,
    warpedX,
    mapX(x: number): number {
      const c = cellFor(x, restX);
      const s = Math.max(
        0,
        Math.min(1, (x - restX[c]) / (restX[c + 1] - restX[c])),
      );
      return warpedX[c] + (warpedX[c + 1] - warpedX[c]) * s;
    },
    invertX(X: number): number {
      const c = cellFor(X, warpedX);
      const s = Math.max(
        0,
        Math.min(1, (X - warpedX[c]) / (warpedX[c + 1] - warpedX[c])),
      );
      return restX[c] + (restX[c + 1] - restX[c]) * s;
    },
  };
}

// ── Turn targets ─────────────────────────────────────────────────────────────

/**
 * What a head does at full turn, as the cues `measure_turn_reference` reads off
 * a front/turned reference pair. The turn is fitted to these — the cylinder's
 * radius and the features' depths are solved from them, not tuned.
 *
 * Every field is optional: `DEFAULT_TURN_TARGETS` supplies the three a
 * reference measures, and the nose and the mouth derive from the eyes when they
 * are not given.
 *
 * What happens when the layer set cannot reach a target depends on where the
 * target came from. A number the CALLER passed is a measurement, so an
 * unreachable one throws, naming the field and what was on offer. A number this
 * module filled in — a default, or a nose/mouth derived from the eyes — is a
 * style prior, not a promise about this character: it is CLAMPED to what the
 * layer set can do and the rig is built. The alternative is a generator that
 * refuses its own defaults, which would leave a perfectly good layer set with
 * no model at all. `solveTurnModel` reports which fields it clamped.
 */
export interface TurnTargets {
  /** How far the eye pair's centre slides toward the far side at full turn, as
   *  a fraction of the head's half-width. The sign is ignored: which way is
   *  the turn's own business. */
  eyeShift?: number;
  /** The far eye's width over the near eye's at full turn, divided by the same
   *  ratio at rest. 1 is no foreshortening; 0 is an edge-on far eye. */
  farEyeRatio?: number;
  /** The head's half-width at full turn over its half-width at rest. 1 holds
   *  the silhouette; below 1 narrows it. */
  silhouetteRatio?: number;
  /** `eyeShift` for the nose. Derived from `eyeShift` when absent. */
  noseShift?: number;
  /** `eyeShift` for the mouth. Derived from `eyeShift` when absent. */
  mouthShift?: number;
  /** The head's own half-width at the eye row, in canvas px: what the shift
   *  fractions are fractions OF, and the rest distance the silhouette hold
   *  pivots on. Without it both fall back to the face plate's half-width, which
   *  is narrower than the head the hair draws, so the shifts land short — an
   *  approximation for callers that have no pixels, not a default to prefer. */
  headHalfWidth?: number;
}

/**
 * A `turnTargets` field this generator will not build a rig from: not a number,
 * outside its range, unreachable on this layer set, or a measured head narrower
 * than the face plate it is drawn around. Every one of them carries a number
 * the CALLER passed, so a host can tell them apart from the invariant breaks the
 * rest of the generator throws and report them as bad input instead of failing.
 */
export class TurnTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnTargetError";
  }
}

/**
 * The reference the turn is fitted to when the caller measured none of its own:
 * a 3/4 portrait, which `measure_turn_reference` reads as 0.671 / −0.224 /
 * 1.012 (its raw turned far/near iris ratio is 0.71 — 0.67 is that ratio
 * normalised by the same ratio at rest, which is what the field means).
 * The silhouette is held exactly: a 1 % change is inside that tool's own noise.
 */
export const DEFAULT_TURN_TARGETS: Readonly<
  Required<Pick<TurnTargets, "eyeShift" | "farEyeRatio" | "silhouetteRatio">>
> = {
  eyeShift: 0.22,
  farEyeRatio: 0.67,
  silhouetteRatio: 1,
} as const;

/** Share of the eye pair's slide the nose and the mouth take when a reference
 *  measured only the eyes. Both stand proud of the surface the eyes sit on —
 *  the nose furthest — so both travel further, in the same proportion the 3/4
 *  reference above shows. */
const NOSE_SHIFT_SHARE = 1.36;
const MOUTH_SHIFT_SHARE = 1.18;

/** Bounds on the ratio targets. Outside them the number is a typo, not a head:
 *  a far eye wider than the near one by half already means the pair was
 *  measured the wrong way round. */
const TURN_RATIO_MAX = 1.5;
const SILHOUETTE_RATIO_MIN = 0.5;

/** `TurnTargets` with every target filled in — what the solver fits. */
export interface ResolvedTurnTargets {
  eyeShift: number;
  farEyeRatio: number;
  silhouetteRatio: number;
  noseShift: number;
  mouthShift: number;
  /** The caller's measured head half-width, checked. Absent when it has none. */
  headHalfWidth?: number;
  /** The fields the caller did NOT supply: filled from DEFAULT_TURN_TARGETS, or
   *  derived from the eyes. Those are the ones the solver may clamp; see
   *  TurnTargets. */
  defaulted: ReadonlySet<keyof TurnTargets>;
}

/** The turn depth of each feature family: the share of the pinned bulk slide
 *  (`headTurnParallaxUnit`) it gets back at full turn. Solved, never tuned. */
export interface TurnDepths {
  eye: number;
  nose: number;
  mouth: number;
}

/**
 * Fill in the targets the caller left out and check the ones it gave.
 *
 * The defaults go through the same checks as a caller's numbers — they are
 * targets like any other, and a bad one has to fail where it is written, not
 * in the geometry three functions down. The GEOMETRIC bounds are not checked
 * here: whether a target is reachable is a property of the layer set, so it
 * belongs to `solveTurnModel`.
 */
export function resolveTurnTargets(
  targets: TurnTargets = {},
): ResolvedTurnTargets {
  const eyeShift = targets.eyeShift ?? DEFAULT_TURN_TARGETS.eyeShift;
  const check = (
    field: keyof TurnTargets,
    value: number | undefined,
    ok: (v: number) => boolean,
    expected: string,
  ) => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || !ok(value)) {
      // A DERIVED target says so: the number in the message is not one the
      // caller wrote, and the field to fix is the one it came from. Only the
      // two shares are derived; the rest fall back to a default, which is a
      // number in its own right.
      const derived =
        (field === "noseShift" || field === "mouthShift") &&
        targets[field] === undefined;
      const from = derived
        ? `, derived from turnTargets.eyeShift (${eyeShift}),`
        : "";
      throw new TurnTargetError(
        `auto-rig: turnTargets.${field} (${value})${from} must be ${expected}`,
      );
    }
  };

  const farEyeRatio = targets.farEyeRatio ?? DEFAULT_TURN_TARGETS.farEyeRatio;
  const silhouetteRatio =
    targets.silhouetteRatio ?? DEFAULT_TURN_TARGETS.silhouetteRatio;
  const noseShift = targets.noseShift ?? NOSE_SHIFT_SHARE * eyeShift;
  const mouthShift = targets.mouthShift ?? MOUTH_SHIFT_SHARE * eyeShift;

  const isShift = (v: number) => Math.abs(v) <= 1;
  const shiftRange = "a fraction of the head half-width, |value| <= 1";
  check("eyeShift", eyeShift, isShift, shiftRange);
  check(
    "farEyeRatio",
    farEyeRatio,
    (v) => v > 0 && v <= TURN_RATIO_MAX,
    `in (0, ${TURN_RATIO_MAX}]`,
  );
  check(
    "silhouetteRatio",
    silhouetteRatio,
    (v) => v >= SILHOUETTE_RATIO_MIN && v <= TURN_RATIO_MAX,
    `in [${SILHOUETTE_RATIO_MIN}, ${TURN_RATIO_MAX}]`,
  );
  check("noseShift", noseShift, isShift, shiftRange);
  check("mouthShift", mouthShift, isShift, shiftRange);
  // headHalfWidth is checked against the layer set's own plate in solveTurnModel,
  // which is where the two meet.
  check("headHalfWidth", targets.headHalfWidth, (v) => v > 0, "positive");

  const defaulted = new Set<keyof TurnTargets>(
    (
      [
        "eyeShift",
        "farEyeRatio",
        "silhouetteRatio",
        "noseShift",
        "mouthShift",
      ] as const
    ).filter((field) => targets[field] === undefined),
  );
  return {
    eyeShift,
    farEyeRatio,
    silhouetteRatio,
    noseShift,
    mouthShift,
    headHalfWidth: targets.headHalfWidth,
    defaulted,
  };
}

// ── Turn landmarks ───────────────────────────────────────────────────────────

/** A feature the turn slides across the face: its rest centre and its width in
 *  model px, which is all the cues measure. `y` is optional — only the eye
 *  pair's is used, to place the eye row against hair_front's own crop for the
 *  bangs' turn-lead correction (see `solveTurnModel`'s `hairFront` param). */
export interface TurnLandmark {
  x: number;
  y?: number;
  w: number;
}

/** The landmarks each solved depth is fitted to. The eye family is a PAIR — the
 *  cues are about the two eyes against each other — the other two a single
 *  part, kept in arrays so one solver serves all three. */
export interface TurnLandmarkSet {
  eye: TurnLandmark[];
  nose: TurnLandmark[];
  mouth: TurnLandmark[];
}

/**
 * Pick the parts the turn cues are measured on out of a layer set, in absolute
 * model x.
 *
 * The eye pair is the WHITES, even when the layer set has irises. The white is
 * the eye's own extent — the thing that has to stay on the face plate as the
 * pair slides, and the widest part of the stack — while the iris is clipped to
 * it and slides with it, so the two foreshorten together: on the reference
 * character the far/near ratio read off the white and off the iris differ by
 * 0.01. Bounding the slide by the narrower iris instead would put the white's
 * outer edge over the side hair, where the render loses it.
 */
export function turnLandmarks(layers: LayerInput[]): TurnLandmarkSet {
  const markOf = (role: string): TurnLandmark | undefined => {
    const layer = layers.find((l) => l.role === role);
    if (!layer) return undefined;
    const t = bboxToTransform(layer.bbox, layer.canvasW, layer.canvasH, role);
    return { x: t.x, y: t.y, w: layer.cropW };
  };
  const pairOf = (left: string, right: string) => {
    const l = markOf(left);
    const r = markOf(right);
    return l && r ? [l, r] : undefined;
  };
  const one = (role: string) => {
    const m = markOf(role);
    return m ? [m] : [];
  };
  return {
    eye: pairOf("eye_L", "eye_R") ?? [],
    nose: one("nose"),
    mouth: one("mouth"),
  };
}

// ── solveTurnDepth ───────────────────────────────────────────────────────────

/** The depth that comes closest to a shift target at one radius. */
export interface TurnDepthSolution {
  /** Whether `depth` HITS the target, or the bounds cut it short. */
  reached: boolean;
  /** The depth to use: the target's own solution, or the nearest bound. */
  depth: number;
  /** The shift `depth` actually produces, px (negative = toward the far side). */
  achieved: number;
  /** Every shift this family could have had, px, ascending. */
  attainable: [number, number];
}

/** Bisection steps for both solvers. The intervals start finite and halve, so
 *  40 is exact in double precision for any radius or depth a head has. */
const TURN_BISECT_STEPS = 40;

/** Px slack on `solveTurnDepthSigned`'s own attainable bound, so a target
 *  that round-trips through a reported cue and back — e.g. a caller
 *  re-submitting the exact `attainable` boundary this function itself
 *  reported, cue-scaled by `hh` and back — is not refused by a float ulp of
 *  rounding. Far below any physically meaningful px difference. */
const TURN_DEPTH_EPS = 1e-6;

/**
 * The depth that slides a landmark family by `targetPx` at full turn —
 * `targetPx` a MAGNITUDE, always toward the far side (see `TurnTargets`'
 * "the sign is ignored" contract). The nose/mouth shares and every existing
 * caller of this export want exactly that; `evaluateTurnCandidate`'s eye
 * solve does not (see `solveTurnDepthSigned`), so it calls that directly.
 */
export function solveTurnDepth(
  targetPx: number,
  landmarks: TurnLandmark[],
  unit: number,
  map: TurnColumnMap,
  holdEdgeX: number,
  plateEdgeX: number,
): TurnDepthSolution {
  // The cues are signed toward the far side; the target's own sign is ignored.
  return solveTurnDepthSigned(
    -Math.abs(targetPx),
    landmarks,
    unit,
    map,
    holdEdgeX,
    plateEdgeX,
  );
}

/**
 * The depth that lands a landmark family's slide exactly on the already-SIGNED
 * `target` (negative toward the far side, positive toward the near one),
 * or the nearer bound when `target` sits outside what any non-negative depth
 * can reach — depth cannot go negative (a feature does not stand BEHIND the
 * surface), so a positive `target` past `atRest` is exactly as unreached as a
 * too-negative one past `atCap`.
 *
 * The part is translated `depth * unit` toward the far side BEFORE its vertices
 * bind to the face grid (that is the order `applyWarpToChild` works in), so
 * what a reference measures is the grid's map OF the translated position, not
 * the translation: `achieved(d) = mean(mapX(x - d*unit) - x)`. The map
 * compresses the far side and stretches the near one, so the two are not the
 * same number, and the far side's compression makes `achieved` shrink faster
 * than `d` grows. It is monotone decreasing in `d` because the map is monotone
 * increasing, which is what makes a bisection valid.
 *
 * The travel has two upper bounds, and the tighter one wins:
 *   - the FACE. Every landmark's far edge has to stay on the face plate, whose
 *     contour the turn only foreshortens. A feature past it is drawn over the
 *     side hair, which bends with the plate and swallows it, or hangs over the
 *     cheek's edge with nothing behind it — on the reference character the far
 *     eye went 35 px past the contour and the render came back with an eye 17
 *     px wide where the solver had promised 53. The reference keeps the far eye
 *     whole. Since `mapX` is monotone, staying inside the plate's MAPPED edge
 *     is the same as staying inside its rest edge, so the bound is a plain rest
 *     distance.
 *   - the SILHOUETTE: the far edge's mapped position may not pass the held
 *     silhouette edge, and its rest position may not leave the grid, where the
 *     engine would clamp it onto the edge column.
 *
 * Both ends of the interval matter, not just the far one: at `d = 0` a landmark
 * already drifts, because the turn's bend moves the near side out further than
 * it moves the far side in, so a target SMALLER than that drift has no
 * non-negative depth either. Neither end is an error here — the solution is
 * reported with `reached: false` and the bound it stopped at, and whether that
 * is a clamp or a failure is the caller's call (see solveTurnModel).
 *
 * `evaluateTurnCandidate`'s eye solve calls this directly instead of going
 * through `solveTurnDepth`'s magnitude wrapper: once the silhouette centre's
 * own drift is folded into the target, that target can legitimately land on
 * either side of zero, and `-Math.abs` would silently answer a different
 * question than the one asked (an eyeShift and its negation producing
 * different rigs). Every other caller (the nose/mouth shares) keeps the
 * magnitude-only contract through the wrapper.
 */
function solveTurnDepthSigned(
  target: number,
  landmarks: TurnLandmark[],
  unit: number,
  map: TurnColumnMap,
  holdEdgeX: number,
  plateEdgeX: number,
): TurnDepthSolution {
  if (landmarks.length === 0) {
    throw new Error("auto-rig: solveTurnDepth: no landmark to slide");
  }
  const farEdge = Math.min(...landmarks.map((l) => l.x - l.w / 2));
  const floor = Math.max(map.invertX(holdEdgeX), map.restX[0], plateEdgeX);
  // Never negative: a landmark that starts outside a bound cannot be slid back
  // in by a depth, and a depth away from the turn is not a depth.
  const cap = Math.max(0, (farEdge - floor) / unit);
  const achieved = (d: number) =>
    landmarks.reduce((sum, l) => sum + (map.mapX(l.x - d * unit) - l.x), 0) /
    landmarks.length;

  const atCap = achieved(cap);
  const atRest = achieved(0);
  const attainable: [number, number] = [atCap, atRest];
  if (target > atRest + TURN_DEPTH_EPS)
    return { reached: false, depth: 0, achieved: atRest, attainable };
  if (target < atCap - TURN_DEPTH_EPS)
    return { reached: false, depth: cap, achieved: atCap, attainable };
  // Within EPS of a bound but past it either way (the ulp this guards
  // against) — clamp before bisecting, rather than searching for a target
  // outside the interval `achieved` can actually produce.
  const clampedTarget = Math.min(Math.max(target, atCap), atRest);

  let lo = 0;
  let hi = cap;
  for (let i = 0; i < TURN_BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (achieved(mid) > clampedTarget) lo = mid;
    else hi = mid;
  }
  const depth = (lo + hi) / 2;
  return { reached: true, depth, achieved: achieved(depth), attainable };
}

// ── solveTurnModel ───────────────────────────────────────────────────────────

/** What the turn solve settled on, for a caller that wants to see it — the
 *  cues it reached and the targets it had to cut down to reach them. */
export interface TurnSolveReport {
  /** Cylinder radius the face-warp bake and the parallax unit were built on. */
  radius: number;
  /** Rest distance from the face centre the silhouette hold pivots on. */
  holdBase: number;
  depths: TurnDepths;
  /** What the rig actually reaches, in the targets' own units. */
  achieved: { eyeShift: number; farEyeRatio: number; silhouetteRatio: number };
  /** Defaulted fields the layer set could not reach, cut down to what it can.
   *  Empty when every target was met. */
  clamped: (keyof TurnTargets)[];
}

/** The turn the targets ask for, or the first CALLER target this layer set
 *  cannot reach and what it could have had instead (in that target's own
 *  units). Defaults never land in the second branch — they clamp. */
export type TurnModelSolution =
  | (TurnSolveReport & {
      unreachable: false;
      /** Where the hold's boundary is sent at each stop. */
      holdEdgeAt: (deg: number) => number;
    })
  | {
      unreachable: true;
      field: keyof TurnTargets;
      /** The caller's own number — never a clamped stand-in. */
      value: number;
      attainable: [number, number];
    };

/** Radius sweep, as multiples of the face plate's half-width. The floor is the
 *  no-fold margin itself: at it the bend's bound sits exactly on the plate's
 *  edge, and below it the plate — features included — leaves the analytic part
 *  of the cylinder and rides along rigidly instead of foreshortening. The
 *  ceiling is all but a plate: at 8 half-widths the face covers ±7° of the
 *  cylinder and the turn is nearly a slide — the far/near ratio it can still
 *  produce, 0.93 on the reference character, is the top of the attainable range
 *  the solver reports. A head that wants less foreshortening wants none. */
const TURN_SWEEP_MAX_FACTOR = 8;
/** Sample count of that sweep. The ratio curve is smooth in log-radius, so this
 *  only has to be dense enough to bracket the target, not to resolve it. */
const TURN_SWEEP_SAMPLES = 32;
/** How far past the plate's own reach a hold edge has to sit, px. The ramp onto
 *  the strands runs outward, so a hold edge ON the reach is a zero-width ramp;
 *  one pixel of clearance is what makes it a ramp. */
const HOLD_CLEARANCE = 1;

/** A radius that can carry the turn, with everything the fit reads off it. */
interface TurnCandidate {
  radius: number;
  /** The far/near eye width ratio it produces, at the eye depth below. */
  ratio: number;
  unit: number;
  /** Its column map at the −30° stop, where every cue is measured. */
  map: TurnColumnMap;
  holdBase: number;
  holdEdgeAt: (deg: number) => number;
  /** Model x of the held silhouette's far edge at full turn. */
  holdEdgeX: number;
  eye: TurnDepthSolution;
  /** The silhouette ratio this radius can actually carry at full turn, each
   *  side capped to the deformed grid's own reach (`TurnColumnMap.warpedX`'s
   *  edges) — equal to the requested ratio when neither side needed it. */
  achievedSilhouetteRatio: number;
  /** Whether either side needed that cap. */
  silhouetteCapped: boolean;
  /** How far the silhouette's own centre drifts from the face centre at full
   *  turn, against rest — each side's real landing (whichever part owns that
   *  edge actually carries it there; see `landingAt`) minus how far its rest
   *  x already sat off the face centre. `measure_turn_reference` reads the
   *  eye pair against THIS moved centre, not the face centre, so it is what
   *  `eye`'s target and `achieved.eyeShift` are corrected by. */
  silhouetteCenterShift: number;
  /** The silhouette ratio a render actually shows: each side's real LANDING
   *  span over its rest span (`landingAt`/`restAt`, the same pair
   *  `silhouetteCenterShift` reads) — as `measure_turn_reference` would
   *  measure it off the two images, unlike `achievedSilhouetteRatio`, which
   *  is the hold's own capped-destination ratio and does not see hair_back's
   *  bulge or a face-plate edge's own foreshortening. */
  renderedSilhouetteRatio: number;
}

/** Why a radius yielded no candidate, in the blocked target's own terms. */
type TurnCandidateMiss =
  | {
      blocked: "silhouetteRatio";
      /** The narrowest ratio the plate-fold geometry could have held here —
       *  a LOWER bound — and the widest the deformed grid's own reach could
       *  have carried without capping — an UPPER bound. Computed the same way
       *  regardless of which of the two actually blocked this radius, so
       *  every refusal names the same pair a caller could have asked for
       *  instead. */
      lower: number;
      upper: number;
    }
  | {
      blocked: "eyeShift";
      /** The px interval it offered the eyes instead, ascending. */
      offeredShift: [number, number];
    };

/** Everything a candidate is evaluated against that does not vary with the
 *  radius. One pass of the solve holds one of these. */
interface TurnSolveContext {
  landmarks: TurnLandmarkSet;
  faceGrid: IkiWarpGrid;
  faceCenterX: number;
  faceHalfWidth: number;
  /** Rest x of the plate's far edge — the slide's hard stop. */
  plateEdgeX: number;
  /** The caller's measured head half-width, when it has one. */
  headHalfWidth?: number;
  /** What the shift fractions are fractions of, px. */
  hh: number;
  /** The silhouette ratio this pass is solving for. */
  silhouetteRatio: number;
  /** The MAGNITUDE of the eye shift this pass is solving for — `TurnTargets`'
   *  own "the sign is ignored" contract taken at the door, so a request and
   *  its negation reach identically here. */
  eyeShift: number;
  /** Whether an eye shift the bounds cut short is a clamp or a rejection. */
  clampEyeShift: boolean;
  /** Whether a silhouette the deformed grid cannot fully carry is a clamp or a
   *  rejection — same split as `clampEyeShift`, for the same reason. */
  clampSilhouetteRatio: boolean;
  /** The eye row's `u` in `bakeHairSwayWarp`'s own `tipShift · u^CURL` shape —
   *  0 at hair_front's root, 1 at its tips, BEFORE the curl exponent, which is
   *  applied where this is used. See `solveTurnModel`'s `hairFront` param.
   *  Undefined when there is no hair_front layer, or its eye row cannot be
   *  placed against it: the silhouette centre then holds to the hold
   *  destinations alone. */
  hairFrontLeadFraction?: number;
  /** hair_front's own rest x and crop width/height, for `hairFrontLandingAt`
   *  — its own column geometry (`meshCellsFor`), and the silhouette point used
   *  when `headHalfWidth` is not measured (see `evaluateTurnCandidate`'s
   *  silhouette-centre correction). Undefined when there is no hair_front
   *  layer, in which case that correction falls back to the ideal hold
   *  destinations, symmetric about the face centre. */
  hairFrontSilhouette?: { x: number; cropW: number; cropH: number };
  /** hair_back's own rest x and crop width, for `evaluateTurnCandidate`'s
   *  silhouette-centre correction on a side `headEdges` names "hair_back" for
   *  — its own mesh half-width (`cropW / 2`) and centre, `hairBackOffsetAt`
   *  needs to place a vertex at an arbitrary rest x in hair_back's own local
   *  frame. Undefined when there is no hair_back layer. */
  hairBack?: { x: number; cropW: number };
  /** Every role with an opaque pixel in the eye-row band, per side, each
   *  with its OWN rest x there — as the mcp layer measures it (`rowSpansByRole`),
   *  a companion to a MEASURED `headHalfWidth`, not a caller-facing target.
   *  `evaluateTurnCandidate` takes the OUTERMOST *landing* across a side's own
   *  list, not the outermost REST x: which part ends up furthest out after
   *  the turn can differ from which one drew furthest out at rest (a bulging
   *  back-hair overtaking the bangs, say). Absent on the fallback path (no
   *  measured head to report edges for), which keeps hair_front's own crop
   *  edge as the silhouette point on both sides, as if it always owned them. */
  headEdges?: {
    left: { role: string; x: number }[];
    right: { role: string; x: number }[];
  };
}

/**
 * The rest x a hair_front vertex is sent to at one turn stop — the three-zone
 * rule `bakeHairFrontSilhouetteWarp` bakes into a per-vertex offset and
 * `evaluateTurnCandidate` reads the composed landing of, factored into one
 * place so the two cannot drift apart:
 *
 *   - within `faceHalfWidth` of the face centre, on the plate: exactly where
 *     the grid puts it (`map.mapX(x)` — a no-op for anything actually inside
 *     the grid, since the map does that on its own; it only bites a plate
 *     vertex that sits outside it);
 *   - out to `holdBase`: a straight ramp from the plate edge's own mapped
 *     destination onto `holdEdge`'s, already capped to the deformed grid's
 *     own reach at this stop;
 *   - beyond `holdBase`: `holdEdge`'s own displacement, slope 1 in REST x, so
 *     the outer strands carry whatever silhouette change was asked for.
 */
function hairFrontHoldTarget(
  x: number,
  faceCenterX: number,
  faceHalfWidth: number,
  holdBase: number,
  holdEdge: [number, number],
  map: TurnColumnMap,
): number {
  const local = x - faceCenterX;
  const dist = Math.abs(local);
  const side = Math.sign(local);
  const sideIdx = side < 0 ? 0 : 1;
  if (dist <= faceHalfWidth) return map.mapX(x);
  if (dist <= holdBase) {
    const inner = map.mapX(faceCenterX + side * faceHalfWidth);
    const u = (dist - faceHalfWidth) / (holdBase - faceHalfWidth);
    return inner + (faceCenterX + side * holdEdge[sideIdx] - inner) * u;
  }
  return x + side * (holdEdge[sideIdx] - holdBase);
}

/**
 * hair_front's own silhouette landing at an ARBITRARY rest x — not the
 * analytic hold∘lead∘grid at that single point, but the same piecewise-linear
 * mesh the bake ships: the shipped mesh has only `meshCellsFor`'s own column
 * count (8 on the hero, ~82 px apart), the outer column's `invertX` clamps
 * onto the deformed grid's own edge (see `hairFrontHoldTarget`), and between
 * columns the GPU lerps the FINAL, already-mapped x of the two neighbouring
 * columns — this maps their LERPED pre-bind x once instead, which agrees
 * exactly wherever no column-map segment break falls between the two (most
 * pairs, the map being piecewise-linear) and only approximates it otherwise.
 * A single continuous evaluation misses the bigger of the two effects either
 * way: it can predict a destination the outer column's own clamp never
 * reaches, and it treats a point between columns as if it sat exactly on one.
 *
 * `x` need not be inside hair_front's own crop at all — past its outer column
 * this clamps to that column's own landing (`t` is clamped below), the same
 * "beyond the mesh's own edge" answer `invertX` gives a real vertex there.
 */
function hairFrontLandingAt(
  x: number,
  hairFront: { x: number; cropW: number; cropH: number },
  faceCenterX: number,
  faceHalfWidth: number,
  holdBase: number,
  cappedHoldEdge: [number, number],
  map: TurnColumnMap,
  lead: number,
): number {
  const { cols } = meshCellsFor(hairFront.cropW, hairFront.cropH);
  const preBindAt = (col: number): number => {
    const colX =
      hairFront.x - hairFront.cropW / 2 + (col / cols) * hairFront.cropW;
    const target = hairFrontHoldTarget(
      colX,
      faceCenterX,
      faceHalfWidth,
      holdBase,
      cappedHoldEdge,
      map,
    );
    return map.invertX(target);
  };
  const s = ((x - hairFront.x + hairFront.cropW / 2) / hairFront.cropW) * cols;
  const lo = Math.max(0, Math.min(cols, Math.floor(s)));
  const hi = Math.max(0, Math.min(cols, lo + 1));
  const t = Math.max(0, Math.min(1, s - lo));
  const preBindLo = preBindAt(lo);
  const preBind = preBindLo + t * (preBindAt(hi) - preBindLo);
  return map.mapX(preBind + lead);
}

/**
 * One radius, evaluated against the cues: the candidate it yields, or which
 * target blocked it and what it could have done instead.
 *
 * Two hold gates run here first, mirroring what `bakeHairFrontSilhouetteWarp`
 * does with the same numbers: the per-stop plate-fold check (through
 * `plateReachAt`), and, at full turn, each side's own reach on the DEFORMED
 * grid (`TurnColumnMap.warpedX`'s edges — the same bound `invertX` clamps to).
 * Both bounds are computed EVERY time, whichever gate actually fires (or
 * neither), so an unreachable silhouette names itself instead of throwing out
 * of the bake, or the rig silently landing short of what a caller asked for,
 * and a refusal never advertises a range the OTHER gate would have narrowed.
 * The grid-reach gate only rejects a radius for a CALLER-measured ratio; a
 * DEFAULTED one takes whatever the grid can actually carry instead — see
 * `achievedSilhouetteRatio`. Folding is never acceptable either way.
 */
function evaluateTurnCandidate(
  ctx: TurnSolveContext,
  radius: number,
): TurnCandidate | TurnCandidateMiss {
  const columnMapAt = (deg: number) =>
    turnColumnMap(ctx.faceGrid, ctx.faceCenterX, radius, deg);
  // A measured head IS the hold's boundary; without one it is the outermost the
  // plate ever reaches, clear of it by HOLD_CLEARANCE.
  const holdBase =
    ctx.headHalfWidth ??
    plateReach(ctx.faceCenterX, ctx.faceHalfWidth, columnMapAt) +
      HOLD_CLEARANCE;
  // The boundary stays put and its DESTINATION moves: the full ratio at the
  // outer stops, none of it at rest, linear in between.
  const holdEdgeAt = (deg: number) =>
    holdBase *
    (1 + ((ctx.silhouetteRatio - 1) * Math.abs(deg)) / HEAD_TURN_MAX_DEG);

  // The lower bound this radius could ever hold (the plate-fold geometry) and
  // the upper bound it could ever carry (the deformed grid's own reach),
  // computed UNCONDITIONALLY — every refusal below names both, regardless of
  // which one actually blocked this radius, so a caller cannot cut one target
  // down only to have the other's refusal advertise a stale range.
  let foldLowerBound = -Infinity;
  let folds = false;
  for (const deg of HEAD_TURN_STOPS) {
    if (deg === 0) continue; // proven never to bind — holdBase always clears the rest reach
    const reach = plateReachAt(
      columnMapAt(deg),
      ctx.faceCenterX,
      ctx.faceHalfWidth,
    );
    // What the ratio would have to be for the hold edge to clear the plate at
    // this stop, given the stop gets |deg|/30 of the ratio's travel.
    foldLowerBound = Math.max(
      foldLowerBound,
      1 +
        ((reach + HOLD_CLEARANCE) / holdBase - 1) *
          (HEAD_TURN_MAX_DEG / Math.abs(deg)),
    );
    if (holdEdgeAt(deg) <= reach) folds = true;
  }

  const unit = headTurnParallaxUnit(radius);
  const map = columnMapAt(-HEAD_TURN_MAX_DEG);
  // The hold can only place a vertex as far out as the deformed grid itself
  // reaches on that side; past it `invertX` clamps onto the edge column (see
  // bakeHairFrontSilhouetteWarp). So the ratio this radius can actually carry
  // at full turn is each side's requested destination capped to that reach,
  // not the requested ratio itself.
  const requestedHoldEdge = holdEdgeAt(HEAD_TURN_MAX_DEG);
  const gridReach: [number, number] = [
    Math.abs(map.warpedX[0] - ctx.faceCenterX),
    Math.abs(map.warpedX[map.warpedX.length - 1] - ctx.faceCenterX),
  ];
  const reachUpperBound =
    (Math.min(gridReach[0], gridReach[1]) - HOLD_CLEARANCE) / holdBase;
  const cappedHoldEdge: [number, number] = [
    Math.min(requestedHoldEdge, gridReach[0] - HOLD_CLEARANCE),
    Math.min(requestedHoldEdge, gridReach[1] - HOLD_CLEARANCE),
  ];
  const silhouetteCapped =
    cappedHoldEdge[0] < requestedHoldEdge ||
    cappedHoldEdge[1] < requestedHoldEdge;
  const achievedSilhouetteRatio =
    (cappedHoldEdge[0] + cappedHoldEdge[1]) / (2 * holdBase);
  // The bangs' own root-pinned turn lead (bakeHairSwayWarp, shared with the
  // sway) reaches the eye row at a share of its full tip lead — the same
  // `u^HAIR_SWAY_CURL` shape the bake applies per row, sampled at
  // `hairFrontLeadFraction` instead of a mesh row's own fraction (see its own
  // doc). It moves EVERY row toward the far side by the same amount
  // regardless of which side of the axis a column sits on — a raw offset in
  // REST x, negative (this map is the −30° one, and the lead's own −30°
  // keyform is `0 − tipShift·u^CURL`), added before the hold's own inverse is
  // re-mapped inside `hairFrontLandingAt`, exactly like `bakeHairSwayWarp` and
  // `bakeHairFrontSilhouetteWarp` sum their offsets on the shipped mesh. Only
  // hair_front leads — a role `landingOfRole` sends down any other path does
  // not use this at all.
  const lead =
    ctx.hairFrontLeadFraction === undefined
      ? 0
      : -HAIR_FRONT_DEPTH *
        unit *
        Math.pow(ctx.hairFrontLeadFraction, HAIR_SWAY_CURL);
  // The silhouette point each side's centre is read from: `measure_turn_reference`
  // reads the eye pair against the OPAQUE UNION's own centre, not an assumed
  // faceCenterX-symmetric one, so with `headEdges` this is that same union's
  // own extreme — the min (−x side) / max (+x side) of every candidate's own
  // rest x, not `holdBase`'s idealised, centred stand-in for it (`holdBase`
  // still sizes the HOLD itself; this is only where the DRIFT is measured
  // from). Without an edge list for this side — no measured head at all, or
  // one measured but with nothing recorded there — the measured head's own
  // edge (`holdBase` IS that edge then, on the nose by construction), or
  // hair_front's own crop edge otherwise: the best available stand-in for
  // where a render's outermost opaque pixel sits when nothing measured it.
  const restAt = (side: -1 | 1): number => {
    const candidates = side < 0 ? ctx.headEdges?.left : ctx.headEdges?.right;
    if (candidates !== undefined && candidates.length > 0) {
      const xs = candidates.map((c) => c.x);
      return side < 0 ? Math.min(...xs) : Math.max(...xs);
    }
    return ctx.headHalfWidth !== undefined ||
      ctx.hairFrontSilhouette === undefined
      ? ctx.faceCenterX + side * holdBase
      : ctx.hairFrontSilhouette.x + (side * ctx.hairFrontSilhouette.cropW) / 2;
  };
  const hairFrontAt = (x: number): number =>
    ctx.hairFrontSilhouette === undefined
      ? x
      : hairFrontLandingAt(
          x,
          ctx.hairFrontSilhouette,
          ctx.faceCenterX,
          ctx.faceHalfWidth,
          holdBase,
          cappedHoldEdge,
          map,
          lead,
        );
  // Where a named role's OWN rest x lands after the turn — the mcp measures
  // the union of every layer's opaque pixels, so an edge can belong to any
  // role, not just the bangs. `face` and the FEATURE_NOD_DEPTH family (the
  // eye stack, lashes, brows, blush, the nose, both mouths) ride `faceWarp`,
  // so their own path is `map.mapX` — WITHOUT that family's own depth
  // parallax (29/32/26 px on the hero for eye/nose/mouth, not negligible on
  // its own), which is not solved yet at this point in the sweep (the eye's
  // own signed solve just below needs `silhouetteCenterShift`, computed from
  // this, and nose/mouth's are not solved until `solveFeatureDepths`, after a
  // radius is even chosen). The omission is harmless not because the
  // magnitude is small but because none of this family can realistically OWN
  // the eye-row silhouette edge in the first place: they sit near the face's
  // own centre, well inside whatever hair, face-plate, or body edge is
  // actually outermost there. `hair_back` and `body` ride their own rigid
  // deformers, not faceWarp, so neither uses `map` at all. Anything not in
  // `ROLE_TABLE` is a bug, not a role to render as unmoved.
  const landingOfRole = (role: string, x: number): number => {
    if (role === "hair_front") return hairFrontAt(x);
    if (role === "hair_back" && ctx.hairBack !== undefined) {
      const halfWidth = ctx.hairBack.cropW / 2;
      const relX = x - ctx.hairBack.x;
      // The "from" value of its own 2-point AngleX translateX binding (see
      // bindingsForRole) — the stop every cue here is measured at is exactly
      // its lower end, -HEAD_TURN_MAX_DEG.
      const translateX = -HAIR_BACK_DEPTH * unit;
      return (
        x + translateX + hairBackOffsetAt(relX, halfWidth, -HEAD_TURN_MAX_DEG)
      );
    }
    if (role === "hair_back") {
      throw new Error(
        "auto-rig: evaluateTurnCandidate: a headEdges candidate names " +
          "hair_back, but this layer set has no hair_back layer",
      );
    }
    if (role === "body") {
      // bodyDeformer is a SIBLING of headDeformer, not its child, so body's
      // landing in the HEAD's own frame is its own AngleX travel minus the
      // head's: (-BODY_TURN_FOLLOW·HEAD_TURN_TRAVEL) − (-HEAD_TURN_TRAVEL).
      return x + HEAD_TURN_TRAVEL * (1 - BODY_TURN_FOLLOW);
    }
    if (role === "face" || FEATURE_NOD_DEPTH[roleFamily(role)] !== undefined) {
      return map.mapX(x);
    }
    throw new Error(
      `auto-rig: evaluateTurnCandidate: unrecognised role "${role}"`,
    );
  };
  const landingAt = (side: -1 | 1): number => {
    const candidates = side < 0 ? ctx.headEdges?.left : ctx.headEdges?.right;
    if (candidates === undefined || candidates.length === 0) {
      return hairFrontAt(restAt(side));
    }
    const landings = candidates.map((c) => landingOfRole(c.role, c.x));
    return side < 0 ? Math.min(...landings) : Math.max(...landings);
  };
  // How far the silhouette's own centre drifts off the face centre at full
  // turn, against how far it already sat off centre at rest (zero unless
  // hair_front's crop is itself off-centre) — the head's own rigid travel
  // cancels between the eyes and the silhouette, leaving just this drift.
  // `measure_turn_reference` reads the eye pair against THIS moved centre,
  // not the face centre, so it is what the eye cue below is corrected by.
  const silhouetteCenterShift =
    (landingAt(1) + landingAt(-1)) / 2 - (restAt(1) + restAt(-1)) / 2;
  // What a render actually shows: the real landing span over the real rest
  // span, the same pair silhouetteCenterShift reads — see its own doc on
  // TurnCandidate for why this differs from achievedSilhouetteRatio.
  const renderedSilhouetteRatio =
    (landingAt(1) - landingAt(-1)) / (restAt(1) - restAt(-1));

  // A CALLER-measured ratio this radius would need to cap disqualifies the
  // radius; a DEFAULTED one takes the capped value instead (see
  // achievedSilhouetteRatio). Folding is never acceptable, defaulted or not —
  // see solveTurnModel's own comment on why a defaulted ratio never folds.
  if (folds || (silhouetteCapped && !ctx.clampSilhouetteRatio)) {
    return {
      blocked: "silhouetteRatio",
      lower: foldLowerBound,
      upper: reachUpperBound,
    };
  }
  const holdEdgeX = ctx.faceCenterX - holdEdgeAt(HEAD_TURN_MAX_DEG);
  // measure_turn_reference reads the eye pair against each pose's OWN
  // silhouette centre, not the face centre — at rest that centre IS the face
  // centre, but at full turn it has moved by `silhouetteCenterShift`. The raw
  // landmark slide `solveTurnDepthSigned` solves for is measured against the
  // face centre, so its target has to be `silhouetteCenterShift` MINUS the
  // requested magnitude's own px: adding the two back together at measurement
  // time (`achieved.eyeShift` below) lands back on the requested cue.
  //
  // That target can legitimately be positive (the centre's own drift already
  // meets or exceeds the request, so the eyes need to move toward the NEAR
  // side to land on it) as well as negative, which is exactly why this calls
  // the SIGNED solver directly: `solveTurnDepth`'s magnitude-only wrapper
  // would silently flip a negative request back to positive, quietly hitting
  // a different cue than the one asked for (a request and its negation must
  // produce the identical rig — `TurnTargets.eyeShift`'s own "the sign is
  // ignored" contract, taken here, not by folding an already-negative result
  // back to positive later).
  const eye = solveTurnDepthSigned(
    silhouetteCenterShift - ctx.eyeShift * ctx.hh,
    ctx.landmarks.eye,
    unit,
    map,
    holdEdgeX,
    ctx.plateEdgeX,
  );
  // A measured shift this radius cannot produce disqualifies the radius; a
  // defaulted one takes what the radius offers.
  if (!eye.reached && !ctx.clampEyeShift) {
    return {
      blocked: "eyeShift",
      // eyeShift is a MAGNITUDE (the sign is ignored — see TurnTargets), so a
      // negative lower bound here would advertise a value the field's own
      // contract already rules out; 0 is the true floor.
      offeredShift: [
        Math.max(0, (-eye.attainable[1] + silhouetteCenterShift) / ctx.hh),
        (-eye.attainable[0] + silhouetteCenterShift) / ctx.hh,
      ],
    };
  }

  // Each eye's rest width against its turned width, where the slide put it.
  const scaleOf = (l: TurnLandmark) =>
    (map.mapX(l.x + l.w / 2 - eye.depth * unit) -
      map.mapX(l.x - l.w / 2 - eye.depth * unit)) /
    l.w;
  // A −30° turn foreshortens the −x side: that eye is the far one. Dividing the
  // two rest-normalised scales IS the cue — the reference's own far/near ratio
  // is already divided by its rest one.
  const far = ctx.landmarks.eye.reduce((a, b) => (b.x < a.x ? b : a));
  const near = ctx.landmarks.eye.reduce((a, b) => (b.x > a.x ? b : a));
  return {
    radius,
    ratio: scaleOf(far) / scaleOf(near),
    unit,
    map,
    holdBase,
    holdEdgeAt,
    holdEdgeX,
    eye,
    achievedSilhouetteRatio,
    silhouetteCapped,
    silhouetteCenterShift,
    renderedSilhouetteRatio,
  };
}

/** The radii that can carry the turn, and what blocked the ones that cannot. */
interface TurnSweep {
  candidates: TurnCandidate[];
  /** The narrowest silhouette ratio any radius blocked for the silhouette
   *  could have held, from its own plate-fold geometry — a LOWER bound,
   *  computed the same way whichever gate is what actually blocked it;
   *  Infinity when no radius was blocked for the silhouette at all. */
  heldRatioLower: number;
  /** The widest silhouette ratio any radius blocked for the silhouette could
   *  have carried without capping, from its own deformed-grid reach — an
   *  UPPER bound, same convention; -Infinity when no radius was blocked for
   *  the silhouette at all. */
  heldRatioUpper: number;
  /** The widest eye shift the blocked radii offered, in shift units; absent
   *  when the slide blocked none. */
  offeredShift?: [number, number];
}

/** Log-spaced sweep of the radius: the shape of the head is not known to any
 *  finer resolution than the cues themselves, so the search starts by looking
 *  at the whole plausible range. */
function sweepTurnRadii(ctx: TurnSolveContext): TurnSweep {
  const minRadius = ctx.faceHalfWidth * HEAD_CYLINDER_RADIUS_FACTOR;
  const maxRadius = ctx.faceHalfWidth * TURN_SWEEP_MAX_FACTOR;
  const candidates: TurnCandidate[] = [];
  let heldRatioLower = Infinity;
  let heldRatioUpper = -Infinity;
  let offeredShift: [number, number] | undefined;
  for (let i = 0; i < TURN_SWEEP_SAMPLES; i++) {
    const radius =
      minRadius * Math.pow(maxRadius / minRadius, i / (TURN_SWEEP_SAMPLES - 1));
    const result = evaluateTurnCandidate(ctx, radius);
    if (!("blocked" in result)) {
      candidates.push(result);
    } else if (result.blocked === "silhouetteRatio") {
      heldRatioLower = Math.min(heldRatioLower, result.lower);
      heldRatioUpper = Math.max(heldRatioUpper, result.upper);
    } else {
      offeredShift = offeredShift
        ? [
            Math.min(offeredShift[0], result.offeredShift[0]),
            Math.max(offeredShift[1], result.offeredShift[1]),
          ]
        : result.offeredShift;
    }
  }
  return { candidates, heldRatioLower, heldRatioUpper, offeredShift };
}

/**
 * The radius whose far/near ratio comes nearest `target`.
 *
 * The ratio is not monotone in the radius — a flatter cylinder foreshortens
 * less but needs a deeper slide to move the eyes as far, and the grid's cells
 * are straight lines the landmarks cross at different radii — so the sweep's
 * samples are scanned from the LARGEST radius down for the first adjacent pair
 * that brackets the target: where two radii both fit, the flatter head is the
 * one that keeps more of the face on the analytic part of the cylinder. The
 * bisection inside that pair is geometric, matching the log-spaced sweep.
 */
function fitTurnRadius(
  ctx: TurnSolveContext,
  candidates: TurnCandidate[],
  target: number,
): TurnCandidate {
  // The whole sampled span, narrowed to the bracketing pair — there always is
  // one, the target being inside the samples' own range. Adjacent in the array
  // is adjacent in radius because the feasible candidates are an upper interval
  // of the sweep: both gates bite at the small-radius end (the tightest bend
  // overshoots the hold and eats the most slide), so nothing is missing from
  // the middle. An interior gap would need a guard here.
  let lo = candidates[0];
  let hi = candidates[candidates.length - 1];
  for (let i = candidates.length - 2; i >= 0; i--) {
    if (
      (candidates[i].ratio - target) * (candidates[i + 1].ratio - target) <=
      0
    ) {
      lo = candidates[i];
      hi = candidates[i + 1];
      break;
    }
  }
  for (let i = 0; i < TURN_BISECT_STEPS; i++) {
    const mid = evaluateTurnCandidate(ctx, Math.sqrt(lo.radius * hi.radius));
    // A gap in the feasible set inside the bracket: keep the pair we have.
    if ("blocked" in mid) break;
    if ((mid.ratio - target) * (lo.ratio - target) <= 0) hi = mid;
    else lo = mid;
  }
  return Math.abs(lo.ratio - target) <= Math.abs(hi.ratio - target) ? lo : hi;
}

/**
 * The nose's and the mouth's depth at the solved radius, on the same terms as
 * the eyes': a measured target must be hit, a derived one takes what it can get.
 *
 * A DERIVED share follows the eyes' actual travel, not the travel they were
 * asked for: the shares are proportions BETWEEN the three features, so against a
 * clamped eye pair the un-scaled ones would send the nose across the far eye.
 */
function solveFeatureDepths(
  ctx: TurnSolveContext,
  targets: ResolvedTurnTargets,
  best: TurnCandidate,
  eyeShift: number,
):
  | { nose: number; mouth: number; clamped: (keyof TurnTargets)[] }
  | { blocked: "noseShift" | "mouthShift"; attainable: [number, number] } {
  const clamped: (keyof TurnTargets)[] = [];
  const solved: Partial<Record<"noseShift" | "mouthShift", number>> = {};
  const families = [
    ["noseShift", ctx.landmarks.nose, NOSE_SHIFT_SHARE],
    ["mouthShift", ctx.landmarks.mouth, MOUTH_SHIFT_SHARE],
  ] as const;
  for (const [field, marks, share] of families) {
    // Both share eyeShift's own head-relative contract (a fraction of `hh`,
    // sign ignored), so the target gets the SAME silhouette-centre correction
    // the eye's own solve uses (see evaluateTurnCandidate) — measured against
    // the pose's own silhouette centre, not the raw landmark slide against the
    // fixed face centre.
    const m = Math.abs(
      targets.defaulted.has(field) ? share * eyeShift : targets[field],
    );
    const solution = solveTurnDepthSigned(
      best.silhouetteCenterShift - m * ctx.hh,
      marks,
      best.unit,
      best.map,
      best.holdEdgeX,
      ctx.plateEdgeX,
    );
    if (!solution.reached) {
      if (!targets.defaulted.has(field)) {
        return {
          blocked: field,
          // noseShift/mouthShift are MAGNITUDES too (see the correction
          // above), so a negative lower bound here would advertise a value
          // the field's own contract already rules out; 0 is the true floor.
          attainable: [
            Math.max(
              0,
              (-solution.attainable[1] + best.silhouetteCenterShift) / ctx.hh,
            ),
            (-solution.attainable[0] + best.silhouetteCenterShift) / ctx.hh,
          ],
        };
      }
      clamped.push(field);
    }
    solved[field] = solution.depth;
  }
  return {
    nose: solved.noseShift!,
    mouth: solved.mouthShift!,
    clamped,
  };
}

/**
 * Solve the head turn from its measured cues: one radius and three depths.
 *
 * The radius and the eye depth are solved TOGETHER, because the two cues do not
 * separate: how far the eye pair slides depends on the radius (through the unit
 * and the map), and how much the far eye foreshortens depends on where the
 * slide put it. For a candidate radius the eye depth is whatever hits
 * `eyeShift` on that radius' own map — or, for a DEFAULTED eyeShift the bounds
 * cut short, as much of it as that radius allows — and the far/near width ratio
 * that falls out of it is the residual `fitTurnRadius` drives to `farEyeRatio`.
 *
 * Everything is measured on the SAME map the rig renders with — the piecewise
 * linear one `turnColumnMap` builds from the grid's own columns, at the −30°
 * stop — so a solved target is a promise about the shipped keyforms, not about
 * an idealised cylinder the engine never evaluates.
 *
 * A target that does not fit is clamped when it was a default and refused when
 * the caller measured it; see TurnTargets. Clamping the EYE SHIFT keeps the
 * radius search intact on purpose: the shift is bounded by the art (the far eye
 * has to stay on the plate), so trading the foreshortening cue away to buy the
 * last few pixels of slide would flatten the cylinder — on the reference
 * character, to the sweep's ceiling — and a head that does not foreshorten does
 * not read as turning at all.
 */
export function solveTurnModel(
  targets: ResolvedTurnTargets,
  landmarks: TurnLandmarkSet,
  faceGrid: IkiWarpGrid,
  faceCenterX: number,
  faceHalfWidth: number,
  /** hair_front's own transform x/y and crop width/height, when the layer set
   *  has one — see `TurnSolveContext.hairFrontLeadFraction` and
   *  `.hairFrontSilhouette`. Absent skips the turn-lead correction and falls
   *  the silhouette-centre correction back to the ideal hold destinations,
   *  which is also correct for a layer set with no hair_front: there is then
   *  no bangs edge for either to read. */
  hairFront?: { x: number; centerY: number; cropW: number; cropH: number },
  /** hair_back's own transform x and crop width, when the layer set has one —
   *  see `TurnSolveContext.hairBack`. Only read for a `headEdges` candidate
   *  naming "hair_back". */
  hairBack?: { x: number; cropW: number },
  /** Every role with an opaque pixel in the eye-row band, per side, each with
   *  its own rest x there — see `TurnSolveContext.headEdges`. Absent (the
   *  usual case for a caller with no measured head, or one built by hand)
   *  falls the silhouette-centre correction back to hair_front on both sides. */
  headEdges?: {
    left: { role: string; x: number }[];
    right: { role: string; x: number }[];
  },
): TurnModelSolution {
  // A measured head narrower than the face it is drawn around is not a head the
  // rest of this can make sense of: the hold's whole zone lives outside the
  // plate's edge, so the plate would be sticking out of the silhouette at rest.
  if (
    targets.headHalfWidth !== undefined &&
    targets.headHalfWidth <= faceHalfWidth
  ) {
    throw new TurnTargetError(
      `auto-rig: turnTargets.headHalfWidth (${targets.headHalfWidth}) must be wider than the face plate's own half-width (${faceHalfWidth})`,
    );
  }

  // The eye row's fraction of the way from hair_front's own root (pinned, the
  // TOP of its crop) to its tips (the bottom) — 0 at the root, 1 at the tips,
  // clamped for an eye row painted outside the crop's own span (unusual
  // art). Absent without a hair_front layer, or without both eyes' own y (a
  // caller that built landmarks by hand, e.g. a lower-level test).
  const eyeRowY =
    landmarks.eye.length === 2 &&
    landmarks.eye[0].y !== undefined &&
    landmarks.eye[1].y !== undefined
      ? (landmarks.eye[0].y + landmarks.eye[1].y) / 2
      : undefined;
  const hairFrontLeadFraction =
    hairFront === undefined || eyeRowY === undefined
      ? undefined
      : Math.max(
          0,
          Math.min(
            1,
            (hairFront.centerY + hairFront.cropH / 2 - eyeRowY) /
              hairFront.cropH,
          ),
        );

  const ctx: TurnSolveContext = {
    landmarks,
    faceGrid,
    faceCenterX,
    faceHalfWidth,
    plateEdgeX: faceCenterX - faceHalfWidth,
    headHalfWidth: targets.headHalfWidth,
    // The pixels the shift fractions are fractions of. Without a measured head
    // the face plate stands in for it — see TurnTargets.headHalfWidth.
    hh: targets.headHalfWidth ?? faceHalfWidth,
    silhouetteRatio: targets.silhouetteRatio,
    // The sign is ignored (see TurnTargets.eyeShift) — taken here, once, so
    // every downstream use already has the magnitude.
    eyeShift: Math.abs(targets.eyeShift),
    clampEyeShift: targets.defaulted.has("eyeShift"),
    clampSilhouetteRatio: targets.defaulted.has("silhouetteRatio"),
    hairFrontLeadFraction,
    hairFrontSilhouette:
      hairFront === undefined
        ? undefined
        : { x: hairFront.x, cropW: hairFront.cropW, cropH: hairFront.cropH },
    hairBack,
    // A companion to a MEASURED headHalfWidth only — see its own doc.
    headEdges: targets.headHalfWidth === undefined ? undefined : headEdges,
  };
  const clamped: (keyof TurnTargets)[] = [];
  const clampInto = (value: number, [lo, hi]: [number, number]) =>
    Math.min(Math.max(value, lo), hi);

  const pass = sweepTurnRadii(ctx);
  if (pass.candidates.length === 0) {
    // Either gate can empty the sweep, and only a MEASURED target can: the
    // shift, because a defaulted one is clamped per radius rather than gated,
    // and the silhouette, because a defaulted ratio of 1 always holds — the
    // flattest radius in the sweep bends the plate's edge inward at every
    // turned stop, leaving the rest stop's reach (the plate's own half-width)
    // as the largest, and every hold base clears that. So both values below
    // are the caller's own, never a clamped stand-in.
    return pass.offeredShift
      ? {
          unreachable: true,
          field: "eyeShift",
          value: targets.eyeShift,
          attainable: pass.offeredShift,
        }
      : {
          unreachable: true,
          field: "silhouetteRatio",
          value: targets.silhouetteRatio,
          // Two different bounds, not one number twice, and computed the same
          // way regardless of which ratio was actually rejected: the
          // narrowest any radius could still hold from its own plate-fold
          // geometry, and the widest any radius could carry from its own
          // deformed-grid reach — see evaluateTurnCandidate. Neither gate
          // firing on any radius leaves that side's own general range bound.
          attainable: [
            pass.heldRatioLower === Infinity
              ? SILHOUETTE_RATIO_MIN
              : pass.heldRatioLower,
            pass.heldRatioUpper === -Infinity
              ? TURN_RATIO_MAX
              : pass.heldRatioUpper,
          ],
        };
  }

  const ratios = pass.candidates.map((c) => c.ratio);
  const attainableRatio: [number, number] = [
    Math.min(...ratios),
    Math.max(...ratios),
  ];
  let farEyeRatio = targets.farEyeRatio;
  if (farEyeRatio < attainableRatio[0] || farEyeRatio > attainableRatio[1]) {
    if (!targets.defaulted.has("farEyeRatio")) {
      return {
        unreachable: true,
        field: "farEyeRatio",
        value: targets.farEyeRatio,
        attainable: attainableRatio,
      };
    }
    farEyeRatio = clampInto(farEyeRatio, attainableRatio);
    clamped.push("farEyeRatio");
  }

  const best = fitTurnRadius(ctx, pass.candidates, farEyeRatio);
  if (!best.eye.reached) clamped.push("eyeShift");
  if (best.silhouetteCapped) clamped.push("silhouetteRatio");
  // Undo the same silhouette-centre correction the depth was solved with (see
  // evaluateTurnCandidate), so this reports the cue measure_turn_reference
  // would read off a render — eye position against that pose's OWN silhouette
  // centre — not the raw landmark slide against the fixed face centre.
  const eyeShift = (-best.eye.achieved + best.silhouetteCenterShift) / ctx.hh;

  const features = solveFeatureDepths(ctx, targets, best, eyeShift);
  if ("blocked" in features) {
    return {
      unreachable: true,
      field: features.blocked,
      value: targets[features.blocked],
      attainable: features.attainable,
    };
  }

  return {
    unreachable: false,
    radius: best.radius,
    holdBase: best.holdBase,
    holdEdgeAt: best.holdEdgeAt,
    depths: { eye: best.eye.depth, nose: features.nose, mouth: features.mouth },
    achieved: {
      eyeShift,
      farEyeRatio: best.ratio,
      silhouetteRatio: best.renderedSilhouetteRatio,
    },
    clamped: [...clamped, ...features.clamped],
  };
}

// ── bindingsForRole ───────────────────────────────────────────────────────────

// Role prefixes that belong to the eye stack (blink + optional gaze bindings).
// Hoisted to module scope so it is not reallocated on every bindingsForRole call.
const EYE_STACK_PREFIXES = ["eye_", "iris_", "pupil_", "highlight_"] as const;

/** Signed depth of each hair layer from the head cylinder's axis, as a fraction
 *  of the cylinder radius; positive is toward the viewer. Tuned by eye against
 *  the rendered turn, not derived.
 *
 *  The bangs lead the face by a little — HAIR_FRONT_DEPTH is the FRINGE TIPS'
 *  lead specifically, not the whole sheet's: the crown is root-pinned by the
 *  warp that applies it, not a binding (see bindingsForRole's doc for why).
 *  0.16 was right while the shift was rigid and the back hair stood still, the
 *  lead the only depth cue; once the back hair bent and bulged on the turn the
 *  same lead read as the bangs running ahead of the head, so it came down. At
 *  0.06 the layering all but vanishes. 0.1 is settled with the lead
 *  root-pinned: the fringe tips get it, the crown gets none.
 *
 *  hair_back follows the head at about 60% of its travel (its counter-shift
 *  takes ~20px off headDeformer's +50px). A deeper value that held the back of
 *  the head still in world space read as the face sliding over a backdrop; the
 *  turn cue for the back hair comes from its bend (bakeHairBackTurnWarp), not
 *  from lagging the head. */
const HAIR_FRONT_DEPTH = 0.1;
const HAIR_BACK_DEPTH = -0.08;

/** Rigid vertical travel of the head at full nod (px at AngleY = ±30). */
const NOD_TRAVEL = 30;
/** Geometric pitch per degree of ParamAngleY: a full ±30 nod bends the face
 *  cylinder by ±15°. The face-warp grid reaches up to the hair crown, which
 *  sits near 45° on the vertical cylinder; a full 30° pitch there drops the
 *  bangs' crown ~140px while the rigid back hair stays put, and the back
 *  hair's crown pops out above it as a second silhouette. At half pitch the
 *  drop stays under the back hair and the nod still foreshortens visibly. */
const NOD_BEND = 0.5;
/** Vertical share of the nod for hair_back, as a fraction of
 *  `headNodParallaxUnit`. The back hair gets no vertical bend of its own, so
 *  it only needs to follow the bent crown down to stay tucked beneath it.
 *  Tuned against renders as −0.07 of a turn-sized unit (sin 30°), before the
 *  nod had its own; the same pixels in the nod unit (sin 15°). */
const HAIR_BACK_NOD_DEPTH = -0.135;

/**
 * The nod's counterpart of `headTurnParallaxUnit`: the bulk vertical slide the
 * 2D bake pins out of the face warp at full nod. The nod bends at NOD_BEND of
 * the angle, so this is RADIUS_Y · sin(30° · NOD_BEND), not RADIUS_Y · sin(30°).
 */
export function headNodParallaxUnit(gridHalfHeight: number): number {
  return (
    gridHalfHeight *
    HEAD_CYLINDER_RADIUS_FACTOR *
    Math.sin(HEAD_TURN_MAX_DEG * NOD_BEND * (Math.PI / 180))
  );
}

/** Depth of the features in front of the head cylinder's NOD axis, as a
 *  fraction of its radius — the share of the bulk vertical slide the 2D bake
 *  pins out of the face warp (`headNodParallaxUnit`) that each part gets back.
 *
 *  The face contour is a cylinder rotating about its own axis: its silhouette
 *  stays put and only foreshortens, which is what the pinned bake gives it.
 *  The features painted on that surface do not stay put — they slide across it
 *  toward the far side, and a nose that stands off the surface slides further.
 *  Without their share they sat still while the outline squeezed around them,
 *  and the head read as a flat sheet bending rather than pitching.
 *
 *  The nose is the anchor of the whole read, so the parallax exists only when
 *  it is a layer of its own (the composer cuts it out of the face). With the
 *  nose painted on the face plate, any lead on the eyes and mouth inverts the
 *  3/4 view — the nose lands nearer the NEAR eye and the mouth hangs off its
 *  far side — and a blind review ranked that below no parallax at all.
 *
 *  Keyed by role family (`eye_L` → `eye`). The whole eye stack shares one
 *  depth because iris/pupil/highlight clip to the white, and the lashes fold
 *  onto it. The magnitudes are small on purpose, and judged by eye across a
 *  ladder of rigs: the nose at twice the surface's share and the mouth on the
 *  surface with the eyes is where the nod stopped looking like a plate without
 *  looking like a slide. The TURN's depths are not tuned here at all — they are
 *  solved per layer set from a measured reference (`solveTurnModel`); no nodded
 *  reference has been measured, so this axis is still by eye. */
const FEATURE_NOD_DEPTH: Readonly<Record<string, number>> = {
  eye: 0.04,
  iris: 0.04,
  pupil: 0.04,
  highlight: 0.04,
  lash: 0.04,
  brow: 0.04,
  blush: 0.04,
  mouth: 0.04,
  mouth_open: 0.04,
  nose: 0.08,
};

/** The bangs' share of the nod: the brows'. They hang from the hairline, which
 *  sits on the same surface as the brows, so they slide with them — held still
 *  while the brows slid, the fringe closed onto the brows looking up and left
 *  a bare forehead looking down. (Before the brows slid, a lead here lifted
 *  the bangs clear off them, which is why they had none.) The turn lead stays
 *  a root-pinned warp: on the turn the crown sits on the axis and must not
 *  slide. */
const HAIR_FRONT_NOD_DEPTH = FEATURE_NOD_DEPTH.brow;

/** `eye_L` → `eye`; an unsided role is its own family. */
function roleFamily(role: string): string {
  return role.replace(/_[LR]$/, "");
}

/** Which solved turn depth a feature family slides on: the nose has its own,
 *  the two mouth drawings share one, and everything else painted on the face —
 *  the eye stack, the lashes, the brows, the blush — rides with the eyes. */
function turnFamily(role: string): keyof TurnDepths {
  const family = roleFamily(role);
  if (family === "nose") return "nose";
  if (family === "mouth" || family === "mouth_open") return "mouth";
  return "eye";
}

/**
 * The depth-parallax translate bindings of a facial feature, or [] for any
 * other role, whenever the units are absent (a unit-less call is a rig without
 * a face warp to slide across), and whenever the rig has no nose layer to lead
 * (see FEATURE_NOD_DEPTH). Symmetric about zero, so the rest pose — the one
 * every proportion is judged on — is untouched.
 *
 * The two axes take their depth from different places: the turn's is SOLVED per
 * layer set from the measured cues (`turnDepths`, absent on a rig that solved
 * none), the nod's is the tuned table.
 */
function featureParallaxBindings(
  role: string,
  options: {
    parallaxUnit?: number;
    parallaxUnitY?: number;
    hasNose?: boolean;
    turnDepths?: TurnDepths;
  },
): IkiBinding[] {
  if (!options.hasNose) return [];
  // The nod's table is also the role gate: a family with no depth in it is not
  // a feature painted on the face, and slides on neither axis.
  const nodDepth = FEATURE_NOD_DEPTH[roleFamily(role)];
  if (nodDepth === undefined) return [];
  const bindings: IkiBinding[] = [];
  const turnDepth = options.turnDepths?.[turnFamily(role)] ?? 0;
  const shiftX = turnDepth * (options.parallaxUnit ?? 0);
  if (shiftX !== 0) {
    bindings.push({
      parameter: StandardParameter.AngleX,
      channel: "translateX",
      from: -shiftX,
      to: shiftX,
    });
  }
  const shiftY = nodDepth * (options.parallaxUnitY ?? 0);
  if (shiftY !== 0) {
    bindings.push({
      parameter: StandardParameter.AngleY,
      channel: "translateY",
      from: -shiftY,
      to: shiftY,
    });
  }
  return bindings;
}

/**
 * Derive the IkiBinding[] for a part from its role spec and crop dimensions.
 *
 * - face → no bindings: the contour is the cylinder itself, pinned by the bake
 * - every feature on that contour — eye stack, lashes, brows, both mouths,
 *     nose, blush — carries the AngleX translateX / AngleY translateY depth
 *     parallax: the turn's from the solved `turnDepths`, the nod's from
 *     FEATURE_NOD_DEPTH (both need `parallaxUnit` / `parallaxUnitY` and
 *     `hasNose`), on top of whatever its role adds below
 * - hair_front: an AngleY translateY nod follow at the brows' depth
 *     (HAIR_FRONT_NOD_DEPTH), with the same `hasNose` gate as the brows it
 *     follows, and nothing on the turn. Both its sway AND its
 *     AngleX turn lead are root-pinned warps attached in
 *     generateIkiFromLayerSet — a rigid translate/rotate would carry the whole
 *     sheet (crown included) with the fringe tips, instead of leading from them.
 * - hair_back: the AngleX depth-parallax translateX, and an AngleY translateY
 *     that tucks its crown under the bent front hair (needs `parallaxUnitY`)
 * - brow_L/R: BrowLeftY/RightY translateY (raise/lower) + BrowLeftAngle/RightAngle rotate
 *     (each brow rotates its own, CCW-positive)
 * - eye-stack:
 *     iris_/pupil_/highlight_ → gaze translateX + translateY (no blink binding)
 *     eye_ (white) → none here; its blink is a fold warp attached in assembly,
 *       and iris/pupil/highlight clip to it so the closing white CUTS them away
 * - mouth: MouthForm scaleX (-0.2 to 0.4), plus MouthOpen as scaleY (0 to 3)
 *     without a mouth_open layer, or as an opacity fade-out with one
 * - mouth_open: MouthOpen opacity fade-in + the same MouthForm scaleX
 *
 * Returns [] when the role has no bindings (callers skip the bindings key when
 * the array is empty).
 */
export function bindingsForRole(
  spec: RoleSpec,
  role: string,
  cropW: number,
  cropH: number,
  options: {
    hasMouthOpen?: boolean;
    parallaxUnit?: number;
    parallaxUnitY?: number;
    /** Whether the layer set has a `nose` role — the feature parallax's gate. */
    hasNose?: boolean;
    /** The turn depths solved for this layer set; without them nothing slides
     *  on the turn. */
    turnDepths?: TurnDepths;
  } = {},
): IkiBinding[] {
  return [
    ...roleOwnBindings(spec, role, cropW, cropH, options),
    ...featureParallaxBindings(role, options),
  ];
}

/** The bindings a role has for its own expression or motion — everything in
 *  `bindingsForRole`'s list except the shared feature parallax. */
function roleOwnBindings(
  spec: RoleSpec,
  role: string,
  cropW: number,
  cropH: number,
  options: {
    hasMouthOpen?: boolean;
    parallaxUnit?: number;
    parallaxUnitY?: number;
    hasNose?: boolean;
  },
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

  // Mouth form applies to whichever mouth drawing is showing.
  const mouthForm = {
    // Mouth form: scaleX from -0.2 (pursed, param=-1) to 0.4 (wide, param=1).
    parameter: StandardParameter.MouthForm,
    channel: "scaleX" as const,
    from: -0.2,
    to: 0.4,
  };

  if (role === "mouth") {
    // With an open-mouth drawing present, the closed one fades out rather than
    // being stretched. Stretching a closed mouth is what produced a smear: the
    // art is a ~15px-tall line and scaleY 3 blows it up to a blurred band.
    if (options.hasMouthOpen) {
      return [
        {
          parameter: StandardParameter.MouthOpen,
          channel: "opacity",
          from: 1,
          to: 0,
        },
        mouthForm,
      ];
    }
    return [
      // Mouth open: scaleY from 0 (closed, param=0) to 3 (wide open, param=1).
      // Only a fallback — it distorts, but it is better than a mouth that
      // cannot open at all when the layer set has no open drawing.
      {
        parameter: StandardParameter.MouthOpen,
        channel: "scaleY",
        from: 0,
        to: 3,
      },
      mouthForm,
    ];
  }

  if (role === "mouth_open") {
    return [
      {
        parameter: StandardParameter.MouthOpen,
        channel: "opacity",
        from: 0,
        to: 1,
      },
      mouthForm,
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

  if (role === "hair_front" || role === "hair_back") {
    const isFront = role === "hair_front";
    // Depth parallax on the head turn, for hair_back only: it hangs rigid off
    // headDeformer, so without a shift on top of the face turn it stayed flat
    // while the face beneath it foreshortened, reading as a cutout sliding.
    // hair_front leads the same way but as a root-pinned warp attached in
    // generateIkiFromLayerSet, not a binding here — see the doc above for why.
    const parallax: IkiBinding[] = [];
    if (!isFront) {
      const shiftX = HAIR_BACK_DEPTH * (options.parallaxUnit ?? 0);
      if (shiftX !== 0) {
        parallax.push({
          parameter: StandardParameter.AngleX,
          channel: "translateX",
          from: -shiftX,
          to: shiftX,
        });
      }
    }
    // On the nod the bangs slide with the brows they hang over — only when the
    // brows slide, i.e. with a nose to lead them — and the back hair follows
    // the bent crown down; see the two NOD_DEPTH constants.
    const frontDepth = options.hasNose ? HAIR_FRONT_NOD_DEPTH : 0;
    const shiftY =
      (isFront ? frontDepth : HAIR_BACK_NOD_DEPTH) *
      (options.parallaxUnitY ?? 0);
    if (shiftY !== 0) {
      parallax.push({
        parameter: StandardParameter.AngleY,
        channel: "translateY",
        from: -shiftY,
        to: shiftY,
      });
    }
    return parallax;
  }

  // face, blush_*, nose → nothing of their own
  return [];
}

// ── bakeEyelidFoldWarp ─────────────────────────────────────────────────────

/** Crease sits this fraction of the eye height BELOW the white's center. */
const EYELID_FOLD_CREASE = 0.15;
/** Without separate lashes, retain a thin band of the eye's own line art. */
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

// ── bakeHairBackTurnWarp ──────────────────────────────────────────────────────

/** Cylinder radius for the back hair's turn bend, as a multiple of the part's
 *  own half-width. Much flatter than the face's 1.2: the back hair spans the
 *  whole head, and at the face's curvature its near edge would fold in by
 *  ~180px. At 2.5 the near side tucks behind the face and the far side fills
 *  out, which is the whole cue. */
const HAIR_BACK_BEND_RADIUS_FACTOR = 2.5;
/** How far the back hair's far edge bulges OUT at full turn, as a fraction of
 *  the part's half-width. A cylinder bend barely moves the far edge (it just
 *  stops compressing), but on a real head the hair volume hidden behind the
 *  far side swings into view and the silhouette fills out. Grows linearly
 *  from the centre column to the far edge. Judged from renders: at ~0.32 the
 *  far strands look pulled thin. */
const HAIR_BACK_FAR_BULGE = 0.22;

/**
 * The back hair's share of the head turn, as a per-vertex warp on AngleX.
 *
 * hair_back hangs from the rigid headDeformer, not faceWarp, so without this it
 * turned as a flat sheet: the face foreshortened and slid while the silhouette
 * behind it kept its rest outline. Over the part's own columns, at a flatter
 * radius than the face: the NEAR side takes the same pinned cylinder bend the
 * face uses, so it compresses behind the face; the FAR side takes the chord of
 * its own ±30 keyform, linear in the angle, plus a bulge (HAIR_BACK_FAR_BULGE),
 * so it swings out and fills.
 *
 * Keyed on `HEAD_TURN_STOPS` — see there for why the stops sit 15° apart. The
 * near side needs that density as much as the face does: on the hero the
 * three-stop chord diverged from the analytic bend by 12.5 model units at the
 * near outer column at half turn (chord −47.8 against −35.3), enough that its
 * silhouette disagreed with the face's.
 *
 * The far side is deliberately not analytic. A cylinder's far column reverses
 * once the turn passes |asin(x/radius)|/2 (≈12° at the hero's far edge), so
 * net of the linear bulge that edge moved 52 model units through the first
 * 15° and only 24 through the second — it swung out and then stalled, where a
 * sheet revealed from behind the head should swing out at one speed. Linear in
 * the angle it is 38 and 38. The ±30 keyforms and the rest keyform are
 * unchanged by construction: at |deg| = 30 the two branches coincide, at 0
 * nothing is far, and the centre column is pinned on both.
 */
/**
 * The per-vertex piece of `bakeHairBackTurnWarp`, factored out so
 * `evaluateTurnCandidate`'s own reading of a hair_back-owned silhouette edge
 * cannot drift from what the bake actually ships: both call this with the
 * SAME `halfWidth` (hair_back's own mesh half-width, i.e. its `cropW / 2`)
 * and `x` (a vertex's position relative to hair_back's own centre — LOCAL,
 * not `partX + x`, because hair_back's bend is about its own centre column,
 * not the face's). `deg` is one of `HEAD_TURN_STOPS`; see the bake's own doc
 * for the near/far split this computes.
 */
function hairBackOffsetAt(x: number, halfWidth: number, deg: number): number {
  const radius = halfWidth * HAIR_BACK_BEND_RADIUS_FACTOR;
  const bulge = HAIR_BACK_FAR_BULGE * halfWidth;
  const DEG_TO_RAD = Math.PI / 180;
  const theta = deg * DEG_TO_RAD;
  // Turning right (s = +1) the far side is x < 0; the bulge pushes it further
  // left, i.e. outward. It grows LINEARLY with the turn — unlike the near
  // side's analytic bend — so each stop takes its own share of it: at full
  // bulge on every stop the mid stops would step it to full at 15° instead
  // of ramping it. Zero at rest.
  const s = Math.sign(deg);
  const turnFraction = Math.abs(deg) / HEAD_TURN_MAX_DEG;
  const fullTheta = s * HEAD_TURN_MAX_DEG * DEG_TO_RAD;
  const bulgeAtStop = (bulge * deg) / HEAD_TURN_MAX_DEG;
  const far = Math.max(0, (-s * x) / halfWidth);
  // The far side is the chord of its own ±30 keyform — see the doc comment.
  const bend =
    far > 0
      ? turnFraction * pinnedCylinderBend(x, radius, fullTheta)
      : pinnedCylinderBend(x, radius, theta);
  return bend - bulgeAtStop * far;
}

export function bakeHairBackTurnWarp(
  mesh: IkiMesh,
  parameter: string,
): IkiWarp {
  let left = Infinity;
  let right = -Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    left = Math.min(left, mesh.vertices[i]);
    right = Math.max(right, mesh.vertices[i]);
  }
  const halfWidth = (right - left) / 2;
  const keyforms = HEAD_TURN_STOPS.map((deg) => {
    const offsets: number[] = [];
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      const x = mesh.vertices[i];
      offsets.push(hairBackOffsetAt(x, halfWidth, deg), 0);
    }
    return { value: deg, offsets };
  });
  return { parameter, keyforms };
}

// ── bakeHairFrontSilhouetteWarp ──────────────────────────────────────────────

/**
 * How far the face plate's edge EVER travels from the face centre over the
 * turn, either side — the floor under any hold edge.
 *
 * It scans both sides at EVERY stop instead of taking the rest half-width or
 * the full-turn one, because the bend is pinned against the cylinder's bulk
 * slide and at the MID stops the near edge wins that race: it lands further out
 * than it sits at rest (207 against 201 on the hero, 315 against 300 on the
 * assembly fixture). A hold edge inside that reach would make the ramp between
 * the two run backwards.
 */
export function plateReach(
  faceCenterX: number,
  faceHalfWidth: number,
  columnMapAt: (deg: number) => TurnColumnMap,
): number {
  let reach = 0;
  for (const deg of HEAD_TURN_STOPS) {
    reach = Math.max(
      reach,
      plateReachAt(columnMapAt(deg), faceCenterX, faceHalfWidth),
    );
  }
  return reach;
}

/**
 * The same thing at ONE stop: how far the plate's edge lands from the face
 * centre, whichever side lands further out.
 *
 * Every gate on the hold edge is this number — the bake's own guard, and the
 * solver's check that a radius can hold the silhouette it was asked for. They
 * have to agree: a radius the solver accepts and the bake then refuses is a
 * generator that throws from inside its own answer.
 */
export function plateReachAt(
  map: TurnColumnMap,
  faceCenterX: number,
  faceHalfWidth: number,
): number {
  let reach = 0;
  for (const side of [-1, 1]) {
    const dest = map.mapX(faceCenterX + side * faceHalfWidth);
    reach = Math.max(reach, Math.abs(dest - faceCenterX));
  }
  return reach;
}

/**
 * The head's OUTLINE, held through the turn by the part that draws it — the
 * bangs — as a per-vertex AngleX warp on hair_front, keyed on HEAD_TURN_STOPS.
 *
 * The face warp bends everything riding its grid, so the side strands, which
 * are where a viewer reads the head's width, squeeze in with the plate and the
 * head narrows instead of turning. Ramping the bend out at the GRID level
 * cannot separate them: at FACE_GRID_CELLS columns the cell that carries a
 * strand also carries the outer eye, so un-bending one un-bends the other.
 *
 * hair_front therefore cancels the bend on itself. Part warps displace the mesh
 * vertices BEFORE those vertices bind to the rest grid, so this is an INVERSE:
 * for the position `target` a vertex should end up at, it displaces the vertex
 * to `invertX(target)`, which the grid's own map then sends back to `target`.
 * In ABSOLUTE model x (`partX + vx`) throughout, because that map is the
 * grid's, not the part's.
 *
 * `target` is a MONOTONE three-zone function of the vertex's REST distance from
 * the face centre, so the warp can never fold a hair cell:
 *   - within `faceHalfWidth`, on the plate: exactly where the grid puts it;
 *   - out to `holdBase`: a straight ramp from the plate edge's destination onto
 *     the hold edge's, `holdEdgeAt(deg)`;
 *   - beyond `holdBase`: the hold edge's own displacement, slope 1, so the
 *     outer strands carry whatever silhouette change the caller asked for.
 * The zone boundaries are REST distances and do not move with the stop — only
 * the destinations do, which is what keeps the ramp and the outer zone
 * continuous at every stop. A destination that MOVES is the point of
 * `holdEdgeAt`: a caller that has measured the head's width and wants a
 * specific silhouette ratio at full turn narrows it per stop, while the
 * boundary it pivots on stays put. `holdEdgeAt(0)` must therefore be
 * `holdBase` — enforced, since anything else displaces the bangs in the rest
 * pose, where every proportion was judged. A vertex exactly on the axis never
 * leaves the first zone, so its zero `side` is never read.
 *
 * The hold only reaches as far as the DEFORMED grid does: each side's
 * destination is capped to that side's own reach (`holdEdge` below) before
 * `invertX` runs, rather than leaving invertX's own clamp — pinning a target
 * past the edge column onto it — to decide silently. `evaluateTurnCandidate`
 * runs the identical cap first, so a CALLER target that would need it here is
 * refused there instead, and a DEFAULTED one is reported through
 * `TurnSolveReport.achieved.silhouetteRatio` rather than landing short
 * unannounced. A vertex whose own REST x already sits beyond the grid is a
 * separate limit invertX still absorbs quietly, regardless of the cap: at full
 * turn the near side's outermost mesh columns are swallowed that way — see the
 * headroom cap in generateIkiFromLayerSet.
 */
export function bakeHairFrontSilhouetteWarp(
  mesh: IkiMesh,
  partX: number,
  faceCenterX: number,
  faceHalfWidth: number,
  holdBase: number,
  holdEdgeAt: (deg: number) => number,
  columnMapAt: (deg: number) => TurnColumnMap,
): IkiWarp {
  if (holdEdgeAt(0) !== holdBase) {
    throw new Error(
      `auto-rig: bakeHairFrontSilhouetteWarp: holdEdgeAt(0) is ${holdEdgeAt(0)}, not the hold edge's own rest distance ${holdBase}, so the bangs would move in the rest pose`,
    );
  }
  const SIDES = [-1, 1] as const;
  const keyforms = HEAD_TURN_STOPS.map((deg) => {
    const map = columnMapAt(deg);
    const requestedHoldEdge = holdEdgeAt(deg);
    // Where the plate's own edges land, one per side: the ramp's inner end.
    const plateDest = SIDES.map((side) =>
      map.mapX(faceCenterX + side * faceHalfWidth),
    );
    // A hold edge inside the plate's mapped edge would run the ramp between
    // them backwards and fold the strands onto the cheek. The MID stops are the
    // ones that catch it — see plateReach.
    const reached = plateReachAt(map, faceCenterX, faceHalfWidth);
    if (requestedHoldEdge <= reached) {
      const side =
        Math.abs(plateDest[1] - faceCenterX) >
        Math.abs(plateDest[0] - faceCenterX)
          ? 1
          : -1;
      throw new Error(
        `auto-rig: bakeHairFrontSilhouetteWarp: at ${deg}° on the ${side < 0 ? "-x" : "+x"} side the hold edge sits ${requestedHoldEdge} from the face centre but the plate's edge maps to ${reached}, so the ramp between them would fold`,
      );
    }
    // The hold can only place a vertex as far out as the DEFORMED grid itself
    // reaches on that side — invertX below clamps anything past the edge
    // column onto it — so each side's destination is capped to that reach
    // (the same HOLD_CLEARANCE margin the plate check above uses) before the
    // ramp and the outer zone are built from it; solveTurnModel's
    // evaluateTurnCandidate runs this same cap first, so a caller-measured
    // target that would need it here never reaches the bake. This is a
    // per-STOP limit, never a rest-space one: at 0° `map` is the identity (no
    // bend to clamp against) and `requestedHoldEdge` already equals `holdBase`
    // exactly (enforced above), so capping it there would shrink the REST
    // silhouette itself — the rest keyform has to stay all-zero.
    const holdEdge: [number, number] =
      deg === 0
        ? [requestedHoldEdge, requestedHoldEdge]
        : (SIDES.map((_side, idx) =>
            Math.min(
              requestedHoldEdge,
              Math.abs(
                map.warpedX[idx === 0 ? 0 : map.warpedX.length - 1] -
                  faceCenterX,
              ) - HOLD_CLEARANCE,
            ),
          ) as [number, number]);
    const offsets: number[] = [];
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      const x = partX + mesh.vertices[i];
      // Shared with evaluateTurnCandidate's own silhouette-centre reading, so
      // the two cannot drift apart on what a vertex's target actually is.
      const target = hairFrontHoldTarget(
        x,
        faceCenterX,
        faceHalfWidth,
        holdBase,
        holdEdge,
        map,
      );
      // dy is zero — the silhouette hold is horizontal, like the bend it cancels.
      offsets.push(map.invertX(target) - x, 0);
    }
    return { value: deg, offsets };
  });
  return { parameter: StandardParameter.AngleX, keyforms };
}

// ── bakeHairSwayWarp ───────────────────────────────────────────────────────────

/** Tip travel of a swaying hair part at full sway, as a fraction of its own
 *  height — "the ends swing 9% of the hair's length". Long back hair therefore
 *  swings further than the bangs in pixels, as it should. */
const HAIR_SWAY_TIP_FRACTION = 0.09;
/** Exponent on distance-from-root. 1 would be a hinge (straight shear); hair
 *  bends, so the swing grows faster toward the ends. */
const HAIR_SWAY_CURL = 1.5;
/** Range of the HairSwayX / HairSwayZ output parameters. */
const HAIR_SWAY_RANGE = 20;
/** How far into that range one spring actually swings, as a fraction: the
 *  hair rigs (mass 1, stiffness 80, damping 10 → ζ ≈ 0.56) overshoot a step
 *  by ~12% on their ±10 steady state, peaking near 11.2. Used to size the
 *  bangs' swing against the face-warp grid. */
const HAIR_SWAY_PEAK_FRACTION = 0.56;

/**
 * Root-pinned sideways sway for a hair part, as a per-vertex warp.
 *
 * Parts have no pivot — a `rotate` binding turns a part about its crop centre.
 * Used for sway that swung the bangs' ROOTS off the hairline as much as their
 * ends, which is exactly how hair does not move. This warp instead leaves the
 * top row of the mesh where it is and displaces each row sideways by
 * `tipShift · u^HAIR_SWAY_CURL`, with `u` the row's distance from the top as a
 * fraction of the height: 0 at the roots, 1 at the ends.
 *
 * Keyforms sit at ±range with the rest pose in between, so a zero parameter is
 * zero offsets. Offsets are in the mesh's own pixel frame (+y up, centered),
 * matching `createPixelGridMesh` — pass the SAME mesh the part renders.
 *
 * Also reused for the bangs' AngleX turn lead: same root-pinned shape, driven
 * by the turn instead of a sway spring.
 */
export function bakeHairSwayWarp(
  mesh: IkiMesh,
  parameter: string,
  tipShift: number,
  range: number,
): IkiWarp {
  let top = -Infinity;
  let bottom = Infinity;
  for (let i = 1; i < mesh.vertices.length; i += 2) {
    top = Math.max(top, mesh.vertices[i]);
    bottom = Math.min(bottom, mesh.vertices[i]);
  }
  const height = top - bottom;
  const swing: number[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    const u = height > 0 ? (top - mesh.vertices[i + 1]) / height : 0;
    swing.push(tipShift * Math.pow(u, HAIR_SWAY_CURL), 0);
  }
  return {
    parameter,
    keyforms: [
      // `0 - v`, not `-v`: the pinned root row must stay a plain +0.
      { value: -range, offsets: swing.map((v) => 0 - v) },
      { value: range, offsets: swing },
    ],
  };
}

// ── Rigid head travel + body follow ─────────────────────────────────────────

/** Rigid sideways travel of the head at full turn (px at AngleX = ±30). */
const HEAD_TURN_TRAVEL = 50;
/** The torso's share of that travel. Below ~0.2 the shoulders still read as
 *  bolted down; at 1 the neck stops articulating. 0.3 keeps 70 % of the turn
 *  in the neck while the shoulders visibly come along. Judged in the
 *  playground, not derived. */
const BODY_TURN_FOLLOW = 0.3;
/** Vertical travel of the head at full breath (px, +y up; negative = down). */
const HEAD_BREATH_BOB = -12;
/** The torso's share of the head's breath bob, SAME direction. In phase with
 *  the head (not the sample model's counter-phase +6/−12, which reads as a
 *  shrug: chest up while the head settles) so the neck compresses by 6 px, not
 *  18. Moving DOWN also keeps the torso's flat canvas-bottom cut off-canvas —
 *  a rise would lift that hard edge into view every breath. */
const BODY_BREATH_FOLLOW = 0.5;

// ── generateIkiFromLayerSet ───────────────────────────────────────────────────

/**
 * Auto-rig: given decoded layer inputs and the shared canvas size, produce a
 * valid IkiModel ready for parseIkiModel.
 *
 *   - Validate all inputs before deriving anything.
 *   - Place parts at source-derived positions (bboxToTransform, unshifted).
 *   - Emit the standard parameters (same ids/ranges as sample-model.ts), plus a
 *     conditional HairSwayX descriptor + hair-sway physics rig when a hair_front
 *     layer is present.
 *   - Build headDeformer (matrix, neck pivot, AngleX+Breath bindings),
 *     bodyDeformer when a body layer is present (matrix, torso-base pivot,
 *     AngleX follow + Breath follow), and faceWarp (warp, FACE_GRID_CELLS²,
 *     baked cylinder warp center-relative on faceCenterX).
 *   - Mesh parts (spec.mesh===true) → width:1, height:1, pixel grid mesh sized by
 *     meshCellsFor + role bindings.
 *   - Static parts (spec.mesh===false) → width:cropW, height:cropH, no mesh.
 *   - Part ids equal the role string (deterministic, no crypto.randomUUID).
 *   - Return parseIkiModel(structuredClone(model)) — every caller gets a
 *     validated model; bad assembly fails loudly.
 *
 * `options.turnTargets` is what the head turn is fitted to: the cues a 30°
 * reference measures, defaulting to DEFAULT_TURN_TARGETS. A target the CALLER
 * passed that this layer set cannot reach throws; one that came from the
 * defaults is clamped to what it can do — see TurnTargets for why the two
 * differ, and pass `options.onTurnSolved` to see which ones were clamped and
 * what the turn ended up reaching.
 */
export function generateIkiFromLayerSet(
  layers: LayerInput[],
  canvas: { width: number; height: number },
  options: {
    turnTargets?: TurnTargets;
    /** Called once, after a turn is solved, with what it settled on. Not called
     *  for a layer set without a nose, which solves no turn at all. */
    onTurnSolved?: (report: TurnSolveReport) => void;
    /** Every role with an opaque pixel in the eye-row band, per side, when
     *  `turnTargets.headHalfWidth` was measured off that same union — a
     *  companion to it, not a turn target itself (the caller-facing contract
     *  stays the three cues). See `TurnSolveContext.headEdges`. */
    headEdges?: {
      left: { role: string; x: number }[];
      right: { role: string; x: number }[];
    };
  } = {},
): IkiModel {
  // Validate first — never derive anything from unchecked input.
  validateLayerInputs(layers, canvas);

  // Hair-sway secondary motion is gated on a front-hair layer being present.
  const hasHair = layers.some((l) => l.role === "hair_front");
  const hasMouthOpen = layers.some((l) => l.role === "mouth_open");
  // The feature parallax's gate — see FEATURE_NOD_DEPTH.
  const hasNose = layers.some((l) => l.role === "nose");
  const bodyLayer = layers.find((l) => l.role === "body");

  // ── Standard parameters — verbatim from sample-model.ts ──────────────────
  const parameters: IkiParameter[] = [
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
      id: StandardParameter.AngleY,
      name: "Head Angle Y",
      min: -30,
      max: 30,
      default: 0,
    },
    {
      id: StandardParameter.AngleZ,
      name: "Head Angle Z",
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

  // Hair-sway output params (physics-driven), declared only when there is front
  // hair to drive — keeps no-hair models free of unused parameters.
  if (hasHair) {
    parameters.push(
      {
        id: StandardParameter.HairSwayX,
        name: "Hair Sway X",
        min: -HAIR_SWAY_RANGE,
        max: HAIR_SWAY_RANGE,
        default: 0,
      },
      {
        id: StandardParameter.HairSwayZ,
        name: "Hair Sway Z",
        min: -HAIR_SWAY_RANGE,
        max: HAIR_SWAY_RANGE,
        default: 0,
      },
    );
  }

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
    cols: FACE_GRID_CELLS,
    rows: FACE_GRID_CELLS,
    points: generateGridPoints(
      FACE_GRID_CELLS,
      FACE_GRID_CELLS,
      faceGridMinX,
      faceGridMaxX,
      unionMinY,
      unionMaxY,
    ),
  };

  // The head cylinder's turn radius, and how far in front of its axis each
  // feature sits: SOLVED from the turn cues, on the very column map the face
  // warp will be baked with, so what the targets promise is what the keyforms
  // do. Without a nose there is no feature slide to fit (see FEATURE_NOD_DEPTH)
  // and nothing to solve the radius against, so it stays the grid's own reach
  // with the no-fold margin — halfW IS that reach, the grid being symmetric
  // about faceCenterX, and the bound then lands exactly on the outer columns.
  // Depth-parallax units for the hair and feature layers come off the same
  // cylinders the bake bends: this radius for the turn, the larger vertical
  // reach about the face center for the nod.
  const faceCenterY = faceTransform.y;
  const halfH = Math.max(faceCenterY - unionMinY, unionMaxY - faceCenterY);
  const faceHalfWidth = faceLayer.cropW / 2;
  const hairFrontLayer = layers.find((l) => l.role === "hair_front");
  const hairBackLayer = layers.find((l) => l.role === "hair_back");
  const turn = hasNose
    ? solveTurnModel(
        resolveTurnTargets(options.turnTargets),
        turnLandmarks(layers),
        faceGrid,
        faceCenterX,
        faceHalfWidth,
        hairFrontLayer &&
          (() => {
            const t = bboxToTransform(
              hairFrontLayer.bbox,
              hairFrontLayer.canvasW,
              hairFrontLayer.canvasH,
              "hair_front",
            );
            return {
              x: t.x,
              centerY: t.y,
              cropW: hairFrontLayer.cropW,
              cropH: hairFrontLayer.cropH,
            };
          })(),
        hairBackLayer && {
          x: bboxToTransform(
            hairBackLayer.bbox,
            hairBackLayer.canvasW,
            hairBackLayer.canvasH,
            "hair_back",
          ).x,
          cropW: hairBackLayer.cropW,
        },
        options.headEdges,
      )
    : undefined;
  if (turn?.unreachable) {
    throw new TurnTargetError(
      `auto-rig: turnTargets.${turn.field} ${turn.value} is unreachable for this layer set (attainable ${turn.attainable[0]}…${turn.attainable[1]})`,
    );
  }
  if (turn) {
    options.onTurnSolved?.({
      radius: turn.radius,
      holdBase: turn.holdBase,
      depths: turn.depths,
      achieved: turn.achieved,
      clamped: turn.clamped,
    });
  }
  const faceRadius = turn?.radius ?? halfW * HEAD_CYLINDER_RADIUS_FACTOR;
  const parallaxUnit = headTurnParallaxUnit(faceRadius);
  const parallaxUnitY = headNodParallaxUnit(halfH);

  // ── headDeformer pivot (neck): slightly below the face bottom ─────────────
  // faceBottom is the model-space y of the bottom edge of the face crop.
  // The neck pivot sits 15% of the face crop height below the face bottom.
  const faceBottom = faceTransform.y - faceCropH / 2;
  const neckPivot = {
    x: faceCenterX,
    y: faceBottom - faceCropH * 0.15, // 15% below face bottom = neck
  };

  // ── Bake the center-relative turn × nod cylinder warp ─────────────────────
  const faceWarp2d = bakeHeadTurnGridWarp2DCentered(
    faceGrid,
    StandardParameter.AngleX,
    StandardParameter.AngleY,
    faceCenterX,
    faceCenterY,
    faceRadius,
  );

  // ── Deformers ─────────────────────────────────────────────────────────────
  const deformers = [
    // headDeformer: rigid matrix rotating/translating the whole head about the
    // neck pivot; bindings mirror sample-model.ts exactly.
    {
      id: "headDeformer",
      pivot: neckPivot,
      bindings: [
        // The turn is a pure yaw: no roll rides on AngleX. The sample model's
        // ±6° "lean into the turn" was tried here and dropped — rotating about
        // the neck pivot swings the crown (~500px above it) far more than the
        // chin, so the top of the head appeared to lunge ahead of the face on
        // every turn. Roll is AngleZ's job, below.
        {
          parameter: StandardParameter.AngleX,
          channel: "translateX" as const,
          from: -HEAD_TURN_TRAVEL,
          to: HEAD_TURN_TRAVEL,
        },
        // Nod: a vertical translate only. No rotate — a pitch expressed as a
        // rigid rotation would sum with the AngleZ roll below at diagonal
        // poses, collapsing pitch into roll.
        {
          parameter: StandardParameter.AngleY,
          channel: "translateY" as const,
          from: -NOD_TRAVEL,
          to: NOD_TRAVEL,
        },
        // Tilt: the whole head rolls about the neck pivot, one degree per
        // degree. Positive AngleZ is clockwise on screen (engine rotate is
        // CCW-positive, hence the flipped from/to) — Live2D's convention: in
        // its own sample motions AngleZ carries the sign of AngleX 214 times
        // out of 222, i.e. a head that leans into its turn tilts clockwise on
        // a turn to the viewer's right. The only rotate binding on the head.
        {
          parameter: StandardParameter.AngleZ,
          channel: "rotate" as const,
          from: 30,
          to: -30,
        },
        {
          parameter: StandardParameter.Breath,
          channel: "translateY" as const,
          from: 0,
          to: HEAD_BREATH_BOB,
        },
      ],
    },
    // faceWarp: cylinder-bend warp parented to headDeformer; grid is symmetric
    // about faceCenterX so the bake's cylinder axis aligns with the face center.
    // One 2D warp carries both the turn and the nod (a deformer holds either
    // `warps` or `warp2d`, never both).
    {
      kind: "warp" as const,
      id: "faceWarp",
      parent: "headDeformer",
      grid: faceGrid,
      warp2d: faceWarp2d,
    },
  ];

  // bodyDeformer: the torso's own rigid deformer. A sibling of headDeformer, not
  // its parent, so the head's own bindings stay untouched; reparent the head
  // under it once the torso gains a rotation. Translate-only, so the pivot is
  // inert today; it sits at the torso base, where a future lean would rock from.
  if (bodyLayer) {
    const bt = bboxToTransform(
      bodyLayer.bbox,
      bodyLayer.canvasW,
      bodyLayer.canvasH,
      "body",
    );
    deformers.push({
      id: "bodyDeformer",
      pivot: { x: bt.x, y: bt.y - bodyLayer.cropH / 2 },
      bindings: [
        // Low-weight follow of the turn, same direction as the head.
        {
          parameter: StandardParameter.AngleX,
          channel: "translateX" as const,
          from: -BODY_TURN_FOLLOW * HEAD_TURN_TRAVEL,
          to: BODY_TURN_FOLLOW * HEAD_TURN_TRAVEL,
        },
        // Breath: follow the head's bob, same direction, half amplitude.
        {
          parameter: StandardParameter.Breath,
          channel: "translateY" as const,
          from: 0,
          to: BODY_BREATH_FOLLOW * HEAD_BREATH_BOB,
        },
      ],
    });
  }

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
    const roleBindings = bindingsForRole(spec, role, cropW, cropH, {
      hasMouthOpen,
      parallaxUnit,
      parallaxUnitY,
      hasNose,
      turnDepths: turn?.depths,
    });
    // `IkiPart.deformer` is optional, so a "none" role states its detachment by
    // leaving the field off rather than naming a deformer that must exist.
    const deformerId = spec.deformer === "none" ? undefined : spec.deformer;

    if (spec.mesh) {
      // Warp-deformer child: width:1, height:1 with a pixel grid mesh centered
      // at the crop center. The engine applies the part transform to position it.
      const { cols, rows } = meshCellsFor(cropW, cropH);
      const mesh = createPixelGridMesh(cols, rows, cropW, cropH);
      const part: IkiPart = {
        id: role,
        color: [1, 1, 1, 1] as [number, number, number, number],
        width: 1,
        height: 1,
        order: spec.order,
        transform: t,
        deformer: deformerId,
        mesh,
      };
      if (roleBindings.length > 0) {
        part.bindings = roleBindings;
      }
      // Hair sway and turn lead: the PhysicsMotion springs lag AngleX / AngleZ
      // onto HairSwayX / HairSwayZ (rigs and params exist only with front
      // hair), and both hair parts swing their ends on them with the roots
      // pinned. The back hair is longer, so the same fraction of its height is
      // a bigger swing.
      if ((role === "hair_front" || role === "hair_back") && hasHair) {
        let tipShift = HAIR_SWAY_TIP_FRACTION * cropH;
        let leadWarp: IkiWarp | undefined;
        let silhouetteWarp: IkiWarp | undefined;
        if (role === "hair_front") {
          // hair_front is a faceWarp child: its vertices are swayed, shifted
          // and silhouette-held BEFORE they bind to the rest grid, and past the
          // grid's edge they clamp to the edge column — the tips flatten into
          // a vertical line. The cap sizes the swing against the margin the
          // sway has to itself: the rest pose and small turns. As the turn
          // grows the silhouette hold spends that whole margin on the outermost
          // columns — holding their rest x means parking them on the grid's own
          // edge — so at the extremes their swing is swallowed whatever the cap
          // says, and reserving the hold's share here would zero the swing
          // everywhere instead, rest pose included. A wider grid would buy them
          // both room, but this generator still derives the turn radius from the
          // grid's own half-width, so widening it without decoupling the two
          // flattens the face's bend.
          const shift = HAIR_FRONT_DEPTH * parallaxUnit;
          const headroom =
            Math.min(
              faceGridMaxX - (t.x + cropW / 2),
              t.x - cropW / 2 - faceGridMinX,
            ) - shift;
          // The lead alone can never exhaust the headroom (tips get
          // 0.06·halfW against a ≥0.12·span margin); Math.max(0, headroom)
          // only guards the sway, which can still turn it negative.
          tipShift = Math.min(
            tipShift,
            Math.max(0, headroom) / HAIR_SWAY_PEAK_FRACTION,
          );
          // The bangs' turn lead: root-pinned like the sway, keyed to
          // HEAD_TURN_MAX_DEG instead of a sway spring's range — see
          // bindingsForRole's doc for why this is a warp, not a binding.
          // Warp order in the array doesn't matter; they sum.
          leadWarp = bakeHairSwayWarp(
            mesh,
            StandardParameter.AngleX,
            shift,
            HEAD_TURN_MAX_DEG,
          );
          // The bangs draw the head's outline, so they hold it through the
          // turn instead of squeezing in with the plate beneath them.
          const columnMapAt = (deg: number) =>
            turnColumnMap(faceGrid, faceCenterX, faceRadius, deg);
          // The solve already picked this zone for the radius it picked: the
          // head's measured half-width when it had one, and a destination that
          // carries the silhouette ratio through the turn. Without a solve
          // nothing here has measured where the outline actually is, so the
          // hold edge is the outermost the plate ever reaches, clear of it by a
          // pixel, and it holds its rest position: the silhouette stops
          // narrowing without being asked to move. That reach already covers
          // the rest pose (its 0° stop is the identity map), and anything
          // inside it would fold the ramp.
          const holdBase =
            turn?.holdBase ??
            plateReach(faceCenterX, faceHalfWidth, columnMapAt) +
              HOLD_CLEARANCE;
          silhouetteWarp = bakeHairFrontSilhouetteWarp(
            mesh,
            t.x,
            faceCenterX,
            faceHalfWidth,
            holdBase,
            turn?.holdEdgeAt ?? (() => holdBase),
            columnMapAt,
          );
        }
        part.warps = [
          bakeHairSwayWarp(
            mesh,
            StandardParameter.HairSwayX,
            tipShift,
            HAIR_SWAY_RANGE,
          ),
          bakeHairSwayWarp(
            mesh,
            StandardParameter.HairSwayZ,
            tipShift,
            HAIR_SWAY_RANGE,
          ),
          ...(leadWarp ? [leadWarp] : []),
          ...(silhouetteWarp ? [silhouetteWarp] : []),
        ];
      }
      // The back hair's turn: it gets no cylinder bend from a deformer, so it
      // bends on its own. Part warps sum, so this sits beside the sway.
      if (role === "hair_back") {
        part.warps = [
          ...(part.warps ?? []),
          bakeHairBackTurnWarp(mesh, StandardParameter.AngleX),
        ];
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
          // Separate lashes supply the closed-eye line. Collapse their sclera
          // clip completely so a strip of iris cannot show underneath.
          const hasLash = layers.some((l) => l.role === `lash_${spec.eyeSide}`);
          part.warps = [
            bakeEyelidFoldWarp(
              mesh,
              openParam,
              creaseWorldY - t.y,
              isLash ? LASH_FOLD_K : hasLash ? 0 : EYELID_FOLD_K,
            ),
          ];
        } else {
          part.clip = { masks: [`eye_${spec.eyeSide}`] };
        }
      }
      return part;
    } else {
      // Static quad: no mesh, sized to the crop. It still takes bindings: no
      // static role carries any today, but this branch once dropped them
      // silently, and the next static role with a binding must not hit that.
      const part: IkiPart = {
        id: role,
        color: [1, 1, 1, 1] as [number, number, number, number],
        width: cropW,
        height: cropH,
        order: spec.order,
        transform: t,
        deformer: deformerId,
      };
      if (roleBindings.length > 0) {
        part.bindings = roleBindings;
      }
      return part;
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
    // Secondary motion: one spring lags AngleX onto HairSwayX so front hair
    // sways behind the head turn (same constants as the hand-authored sample),
    // and a second lags AngleZ onto HairSwayZ so it swings behind a tilt. Two
    // rigs because a rig has one input and one output (validator-enforced).
    // Both hair parts read the outputs through root-pinned sway warps.
    // Omitted when there is no front hair to drive.
    physics: hasHair
      ? [
          {
            id: "hairSway",
            input: { parameter: StandardParameter.AngleX, weight: 1 },
            output: { parameter: StandardParameter.HairSwayX, scale: -10 },
            mass: 1,
            stiffness: 80,
            damping: 10,
          },
          {
            id: "hairTilt",
            input: { parameter: StandardParameter.AngleZ, weight: 1 },
            output: { parameter: StandardParameter.HairSwayZ, scale: -10 },
            mass: 1,
            stiffness: 80,
            damping: 10,
          },
        ]
      : undefined,
  };

  // Gate: run through parseIkiModel so bad assembly fails loudly at the source.
  // structuredClone prevents the validator's normalizing output from aliasing
  // the local object, and ensures the returned model is fully independent.
  return parseIkiModel(structuredClone(model));
}
