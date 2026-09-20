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
  type IkiDeformer,
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
  // whose grid it would stretch across the shoulders) as a MESH, so its ends
  // can swing on the hair-sway warps. It holds the head's outline STILL
  // through the turn — the head it hangs off no longer travels and it has no
  // turn warp of its own — while the face slides inside it.
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
 * the face warp. Pinning it there was right: applied to the face IN FULL it
 * shoved the head off the shoulders. But it is also the whole depth cue, so
 * layers that do NOT sit on the cylinder's axis have to get their own share of
 * it back, scaled by how far in front of (or behind) the axis they sit — the
 * bangs (HAIR_FRONT_DEPTH) and the features on the face (the solved
 * TurnDepths). The head's own travel is not one of those shares: it rides the
 * same bake as a separate uniform slide over every column (`turnSlide`), sized
 * by what the held shell has room for rather than by a depth.
 * `headNodParallaxUnit` is the same quantity on the nod axis.
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
 * No production caller since faceWarp moved to the 2D bake; kept as the PURE
 * BEND reference the 2D bake's tests compare their AngleY = 0 row against,
 * keyed on the same `HEAD_TURN_STOPS`. That row equals this bake only at
 * `travel = 0`: the bend is all the shipped row has once its uniform sideways
 * slide is taken back out.
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
 * cell folds. Deliberate bulk head motion is added back on its own, where it can
 * be tuned independently — the turn's as the 2D bake's uniform `travel` slide,
 * the nod's as a headDeformer translate — and the bangs get their
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

/** The head's uniform sideways slide at one turn stop: the whole `travel` at
 *  ±HEAD_TURN_MAX_DEG, linear in between, none at rest. The bake and
 *  `turnColumnMap` share it so the map cannot describe a slide the grid does
 *  not carry. */
function turnSlide(travel: number, angleX: number): number {
  return (travel * angleX) / HEAD_TURN_MAX_DEG;
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
 * `travel` is the head's own sideways travel at full turn (px at
 * ±HEAD_TURN_MAX_DEG), added to every point's dx as `turnSlide`'s uniform
 * per-stop offset. It belongs in the grid rather than on a headDeformer
 * translate because a rigid head translate carries the hair shell along with
 * it: in the grid only what rides the grid slides, so the face plate and its
 * features travel inside a silhouette the bangs hold still
 * (`bakeHairFrontSilhouetteWarp`), which is what a turned head actually does.
 * Being uniform it bends nothing — the AngleX = 0 cells stay all-zero and dy
 * never sees it — and being linear in AngleX it is the one part of this bake
 * the engine's parameter-linear blend reproduces EXACTLY between the stops:
 * the chord error the HEAD_TURN_STOPS spacing bounds is all the bend's.
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
  travel: number,
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
      const slide = turnSlide(travel, angleX);
      const offsets: number[] = [];
      for (let i = 0; i < pointCount; i++) {
        offsets.push(
          boundedCylinderBend(grid.points[i * 2] - centerX, radiusX, thetaX) +
            slide,
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
 * `angleX` — the bend AND the same uniform `turnSlide(travel, angleX)` the
 * bake ships, so a caller passes the travel the rig was baked with or it
 * measures a head the rig never renders. headDeformer adds no turn translate
 * on top of it.
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
  travel: number,
): TurnColumnMap {
  if (Math.abs(angleX) > HEAD_TURN_MAX_DEG) {
    throw new Error(
      `auto-rig: turnColumnMap: angleX ${angleX}° is outside the turn's ±${HEAD_TURN_MAX_DEG}° range`,
    );
  }
  const theta = angleX * (Math.PI / 180);
  const slide = turnSlide(travel, angleX);
  const restX: number[] = [];
  const warpedX: number[] = [];
  for (let col = 0; col <= grid.cols; col++) {
    const x = grid.points[col * 2];
    restX.push(x);
    warpedX.push(
      x + boundedCylinderBend(x - faceCenterX, radiusX, theta) + slide,
    );
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
  /** The head's half-width at full turn over its half-width at rest, as a
   *  RENDER measures it — the outermost opaque edge on each side, whichever
   *  part owns it. 1 holds the silhouette; below 1 narrows it. The hold that
   *  produces it is fitted to it, so a measured one is met or refused, never
   *  quietly rendered as something else. */
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
 * already drifts, because the map carries the face's own sideways slide as well
 * as the bend, and the slide is much the larger of the two — on the assembly
 * fixture at −30° the two together drift the eye pair ≈64 px toward the far
 * side, whereas the bend alone would have moved it ≈11 px toward the near one.
 * That drift therefore runs toward the FAR side, and IS the floor under every
 * shift cue: a target asking for LESS far-side shift than that drift does has
 * no non-negative depth either. Neither end is an error here — the solution is
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
      /** How far the face slides sideways inside that held boundary at full
       *  turn, px — what the face bake and the hold's own column map have to
       *  be built with, rather than the plate's own uncapped ask. */
      travel: number;
    })
  | {
      unreachable: true;
      field: keyof TurnTargets;
      /** The caller's own number — never a clamped stand-in. */
      value: number;
      /** What the caller could have asked for instead, inside the field's own
       *  accepted domain. Absent only for `silhouetteRatio`, and only when
       *  nothing that domain accepts renders on this layer set at all. */
      attainable?: [number, number];
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

/** Sampling of the hold's own usable range, per radius (see `holdRange`). What
 *  a render shows moves smoothly with the hold but not monotonically, so the
 *  range is sampled densely enough to bracket the turn-back where the travel's
 *  own feedback reverses it, not to resolve the ask — the bisection inside the
 *  bracketing interval does that. */
const TURN_HOLD_SAMPLES = 16;
/** How many times `holdRange`'s ceiling may chase its own reach. Each pass
 *  starts from the previous pass's grid reach and the travel that reach moves
 *  with is bounded by the plate's own ask, so it settles in two or three. */
const TURN_HOLD_SATURATION_PASSES = 4;

/** A radius that can carry the turn, with everything the fit reads off it. */
interface TurnCandidate {
  radius: number;
  /** The far/near eye width ratio it produces, at the eye depth below. */
  ratio: number;
  unit: number;
  /** The sideways travel it carries at full turn, px: `ctx.travel` capped to
   *  what this radius' own held shell can swallow (`shellTravelCap`). The face
   *  bake and the bangs' hold have to be built with THIS number — `map`
   *  already is. */
  travel: number;
  /** Its column map at the −30° stop, where every cue is measured. */
  map: TurnColumnMap;
  holdBase: number;
  holdEdgeAt: (deg: number) => number;
  /** Model x of the held silhouette's far edge at full turn. */
  holdEdgeX: number;
  eye: TurnDepthSolution;
  /** Whether the ratio this radius ships had to be cut to the nearest one a
   *  render of it can show. Only a DEFAULTED target ever gets here cut down —
   *  a caller-measured one the range cannot render is refused instead. */
  silhouetteClamped: boolean;
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
   *  measure it off the two images, and the measure the hold above was FITTED
   *  against. It is the target itself whenever one was reachable, so it is
   *  what `TurnSolveReport.achieved.silhouetteRatio` reports. */
  renderedSilhouetteRatio: number;
}

/** Why a radius yielded no candidate, in the blocked target's own terms. */
type TurnCandidateMiss =
  | {
      blocked: "silhouetteRatio";
      /** The ratios a render of this radius can actually SHOW, ascending —
       *  `renderedSilhouetteRatio`'s own measure, which is the measure a
       *  caller's own number came from: the narrowest and the widest over the
       *  holds this radius can ship (`holdRange`'s samples), clipped to the
       *  ratios `resolveTurnTargets` accepts. The rendered ratio is continuous
       *  in the hold, so every ratio between them is one the fit lands on the
       *  shipped mesh's own terms (`hairFrontLandingAt`, which a raster of it
       *  agrees with to a fraction of a pixel), and both ends are values a
       *  caller can resubmit and have rigged. Infinity and -Infinity when
       *  nothing inside that domain renders here: the neutral pair
       *  `sweepTurnRadii`'s own min/max ignore. */
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
  /** The sideways travel this layer set ASKS the turn for, px at full turn:
   *  `headTurnTravel` on its own plate. What a candidate actually carries is
   *  this capped to what its own held shell can swallow — see
   *  `TurnCandidate.travel`. */
  travel: number;
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
  /** Whether the ratio is this generator's own default — carried through as
   *  the hold's own ratio and clamped to what the grid can reach — or a
   *  caller's render measurement, which the hold is fitted to and which is
   *  rejected when no hold renders it. Same split as `clampEyeShift`, for the
   *  same reason. */
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
  /** Every role with an opaque pixel in the eye-row band, per side, each
   *  with its OWN rest x there — as the mcp layer measures it (`rowSpansByRole`),
   *  a companion to a MEASURED `headHalfWidth`, not a caller-facing target.
   *  `evaluateTurnCandidate` takes the OUTERMOST *landing* across a side's own
   *  list, not the outermost REST x: which part ends up furthest out after
   *  the turn can differ from which one drew furthest out at rest (the bangs'
   *  own lead carrying them past a held back-hair edge, say). Absent on the
   *  fallback path (no measured head to report edges for), which keeps
   *  hair_front's own crop edge as the silhouette point on both sides, as if
   *  it always owned them. */
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
 * hair_front's own silhouette landing at an ARBITRARY rest point — not the
 * analytic hold∘lead∘grid at that point, but what the renderer actually draws
 * there, on the mesh the bake ships. That mesh has only `meshCellsFor`'s own
 * cell counts (8 columns on the hero, ~82 px apart), every vertex carries the
 * hold's own inverse (`hairFrontHoldTarget` through `invertX`, which clamps
 * onto the deformed grid's edge) plus the row's share of the bangs' turn lead,
 * and the GPU interpolates the FINAL, already-mapped positions of the vertices
 * around a point — so this maps each of the four surrounding vertices through
 * the grid first and interpolates those, column fraction and row fraction
 * alike. Interpolating anything earlier — the pre-bind xs, or an analytic lead
 * at a row the mesh has no vertex on — is a different number wherever a
 * column-map segment break falls between two columns, or the lead's own
 * `u^HAIR_SWAY_CURL` curve bends between two rows.
 *
 * `leadTipShift` is the bangs' full tip lead in px (positive; the −30° keyform
 * carries `0 − tipShift·u^CURL`, see `bakeHairSwayWarp`) and `leadRow` the
 * measured row's own fraction of the crop's height, 0 at the pinned root and 1
 * at the tips — the two the shipped lead warp is built from, rather than one
 * pre-sampled offset, because the rows the GPU interpolates between are the
 * mesh's, not the measured row itself.
 *
 * The point need not be inside hair_front's own crop at all — past its outer
 * column this clamps to that column's own landing (`t` is clamped below), the
 * same "beyond the mesh's own edge" answer `invertX` gives a real vertex there.
 */
function hairFrontLandingAt(
  x: number,
  hairFront: { x: number; cropW: number; cropH: number },
  faceCenterX: number,
  faceHalfWidth: number,
  holdBase: number,
  cappedHoldEdge: [number, number],
  map: TurnColumnMap,
  leadTipShift: number,
  leadRow: number,
): number {
  const { cols, rows } = meshCellsFor(hairFront.cropW, hairFront.cropH);
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
  // Row 0 is the pinned root (createPixelGridMesh's own top row), row `rows`
  // the tips, and the lead each carries is the bake's own `u^CURL` at that
  // row's `u = row / rows`.
  const leadAt = (row: number): number =>
    -leadTipShift * Math.pow(row / rows, HAIR_SWAY_CURL);
  const bracket = (v: number, cells: number) => {
    const lo = Math.max(0, Math.min(cells, Math.floor(v)));
    return {
      lo,
      hi: Math.max(0, Math.min(cells, lo + 1)),
      t: Math.max(0, Math.min(1, v - lo)),
    };
  };
  const col = bracket(
    ((x - hairFront.x + hairFront.cropW / 2) / hairFront.cropW) * cols,
    cols,
  );
  const row = bracket(leadRow * rows, rows);
  const landingAt = (c: number, r: number) =>
    map.mapX(preBindAt(c) + leadAt(r));
  // `col.t` runs left→right and `row.t` top→bottom, the axes the mesh's own
  // cell is built on, so its TL→BR diagonal is `col.t === row.t` and the
  // lower-left triangle is the one with `col.t <= row.t`.
  const tl = landingAt(col.lo, row.lo);
  const br = landingAt(col.hi, row.hi);
  if (col.t <= row.t) {
    const bl = landingAt(col.lo, row.hi);
    return tl + row.t * (bl - tl) + col.t * (br - bl);
  }
  const tr = landingAt(col.hi, row.lo);
  return tl + col.t * (tr - tl) + row.t * (br - tr);
}

/**
 * The most sideways travel a MEASURED shell can swallow at this radius: how far
 * the face may slide before the plate's own edge reaches the hold's boundary.
 *
 * Read off the BEND ALONE (`bendOnlyMapAt` — the map at a stop with no travel
 * in it), the slide being what is solved for here: at each turned stop the
 * plate's two edges land either side of the face centre — `plateReachAt`'s own
 * two numbers, kept SIGNED — and the slide then pushes the edge on the side it
 * moves toward further out while pulling the other one in. So only the TOWARD
 * edge binds. A max-absolute reach would bind on the near edge instead, which
 * a tight bend throws wide precisely BEFORE the slide pulls it back inside the
 * shell, and would refuse the radius the slide was about to rescue.
 *
 * Each stop carries |deg|/30 of the travel, so the room one stop has left is
 * scaled back up by 30/|deg| to say what it allows at FULL turn, and the
 * tightest stop wins. Floored at 0: a plate already reaching past the shell
 * cannot be slid any further out.
 *
 * `holdEdgeAt` is asked for the boundary on the side the slide moves TOWARD,
 * because that is the only side the plate can breach: a measured shell need
 * not sit centred on the face (`TurnSolveContext.headEdges` records each
 * side's own extreme), and a shell 300 px out on one side and 500 on the
 * other has 300 px of room for a −30° slide however much it has for a +30°
 * one. Taking one symmetric number for both directions would let the plate
 * slide straight out of the narrow side and become the silhouette there.
 *
 * `askedTravel` is only read for the slide's SIGN at each stop, which is the
 * turn's own; the cap it returns is the whole ceiling, for the caller to take
 * a minimum with.
 */
function shellTravelCap(
  faceCenterX: number,
  faceHalfWidth: number,
  askedTravel: number,
  bendOnlyMapAt: (deg: number) => TurnColumnMap,
  holdEdgeAt: (deg: number, side: -1 | 1) => number,
): number {
  let cap = Infinity;
  for (const deg of HEAD_TURN_STOPS) {
    if (deg === 0) continue; // nothing slides at rest, so nothing to cap
    const map = bendOnlyMapAt(deg);
    const slideSign: -1 | 1 = turnSlide(askedTravel, deg) < 0 ? -1 : 1;
    // The further-out of the two edge landings ALONG the slide's own direction:
    // the toward edge's own distance from the centre, the away edge's negated.
    // The bend is monotone and pinned on the face centre, so exactly one edge
    // ever lands on the slide's own side and this max always resolves to it —
    // it is two-sided to mirror `plateReachAt`'s own shape, not to guard a
    // case the geometry allows.
    const towardReach = Math.max(
      ...[-1, 1].map(
        (side) =>
          slideSign *
          (map.mapX(faceCenterX + side * faceHalfWidth) - faceCenterX),
      ),
    );
    cap = Math.min(
      cap,
      (Math.max(0, holdEdgeAt(deg, slideSign) - HOLD_CLEARANCE - towardReach) *
        HEAD_TURN_MAX_DEG) /
        Math.abs(deg),
    );
  }
  return cap;
}

/** Everything ONE hold ratio settles inside `evaluateTurnCandidate`: the
 *  travel that ratio leaves the sliding plate, the map that carries it, and
 *  where each side's silhouette lands through that map. The ratio the rig
 *  ships is picked among these — fitted until `renderedSilhouetteRatio` is the
 *  target, whether that target was measured or defaulted. */
interface TurnHoldEval {
  /** The hold's own ratio: where its boundary is sent at full turn, as a
   *  fraction of the rest distance it keeps. */
  ratio: number;
  /** The sideways travel it leaves the face at full turn, px. */
  travel: number;
  /** Its column map at the −30° stop, where every cue is measured. */
  map: TurnColumnMap;
  holdBase: number;
  holdEdgeAt: (deg: number) => number;
  /** Whether any stop sends the hold edge inside the plate's own reach, which
   *  runs the ramp between them backwards — never acceptable, see
   *  `bakeHairFrontSilhouetteWarp`. */
  folds: boolean;
  /** The ratio at which the tightest stop's hold edge would exactly clear the
   *  plate ON THIS HOLD's own map — a seed for the range's floor, not the
   *  floor itself, see `holdRange`. */
  foldLowerBound: number;
  /** How far the DEFORMED grid reaches either side of the face centre at full
   *  turn (`TurnColumnMap.warpedX`'s edges — the bound `invertX` clamps to),
   *  which is where the hold's own destinations are capped. */
  gridReach: [number, number];
  silhouetteCenterShift: number;
  renderedSilhouetteRatio: number;
  /** The silhouette's own rest span, px: what the rendered ratio is a
   *  fraction of, and so the scale a px tolerance on it converts through. */
  restSpan: number;
}

/**
 * One radius, evaluated against the cues: the candidate it yields, or which
 * target blocked it and what it could have done instead.
 *
 * Everything hangs off ONE number here, the hold's own ratio: it sizes the
 * face's sideways travel (`shellTravelCap` measures the shell's room against
 * where the hold sends its boundary), and that travel builds the map every
 * landing is read through — so a slide that pulls an over-bent near edge back
 * inside the shell rescues a radius the bend alone would have folded, and a
 * bend that folds on its own still loses one. `evaluateHold` is that whole
 * chain for one ratio, and nothing outside it may assume a hold.
 *
 * The silhouette target is a measurement of a RENDER — the outermost opaque
 * edge on each side, whichever part owns it — so the hold is FITTED to it
 * rather than set from it: `holdRange` samples the holds this radius can ship
 * and the fit bisects the sampled interval that straddles the ask, which lands
 * on it exactly. What a render shows is NOT monotone in the hold (see
 * `holdRange`), so no sample's orientation is assumed. Where the target came
 * from decides only what happens when the range cannot render it: a
 * CALLER-measured one is refused, naming that range, and a DEFAULTED one takes
 * the nearest end of it and is reported in `TurnSolveReport.clamped`. Folding
 * is never acceptable either way.
 */
function evaluateTurnCandidate(
  ctx: TurnSolveContext,
  radius: number,
): TurnCandidate | TurnCandidateMiss {
  // The travel is settled BEFORE the map that carries it, the map being built
  // from it: the face slides INSIDE a shell the bangs hold, so what it may
  // slide is what that shell has room for — measured on the bend alone.
  const bendOnlyMapAt = (deg: number) =>
    turnColumnMap(ctx.faceGrid, ctx.faceCenterX, radius, deg, 0);
  // The measured silhouette's own rest extreme on one side, when `headEdges`
  // recorded one there. Read both by the travel cap below — which side of the
  // shell the sliding plate has to stay inside — and by `restAt`, so the two
  // cannot disagree about where the shell's boundary actually is.
  const measuredEdgeAt = (side: -1 | 1): number | undefined => {
    const candidates = side < 0 ? ctx.headEdges?.left : ctx.headEdges?.right;
    if (candidates === undefined || candidates.length === 0) return undefined;
    const xs = candidates.map((c) => c.x);
    return side < 0 ? Math.min(...xs) : Math.max(...xs);
  };
  // That side's own half-width: a measured shell can sit off centre, and the
  // narrow side is the one the plate can breach. Without an edge list there
  // the measured half-width stands in on both sides, as it always did.
  const shellHalfWidthAt = (side: -1 | 1): number => {
    const edge = measuredEdgeAt(side);
    return edge === undefined
      ? ctx.headHalfWidth!
      : side * (edge - ctx.faceCenterX);
  };
  const unit = headTurnParallaxUnit(radius);
  // The bangs' own root-pinned turn lead (bakeHairSwayWarp, shared with the
  // sway): the shipped warp's own full TIP shift, which each row takes its
  // `u^HAIR_SWAY_CURL` share of. It moves every row toward the far side by
  // that row's amount regardless of which side of the axis a column sits on —
  // a raw offset in REST x, added before the hold's own inverse is re-mapped
  // inside `hairFrontLandingAt`, exactly like `bakeHairSwayWarp` and
  // `bakeHairFrontSilhouetteWarp` sum their offsets on the shipped mesh; the
  // rows the renderer interpolates between are the MESH's, so the row fraction
  // goes down with it rather than a lead pre-sampled at the measured row.
  // Only hair_front leads — a role `landingOfRole` sends down any other path
  // does not use this at all. The hold does not move it, so it is settled
  // once, outside the fit.
  const leadTipShift =
    ctx.hairFrontLeadFraction === undefined ? 0 : HAIR_FRONT_DEPTH * unit;
  const leadRow = ctx.hairFrontLeadFraction ?? 0;

  const evaluateHold = (ratio: number): TurnHoldEval => {
    // The boundary stays put and its DESTINATION moves: the full ratio at the
    // outer stops, none of it at rest, linear in between.
    const holdEdgeFrom = (base: number) => (deg: number) =>
      base * (1 + ((ratio - 1) * Math.abs(deg)) / HEAD_TURN_MAX_DEG);
    // A measured head IS the hold's boundary, so the plate has to stay inside
    // it once slid — `shellTravelCap` is what keeps it there. A hold base
    // derived from the plate instead (below) is measured on the SLID maps and
    // clears the slid plate by construction, so there the whole ask stands.
    const travel =
      ctx.headHalfWidth === undefined
        ? ctx.travel
        : Math.min(
            ctx.travel,
            shellTravelCap(
              ctx.faceCenterX,
              ctx.faceHalfWidth,
              ctx.travel,
              bendOnlyMapAt,
              (deg, side) => {
                const rest = shellHalfWidthAt(side);
                // Never past the shell's own REST edge, whatever the hold
                // does: a hold wider than it (the fit sends one there to keep
                // a rendered ratio of 1 against the bangs' own lead) moves the
                // bangs, and the parts that draw the outline beside them — a
                // static hair_back above all — stay where they are drawn.
                return Math.min(rest, holdEdgeFrom(rest)(deg));
              },
            ),
          );
    const columnMapAt = (deg: number) =>
      turnColumnMap(ctx.faceGrid, ctx.faceCenterX, radius, deg, travel);
    // Without a measured head the boundary is the outermost the slid plate
    // ever reaches, clear of it by HOLD_CLEARANCE.
    const holdBase =
      ctx.headHalfWidth ??
      plateReach(ctx.faceCenterX, ctx.faceHalfWidth, columnMapAt) +
        HOLD_CLEARANCE;
    const holdEdgeAt = holdEdgeFrom(holdBase);

    // The bracket this hold could have been fitted in: the ratio the
    // plate-fold geometry allows, and the one the deformed grid can still
    // reach. Both are computed EVERY time, whichever one actually binds (or
    // neither), so a refusal never advertises a range the other would have
    // narrowed.
    //
    // The lower one is SAFE but not TIGHT: `reach` is read off `columnMapAt`,
    // the slid map, and with a measured head the ratio sizes that slide as
    // well (`shellTravelCap` reads `holdEdgeAt`). At the binding stop the cap
    // moves with the ratio at `holdBase` per unit, i.e. the reach moves at
    // `holdBase·|deg|/30` — exactly the rate the hold edge itself moves — so a
    // ratio narrower than this bound arrives with a smaller slide and can
    // still clear the plate. Everything at or above the bound holds; some
    // below it do too.
    let foldLowerBound = -Infinity;
    let folds = false;
    for (const deg of HEAD_TURN_STOPS) {
      if (deg === 0) continue; // proven never to bind — holdBase always clears the rest reach
      const reach = plateReachAt(
        columnMapAt(deg),
        ctx.faceCenterX,
        ctx.faceHalfWidth,
      );
      // What the ratio would have to be for the hold edge to clear the plate
      // at this stop, given the stop gets |deg|/30 of the ratio's travel.
      foldLowerBound = Math.max(
        foldLowerBound,
        1 +
          ((reach + HOLD_CLEARANCE) / holdBase - 1) *
            (HEAD_TURN_MAX_DEG / Math.abs(deg)),
      );
      if (holdEdgeAt(deg) <= reach) folds = true;
    }

    const map = columnMapAt(-HEAD_TURN_MAX_DEG);
    // The hold can only place a vertex as far out as the deformed grid itself
    // reaches on that side; past it `invertX` clamps onto the edge column (see
    // bakeHairFrontSilhouetteWarp). So the ratio this radius can actually
    // carry at full turn is each side's requested destination capped to that
    // reach, not the requested ratio itself.
    const requestedHoldEdge = holdEdgeAt(HEAD_TURN_MAX_DEG);
    const gridReach: [number, number] = [
      Math.abs(map.warpedX[0] - ctx.faceCenterX),
      Math.abs(map.warpedX[map.warpedX.length - 1] - ctx.faceCenterX),
    ];
    const cappedHoldEdge: [number, number] = [
      Math.min(requestedHoldEdge, gridReach[0] - HOLD_CLEARANCE),
      Math.min(requestedHoldEdge, gridReach[1] - HOLD_CLEARANCE),
    ];
    // The silhouette point each side's centre is read from:
    // `measure_turn_reference` reads the eye pair against the OPAQUE UNION's
    // own centre, not an assumed faceCenterX-symmetric one, so with
    // `headEdges` this is that same union's own extreme — the min (−x side) /
    // max (+x side) of every candidate's own rest x, not `holdBase`'s
    // idealised, centred stand-in for it (`holdBase` still sizes the HOLD
    // itself; this is only where the DRIFT is measured from). Without an edge
    // list for this side — no measured head at all, or one measured but with
    // nothing recorded there — the measured head's own edge (`holdBase` IS
    // that edge then, on the nose by construction), or hair_front's own crop
    // edge otherwise: the best available stand-in for where a render's
    // outermost opaque pixel sits when nothing measured it.
    const restAt = (side: -1 | 1): number => {
      const edge = measuredEdgeAt(side);
      if (edge !== undefined) return edge;
      return ctx.headHalfWidth !== undefined ||
        ctx.hairFrontSilhouette === undefined
        ? ctx.faceCenterX + side * holdBase
        : ctx.hairFrontSilhouette.x +
            (side * ctx.hairFrontSilhouette.cropW) / 2;
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
            leadTipShift,
            leadRow,
          );
    // Where a named role's OWN rest x lands after the turn — the mcp measures
    // the union of every layer's opaque pixels, so an edge can belong to any
    // role, not just the bangs. `face` and the FEATURE_NOD_DEPTH family (the
    // eye stack, lashes, brows, blush, the nose, both mouths) ride `faceWarp`,
    // so their own path is `map.mapX` — WITHOUT that family's own depth
    // parallax, which is not solved yet at this point in the sweep (the eye's
    // own signed solve below needs `silhouetteCenterShift`, computed from
    // this, and nose/mouth's are not solved until `solveFeatureDepths`, after
    // a radius is even chosen). The omission is harmless not because the
    // magnitude is small but because none of this family can realistically OWN
    // the eye-row silhouette edge in the first place: they sit near the face's
    // own centre, well inside whatever hair, face-plate, or body edge is
    // actually outermost there. `hair_back` and `body` ride their own rigid
    // deformers, not faceWarp, so neither uses `map` at all. Anything not in
    // `ROLE_TABLE` is a bug, not a role to render as unmoved.
    const landingOfRole = (role: string, x: number): number => {
      if (role === "hair_front") return hairFrontAt(x);
      if (role === "hair_back") {
        // It holds the head's outline: it rides a head that no longer travels
        // and has no turn binding or warp of its own, so it lands where it
        // sits.
        return x;
      }
      if (role === "body") {
        // The head no longer translates on the turn — its travel is in the
        // face grid, where only what rides the grid carries it — so the head's
        // frame is the rest frame and the body lands at its own AngleX travel
        // alone: the "from" value of its own translateX binding at this stop.
        return x - BODY_TURN_FOLLOW * travel;
      }
      if (
        role === "face" ||
        FEATURE_NOD_DEPTH[roleFamily(role)] !== undefined
      ) {
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
    return {
      ratio,
      travel,
      map,
      holdBase,
      holdEdgeAt,
      folds,
      foldLowerBound,
      gridReach,
      // How far the silhouette's own centre drifts off the face centre at full
      // turn, against how far it already sat off centre at rest (zero unless
      // hair_front's crop is itself off-centre) — the held shell keeps its own
      // place while the face slides inside it, so this is the drift the hold
      // and the bangs' lead leave behind, and the slide itself shows up in the
      // eye cue instead of cancelling out of it.
      // `measure_turn_reference` reads the eye pair against THIS moved centre,
      // not the face centre, so it is what the eye cue is corrected by.
      silhouetteCenterShift:
        (landingAt(1) + landingAt(-1)) / 2 - (restAt(1) + restAt(-1)) / 2,
      // What a render actually shows: the real landing span over the real rest
      // span, the same pair silhouetteCenterShift reads — the measure the
      // hold is FITTED against, see this function's own doc.
      renderedSilhouetteRatio:
        (landingAt(1) - landingAt(-1)) / (restAt(1) - restAt(-1)),
      restSpan: restAt(1) - restAt(-1),
    };
  };

  // The widest hold worth trying at this radius: once BOTH sides' requested
  // destinations sit outside the deformed grid's own reach, the bake caps them
  // there (`bakeHairFrontSilhouetteWarp`) and a wider hold renders the
  // identical silhouette. That reach moves with the travel a wider hold buys,
  // so this walks up to it — each pass starting from the previous one's own
  // reach — and settles, the travel being bounded by the plate's own ask.
  const saturatedHold = (): TurnHoldEval => {
    let hold = evaluateHold(1);
    for (let i = 0; i < TURN_HOLD_SATURATION_PASSES; i++) {
      const needed =
        (Math.max(hold.gridReach[0], hold.gridReach[1]) - HOLD_CLEARANCE) /
        hold.holdBase;
      if (needed <= hold.ratio) break;
      hold = evaluateHold(needed);
    }
    return hold;
  };

  // Every hold this radius can actually ship, sampled across its own usable
  // range: from the narrowest that does not fold the ramp onto the strands up
  // to that saturation point. What a render SHOWS is not monotone in the hold
  // — a wider hold buys more travel (`shellTravelCap`), and more travel pulls
  // the deformed grid's near-side reach IN, which caps the near destination
  // the hold was widening — so the range is sampled rather than read off its
  // two ends, and the fit below works in whichever sampled interval actually
  // straddles the ask. Every sample is fold-free, so anything the fit returns
  // from one can be shipped.
  //
  // `foldLowerBound` is a SEED for the floor, not the floor: it reads the
  // plate's reach off one hold's own map, and that reach does not move with
  // the hold the way it assumes. A narrower hold buys a smaller slide, which
  // pulls the plate's toward edge in but pushes its AWAY edge out, and
  // `plateReachAt` takes the larger of the two — so the seed can itself fold,
  // and the real floor is bisected between it and the saturation point, where
  // the slide is largest and the hold furthest out. Undefined when even that
  // point folds: the radius can hold nothing, so it has nothing to offer.
  const holdRange = (): TurnHoldEval[] | undefined => {
    const ceiling = saturatedHold();
    if (ceiling.folds) return undefined;
    let floor = evaluateHold(Math.min(ceiling.foldLowerBound, ceiling.ratio));
    if (floor.folds) {
      let lo = floor;
      let hi = ceiling;
      for (let i = 0; i < TURN_BISECT_STEPS; i++) {
        const mid = evaluateHold((lo.ratio + hi.ratio) / 2);
        if (mid.folds) lo = mid;
        else hi = mid;
      }
      floor = hi;
    }
    const samples = [floor];
    for (let i = 1; i < TURN_HOLD_SAMPLES; i++) {
      const sample = evaluateHold(
        floor.ratio + ((ceiling.ratio - floor.ratio) * i) / TURN_HOLD_SAMPLES,
      );
      if (!sample.folds) samples.push(sample);
    }
    samples.push(ceiling);
    return samples;
  };

  /** What this radius offers a refused caller: the ratios a render of it can
   *  show, clipped to the domain `resolveTurnTargets` accepts — offering one
   *  outside it would be offering a number the validator throws on. Clipped
   *  PER RADIUS, before `sweepTurnRadii` unions them, so each end of what the
   *  sweep advertises is an end some radius can really be fitted to. The
   *  neutral pair when nothing survives that clip (or there was nothing to
   *  clip): `sweepTurnRadii`'s own min/max ignore it. */
  const silhouetteMiss = (span?: [number, number]): TurnCandidateMiss => {
    const lower = Math.max(span?.[0] ?? Infinity, SILHOUETTE_RATIO_MIN);
    const upper = Math.min(span?.[1] ?? -Infinity, TURN_RATIO_MAX);
    return lower > upper
      ? { blocked: "silhouetteRatio", lower: Infinity, upper: -Infinity }
      : { blocked: "silhouetteRatio", lower, upper };
  };

  const asked = ctx.silhouetteRatio;
  // The hold the target names outright, tried first. Where it already renders
  // the target it IS the answer: a static shell renders its own rest span
  // whatever the hold does, so every hold there is equally exact, and the one
  // that leaves the bangs where the target says is the one to ship rather than
  // an arbitrarily narrower one a search would settle on first.
  const natural = evaluateHold(asked);
  // solveTurnDepthSigned's own px slack, on the span the rendered ratio is a
  // fraction of: the fit stops there, and a caller resubmitting the exact
  // interval a refusal reported is not refused again by a float ulp of the
  // division that reported it.
  const eps = TURN_DEPTH_EPS / natural.restSpan;
  let hold: TurnHoldEval;
  let silhouetteClamped = false;
  if (
    !natural.folds &&
    Math.abs(natural.renderedSilhouetteRatio - asked) <= eps
  ) {
    hold = natural;
  } else {
    const samples = holdRange();
    if (samples === undefined) return silhouetteMiss();
    // Every ratio between the extreme samples is on offer, the rendered ratio
    // being continuous in the hold: the sampled values are all attainable and
    // so is everything they straddle.
    const rendered = samples.map((h) => h.renderedSilhouetteRatio);
    const span: [number, number] = [
      Math.min(...rendered),
      Math.max(...rendered),
    ];
    // Of two holds, the one whose render is nearer the target — and between
    // two that both hit it, the one whose own ratio is nearer what was asked,
    // so a flat stretch of the range does not move the bangs for nothing.
    const nearer = (a: TurnHoldEval, b: TurnHoldEval) => {
      const ea = Math.abs(a.renderedSilhouetteRatio - asked);
      const eb = Math.abs(b.renderedSilhouetteRatio - asked);
      if (ea <= eps && eb <= eps) {
        return Math.abs(a.ratio - asked) <= Math.abs(b.ratio - asked) ? a : b;
      }
      return ea <= eb ? a : b;
    };
    if (asked < span[0] - eps || asked > span[1] + eps) {
      // A CALLER-measured ratio no hold renders is refused in the rendered
      // range's own terms; a DEFAULTED one takes the nearest end of that range
      // and says so — see solveTurnModel's report.
      if (!ctx.clampSilhouetteRatio) return silhouetteMiss(span);
      const wanted = asked < span[0] ? span[0] : span[1];
      hold = samples.reduce((a, b) =>
        Math.abs(b.renderedSilhouetteRatio - wanted) <
        Math.abs(a.renderedSilhouetteRatio - wanted)
          ? b
          : a,
      );
      silhouetteClamped = true;
    } else {
      // The sampled interval the target actually sits in, bisected on the
      // HOLD: the rendered ratio is continuous in it, so an interval whose
      // ends straddle the target contains a hold that renders it — whichever
      // way round those ends sit, which is why the direction is read off the
      // interval rather than assumed.
      let best = samples.reduce(nearer);
      let lo: TurnHoldEval | undefined;
      let hi: TurnHoldEval | undefined;
      for (let i = 0; i + 1 < samples.length; i++) {
        const a = samples[i].renderedSilhouetteRatio - asked;
        const b = samples[i + 1].renderedSilhouetteRatio - asked;
        if (a * b <= 0) {
          lo = samples[i];
          hi = samples[i + 1];
          break;
        }
      }
      for (let i = 0; lo !== undefined && hi !== undefined; i++) {
        if (
          i >= TURN_BISECT_STEPS ||
          Math.abs(best.renderedSilhouetteRatio - asked) <= eps
        ) {
          break;
        }
        const mid = evaluateHold((lo.ratio + hi.ratio) / 2);
        if (!mid.folds) best = nearer(best, mid);
        // Keep the half the target is still inside, in the orientation these
        // two ends establish.
        if (
          (mid.renderedSilhouetteRatio - asked) *
            (lo.renderedSilhouetteRatio - asked) >
          0
        ) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      hold = best;
    }
  }
  // Folding is never acceptable, fitted or clamped: `natural` is only kept
  // when it does not fold, every `holdRange()` sample is fold-free, and the
  // fit only ever replaces `best` with a non-folding evaluation — so a folding
  // hold here is a broken invariant, not a case to handle.
  if (hold.folds) {
    throw new Error(
      "auto-rig: evaluateTurnCandidate: the hold it settled on folds",
    );
  }
  const {
    travel,
    map,
    holdBase,
    holdEdgeAt,
    silhouetteCenterShift,
    renderedSilhouetteRatio,
  } = hold;
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
    travel,
    map,
    holdBase,
    holdEdgeAt,
    holdEdgeX,
    eye,
    silhouetteClamped,
    silhouetteCenterShift,
    renderedSilhouetteRatio,
  };
}

/** A swept radius: the candidate it yielded and WHERE in the sweep it sat.
 *  The feasible radii are not one unbroken run any more — a caller-measured
 *  silhouette refuses a radius whose own rendered range cannot be fitted to
 *  it, and that can bite in the middle of the sweep — so which candidates are
 *  NEIGHBOURS has to be read off the sweep rather than off the array. */
type SweptCandidate = TurnCandidate & { sweepIndex: number };

/** The radii that can carry the turn, and what blocked the ones that cannot. */
interface TurnSweep {
  candidates: SweptCandidate[];
  /** The narrowest silhouette a render of the radii blocked for the silhouette
   *  could have shown, inside the ratios the targets accept (see
   *  `TurnCandidateMiss.lower`); Infinity when no radius was blocked for the
   *  silhouette at all, or when none of the blocked ones renders anything a
   *  caller is allowed to ask for. */
  heldRatioLower: number;
  /** The widest silhouette a render of any radius blocked for the silhouette
   *  could have shown — an UPPER bound, same convention; -Infinity in the same
   *  two cases. */
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
  const candidates: SweptCandidate[] = [];
  let heldRatioLower = Infinity;
  let heldRatioUpper = -Infinity;
  let offeredShift: [number, number] | undefined;
  for (let i = 0; i < TURN_SWEEP_SAMPLES; i++) {
    const radius =
      minRadius * Math.pow(maxRadius / minRadius, i / (TURN_SWEEP_SAMPLES - 1));
    const result = evaluateTurnCandidate(ctx, radius);
    if (!("blocked" in result)) {
      candidates.push({ ...result, sweepIndex: i });
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

/** One unbroken run of the sweep's feasible radii, and the far/near ratios it
 *  covers: the ratio is continuous in the radius, so a run spans every ratio
 *  between its own extremes, and a target BETWEEN two runs is one no radius in
 *  the sweep produces. */
interface TurnRatioCluster {
  candidates: SweptCandidate[];
  /** Ascending. */
  ratios: [number, number];
}

/** The sweep's feasible radii, split where it skipped one. A caller-measured
 *  silhouette can refuse a radius in the middle of the range — the rendered
 *  ratios a radius can be fitted to move with it — and a far/near ratio that
 *  falls in the gap between two runs is attainable on neither, so the two must
 *  not be bracketed across. */
function ratioClusters(candidates: SweptCandidate[]): TurnRatioCluster[] {
  const clusters: TurnRatioCluster[] = [];
  let run: SweptCandidate[] = [];
  const close = () => {
    if (run.length === 0) return;
    const ratios = run.map((c) => c.ratio);
    clusters.push({
      candidates: run,
      ratios: [Math.min(...ratios), Math.max(...ratios)],
    });
    run = [];
  };
  for (const candidate of candidates) {
    const previous = run[run.length - 1];
    if (
      previous !== undefined &&
      candidate.sweepIndex !== previous.sweepIndex + 1
    ) {
      close();
    }
    run.push(candidate);
  }
  close();
  return clusters;
}

/**
 * The radius whose far/near ratio comes nearest `target`, inside ONE cluster
 * of sweep-adjacent radii.
 *
 * The ratio is not monotone in the radius — a flatter cylinder foreshortens
 * less but needs a deeper slide to move the eyes as far, and the grid's cells
 * are straight lines the landmarks cross at different radii — so the cluster's
 * samples are scanned from the LARGEST radius down for the first adjacent pair
 * that brackets the target: where two radii both fit, the flatter head is the
 * one that keeps more of the face on the analytic part of the cylinder. The
 * bisection inside that pair is geometric, matching the log-spaced sweep.
 *
 * A pair that is adjacent in the array is adjacent in the SWEEP here, the
 * cluster being one unbroken run of it (see `ratioClusters`) — that is what
 * keeps the bisection out of a gap the sweep already found. Finer gaps inside
 * a pair it cannot see: the bisection stops when it lands on a refused radius,
 * and `solveTurnModel` checks what this actually reached against the target
 * rather than trusting it.
 */
function fitTurnRadius(
  ctx: TurnSolveContext,
  candidates: SweptCandidate[],
  target: number,
): TurnCandidate {
  // The cluster's whole span, narrowed to the bracketing pair — there is one
  // whenever the target sits inside its own ratio range.
  let lo: TurnCandidate = candidates[0];
  let hi: TurnCandidate = candidates[candidates.length - 1];
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
    // What this plate asks the turn for; each candidate caps it to its own
    // shell — see TurnSolveContext.travel.
    travel: headTurnTravel(faceHalfWidth),
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
    // and the silhouette, because a defaulted ratio of 1 leaves the hold edge
    // at its own rest distance — without a measured head that distance is the
    // plate's own scanned reach plus a pixel (`plateReach`), which clears every
    // stop by construction, and with one it is the head the slide is capped to
    // stay inside (`shellTravelCap`). So both values below are the caller's
    // own, never a clamped stand-in.
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
          // Two different bounds, not one number twice, and computed the
          // same way regardless of which ratio was actually rejected: both
          // are ratios a RENDER could have shown (the measure the caller's
          // own number came from), the narrowest and the widest any radius
          // could be fitted to, with every ratio between them one it can be
          // fitted to exactly; see evaluateTurnCandidate, which clips each
          // radius' own range to the domain `resolveTurnTargets` accepts
          // before it gets here. Absent when that left every radius with
          // nothing: no ratio a caller is allowed to ask for renders at all.
          attainable:
            pass.heldRatioLower === Infinity ||
            pass.heldRatioUpper === -Infinity
              ? undefined
              : [pass.heldRatioLower, pass.heldRatioUpper],
        };
  }

  // The radii that survived, in unbroken runs of the sweep: a far/near ratio
  // between two runs is one no radius produces, so the fit is confined to the
  // run that covers the target and a target no run covers is out of reach
  // rather than bisected across the gap. A DEFAULTED silhouette leaves every
  // radius standing and so leaves exactly one run — the gaps are what a
  // CALLER-measured one opens (see evaluateTurnCandidate).
  const clusters = ratioClusters(pass.candidates);
  const distanceTo = (c: TurnRatioCluster) =>
    Math.max(
      c.ratios[0] - targets.farEyeRatio,
      targets.farEyeRatio - c.ratios[1],
      0,
    );
  let farEyeRatio = targets.farEyeRatio;
  let cluster = clusters.find(
    (c) =>
      farEyeRatio >= c.ratios[0] - TURN_DEPTH_EPS &&
      farEyeRatio <= c.ratios[1] + TURN_DEPTH_EPS,
  );
  if (cluster === undefined) {
    // What a caller could have asked for instead is one run's own range, not
    // the span across the gaps: every ratio inside it is one this sweep
    // reaches. The nearest run is the one to name.
    cluster = clusters.reduce((a, b) =>
      distanceTo(b) < distanceTo(a) ? b : a,
    );
    if (!targets.defaulted.has("farEyeRatio")) {
      return {
        unreachable: true,
        field: "farEyeRatio",
        value: targets.farEyeRatio,
        attainable: cluster.ratios,
      };
    }
    farEyeRatio = clampInto(farEyeRatio, cluster.ratios);
    clamped.push("farEyeRatio");
  }

  const best = fitTurnRadius(ctx, cluster.candidates, farEyeRatio);
  // What the fit actually reached, against what it was asked for: inside a run
  // the ratio is continuous, but the bisection can still stop on a radius the
  // silhouette gate refuses — a gap finer than the sweep resolves — and land
  // on a bracket end instead. A miss is refused or reported, never passed off
  // as met. The tolerance is solveTurnDepthSigned's own slack read in this
  // cue's own units, which are already dimensionless: the far/near ratio is a
  // width over a width, so there is no px scale to divide it by.
  if (Math.abs(best.ratio - farEyeRatio) > TURN_DEPTH_EPS) {
    if (!targets.defaulted.has("farEyeRatio")) {
      return {
        unreachable: true,
        field: "farEyeRatio",
        value: targets.farEyeRatio,
        attainable: cluster.ratios,
      };
    }
    if (!clamped.includes("farEyeRatio")) clamped.push("farEyeRatio");
  }
  if (!best.eye.reached) clamped.push("eyeShift");
  // Only a DEFAULTED silhouette can be here cut down: the fit lands a
  // caller-measured one or refuses the radius outright (evaluateTurnCandidate),
  // so a ratio that reached this point was either rendered as asked — nothing
  // to report — or is this generator's own default, cut to the nearest ratio a
  // render of this layer set can show.
  if (best.silhouetteClamped) clamped.push("silhouetteRatio");
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
    travel: best.travel,
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

/** Signed depth of the bangs from the head cylinder's axis, as a fraction of
 *  the cylinder radius; positive is toward the viewer. Tuned by eye against
 *  the rendered turn, not derived. The back hair takes no share of it: it
 *  holds the head's outline while the face slides inside it.
 *
 *  The bangs lead that sliding face by a little — this is the FRINGE TIPS'
 *  lead specifically, not the whole sheet's: the crown is root-pinned by the
 *  warp that applies it, not a binding (see bindingsForRole's doc for why).
 *  0.16 was right while the shift was rigid and the whole head travelled
 *  with it, the lead the only depth cue; with the head no longer travelling,
 *  the lead is the bangs' only motion against a held shell, and that much of
 *  it reads as them running ahead, so it came down. At 0.06 the layering all
 *  but vanishes. 0.1 is settled with the lead root-pinned: the fringe tips get
 *  it, the crown gets none. */
const HAIR_FRONT_DEPTH = 0.1;

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
 * - hair_back: nothing on the turn — it rides a head that no longer travels,
 *     so it holds the head's outline while the face slides inside it — and an
 *     AngleY translateY that tucks its crown under the bent front hair (needs
 *     `parallaxUnitY`)
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
    // Neither hair part takes a binding on the TURN. hair_back holds the
    // head's outline still while the face slides inside it, and hair_front
    // leads that slide through a root-pinned warp attached in
    // generateIkiFromLayerSet, not a binding here — see the doc above for why.
    const parallax: IkiBinding[] = [];
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

// ── bakeHairFrontSilhouetteWarp ──────────────────────────────────────────────

/**
 * How far the face plate's edge EVER travels from the face centre over the
 * turn, either side — the floor under any hold edge.
 *
 * It scans both sides at EVERY stop instead of taking the rest half-width or
 * the full-turn one, because the plate slides as well as bends, and the two
 * pull against each other on the edge the slide pushes out while the bend
 * foreshortens it in — the FAR one, whichever physical side that is at this
 * turn's sign, which is why the scan takes both. The slide's push is linear in
 * the angle and the same at any radius; the bend's pull is the cylinder's own,
 * so it shrinks as the radius flattens and gains on the slide as the angle
 * grows. Which stop reaches furthest therefore moves with the radius: on the
 * assembly fixture, whose plate is 300 px half-wide, the bend leads from the
 * first stop at a radius of 1.2 half-widths (REST wins, 300 px), the slide
 * leads until the bend catches it at 4 (a MID stop, 317 px), and is never
 * caught at 8 (FULL turn, 325 px). A hold edge inside that reach would make
 * the ramp between the two run backwards.
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
 * The face warp bends AND slides everything riding its grid, so the side
 * strands, which are where a viewer reads the head's width, squeeze in with the
 * plate and travel off with it: the head narrows and shifts instead of turning.
 * Ramping that out at the GRID level cannot separate them: at FACE_GRID_CELLS
 * columns the cell that carries a strand also carries the outer eye, so
 * un-bending one un-bends the other.
 *
 * hair_front therefore cancels the map — bend and slide both — on itself. Part
 * warps displace the mesh vertices BEFORE those vertices bind to the rest grid,
 * so this is an INVERSE: for the position `target` a vertex should end up at,
 * it displaces the vertex to `invertX(target)`, which the grid's own map then
 * sends back to `target`. In ABSOLUTE model x (`partX + vx`) throughout,
 * because that map is the grid's, not the part's.
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
 * runs the identical cap inside the hold it ships, so what it fits and reports
 * is what lands here: a CALLER target the cap keeps any hold from rendering is
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
    // them backwards and fold the strands onto the cheek. Which stop catches it
    // moves with the radius — see plateReach.
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
      // dy is zero — the hold is horizontal, like the map (bend and slide) it
      // cancels.
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

// ── Head turn travel + body follow ──────────────────────────────────────────

/**
 * The head's sideways travel at full turn (AngleX = ±30), as a fraction of the
 * face plate's own half-width.
 *
 * A fraction, not px, because the travel no longer cancels out of what the turn
 * is fitted to. It used to ride headDeformer, moving the eyes and the silhouette
 * together, so the measured `eyeShift` cue never saw it; baked into the face
 * grid (`bakeHeadTurnGridWarp2DCentered`'s `travel`) it moves the face inside a
 * held silhouette and IS the floor under that cue — an absolute px value would
 * be a quarter of one plate's half-width and the whole of a smaller one's.
 * 0.25 was judged in the playground on a 400 px-wide plate, where it is the
 * 50 px that shipped.
 */
const HEAD_TURN_TRAVEL_RATIO = 0.25;

/** That travel in px, for a plate of this half-width: what a layer set ASKS
 *  the turn for. A solve with a measured head cuts it down to what the held
 *  silhouette has room for — see `shellTravelCap`. */
function headTurnTravel(faceHalfWidth: number): number {
  return HEAD_TURN_TRAVEL_RATIO * faceHalfWidth;
}

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
 *   - Build headDeformer (matrix, neck pivot, nod/tilt/breath bindings — the
 *     turn translates nothing rigidly; its travel is in the face warp),
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
        options.headEdges,
      )
    : undefined;
  if (turn?.unreachable) {
    throw new TurnTargetError(
      turn.attainable === undefined
        ? // Only a silhouette can land here: nothing the field's own accepted
          // range allows renders on this layer set, so there is no interval to
          // offer instead — see `silhouetteMiss` in evaluateTurnCandidate.
          `auto-rig: turnTargets.${turn.field} ${turn.value} is unreachable for this layer set, and so is every ${turn.field} in [${SILHOUETTE_RATIO_MIN}, ${TURN_RATIO_MAX}]`
        : `auto-rig: turnTargets.${turn.field} ${turn.value} is unreachable for this layer set (attainable ${turn.attainable[0]}…${turn.attainable[1]})`,
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
  // The turn's sideways travel for THIS plate, in px: what the solve settled
  // on — this plate's own ask, cut down to what the held silhouette has room
  // for — or that ask uncut when there was no solve to size it against. The
  // face bake, the bangs' hold and the body's follow all key off this one
  // number: the hold inverts the very map the face renders, so a second value
  // here would have it hold against a turn nothing ships.
  const headTravel = turn?.travel ?? headTurnTravel(faceHalfWidth);
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
    headTravel,
  );

  // ── Deformers ─────────────────────────────────────────────────────────────
  const deformers: IkiDeformer[] = [
    // headDeformer: rigid matrix rotating/translating the whole head about the
    // neck pivot. Same bindings as sample-model.ts apart from the turn, which
    // moves the face inside the head rather than the head itself (see below).
    {
      id: "headDeformer",
      pivot: neckPivot,
      bindings: [
        // No AngleX binding: the turn moves NOTHING rigidly. Its sideways
        // travel is baked into faceWarp's own grid (see
        // bakeHeadTurnGridWarp2DCentered's `travel`) so the face slides inside
        // a silhouette the bangs hold; a translate here would take the hair
        // shell with it. Nor is the turn a roll — the sample model's ±6° "lean
        // into the turn" was tried here and dropped, since rotating about the
        // neck pivot swings the crown (~500px above it) far more than the chin,
        // so the top of the head appeared to lunge ahead of the face on every
        // turn. Roll is AngleZ's job, below.

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
        // Low-weight follow of the turn, same direction as the face's own
        // slide — the only rigid part of the travel left.
        {
          parameter: StandardParameter.AngleX,
          channel: "translateX" as const,
          from: -BODY_TURN_FOLLOW * headTravel,
          to: BODY_TURN_FOLLOW * headTravel,
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
            turnColumnMap(faceGrid, faceCenterX, faceRadius, deg, headTravel);
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
