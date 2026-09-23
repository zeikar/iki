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

/**
 * The warp deformers the face and its features turn on — one per group of
 * parts that share a turn depth and a place on the face: the plate, each
 * side's eye stack (white, iris, pupil, highlight, lash), the two mouth
 * drawings, the nose, each brow and each blush. Every one is a `warp2d` over
 * a grid sized to its own members, parented to `headDeformer`, baked from the
 * one solved surface and emitted only when a member layer exists
 * (`generateIkiFromLayerSet`). `faceWarp` keeps the id the shared face grid
 * had.
 */
const TURN_GROUP_IDS = [
  "faceWarp",
  "eyeWarp_L",
  "eyeWarp_R",
  "mouthWarp",
  "noseWarp",
  "browWarp_L",
  "browWarp_R",
  "blushWarp_L",
  "blushWarp_R",
] as const;
/** One of `TURN_GROUP_IDS`. */
export type TurnGroupId = (typeof TURN_GROUP_IDS)[number];
const TURN_GROUP_ID_SET: ReadonlySet<string> = new Set<string>(TURN_GROUP_IDS);

/** Whether a `RoleSpec.deformer` names one of the per-group turn warps — the
 *  test for "a part painted on the face" wherever the generator or the solve
 *  needs it. Exported at module level for the tests, not from the package. */
export function isTurnGroup(id: string): id is TurnGroupId {
  return TURN_GROUP_ID_SET.has(id);
}

export interface RoleSpec {
  /**
   * Which deformer the part is attached to in the generated rig: its turn
   * group's warp for anything painted on the face (`TurnGroupId`), the rigid
   * head or body otherwise. `"none"` attaches it to nothing, so it holds
   * still in world space; no shipped role uses it.
   */
  deformer: TurnGroupId | "headDeformer" | "bodyDeformer" | "none";
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
  /**
   * The layer's painted half-width on every CROP row, top → bottom, one entry
   * per row (`cropH` of them): half the row's opaque span in canvas px under
   * the same alpha ≥ 128 rule the head's `headEdges` are measured with
   * (`@ikijs/mcp`'s `measure-turn`), 0 for a row with no opaque pixel.
   * Optional, and only the FACE's is read: it gives the face plate a
   * row-dependent turn radius and a chin swing (`faceRowProfile`,
   * `turnSurface`); absent — as the editor's own import leaves it — the plate
   * turns on one radius on every row. Validated before anything reads it: an
   * array of length `cropH` whose every entry is a finite number in
   * [0, cropW / 2], the most an inclusive span inside the crop can be.
   */
  rowHalfWidths?: number[];
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
  // The face plate and everything painted on it ride per-group turn warps
  // under the head (TurnGroupId): the plate its own, each eye stack its
  // side's, both mouth drawings one, the nose, each brow and each blush their
  // own. A group's grid is sized to its members alone and baked from the one
  // solved surface with the family's turn depth in its keyforms, so a feature
  // slides across the plate on its own grid instead of a translate binding
  // (see generateIkiFromLayerSet).
  face: { deformer: "faceWarp", order: 10, mesh: true },
  nose: { deformer: "noseWarp", order: 15, mesh: true },
  blush_L: { deformer: "blushWarp_L", order: 20, mesh: true },
  blush_R: { deformer: "blushWarp_R", order: 20, mesh: true },
  mouth: { deformer: "mouthWarp", order: 25, mesh: true },
  // An OPTIONAL second mouth drawing, open. When present the two cross-fade on
  // MouthOpen instead of the closed one being stretched, which is the
  // difference between a portrait rig and one that can lip-sync.
  mouth_open: { deformer: "mouthWarp", order: 26, mesh: true },
  eye_L: { deformer: "eyeWarp_L", order: 30, mesh: true, eyeSide: "L" },
  eye_R: { deformer: "eyeWarp_R", order: 30, mesh: true, eyeSide: "R" },
  iris_L: { deformer: "eyeWarp_L", order: 31, mesh: true, eyeSide: "L" },
  iris_R: { deformer: "eyeWarp_R", order: 31, mesh: true, eyeSide: "R" },
  pupil_L: { deformer: "eyeWarp_L", order: 32, mesh: true, eyeSide: "L" },
  pupil_R: { deformer: "eyeWarp_R", order: 32, mesh: true, eyeSide: "R" },
  highlight_L: { deformer: "eyeWarp_L", order: 33, mesh: true, eyeSide: "L" },
  highlight_R: { deformer: "eyeWarp_R", order: 33, mesh: true, eyeSide: "R" },
  // Upper lashes: an OPTIONAL separate layer ABOVE the iris that folds down to
  // the closed-eye seam (the same crease the white folds to), covering the cut
  // eyeball cleanly. When absent, the white's own fold is the only closed line.
  lash_L: { deformer: "eyeWarp_L", order: 34, mesh: true, eyeSide: "L" },
  lash_R: { deformer: "eyeWarp_R", order: 34, mesh: true, eyeSide: "R" },
  brow_L: { deformer: "browWarp_L", order: 40, mesh: true },
  brow_R: { deformer: "browWarp_R", order: 40, mesh: true },
  // The bangs ride the rigid head, like the back hair, and bind to no grid:
  // every motion of their own — the silhouette hold, the turn lead, the nod
  // and the sway — is a per-vertex warp attached in generateIkiFromLayerSet,
  // so they draw the head's outline where the plate under them bends and
  // slides (see bakeHairFrontSilhouetteWarp).
  hair_front: { deformer: "headDeformer", order: 50, mesh: true },
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
 *   5. `rowHalfWidths`, when present: an array of `cropH` finite numbers in
 *      [0, cropW / 2] — checked before anything reads its length or entries.
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
    // The shape is checked before `.length` or an entry is read, so a plain-JS
    // caller with a malformed profile gets the path-qualified message rather
    // than a TypeError out of faceRowProfile.
    if (layer.rowHalfWidths !== undefined) {
      const rows: unknown = layer.rowHalfWidths;
      if (!Array.isArray(rows)) {
        throw new Error(
          `auto-rig: validateLayerInputs: role "${role}" rowHalfWidths must be an array with one entry per crop row`,
        );
      }
      if (rows.length !== cropH) {
        throw new Error(
          `auto-rig: validateLayerInputs: role "${role}" rowHalfWidths has ${rows.length} entries, not one per crop row (cropH ${cropH})`,
        );
      }
      for (let i = 0; i < rows.length; i++) {
        const a: unknown = rows[i];
        if (
          typeof a !== "number" ||
          !Number.isFinite(a) ||
          a < 0 ||
          a > cropW / 2
        ) {
          throw new Error(
            `auto-rig: validateLayerInputs: role "${role}" rowHalfWidths[${i}] is ${String(a)}, not a finite number in [0, ${cropW / 2}] (half the crop's width)`,
          );
        }
      }
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

/** Target size of one mesh cell. A part's vertices sample its group's turn
 *  grid (and its own per-vertex warps) at this spacing; the GPU is linear
 *  between them, so the spacing bounds how smooth a bend can render. 64 px
 *  keeps a face-mesh cell near a plate-grid cell on the hero (67 px against
 *  the 45 px FACE_PLATE_CELLS gives its plate) and puts eight rows on the back
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

/** Cells per axis of the face plate's turn grid (`faceWarp`). Bilinear cells
 *  render the cylinder bend as a chord: the shared 6-cell grid over the whole
 *  head put 137 px cells under the hero's plate; 10 cells over the plate's own
 *  450 px are 45 px chords, under 0.3 px of sag at full turn, and keep the
 *  nod's chord under 0.35 px on the same rows. The plate is the one group
 *  read at every guard row and under the bangs' join, so it gets the most
 *  cells: 121 nodes × 25 stops × 2 is ≈6 000 keyform numbers, ≈0.1 MB at JSON
 *  precision. 8 is the fallback if the byte budget (1.4 MB on the hero)
 *  bites. The fold guard is the cylinder's own bound and does not depend on
 *  this. */
const FACE_PLATE_CELLS = 10;
/** Cells per axis of every feature group's turn grid. A feature grid spans a
 *  part a few tens of px across plus its bindings' reach and its turn shift,
 *  so 4 cells are 20–60 px chords — under 0.2 px of sag — and the hero's six
 *  feature groups at 25 nodes each add ≈7 500 keyform numbers: with the
 *  plate's, ≈0.2 MB over the shared grid they replace, which took the hero
 *  from 1.09 MB to ≈1.3 MB. */
const FEATURE_GRID_CELLS = 4;
/** Column pitch of the turn's VIRTUAL lattice — the one row of columns
 *  `TurnSurface.mapAt` is piecewise-linear between, anchored on the face
 *  centre (`faceCenterX ± k·16`) so the axis is a node and its dx the slide
 *  exactly. Never shipped: every group grid's node samples it. At 16 px the
 *  chord of the bend stays under 0.25 px at any radius the sweep tries
 *  (≈0.2 px at the hero plate's edge, 0.0005 in cue units), so the map IS the
 *  analytic bend as far as a cue can tell, where a coarser lattice would put
 *  its kinks wherever a group grid's nodes happened to fall. */
const TURN_LATTICE_CELL_PX = 16;
/** Margin a grid is grown by, as a fraction of its span per axis: the turn
 *  family's union for the head's vertical reach, and every group grid on top
 *  of the extent its members can reach (`groupGridFor`), so no vertex lands
 *  on a grid boundary and gets clamped by `bindPointToRestGrid`. */
const GRID_MARGIN = 0.12;

// ── Head-turn cylinder constants ─────────────────────────────────────────────

/** Margin between a cylinder's radius and the reach it has to cover: at
 *  |local|/radius <= 1/1.2 the asin stays clear of +/-1 and asin(1/1.2) + 30°
 *  is still under 90°, so the bend never folds. The nod radius is derived from
 *  the head's vertical reach this way; the turn radius is an input, and
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
 * No production caller since faceWarp moved to the 2D bake
 * (`bakeTurnGroupWarp2D`); kept as the PURE BEND reference that bake's tests
 * compare their AngleY = 0 row against, keyed on the same `HEAD_TURN_STOPS`.
 * That row equals this bake only at `travel = 0`: the bend is all the shipped
 * row has once its uniform sideways slide is taken back out.
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

// ── faceRowProfile ───────────────────────────────────────────────────────────

/** Floor of a face row's half-width, as a fraction of the widest row's. The
 *  rows under the chin are sub-threshold shading and near-empty rows whose
 *  own span would bend them on a cylinder a few px wide; the floor keeps
 *  every row's radius a usable fraction of the eye row's. */
const FACE_ROW_MIN_FRACTION = 0.15;
/** Width of the centred moving average over the measured rows, as a fraction
 *  of the crop's height: wide enough to take the pixel steps out of an
 *  alpha-thresholded outline, narrow enough to leave the jaw's taper. */
const FACE_ROW_SMOOTHING = 0.05;
/** How far the chin swings toward the NEAR side at full turn, as a fraction
 *  of the plate's half-width, scaled by how much narrower than the widest row
 *  a row is (`TurnSurface.swingAt`): a turned head's jaw comes round with it
 *  while the cranium stays. Judged on the hero two-up (slice ④): 0.05
 *  under-read the 30° reference's chin, 0.08 is the ladder value that reads. */
const CHIN_SWING = 0.08;

/**
 * The face plate's painted half-width per row, read off its layer's
 * `rowHalfWidths` (`LayerInput`) in model y. Exported at module level for the
 * tests, not from the package.
 */
export interface FaceRowProfile {
  /** The painted half-width, px, on the row resting at model `y`: linear
   *  between rows, the end rows beyond the crop. */
  at(y: number): number;
  /** The widest row's half-width — what every row above it reads. */
  aMax: number;
  /** Model y of the widest row (the lowest of them when several tie): rows
   *  ABOVE it — greater y, model y running up — read `aMax`; rows at and
   *  below it are the measured ones, and they alone taper and swing. */
  widestY: number;
  /** The crop's own half-width, px: the bound every entry respects and the
   *  width the chin swing is a fraction of. */
  faceHalfWidth: number;
}

/**
 * The face's row profile, or `undefined` when its layer measured none — or
 * measured no opaque row at all, which is the same thing to the turn.
 *
 * The face layer's alpha is NOT the head's width on every row: the hairline
 * rows sit under the bangs (on the hero the top crop row reads 6 % of the
 * cheek's half-width) and the rows under the chin are neck shading below the
 * threshold. Bent on their own span those rows would ride a cylinder a few px
 * wide and the far forehead would land OUTSIDE the cheek at full turn — a
 * cranium bulging past the face. So: the widest row is found among the raw
 * positive entries; every row ABOVE it reads that width (the cranium is as
 * wide as the cheeks; only the jaw tapers); the rows at and below it are the
 * measured ones, an empty row filled from the nearest positive row above it,
 * smoothed by a centred moving average FACE_ROW_SMOOTHING of the crop's
 * height wide (an odd window of at least three rows, the end rows repeated
 * past the crop) and floored at FACE_ROW_MIN_FRACTION of the widest. `at` is
 * linear between the rows' centres and clamps to the end rows outside the
 * crop, so a grid node on the plate's margin reads the row nearest it.
 */
export function faceRowProfile(
  face: LayerInput,
  faceCenterY: number,
): FaceRowProfile | undefined {
  const raw = face.rowHalfWidths;
  if (raw === undefined) return undefined;
  const n = raw.length;
  let aMax = 0;
  let widest = -1;
  for (let i = 0; i < n; i++) {
    if (raw[i] > 0 && raw[i] >= aMax) {
      aMax = raw[i];
      widest = i;
    }
  }
  if (widest < 0) return undefined;

  // Above the widest row aMax; at and below it the measurement, an empty row
  // taking the nearest positive row above it (the widest row is positive, so
  // there always is one).
  const filled: number[] = [];
  for (let i = 0; i < n; i++) {
    filled.push(i < widest ? aMax : raw[i] > 0 ? raw[i] : filled[i - 1]);
  }
  const half = Math.max(1, Math.round((FACE_ROW_SMOOTHING * n) / 2));
  const floor = FACE_ROW_MIN_FRACTION * aMax;
  const rows: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < widest) {
      rows.push(aMax);
      continue;
    }
    let sum = 0;
    for (let k = i - half; k <= i + half; k++) {
      sum += filled[Math.max(0, Math.min(n - 1, k))];
    }
    rows.push(Math.max(floor, sum / (2 * half + 1)));
  }

  // Crop row i is the pixel row whose centre rests at top − i − ½: image rows
  // run down where model y runs up.
  const top = faceCenterY + face.cropH / 2;
  const rowAt = (y: number) => Math.max(0, Math.min(n - 1, top - y - 0.5));
  return {
    at: (y) => {
      const r = rowAt(y);
      const i = Math.floor(r);
      if (i + 1 >= n) return rows[n - 1];
      return rows[i] + (rows[i + 1] - rows[i]) * (r - i);
    },
    aMax,
    widestY: top - widest - 0.5,
    faceHalfWidth: face.cropW / 2,
  };
}

// ── TurnSurface ───────────────────────────────────────────────────────────────

/**
 * The analytic head every bake samples and the solve fits: a turn cylinder
 * about the vertical axis through `faceCenterX` and a nod cylinder about the
 * horizontal axis through `faceCenterY`, each read at a point's REST position.
 *
 * `mapAt` is the turn as `turnColumnMap` describes it on the `lattice`'s
 * columns — the bounded bend on the row's own radius plus the slide of
 * `travel` and the row's own chin swing — so `turnColumnMap` /
 * `pinnedCylinderBend` / `boundedCylinderBend` stay the primitive and
 * `solveTurnModel` stays the fitter: it fits `radius` and `travel` on these
 * very maps, and `bakeTurnGroupWarp2D` reads its dx off the same ones, which
 * is what makes a solved cue a promise about the shipped keyforms. The
 * lattice is VIRTUAL — a dense row of columns anchored on the face centre
 * (`TURN_LATTICE_CELL_PX`) that nothing ships: every group grid's node reads
 * the map at its own rest x, and a rendered vertex reads those nodes
 * bilinearly, which is what the solve reproduces through a landmark's carrier
 * (`TurnLandmark.carrier`).
 */
interface TurnSurface {
  faceCenterX: number;
  faceCenterY: number;
  /** Turn cylinder radius at the EYE ROW, px: solved, or the lattice's own
   *  reach with the no-fold margin when there is nothing to solve against.
   *  `radiusAt` scales it per row. */
  radius: number;
  /** The head's sideways travel at full turn, px — see `turnSlide`. */
  travel: number;
  /** Nod cylinder radius, px: the head's vertical reach about `faceCenterY`
   *  with the no-fold margin — one value for the whole rig, sized where the
   *  turn family's union is (`turnSetup`). */
  nodRadius: number;
  /** The columns `mapAt` is piecewise-linear between; row 0 is all it reads. */
  lattice: IkiWarpGrid;
  /** The turn cylinder's radius on the row resting at `y`: `radius` scaled by
   *  that row's painted half-width over the eye row's (`FaceRowProfile`), so
   *  every row's own painted edge lands at the SAME fraction of its
   *  half-width; `radius` on every row without a profile. */
  radiusAt(y: number): number;
  /** The chin's swing on the row resting at `y`, as a signed addition to
   *  `travel`: −CHIN_SWING · faceHalfWidth · (1 − a(y)/aMax) for a row BELOW
   *  the widest (smaller y), 0 at and above it and everywhere without a
   *  profile. Negative, so it opposes the slide — at −30° the far side is −x
   *  and the slide is −travel, and the swing's `turnSlide` share is a POSITIVE
   *  offset, toward the near side — and ∝ deg like the slide, so it vanishes
   *  at rest. */
  swingAt(y: number): number;
  /** The turn's column map at `deg` for a point resting at `y`: the bend on
   *  `radiusAt(y)` plus `turnSlide(travel + swingAt(y), deg)` — one map per
   *  row (`rowMapsOf` memoises them), every row the same one without a
   *  profile. */
  mapAt(deg: number, y: number): TurnColumnMap;
  /** The nod's vertical displacement of a point resting at `y`, at `angleY`
   *  degrees of ParamAngleY: the pinned cylinder bend about `faceCenterY` at
   *  NOD_BEND of the angle — see that constant for why a full nod is not a
   *  full 30° bend. */
  nodBendAt(y: number, angleY: number): number;
}

/** A `TurnSurface` from its numbers; the samplers are derived from them and
 *  nothing else is. Exported at module level for the bake tests, not from the
 *  package. */
export function turnSurface(spec: {
  faceCenterX: number;
  faceCenterY: number;
  radius: number;
  travel: number;
  nodRadius: number;
  lattice: IkiWarpGrid;
  /** The face's own row profile, when its layer measured one. Without it
   *  every row turns on `radius` with no swing — slice ③'s bake, byte for
   *  byte. */
  profile?: FaceRowProfile;
  /** The row `radiusAt` is normalised at — the eye row the solve fits, so the
   *  report stays a promise about that row. Read only with a `profile`; the
   *  face centre when not given. */
  eyeRowY?: number;
}): TurnSurface {
  const { faceCenterX, faceCenterY, radius, travel, nodRadius, lattice } = spec;
  const { profile } = spec;
  let radiusAt = (_y: number) => radius;
  let swingAt = (_y: number) => 0;
  if (profile !== undefined) {
    // Normalised at the eye row: a(y)/radiusAt(y) = a(eyeRow)/radius on every
    // row, and a(eyeRow) ≤ faceHalfWidth ≤ radius/HEAD_CYLINDER_RADIUS_FACTOR
    // (the sweep's floor), so every row's own painted edge stays on the
    // analytic branch of boundedCylinderBend. The ratio is taken first so a
    // row as wide as the eye row reads `radius` exactly, not to an ulp.
    const aEye = profile.at(spec.eyeRowY ?? faceCenterY);
    radiusAt = (y) => radius * (profile.at(y) / aEye);
    // Below the widest row only (Decision 5): the gate is what keeps the
    // cranium — every row reading aMax, where the term is 0 anyway — free of
    // the swing by construction. It bites only where the smoothing pulls the
    // widest row itself under aMax (two 192/96 bands: 145.5 there), so the
    // swing steps in across that one row by the smoothing's own amount.
    swingAt = (y) =>
      y < profile.widestY
        ? -CHIN_SWING *
          profile.faceHalfWidth *
          Math.max(0, 1 - profile.at(y) / profile.aMax)
        : 0;
  }
  return {
    faceCenterX,
    faceCenterY,
    radius,
    travel,
    nodRadius,
    lattice,
    radiusAt,
    swingAt,
    mapAt: (deg, y) =>
      turnColumnMap(
        lattice,
        faceCenterX,
        radiusAt(y),
        deg,
        travel + swingAt(y),
      ),
    nodBendAt: (y, angleY) =>
      pinnedCylinderBend(
        y - faceCenterY,
        nodRadius,
        angleY * NOD_BEND * (Math.PI / 180),
      ),
  };
}

// ── bakeTurnGroupWarp2D ───────────────────────────────────────────────────────

/**
 * Bake one group's turn AND nod as a 2D grid warp over AngleX × AngleY, every
 * node of `grid` read off the `surface` at its own rest position: the turn's
 * offset is where `groupNodeLanding` lands the node on that stop's maps — the
 * family shifted by `shiftAt(deg)`, the group's own turn shift at that stop, 0
 * for a group with none — less the node's rest position, the same rule the
 * solve reads these nodes back by; the nod adds its bend at the node's rest y
 * to dy. The axes are independent (dx depends only on x and the yaw, dy only
 * on y and the pitch), the same separable convention the playground's 2D bake
 * ships: the row at AngleY = 0 is the turn alone and the column at AngleX = 0
 * the nod alone.
 *
 * Each axis's term at its own rest stop — the landing's at AngleX 0, the
 * nod's at AngleY 0 — is written as a literal zero rather than evaluated, and
 * never added to the other axis's term, so a cell with one turned axis carries
 * exactly that axis's number: at rest each axis is the identity by definition,
 * and `R·sin(asin(l/R)) − l` leaves a ≈3e-14 residue that would otherwise
 * ship — the hero's rest cell used to carry seven of them. That rule discards
 * `shiftAt(0)` too, so it assumes `shiftAt(0) = 0` — which every turn shift
 * satisfies by construction, being proportional to the stop's own degrees
 * (`depth · unit · deg / 30`) — and the row's chin swing with it, which rides
 * `turnSlide` and is 0 at the 0° stop the same way.
 *
 * The surface's `travel` belongs in the grid rather than on a headDeformer
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
export function bakeTurnGroupWarp2D(
  grid: IkiWarpGrid,
  parameterX: string,
  parameterY: string,
  surface: TurnSurface,
  shiftAt: (deg: number) => number,
): IkiGrid2DWarp {
  const STOPS = [...HEAD_TURN_STOPS];
  const pointCount = grid.points.length / 2;

  const keyforms2d: { offsets: number[] }[] = [];
  for (const angleY of STOPS) {
    for (const angleX of STOPS) {
      const shift = shiftAt(angleX);
      const mapAt = (nodeY: number) => surface.mapAt(angleX, nodeY);
      const offsets: number[] = [];
      for (let i = 0; i < pointCount; i++) {
        const x = grid.points[i * 2];
        const y = grid.points[i * 2 + 1];
        const nodDy = angleY === 0 ? 0 : surface.nodBendAt(y, angleY);
        if (angleX === 0) {
          offsets.push(0, nodDy);
          continue;
        }
        const landed = groupNodeLanding(mapAt, shift, x, y);
        const turnDy = landed.y - y;
        offsets.push(landed.x - x, angleY === 0 ? turnDy : turnDy + nodDy);
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

/** Where the head turn sends each column of a lattice, and back. */
export interface TurnColumnMap {
  /** Rest x of every lattice column, ascending — row 0 of `grid.points`. */
  restX: number[];
  /** Where the turn puts each of those columns: strictly increasing whenever
   *  `restX` is, since the bound and the capped angle rule out a fold. */
  warpedX: number[];
  /** Rest x → turned x, for anything reading the lattice. */
  mapX(x: number): number;
  /** The inverse: which rest x lands on `X`. */
  invertX(X: number): number;
}

/**
 * The head turn as a 1D map on x: where the turn puts a point resting at x at
 * `angleX` — the bend AND the same uniform `turnSlide(travel, angleX)` the
 * bakes ship, so a caller passes the travel the rig was baked with or it
 * measures a head the rig never renders. headDeformer adds no turn translate
 * on top of it.
 *
 * It equals the shipped bakes AT the `HEAD_TURN_STOPS` on the nodes of their
 * grids, which is where callers should key: between stops the engine blends
 * the keyforms parameter-linearly (the chord the HEAD_TURN_STOPS comment
 * measures), while this is analytic, so off-stop the two differ by that chord
 * error.
 *
 * The bend depends only on a point's x, so a single row of columns describes
 * the whole surface, and the map is piecewise-linear between them the way a
 * grid child's read is: `bindPointToRestGrid` puts a point in the cell its
 * rest x falls in and `sampleWarpGrid` lerps between that cell's deformed
 * corners — so between two columns the map is a straight line, and outside the
 * outer columns the clamped (s, t) pin it to the edge column's warped x.
 * `mapX` reproduces that clamp rather than extrapolating, because a caller
 * measuring a silhouette needs where the geometry lands, not where an extended
 * cylinder would put it — and the virtual lattice is sized so nothing a bake
 * reads ever sits outside its columns (`turnSetup`).
 *
 * `invertX` answers the other direction — "which rest x has to be here for the
 * turn to land it there". No bake reads it any more: the bangs hold the
 * outline directly (`bakeHairFrontSilhouetteWarp`) rather than cancelling this
 * map on themselves. It clamps `X` to the warped column range, the only place
 * the inverse is defined.
 *
 * Both directions need the warped columns to stay ordered, which holds while
 * asin(1/HEAD_CYLINDER_RADIUS_FACTOR) + |theta| < 90°, i.e. |angleX| ≲ 33.6°.
 * Past that the outer columns fold and the cell search would silently pick
 * the wrong cell, so the range is capped at the parameter's own
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

  // Same cell as bindPointToRestGrid picks: the first whose right edge is past
  // v, else the last one — found by bisection, the edges being ascending.
  const cellFor = (v: number, edges: number[]) => {
    let lo = 0;
    let hi = grid.cols - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v < edges[mid + 1]) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  // Piecewise-linear read of `values` over `edges` at `v`, the within-cell
  // fraction clamped to [0,1] as sampleWarpGrid clamps (s, t). A node reads
  // its own value: `values[c] + Δ·1` is `values[c + 1]` only to an ulp, and
  // the columns a bake reads are nodes.
  const sample = (edges: number[], values: number[], v: number): number => {
    const c = cellFor(v, edges);
    const s = Math.max(
      0,
      Math.min(1, (v - edges[c]) / (edges[c + 1] - edges[c])),
    );
    if (s === 0) return values[c];
    if (s === 1) return values[c + 1];
    return values[c] + (values[c + 1] - values[c]) * s;
  };

  return {
    restX,
    warpedX,
    mapX: (x) => sample(restX, warpedX, x),
    invertX: (X) => sample(warpedX, restX, X),
  };
}

// ── renderedLandingX ─────────────────────────────────────────────────────────

/** A mesh part as the renderer places it before any deformer moves it: its
 *  rest centre and crop, `meshCellsFor`'s cell counts, and its DEFAULT-POSE
 *  TRS — what `evaluateTransform` returns with every parameter at its default
 *  (`defaultPoseOf`). The identity for the face and the bangs; the mouth
 *  family rests at scaleX 1.1, its MouthForm range (−0.2…0.4) not being
 *  centred on the parameter's default, so a caller reading it has to pass
 *  that rather than assume 1. Exported at module level for the tests, not
 *  from the package. */
export interface RenderedPart {
  x: number;
  y: number;
  cropW: number;
  cropH: number;
  cols: number;
  rows: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

/**
 * Where a rest point `(px, py)` of a mesh part RENDERS on x, read the way the
 * engine and the GPU read it, in two stages. First `vertexLanding` lands each
 * MESH VERTEX at its PRE-BIND model position — the local vertex exactly as
 * `createPixelGridMesh` writes it, through the part's default-pose TRS in the
 * engine's own order (scale, rotate, translate): the position
 * `applyWarpToChild` binds. Then the point is interpolated over the mesh
 * TRIANGLE containing it — `createPixelGridMesh`'s [BL, BR, TL] / [TL, BR, TR]
 * split, the lower-left one when the column fraction ≤ the row fraction —
 * never bilinearly over the cell, which differs by its own cross term. A point
 * outside the mesh's rows or columns reads the end row or column with its
 * fraction clamped: the landing of the nearest boundary point, which is what a
 * silhouette point past the bangs' own crop renders as.
 *
 * Every production reader of a rendered point goes through this — the solve's
 * landmarks and silhouette candidates on their carriers, the bangs' own
 * silhouette landing, and the plate's rendered edge under the hold's join and
 * the fold guards — so a solved cue is a promise about the shipped mesh, not
 * about an analytic surface the mesh only chords.
 */
function renderedLandingX(
  part: RenderedPart,
  vertexLanding: (preBindX: number, preBindY: number) => number,
  px: number,
  py: number,
): number {
  const { cols, rows } = part;
  // Lattice fractions of the rest point: u along the columns (0 at the left
  // edge), v down the rows (0 at the top), each clamped into its end cell.
  const u = ((px - part.x + part.cropW / 2) / part.cropW) * cols;
  const v = ((part.y + part.cropH / 2 - py) / part.cropH) * rows;
  const col = Math.max(0, Math.min(cols - 1, Math.floor(u)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - col));
  const fy = Math.max(0, Math.min(1, v - row));
  const cos = Math.cos(part.rotation * (Math.PI / 180));
  const sin = Math.sin(part.rotation * (Math.PI / 180));
  const landingAt = (c: number, r: number): number => {
    const lx = (-part.cropW / 2 + (c / cols) * part.cropW) * part.scaleX;
    const ly = (part.cropH / 2 - (r / rows) * part.cropH) * part.scaleY;
    return vertexLanding(
      part.x + cos * lx - sin * ly,
      part.y + sin * lx + cos * ly,
    );
  };
  // `fx` runs left→right and `fy` top→bottom, the axes the cell is built on,
  // so its TL→BR diagonal is `fx === fy` and the lower-left triangle is the
  // one with `fx <= fy`.
  const tl = landingAt(col, row);
  const br = landingAt(col + 1, row + 1);
  if (fx <= fy) {
    const bl = landingAt(col, row + 1);
    return tl + fy * (bl - tl) + fx * (br - bl);
  }
  const tr = landingAt(col + 1, row);
  return tl + fx * (tr - tl) + fy * (br - tr);
}

/**
 * Where a warp child's vertex at pre-bind `(x, y)` lands on x through its
 * deformer's grid: `bindPointToRestGrid`'s cell — the first whose right edge
 * is past x and the first whose bottom edge is below y, else the end cell —
 * and `sampleWarpGrid`'s bilinear blend of that cell's four corner nodes,
 * each landed by `nodeLanding`, with the within-cell fractions clamped to
 * [0, 1] as the engine clamps them. A node reads its own landing exactly.
 */
function gridChildLandingX(
  grid: IkiWarpGrid,
  nodeLanding: (nodeX: number, nodeY: number) => number,
  x: number,
  y: number,
): number {
  const { cols, rows, points } = grid;
  const stride = cols + 1;
  let col = cols - 1;
  for (let c = 0; c < cols; c++) {
    if (x < points[(c + 1) * 2]) {
      col = c;
      break;
    }
  }
  let row = rows - 1;
  for (let r = 0; r < rows; r++) {
    if (y > points[(r + 1) * stride * 2 + 1]) {
      row = r;
      break;
    }
  }
  const xLeft = points[col * 2];
  const xRight = points[(col + 1) * 2];
  const yTop = points[row * stride * 2 + 1];
  const yBottom = points[(row + 1) * stride * 2 + 1];
  const s = Math.max(0, Math.min(1, (x - xLeft) / (xRight - xLeft)));
  const t = Math.max(0, Math.min(1, (yTop - y) / (yTop - yBottom)));
  const at = (c: number, r: number) =>
    nodeLanding(points[(r * stride + c) * 2], points[(r * stride + c) * 2 + 1]);
  const top = at(col, row) + (at(col + 1, row) - at(col, row)) * s;
  const bot = at(col, row + 1) + (at(col + 1, row + 1) - at(col, row + 1)) * s;
  return top + (bot - top) * t;
}

/** The grid a face-family part binds to — its turn group's — and the part as
 *  it renders on it: what a landmark, a silhouette candidate or the plate's
 *  edge is read through (`carrierLandingX`), and what the generator ships as
 *  that group's deformer and that part's mesh. Exported at module level for
 *  the tests, not from the package. */
export interface TurnCarrier {
  grid: IkiWarpGrid;
  part: RenderedPart;
}

/** Where a rest point of a carried part renders on x: `renderedLandingX` on
 *  the part, each mesh vertex landed through the carrier's grid
 *  (`gridChildLandingX`) with `nodeLanding` at the grid's nodes — the two
 *  stages the engine and the GPU draw a warp child in. */
function carrierLandingX(
  carrier: TurnCarrier,
  nodeLanding: (nodeX: number, nodeY: number) => number,
  px: number,
  py: number,
): number {
  return renderedLandingX(
    carrier.part,
    (vx, vy) => gridChildLandingX(carrier.grid, nodeLanding, vx, vy),
    px,
    py,
  );
}

/** Where a turn-group grid node resting at `(nodeX, nodeY)` lands at one
 *  stop, whose map for a point resting at `y` is `mapAt(y)`, its family
 *  shifted by `shift` px (negative toward the far side): the rule the bake
 *  and the carrier reads share. The bake writes it into the group's keyforms
 *  (`bakeTurnGroupWarp2D`) and the solve reads the same nodes back through
 *  it (`landmarkLandingX`, `landingOfRole`), so given the same shift the two
 *  cannot disagree; `plateLandingOn` reads the plate's nodes by the same rule
 *  at shift 0. */
function groupNodeLanding(
  mapAt: (y: number) => TurnColumnMap,
  shift: number,
  nodeX: number,
  nodeY: number,
): { x: number; y: number } {
  return { x: mapAt(nodeY).mapX(nodeX + shift), y: nodeY };
}

/** `surface.mapAt`, memoised per stop and node row: the map depends on
 *  nothing else, and a solve reads it at every node of every carrier at every
 *  guard row of every stop of every hold it tries. */
function rowMapsOf(
  surface: TurnSurface,
): (deg: number, nodeY: number) => TurnColumnMap {
  const maps = new Map<number, Map<number, TurnColumnMap>>();
  return (deg, nodeY) => {
    let byRow = maps.get(deg);
    if (byRow === undefined) {
      byRow = new Map();
      maps.set(deg, byRow);
    }
    let map = byRow.get(nodeY);
    if (map === undefined) {
      map = surface.mapAt(deg, nodeY);
      byRow.set(nodeY, map);
    }
    return map;
  };
}

/** The face plate as the renderer places it — its rest centre and crop, the
 *  mesh `meshCellsFor` gives that crop, and the identity TRS the generator
 *  writes for it (`bboxToTransform` places it by translate alone, and it
 *  carries no binding). A hand-built plate for the primitive tests; the
 *  solver and the generator read theirs from `turnSetup`'s `face` member.
 *  Exported at module level for the tests, not from the package. */
export function facePlate(
  faceCenterX: number,
  faceCenterY: number,
  faceHalfWidth: number,
  faceCropH: number,
): RenderedPart {
  const cropW = faceHalfWidth * 2;
  return {
    x: faceCenterX,
    y: faceCenterY,
    cropW,
    cropH: faceCropH,
    ...meshCellsFor(cropW, faceCropH),
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
  };
}

/**
 * The face plate's rendered landing on x at one stop, for ANY rest point of
 * it: `renderedLandingX` on the plate's own mesh, each vertex landed through
 * the carrier's grid — the plate's own `faceWarp` grid — as the bilinear
 * blend, over the cell that holds it, of the surface's map at the four corner
 * nodes, each node read at its own rest y (`gridChildLandingX`), which is
 * what the engine draws there. The plate has no turn shift of its own, so a
 * node reads the map at its rest x. Not the bare surface: the grid and the
 * mesh each chord it, and the bangs' join has to sit on what RENDERS.
 *
 * `mapAt` is the surface's map per stop and node row — a caller hands in the
 * memoised reader `rowMapsOf` gives a surface, so the plate's node rows are
 * built once and shared with everything else reading that surface.
 *
 * Exported at module level for the tests, not from the package.
 */
export function plateLandingOn(
  plate: TurnCarrier,
  mapAt: (deg: number, nodeY: number) => TurnColumnMap,
): (deg: number, x: number, y: number) => number {
  return (deg, x, y) =>
    carrierLandingX(
      plate,
      (nodeX, nodeY) => mapAt(deg, nodeY).mapX(nodeX),
      x,
      y,
    );
}

/**
 * The rows the plate's rendered painted edge is read at by every guard that
 * keeps the bangs' hold fold-free: the face mesh's own vertex rows — between
 * two of them the edge column renders linear, so its extremes sit on them —
 * plus every hair_front mesh row's rest y clamped into the face mesh's span,
 * the rows the bangs' join actually samples the plate at (the face rows alone
 * without bangs). ONE list for the solver's `plateReachAt` and
 * `shellTravelCap` and for the bake's per-row guard, so the two cannot
 * disagree: a radius the solver accepts is one the bake can hold.
 *
 * Exported at module level for the tests, not from the package.
 */
export function plateGuardRowsFor(
  face: { y: number; cropW: number; cropH: number },
  hairFront?: { centerY: number; cropW: number; cropH: number },
): number[] {
  // Each mesh row's absolute rest y, exactly as the bakes read a vertex's:
  // the part's y plus createPixelGridMesh's own row y.
  const rowsOf = (part: { cropW: number; cropH: number }, y: number) => {
    const { rows } = meshCellsFor(part.cropW, part.cropH);
    return Array.from(
      { length: rows + 1 },
      (_, r) => y + (part.cropH / 2 - (r / rows) * part.cropH),
    );
  };
  const faceRows = rowsOf(face, face.y);
  if (hairFront === undefined) return faceRows;
  const top = face.y + face.cropH / 2;
  const bottom = face.y - face.cropH / 2;
  return [
    ...faceRows,
    ...rowsOf(hairFront, hairFront.centerY).map((y) =>
      Math.max(bottom, Math.min(top, y)),
    ),
  ];
}

/**
 * The face plate as every guard reads it: its carrier — the `face` member's
 * grid and mesh — the painted half-width on each row, and the rows the
 * rendered edge is read at (`plateGuardRowsFor`). `edgeAt` is the profile's
 * own row when the face layer measured one (`faceRowProfile`), and the crop's
 * half-width on every row otherwise: the hold's join ends there and both
 * fold guards read the plate's edge there. Derived HERE and nowhere else —
 * `turnSetup` hands the generator these and `solveTurnModel` builds its
 * context from the same call on the same inputs — so the hold the solve fits
 * is the hold the bake builds.
 */
function plateGuardsOf(
  carriers: ReadonlyMap<string, TurnCarrier>,
  faceHalfWidth: number,
  profile: FaceRowProfile | undefined,
  hairFront?: { centerY: number; cropW: number; cropH: number },
): {
  plate: TurnCarrier;
  edgeAt: (y: number) => number;
  plateGuardRows: number[];
} {
  const plate = carriers.get("face");
  if (plate === undefined) {
    throw new Error("auto-rig: plateGuardsOf: the carriers have no face");
  }
  return {
    plate,
    edgeAt: profile === undefined ? () => faceHalfWidth : profile.at,
    plateGuardRows: plateGuardRowsFor(plate.part, hairFront),
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
 *  model px, which is all the cues measure. `y` is optional — the eye pair's
 *  places the eye row (`solveTurnModel`'s `eyeRowY`), and every landmark's is
 *  the row its points are read on — its own radius and swing once the face
 *  has a row profile (`TurnSurface.mapAt`). A hand-built landmark without one
 *  reads row 0, the same map as any other on a surface without a profile. */
export interface TurnLandmark {
  x: number;
  y?: number;
  w: number;
  /** The grid the part binds to and the part as it renders on it, when the
   *  landmark is a rigged part's: its points are then read the way the
   *  engine draws them — the mesh triangle over vertices landed bilinearly
   *  on the grid (`landmarkLandingX`) — rather than straight off the
   *  surface's map, which the grid and the mesh only chord. A landmark
   *  without one (hand-built, in a test) reads the map itself. */
  carrier?: TurnCarrier;
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
 *
 * With `carriers` (by role — what `turnSetup` builds) each landmark is read
 * through its own part's grid and mesh; without, straight off the map.
 */
export function turnLandmarks(
  layers: LayerInput[],
  carriers?: ReadonlyMap<string, TurnCarrier>,
): TurnLandmarkSet {
  const markOf = (role: string): TurnLandmark | undefined => {
    const layer = layers.find((l) => l.role === role);
    if (!layer) return undefined;
    const t = bboxToTransform(layer.bbox, layer.canvasW, layer.canvasH, role);
    const mark: TurnLandmark = { x: t.x, y: t.y, w: layer.cropW };
    const carrier = carriers?.get(role);
    if (carrier !== undefined) mark.carrier = carrier;
    return mark;
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

/** The row the cues are measured on and a row profile is normalised at: the
 *  eye pair's mean y when both eyes carry one (every landmark `turnLandmarks`
 *  builds does), else `fallback` — the face centre, for landmarks a
 *  lower-level test built by hand without rows. One derivation for the solve
 *  and `turnSetup`, so the generator's own surface and the solve's read the
 *  same row. */
function eyeRowOf(landmarks: TurnLandmarkSet, fallback: number): number {
  const [l, r] = landmarks.eye;
  return landmarks.eye.length === 2 && l.y !== undefined && r.y !== undefined
    ? (l.y + r.y) / 2
    : fallback;
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
  plateEdgeX: number,
): TurnDepthSolution {
  // The cues are signed toward the far side; the target's own sign is ignored.
  return solveTurnDepthSigned(
    -Math.abs(targetPx),
    landmarks,
    unit,
    () => map,
    plateEdgeX,
  );
}

/**
 * Where a landmark's rest point `(px, py)` lands on x at a stop whose map for
 * a point resting at `y` is `mapAt(y)`, the family shifted by `shift` px
 * (negative toward the far side): through the landmark's carrier when it has
 * one — every node of its grid lands by `groupNodeLanding`, the rule its
 * keyforms were baked by, the shift being that grid's own keyform geometry,
 * and the point is read over the part's mesh the way the engine draws it
 * (`carrierLandingX`) — or straight off the map,
 * `mapAt(py).mapX(px + shift)`, without one.
 */
function landmarkLandingX(
  landmark: TurnLandmark,
  mapAt: (y: number) => TurnColumnMap,
  shift: number,
  px: number,
  py: number,
): number {
  if (landmark.carrier === undefined) return mapAt(py).mapX(px + shift);
  return carrierLandingX(
    landmark.carrier,
    (nodeX, nodeY) => groupNodeLanding(mapAt, shift, nodeX, nodeY).x,
    px,
    py,
  );
}

/** How far a landmark family's solved depth may carry it toward the far side,
 *  px: its landmarks' far edge to the plate's far edge, never negative — a
 *  family that starts past the plate cannot be slid back in by a depth, and a
 *  depth away from the turn is not a depth. The depth solver's own cap, and
 *  what every group grid and the lattice are sized to before the solve
 *  (`turnSetup`), so the two cannot disagree. */
function familyReachPx(
  landmarks: readonly TurnLandmark[],
  plateEdgeX: number,
): number {
  const farEdge = Math.min(...landmarks.map((l) => l.x - l.w / 2));
  return Math.max(0, farEdge - plateEdgeX);
}

/**
 * The depth that lands a landmark family's slide exactly on the already-SIGNED
 * `target` (negative toward the far side, positive toward the near one),
 * or the nearer bound when `target` sits outside what any non-negative depth
 * can reach — depth cannot go negative (a feature does not stand BEHIND the
 * surface), so a positive `target` past `atRest` is exactly as unreached as a
 * too-negative one past `atCap`.
 *
 * The family's grid carries the slide as keyform geometry: each node lands
 * where the map sends its rest x shifted by `depth * unit` toward the far side
 * (`bakeTurnGroupWarp2D`'s `shiftAt`), and the part binds at its rest
 * position, so what a reference measures is the grid's map OF the shifted
 * position, not the shift: `achieved(d) = mean(landing(x, −d·unit) − x)`,
 * each landmark's centre read through its own carrier and mesh
 * (`landmarkLandingX`) — the very keyforms and triangles the engine draws.
 * The map compresses the far side and stretches the near one, so the two are
 * not the same number, and the far side's compression makes `achieved` shrink
 * faster than `d` grows. It is monotone decreasing in `d` because the map is
 * monotone increasing and the two interpolations weight it non-negatively,
 * which is what makes a bisection valid.
 *
 * The travel's upper bound is the FACE: every landmark's far edge has to stay
 * on the face plate, whose contour the turn only foreshortens. A feature past
 * it is drawn over the side hair or hangs over the cheek's edge with nothing
 * behind it — on the reference character the far eye went 35 px past the
 * contour and the render came back with an eye 17 px wide where the solver
 * had promised 53. The reference keeps the far eye whole. Since `mapX` is
 * monotone, staying inside the plate's MAPPED edge is the same as staying
 * inside its rest edge, so the bound is a plain rest distance. The held
 * silhouette is no bound of its own: the hold edge clears the plate's own
 * rendered reach at every stop (the fold guard, see `evaluateTurnCandidate`),
 * and that reach bounds every landmark's far edge already.
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
  mapAt: (y: number) => TurnColumnMap,
  plateEdgeX: number,
): TurnDepthSolution {
  if (landmarks.length === 0) {
    throw new Error("auto-rig: solveTurnDepth: no landmark to slide");
  }
  const cap = familyReachPx(landmarks, plateEdgeX) / unit;
  const achieved = (d: number) =>
    landmarks.reduce(
      (sum, l) =>
        sum + (landmarkLandingX(l, mapAt, -d * unit, l.x, l.y ?? 0) - l.x),
      0,
    ) / landmarks.length;

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
      /** The head this solve fitted — `radius` and `travel` on the lattice it
       *  was handed — for every bake to sample, so nothing renders a turn the
       *  cues were not measured on. */
      surface: TurnSurface;
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

/** Passes `evaluateTurnCandidate` gives the silhouette and the depths it rides
 *  on to settle on each other before it gives the radius up as a `settle`
 *  miss (`TurnCandidateMiss`). The passes are
 *  Aitken-accelerated: a contracting fixed point settles in one to three on
 *  the fixtures, eleven at the slowest seen (a depth that pins at a bound on
 *  some passes and not others defeats the extrapolation) — twice that is
 *  the margin. One that does not contract no count would settle. */
const TURN_SETTLE_PASSES = 24;

/** A radius that can carry the turn, with everything the fit reads off it. */
interface TurnCandidate {
  radius: number;
  /** The far/near eye width ratio it produces, at the eye depth below. */
  ratio: number;
  unit: number;
  /** The sideways travel it carries at full turn, px: `ctx.travel` capped to
   *  what this radius' own held shell can swallow (`shellTravelCap`). The face
   *  bake and the bangs' hold have to be built with THIS number — `mapAt`
   *  already is. */
  travel: number;
  /** Its column map at the −30° stop, where every cue is measured, for a
   *  point resting at `y`. */
  mapAt: (y: number) => TurnColumnMap;
  /** The surface `mapAt` is read off: this radius, that travel. */
  surface: TurnSurface;
  holdBase: number;
  holdEdgeAt: (deg: number) => number;
  eye: TurnDepthSolution;
  /** The nose's and the mouth's depth on this radius' hold, solved on the
   *  same terms (`solveFeatureDepths`): the depths their group grids ship
   *  with, and so the depths a `headEdges` owner in either family is landed
   *  at. Whether a bound that cut one short is a clamp or a refusal is
   *  `solveTurnModel`'s call, once a radius is chosen. */
  nose: TurnDepthSolution;
  mouth: TurnDepthSolution;
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
       *  shipped mesh's own terms (`hairFrontLandingAt`, the bangs' vertices
       *  landed as the bake lands them and read over the mesh's own
       *  triangles), and both ends are values a caller can resubmit and have
       *  rigged. Infinity and -Infinity when
       *  nothing inside that domain renders here: the neutral pair
       *  `sweepTurnRadii`'s own min/max ignore. */
      lower: number;
      upper: number;
    }
  | {
      blocked: "eyeShift";
      /** The px interval it offered the eyes instead, ascending. */
      offeredShift: [number, number];
    }
  | {
      /** The silhouette and the depths its `headEdges` owners ride on did
       *  not settle on each other within TURN_SETTLE_PASSES at this radius
       *  (see evaluateTurnCandidate): nothing to offer in any target's terms.
       *  The sweep skips it like any refused radius, and `solveTurnModel`
       *  refuses the layer set outright when that leaves it nothing. */
      blocked: "settle";
    };

/** Everything a candidate is evaluated against that does not vary with the
 *  radius. One pass of the solve holds one of these. */
interface TurnSolveContext {
  /** Each family's landmarks, every one carrying the carrier its part renders
   *  on (`turnSetup`). */
  landmarks: TurnLandmarkSet;
  /** The columns every candidate's maps are piecewise-linear between — the
   *  virtual lattice every group grid's node reads (`TurnSurface`). */
  lattice: IkiWarpGrid;
  faceCenterX: number;
  faceCenterY: number;
  /** The nod cylinder's radius, the head's vertical reach with the no-fold
   *  margin: not fitted, carried so every candidate's surface is complete. */
  nodRadius: number;
  /** The row the cues are measured on — the eye pair's mean y, else the face
   *  centre — where every candidate's maps are sampled, and where the bangs'
   *  own silhouette landing is read. */
  eyeRowY: number;
  faceHalfWidth: number;
  /** Rest x of the plate's far edge — the slide's hard stop. */
  plateEdgeX: number;
  /** The face plate as it renders — its own group grid and mesh
   *  (`facePlate`): what the plate's rendered edge under the hold's join and
   *  the fold guards is read through (`plateLandingOn`). */
  plate: TurnCarrier;
  /** Every face-family part's carrier by role, the plate's under `face`:
   *  what a `headEdges` candidate naming one of them is landed through. */
  carriers: ReadonlyMap<string, TurnCarrier>;
  /** The face's own row profile, when its layer measured one: every
   *  candidate's surface bends each row on its own radius and swings the chin
   *  by it (`turnSurface`). Absent, one radius on every row. */
  profile?: FaceRowProfile;
  /** The plate's PAINTED half-width at row `y` — where the hold's join and
   *  the guards read its edge: the profile's row, else the crop's own
   *  half-width on every row (`plateGuardsOf`). */
  edgeAt: (y: number) => number;
  /** The rows every plate guard reads the rendered painted edge at — see
   *  `plateGuardRowsFor`; the bake iterates the identical list. */
  plateGuardRows: number[];
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
  /** The nose's and the mouth's shift MAGNITUDES when the caller measured
   *  them — `TurnTargets`' "the sign is ignored", taken at the door like
   *  `eyeShift`'s. Absent when defaulted: the family then takes its share of
   *  the eyes' ACHIEVED shift, known only per candidate
   *  (`solveFeatureDepths`), and a bound that cuts it short is a clamp rather
   *  than a refusal. */
  noseShift?: number;
  mouthShift?: number;
  /** Whether the ratio is this generator's own default — carried through as
   *  the hold's own ratio and clamped to what the grid can reach — or a
   *  caller's render measurement, which the hold is fitted to and which is
   *  rejected when no hold renders it. Same split as `clampEyeShift`, for the
   *  same reason. */
  clampSilhouetteRatio: boolean;
  /** hair_front's own rest centre and crop, for `hairFrontLandingAt` — its
   *  own mesh geometry (`meshCellsFor`), the rows its lead and its join with
   *  the plate are baked at — and the silhouette point used when
   *  `headHalfWidth` is not measured (see `evaluateTurnCandidate`'s
   *  silhouette-centre correction). Undefined when there is no hair_front
   *  layer, in which case that correction falls back to the ideal hold
   *  destinations, symmetric about the face centre, and no lead is modelled:
   *  there are no bangs to carry one. */
  hairFrontSilhouette?: {
    x: number;
    centerY: number;
    cropW: number;
    cropH: number;
  };
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
 * Where a hair_front vertex resting at `(x, y)` is sent at one turn stop — the
 * three-zone rule `bakeHairFrontSilhouetteWarp` bakes into a per-vertex
 * offset and `evaluateTurnCandidate` reads the composed landing of, factored
 * into one place so the two cannot drift apart. The zones are REST distances
 * from the face centre, so they do not move with the stop; only the
 * destinations do:
 *
 *   - within the plate's painted half-width on this row, `edgeAt(y)`: where
 *     the RENDERED plate lands that very point (`plateLandingAt` — the face's
 *     own mesh and grid, not the bare surface), so the bangs sit on the face
 *     they cover through the whole turn;
 *   - out to `holdBase`: a straight ramp from the painted edge's rendered
 *     landing onto `holdEdge`, the hold's own destination at this stop;
 *   - beyond `holdBase`: `holdEdge`'s own displacement, slope 1 in REST x, so
 *     the outer strands carry whatever silhouette change was asked for and
 *     keep their spacing.
 *
 * A vertex exactly on the axis never leaves the first zone, so its zero
 * `side` is never read.
 */
function hairFrontHoldTarget(
  x: number,
  y: number,
  deg: number,
  faceCenterX: number,
  plateLandingAt: (deg: number, x: number, y: number) => number,
  edgeAt: (y: number) => number,
  holdBase: number,
  holdEdge: number,
): number {
  const local = x - faceCenterX;
  const dist = Math.abs(local);
  const side = Math.sign(local);
  const painted = edgeAt(y);
  if (dist <= painted) return plateLandingAt(deg, x, y);
  if (dist <= holdBase) {
    const inner = plateLandingAt(deg, faceCenterX + side * painted, y);
    const u = (dist - painted) / (holdBase - painted);
    return inner + (faceCenterX + side * holdEdge - inner) * u;
  }
  return x + side * (holdEdge - holdBase);
}

/**
 * hair_front's own silhouette landing at an ARBITRARY rest point — not the
 * analytic hold + lead at that point, but what the renderer actually draws
 * there, on the mesh the bake ships: `renderedLandingX` on the bangs' own
 * mesh, every vertex landed as the two warps land it — the hold's own target
 * for that vertex (`holdTargetAt`, the rule the bake writes) plus its row's
 * share of the turn lead — and the point read over the triangle the mesh
 * draws it with. Interpolating anything earlier — the rest xs, or an analytic
 * lead at a row the mesh has no vertex on — is a different number wherever a
 * hold zone's boundary falls between two columns, or the lead's own
 * `u^HAIR_SWAY_CURL` curve bends between two rows.
 *
 * `leadShift` is the bangs' SIGNED tip lead in px at the stop being read: the
 * lead warp is keyed at ±30 (`0 − tipShift·u^CURL` at −30, `tipShift·u^CURL`
 * at +30, see `bakeHairSwayWarp`) and blends linearly between, so at stop d it
 * is `tipShift·d/30` — `−tipShift` at full far turn. Each vertex lands at its
 * hold target plus its own row's share of it, `leadShift·u^HAIR_SWAY_CURL`:
 * `u` is its distance from the pinned root as a fraction of the crop's height,
 * the shipped lead warp's own shape.
 *
 * The point need not be inside hair_front's own crop at all — past its outer
 * column or row this reads the end column or row, the landing of the nearest
 * point the mesh actually draws.
 */
function hairFrontLandingAt(
  x: number,
  y: number,
  hairFront: { x: number; centerY: number; cropW: number; cropH: number },
  holdTargetAt: (restX: number, restY: number) => number,
  leadShift: number,
): number {
  const { cols, rows } = meshCellsFor(hairFront.cropW, hairFront.cropH);
  const top = hairFront.centerY + hairFront.cropH / 2;
  return renderedLandingX(
    {
      x: hairFront.x,
      y: hairFront.centerY,
      cropW: hairFront.cropW,
      cropH: hairFront.cropH,
      cols,
      rows,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    },
    (vx, vy) =>
      holdTargetAt(vx, vy) +
      leadShift * Math.pow((top - vy) / hairFront.cropH, HAIR_SWAY_CURL),
    x,
    y,
  );
}

/**
 * The most sideways travel a MEASURED shell can swallow at this radius: how far
 * the face may slide before the plate's own edge reaches the hold's boundary.
 *
 * Read off the BEND ALONE (`bendOnlyLandingAt` — the rendered plate at a stop
 * with no travel in it; each row's own chin swing, which does not scale with
 * the travel, stays in), the slide being what is solved for here: at each
 * turned stop the plate's painted edges land either side of the face centre —
 * read at every guard row, kept SIGNED — and the slide then pushes the edge on
 * the side it moves toward further out while pulling the other one in. So
 * only the TOWARD edge binds, at whichever row it lands furthest. A
 * max-absolute reach would bind on the near edge instead, which a tight bend
 * throws wide precisely BEFORE the slide pulls it back inside the shell, and
 * would refuse the radius the slide was about to rescue.
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
  edgeAt: (y: number) => number,
  plateGuardRows: number[],
  askedTravel: number,
  bendOnlyLandingAt: (deg: number, x: number, y: number) => number,
  holdEdgeAt: (deg: number, side: -1 | 1) => number,
): number {
  let cap = Infinity;
  for (const deg of HEAD_TURN_STOPS) {
    if (deg === 0) continue; // nothing slides at rest, so nothing to cap
    const slideSign: -1 | 1 = turnSlide(askedTravel, deg) < 0 ? -1 : 1;
    // The toward edge's furthest landing over the guard rows, on the bend
    // alone.
    const towardReach = plateSideReachAt(
      bendOnlyLandingAt,
      faceCenterX,
      edgeAt,
      plateGuardRows,
      deg,
      slideSign,
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
 *  where each side's silhouette lands through that map, every `headEdges`
 *  owner of the face family at the depths the evaluation was handed. The
 *  ratio the rig ships is picked among these — fitted until
 *  `renderedSilhouetteRatio` is the target, whether that target was measured
 *  or defaulted. */
interface TurnHoldEval {
  /** The hold's own ratio: where its boundary is sent at full turn, as a
   *  fraction of the rest distance it keeps. */
  ratio: number;
  /** The sideways travel it leaves the face at full turn, px. */
  travel: number;
  /** Its column map at the −30° stop, where every cue is measured, for a
   *  point resting at `y`. */
  mapAt: (y: number) => TurnColumnMap;
  /** The surface `mapAt` is read off: the candidate's radius, this travel. */
  surface: TurnSurface;
  holdBase: number;
  holdEdgeAt: (deg: number) => number;
  /** Whether any stop sends the hold edge inside the plate's own reach, which
   *  runs the ramp between them backwards — never acceptable, see
   *  `bakeHairFrontSilhouetteWarp`. */
  folds: boolean;
  /** The ratio at which the tightest stop's hold edge would exactly clear the
   *  plate ON THIS HOLD's own slide — a seed for the range's floor, not the
   *  floor itself, see `holdRange`. */
  foldLowerBound: number;
  silhouetteCenterShift: number;
  renderedSilhouetteRatio: number;
  /** The silhouette's own rest span, px: what the rendered ratio is a
   *  fraction of, and so the scale a px tolerance on it converts through. */
  restSpan: number;
}

/** Aitken's Δ² extrapolation of a geometrically contracting sequence from
 *  three consecutive terms — the fixed point itself when the contraction is
 *  linear — clamped into [0, cap], the depths a solve can return and so where
 *  the fixed point lies. The last term as it stands when the sequence has
 *  stopped moving (a depth pinned at a bound) or its steps do not contract,
 *  where the formula has nothing to extrapolate from. */
function aitken(x0: number, x1: number, x2: number, cap: number): number {
  const d1 = x1 - x0;
  const d2 = x2 - x1;
  const denominator = d2 - d1;
  if (denominator === 0) return x2;
  const x = x2 - (d2 * d2) / denominator;
  return Number.isFinite(x) ? Math.min(cap, Math.max(0, x)) : x2;
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
 *
 * The silhouette and the depths are ONE fixed point. A `headEdges` owner of
 * the face family — a brow, a blush, a white, the nose, a mouth — lands
 * through its group grid, whose keyforms carry its family's solved depth
 * (`bakeTurnGroupWarp2D`'s `shiftAt`); the eye depth is solved against the
 * silhouette's centre, and the nose's and the mouth's against that centre and
 * the eyes' achieved shift. So each pass fits the hold with every owner landed
 * at the pass before's depths (none on the first — the read a hold-owned
 * silhouette gets whatever the depths), solves the three depths on it, and
 * RE-READS that same hold at the depths it solved: when the re-read moves
 * neither the centre nor the rendered span by more than TURN_DEPTH_EPS px,
 * the pass is the fixed point, and the candidate reports the re-read — the
 * numbers the emitted grids render — with the depths that produced it. A
 * silhouette owned by the bangs, the back hair, the body or the plate does
 * not move with a depth, so it settles on the first pass, the single-pass
 * solve to the bit. Otherwise the passes contract geometrically (an owner's
 * landing moves by a fraction of the depth it feeds back into), accelerated by
 * Aitken's Δ² on the three depths every second pass; a radius that has not
 * settled within TURN_SETTLE_PASSES yields a `settle` miss rather than a
 * candidate reported off its render, and the sweep moves on to the next
 * radius — an edge owned on BOTH sides by the family the eye cue slides
 * leaves that cue nearly independent of the depth, which no pass count
 * settles, and a layer set no sampled radius settles is refused by
 * `solveTurnModel`, naming that. The refusals — a caller's silhouette the
 * range cannot render, an eye shift the bounds cut short — are issued at the
 * fixed point too, on the range and bounds the shipped depths have, not on a
 * pass's guess.
 */
function evaluateTurnCandidate(
  ctx: TurnSolveContext,
  radius: number,
): TurnCandidate | TurnCandidateMiss {
  // This radius as a head: the surface every map below is read off, at the
  // travel the hold under evaluation leaves the face.
  const surfaceAt = (travel: number) =>
    turnSurface({
      faceCenterX: ctx.faceCenterX,
      faceCenterY: ctx.faceCenterY,
      radius,
      travel,
      nodRadius: ctx.nodRadius,
      lattice: ctx.lattice,
      profile: ctx.profile,
      eyeRowY: ctx.eyeRowY,
    });
  // The travel is settled BEFORE the map that carries it, the map being built
  // from it: the face slides INSIDE a shell the bangs hold, so what it may
  // slide is what that shell has room for — measured on the bend alone, as
  // the plate renders it (the chin swing rides the rows, not the travel, so
  // it is in this landing too: what the travel has to fit beside).
  const bendOnlyLandingAt = plateLandingOn(ctx.plate, rowMapsOf(surfaceAt(0)));
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
  // a raw offset summed onto the hold's own target at each vertex inside
  // `hairFrontLandingAt`, exactly like `bakeHairSwayWarp` and
  // `bakeHairFrontSilhouetteWarp` sum their offsets on the shipped mesh; the
  // rows the renderer interpolates between are the MESH's, so the row goes
  // down with it rather than a lead pre-sampled at the measured row. Only
  // hair_front leads — a role `landingOfRole` sends down any other path does
  // not use this at all. The hold does not move it, so it is settled once,
  // outside the fit.
  const leadTipShift =
    ctx.hairFrontSilhouette === undefined ? 0 : HAIR_FRONT_DEPTH * unit;

  const evaluateHold = (ratio: number, depths: TurnDepths): TurnHoldEval => {
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
              ctx.edgeAt,
              ctx.plateGuardRows,
              ctx.travel,
              bendOnlyLandingAt,
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
    const surface = surfaceAt(travel);
    // One memoised reader of this surface's maps for every carrier read on
    // it: the −30° map for a point resting at `y`, where every cue is
    // measured, is what each landmark's and candidate's nodes are read off.
    const rowMaps = rowMapsOf(surface);
    const mapAt = (y: number) => rowMaps(-HEAD_TURN_MAX_DEG, y);
    // The plate as it renders on THIS hold's slide: what its painted edge is
    // read off below, and what the bangs' join sits on.
    const plateLandingAt = plateLandingOn(ctx.plate, rowMaps);
    // Without a measured head the boundary is the outermost the slid plate
    // ever reaches, clear of it by HOLD_CLEARANCE.
    const holdBase =
      ctx.headHalfWidth ??
      plateReach(
        plateLandingAt,
        ctx.faceCenterX,
        ctx.edgeAt,
        ctx.plateGuardRows,
      ) + HOLD_CLEARANCE;
    const holdEdgeAt = holdEdgeFrom(holdBase);

    // The floor of the bracket this hold could have been fitted in: the ratio
    // the plate-fold geometry allows. Computed EVERY time, whether or not it
    // binds, so a refusal never advertises a range it would have narrowed.
    //
    // SAFE but not TIGHT: `reach` is read off `plateLandingAt`, the slid
    // plate, and with a measured head the ratio sizes that slide as well
    // (`shellTravelCap` reads `holdEdgeAt`). At the binding stop the cap
    // moves with the ratio at `holdBase` per unit, i.e. the reach moves at
    // `holdBase·|deg|/30` — exactly the rate the hold edge itself moves — so a
    // ratio narrower than this bound arrives with a smaller slide and can
    // still clear the plate. Everything at or above the bound holds; some
    // below it do too. The reach is the same list of rows through the same
    // function the bake's own guard iterates (`bakeHairFrontSilhouetteWarp`),
    // so a hold that clears it here clears it there.
    let foldLowerBound = -Infinity;
    let folds = false;
    for (const deg of HEAD_TURN_STOPS) {
      if (deg === 0) continue; // proven never to bind — holdBase always clears the rest reach
      const reach = plateReachAt(
        plateLandingAt,
        ctx.faceCenterX,
        ctx.edgeAt,
        ctx.plateGuardRows,
        deg,
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
    // Where the bangs land a point on the eye row at full turn: their own
    // mesh, each vertex holding the outline as the bake sends it there
    // (`hairFrontHoldTarget`, on this hold and the rendered plate) plus its
    // row's lead.
    const hairFrontAt = (x: number): number =>
      ctx.hairFrontSilhouette === undefined
        ? x
        : hairFrontLandingAt(
            x,
            ctx.eyeRowY,
            ctx.hairFrontSilhouette,
            (vx, vy) =>
              hairFrontHoldTarget(
                vx,
                vy,
                -HEAD_TURN_MAX_DEG,
                ctx.faceCenterX,
                plateLandingAt,
                ctx.edgeAt,
                holdBase,
                holdEdgeAt(-HEAD_TURN_MAX_DEG),
              ),
            -leadTipShift,
          );
    // Where a named role's OWN rest x lands after the turn — the mcp measures
    // the union of every layer's opaque pixels, so an edge can belong to any
    // role, not just the bangs. `face` and the FEATURE_NOD_DEPTH family (the
    // eye stack, lashes, brows, blush, the nose, both mouths) each ride their
    // own group grid, so each is read through its own carrier — the grid and
    // mesh it renders with — at the shift that grid's keyforms carry: its
    // turn family's depth in `depths` times the unit, toward the far side
    // (`bakeTurnGroupWarp2D`'s `shiftAt` at this stop), none for the plate,
    // which IS the surface. Those depths are what this very hold is being
    // solved for, which is why the candidate is a fixed point (see this
    // function's doc). `hair_back` and `body` ride their own rigid deformers,
    // not a group grid, so neither reads a map at all. Anything not in
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
        // group grids, where only what rides a grid carries it — so the head's
        // frame is the rest frame and the body lands at its own AngleX travel
        // alone: the "from" value of its own translateX binding at this stop.
        return x - BODY_TURN_FOLLOW * travel;
      }
      if (
        role === "face" ||
        FEATURE_NOD_DEPTH[roleFamily(role)] !== undefined
      ) {
        const carrier = ctx.carriers.get(role);
        if (carrier === undefined) {
          // The mcp measures edges off the layers it rigs, so a face-family
          // role it names is one this layer set has — anything else is a
          // caller's list that does not belong to these layers.
          throw new Error(
            `auto-rig: evaluateTurnCandidate: headEdges names "${role}", which this layer set has no layer for`,
          );
        }
        const shift = role === "face" ? 0 : -depths[turnFamily(role)] * unit;
        return carrierLandingX(
          carrier,
          (nodeX, nodeY) => groupNodeLanding(mapAt, shift, nodeX, nodeY).x,
          x,
          ctx.eyeRowY,
        );
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
      mapAt,
      surface,
      holdBase,
      holdEdgeAt,
      folds,
      foldLowerBound,
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

  // Every hold this radius can actually ship, sampled across its own usable
  // range: from the narrowest that does not fold the ramp onto the strands up
  // to the widest ratio the targets accept, the bangs being free to hold the
  // outline wherever they are sent now that no grid edge stops them. What a
  // render SHOWS is not assumed monotone in the hold — a wider hold buys more
  // travel (`shellTravelCap`), and the travel moves the plate's own edge that
  // the bangs' inner strands ride — so the range is sampled rather than read
  // off its two ends, and the fit below works in whichever sampled interval
  // actually straddles the ask. Every sample is fold-free, so anything the
  // fit returns from one can be shipped.
  //
  // `foldLowerBound` is a SEED for the floor, not the floor: it reads the
  // plate's reach off one hold's own slide, and that reach does not move with
  // the hold the way it assumes. A narrower hold buys a smaller slide, which
  // pulls the plate's toward edge in but pushes its AWAY edge out, and
  // `plateReachAt` takes the larger of the two — so the seed can itself fold,
  // and the real floor is bisected between it and the ceiling, where the
  // slide is largest and the hold furthest out. Undefined when even the
  // ceiling folds: the radius can hold nothing, so it has nothing to offer.
  const holdRange = (depths: TurnDepths): TurnHoldEval[] | undefined => {
    const ceiling = evaluateHold(TURN_RATIO_MAX, depths);
    if (ceiling.folds) return undefined;
    let floor = evaluateHold(
      Math.min(ceiling.foldLowerBound, ceiling.ratio),
      depths,
    );
    if (floor.folds) {
      let lo = floor;
      let hi = ceiling;
      for (let i = 0; i < TURN_BISECT_STEPS; i++) {
        const mid = evaluateHold((lo.ratio + hi.ratio) / 2, depths);
        if (mid.folds) lo = mid;
        else hi = mid;
      }
      floor = hi;
    }
    const samples = [floor];
    for (let i = 1; i < TURN_HOLD_SAMPLES; i++) {
      const sample = evaluateHold(
        floor.ratio + ((ceiling.ratio - floor.ratio) * i) / TURN_HOLD_SAMPLES,
        depths,
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

  /**
   * The hold fitted to the ask with every `headEdges` owner landed at
   * `depths`: the hold, whether it had to be cut to the nearest end of the
   * range this radius renders, and that range when it was — the refusal a
   * CALLER-measured ask earns for that is issued at the fixed point below,
   * on the range the shipped depths have, not here on a pass's guess.
   * Undefined when even the widest hold folds, which no depth changes.
   */
  const fitHold = (
    depths: TurnDepths,
  ):
    | {
        hold: TurnHoldEval;
        silhouetteClamped: boolean;
        span?: [number, number];
      }
    | undefined => {
    // The hold the target names outright, tried first. Where it already
    // renders the target it IS the answer: a static shell renders its own
    // rest span whatever the hold does, so every hold there is equally
    // exact, and the one that leaves the bangs where the target says is the
    // one to ship rather than an arbitrarily narrower one a search would
    // settle on first.
    const natural = evaluateHold(asked, depths);
    // solveTurnDepthSigned's own px slack, on the span the rendered ratio is
    // a fraction of: the fit stops there, and a caller resubmitting the exact
    // interval a refusal reported is not refused again by a float ulp of the
    // division that reported it.
    const eps = TURN_DEPTH_EPS / natural.restSpan;
    if (
      !natural.folds &&
      Math.abs(natural.renderedSilhouetteRatio - asked) <= eps
    ) {
      return { hold: natural, silhouetteClamped: false };
    }
    const samples = holdRange(depths);
    if (samples === undefined) return undefined;
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
      // No hold renders the ask: the nearest end of the rendered range stands
      // in, and says so. A DEFAULTED ask ships it and reports it — see
      // solveTurnModel's report; a CALLER-measured one is refused in the
      // range's own terms once the depths have settled.
      const wanted = asked < span[0] ? span[0] : span[1];
      const hold = samples.reduce((a, b) =>
        Math.abs(b.renderedSilhouetteRatio - wanted) <
        Math.abs(a.renderedSilhouetteRatio - wanted)
          ? b
          : a,
      );
      return { hold, silhouetteClamped: true, span };
    }
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
      const mid = evaluateHold((lo.ratio + hi.ratio) / 2, depths);
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
    return { hold: best, silhouetteClamped: false };
  };

  // The fixed point (see this function's doc): the depths every owner is
  // landed at on this pass, none on the first, and the pass before's when
  // the pass after next is Aitken-extrapolated from the two.
  let depths: TurnDepths = { eye: 0, nose: 0, mouth: 0 };
  let seed: TurnDepths | undefined;
  for (let pass = 0; ; pass++) {
    const fitted = fitHold(depths);
    if (fitted === undefined) return silhouetteMiss();
    const { hold, silhouetteClamped, span } = fitted;
    // Folding is never acceptable, fitted or clamped: `natural` is only kept
    // when it does not fold, every `holdRange()` sample is fold-free, and the
    // fit only ever replaces `best` with a non-folding evaluation — so a
    // folding hold here is a broken invariant, not a case to handle.
    if (hold.folds) {
      throw new Error(
        "auto-rig: evaluateTurnCandidate: the hold it settled on folds",
      );
    }
    // measure_turn_reference reads the eye pair against each pose's OWN
    // silhouette centre, not the face centre — at rest that centre IS the
    // face centre, but at full turn it has moved by `silhouetteCenterShift`.
    // The raw landmark slide `solveTurnDepthSigned` solves for is measured
    // against the face centre, so its target has to be `silhouetteCenterShift`
    // MINUS the requested magnitude's own px: adding the two back together at
    // measurement time (solveTurnModel's `achieved.eyeShift`) lands back on
    // the requested cue.
    //
    // That target can legitimately be positive (the centre's own drift
    // already meets or exceeds the request, so the eyes need to move toward
    // the NEAR side to land on it) as well as negative, which is exactly why
    // this calls the SIGNED solver directly: `solveTurnDepth`'s
    // magnitude-only wrapper would silently flip a negative request back to
    // positive, quietly hitting a different cue than the one asked for (a
    // request and its negation must produce the identical rig —
    // `TurnTargets.eyeShift`'s own "the sign is ignored" contract, taken
    // here, not by folding an already-negative result back to positive
    // later).
    const eye = solveTurnDepthSigned(
      hold.silhouetteCenterShift - ctx.eyeShift * ctx.hh,
      ctx.landmarks.eye,
      unit,
      hold.mapAt,
      ctx.plateEdgeX,
    );
    const features = solveFeatureDepths(
      ctx,
      (-eye.achieved + hold.silhouetteCenterShift) / ctx.hh,
      unit,
      hold.mapAt,
      hold.silhouetteCenterShift,
    );
    const solved: TurnDepths = {
      eye: eye.depth,
      nose: features.nose.depth,
      mouth: features.mouth.depth,
    };
    // The same hold, re-read with every owner at the depths it just solved:
    // what the emitted grids render. Settled when that read is the one the
    // hold was fitted on, to the solver's own px slack on the centre and on
    // the span.
    const settled = evaluateHold(hold.ratio, solved);
    if (
      Math.abs(settled.silhouetteCenterShift - hold.silhouetteCenterShift) >
        TURN_DEPTH_EPS ||
      Math.abs(settled.renderedSilhouetteRatio - hold.renderedSilhouetteRatio) *
        hold.restSpan >
        TURN_DEPTH_EPS
    ) {
      if (pass + 1 >= TURN_SETTLE_PASSES) return { blocked: "settle" };
      if (seed === undefined) {
        seed = depths;
        depths = solved;
      } else {
        const capOf = (marks: TurnLandmark[]) =>
          familyReachPx(marks, ctx.plateEdgeX) / unit;
        depths = {
          eye: aitken(
            seed.eye,
            depths.eye,
            solved.eye,
            capOf(ctx.landmarks.eye),
          ),
          nose: aitken(
            seed.nose,
            depths.nose,
            solved.nose,
            capOf(ctx.landmarks.nose),
          ),
          mouth: aitken(
            seed.mouth,
            depths.mouth,
            solved.mouth,
            capOf(ctx.landmarks.mouth),
          ),
        };
        seed = undefined;
      }
      continue;
    }

    const {
      travel,
      mapAt,
      surface,
      holdBase,
      holdEdgeAt,
      silhouetteCenterShift,
      renderedSilhouetteRatio,
    } = settled;
    if (silhouetteClamped && !ctx.clampSilhouetteRatio) {
      return silhouetteMiss(span);
    }
    // A measured shift this radius cannot produce disqualifies the radius; a
    // defaulted one takes what the radius offers.
    if (!eye.reached && !ctx.clampEyeShift) {
      return {
        blocked: "eyeShift",
        // eyeShift is a MAGNITUDE (the sign is ignored — see TurnTargets), so
        // a negative lower bound here would advertise a value the field's own
        // contract already rules out; 0 is the true floor.
        offeredShift: [
          Math.max(0, (-eye.attainable[1] + silhouetteCenterShift) / ctx.hh),
          (-eye.attainable[0] + silhouetteCenterShift) / ctx.hh,
        ],
      };
    }

    // Each eye's rest width against its turned width, where the slide put
    // it: its two edges on its own centre row, read as its mesh renders them.
    const eyeShiftPx = -eye.depth * unit;
    const scaleOf = (l: TurnLandmark) =>
      (landmarkLandingX(l, mapAt, eyeShiftPx, l.x + l.w / 2, l.y ?? 0) -
        landmarkLandingX(l, mapAt, eyeShiftPx, l.x - l.w / 2, l.y ?? 0)) /
      l.w;
    // A −30° turn foreshortens the −x side: that eye is the far one. Dividing
    // the two rest-normalised scales IS the cue — the reference's own far/near
    // ratio is already divided by its rest one.
    const far = ctx.landmarks.eye.reduce((a, b) => (b.x < a.x ? b : a));
    const near = ctx.landmarks.eye.reduce((a, b) => (b.x > a.x ? b : a));
    return {
      radius,
      ratio: scaleOf(far) / scaleOf(near),
      unit,
      travel,
      mapAt,
      surface,
      holdBase,
      holdEdgeAt,
      eye,
      nose: features.nose,
      mouth: features.mouth,
      silhouetteClamped,
      silhouetteCenterShift,
      renderedSilhouetteRatio,
    };
  }
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
  /** How many radii the fixed point never settled at (`TurnCandidateMiss`'s
   *  `settle`): skipped like any refused radius, and the cause named when
   *  the sweep is left empty. */
  unsettled: number;
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
  let unsettled = 0;
  for (let i = 0; i < TURN_SWEEP_SAMPLES; i++) {
    const radius =
      minRadius * Math.pow(maxRadius / minRadius, i / (TURN_SWEEP_SAMPLES - 1));
    const result = evaluateTurnCandidate(ctx, radius);
    if (!("blocked" in result)) {
      candidates.push({ ...result, sweepIndex: i });
    } else if (result.blocked === "silhouetteRatio") {
      heldRatioLower = Math.min(heldRatioLower, result.lower);
      heldRatioUpper = Math.max(heldRatioUpper, result.upper);
    } else if (result.blocked === "settle") {
      unsettled++;
    } else {
      offeredShift = offeredShift
        ? [
            Math.min(offeredShift[0], result.offeredShift[0]),
            Math.max(offeredShift[1], result.offeredShift[1]),
          ]
        : result.offeredShift;
    }
  }
  return {
    candidates,
    heldRatioLower,
    heldRatioUpper,
    offeredShift,
    unsettled,
  };
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
 * The nose's and the mouth's depth on one candidate's hold, on the same terms
 * as the eyes': a measured target is aimed at exactly, a derived one takes its
 * family's share of the eyes' ACHIEVED shift — not the shift they were asked
 * for: the shares are proportions BETWEEN the three features, so against a
 * clamped eye pair the un-scaled ones would send the nose across the far eye.
 * Both share eyeShift's own head-relative contract (a fraction of `hh`, sign
 * ignored), so each target gets the SAME silhouette-centre correction the
 * eye's own solve uses (see evaluateTurnCandidate) — measured against the
 * pose's own silhouette centre, not the raw landmark slide against the fixed
 * face centre.
 *
 * Solved on every candidate, not once the radius is chosen: a `headEdges`
 * owner in either family lands through its depth, so the silhouette a
 * candidate is fitted on needs both. Whether a bound that cut a solution short
 * is a clamp or a refusal is `solveTurnModel`'s call.
 */
function solveFeatureDepths(
  ctx: TurnSolveContext,
  /** The eyes' achieved shift on this hold, in the cue's own units. */
  eyeShift: number,
  unit: number,
  mapAt: (y: number) => TurnColumnMap,
  silhouetteCenterShift: number,
): { nose: TurnDepthSolution; mouth: TurnDepthSolution } {
  const solve = (
    measured: number | undefined,
    marks: TurnLandmark[],
    share: number,
  ) =>
    solveTurnDepthSigned(
      silhouetteCenterShift - (measured ?? Math.abs(share * eyeShift)) * ctx.hh,
      marks,
      unit,
      mapAt,
      ctx.plateEdgeX,
    );
  return {
    nose: solve(ctx.noseShift, ctx.landmarks.nose, NOSE_SHIFT_SHARE),
    mouth: solve(ctx.mouthShift, ctx.landmarks.mouth, MOUTH_SHIFT_SHARE),
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
 * Everything is measured on the SAME surface the rig is baked from — the
 * piecewise-linear map `turnColumnMap` builds from the lattice's own columns
 * (`TurnSurface.mapAt`), at the −30° stop, read through the very grids and
 * meshes the parts render with (`carriers`) — so a solved target is a promise
 * about the shipped keyforms, not about an idealised cylinder the engine never
 * evaluates. The solved surface is returned for the bakes to sample.
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
  lattice: IkiWarpGrid,
  faceCenterX: number,
  faceHalfWidth: number,
  /** The nod axis. */
  faceCenterY: number,
  /** The nod cylinder's radius — the head's vertical reach with the no-fold
   *  margin, sized once by `turnSetup` for the solve and the generator alike
   *  (the virtual lattice has no height to read it from). */
  nodRadius: number,
  /** Every face-family part's carrier by role — the group grid it binds to
   *  and the part as it renders on it — the plate's under `face`: what the
   *  landmarks, the silhouette candidates, the bangs' join and the plate
   *  guards read the RENDERED parts through. */
  carriers: ReadonlyMap<string, TurnCarrier>,
  /** The face's own row profile (`faceRowProfile`), when its layer measured
   *  one: every candidate's surface bends each row on its own radius,
   *  normalised at the eye row the cues are fitted on, and the plate's
   *  painted edge is read at each row's own half-width. Absent, the plate is
   *  painted out to its crop and turns on one radius. */
  profile?: FaceRowProfile,
  /** hair_front's own transform x/y and crop width/height, when the layer set
   *  has one — see `TurnSolveContext.hairFrontSilhouette`. Absent skips the
   *  turn-lead correction and falls the silhouette-centre correction back to
   *  the ideal hold destinations, which is also correct for a layer set with
   *  no hair_front: there is then no bangs edge for either to read. */
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

  const eyeRowY = eyeRowOf(landmarks, faceCenterY);

  const ctx: TurnSolveContext = {
    landmarks,
    lattice,
    faceCenterX,
    faceCenterY,
    nodRadius,
    eyeRowY,
    faceHalfWidth,
    // The slide's hard stop is the CROP's edge, profile or not: the far eye
    // may sit on the plate's transparent margin, as it does on the hero.
    plateEdgeX: faceCenterX - faceHalfWidth,
    carriers,
    profile,
    ...plateGuardsOf(carriers, faceHalfWidth, profile, hairFront),
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
    noseShift: targets.defaulted.has("noseShift")
      ? undefined
      : Math.abs(targets.noseShift),
    mouthShift: targets.defaulted.has("mouthShift")
      ? undefined
      : Math.abs(targets.mouthShift),
    clampSilhouetteRatio: targets.defaulted.has("silhouetteRatio"),
    hairFrontSilhouette: hairFront,
    // A companion to a MEASURED headHalfWidth only — see its own doc.
    headEdges: targets.headHalfWidth === undefined ? undefined : headEdges,
  };
  const clamped: (keyof TurnTargets)[] = [];
  const clampInto = (value: number, [lo, hi]: [number, number]) =>
    Math.min(Math.max(value, lo), hi);

  const pass = sweepTurnRadii(ctx);
  if (pass.candidates.length === 0) {
    // A radius the fixed point never settled at offered nothing in any
    // target's terms (see evaluateTurnCandidate), so a sweep one of those
    // leaves empty is refused as such, naming the cause — the ranges below
    // are read off the radii the TARGETS refused and would say nothing of
    // the ones nothing settled at.
    if (pass.unsettled > 0) {
      const refused = TURN_SWEEP_SAMPLES - pass.unsettled;
      throw new TurnTargetError(
        `auto-rig: headEdges: no sampled radius carries the turn — the silhouette and the depths its headEdges owners ride on did not settle within ${TURN_SETTLE_PASSES} passes at ${pass.unsettled} of the ${TURN_SWEEP_SAMPLES} radii${refused > 0 ? `, and the targets refused the other ${refused}` : ""}`,
      );
    }
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
  // rather than bisected across the gap. Defaults leave every radius standing
  // and so leave exactly one run — the gaps are what a CALLER-measured cue
  // opens (see evaluateTurnCandidate): a silhouette no hold at that radius
  // renders, or an eye shift the pair's own drift there already overshoots,
  // neither of which is monotone in the radius.
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

  // The nose's and the mouth's depths were solved on this candidate along
  // with the eyes' (solveFeatureDepths); what is left is the verdict the eye
  // bound got above — a measured target the bounds cut short is refused, a
  // derived one is clamped and says so.
  for (const [field, solution] of [
    ["noseShift", best.nose],
    ["mouthShift", best.mouth],
  ] as const) {
    if (solution.reached) continue;
    if (!targets.defaulted.has(field)) {
      return {
        unreachable: true,
        field,
        value: targets[field],
        // noseShift/mouthShift are MAGNITUDES too (see solveFeatureDepths),
        // so a negative lower bound here would advertise a value the field's
        // own contract already rules out; 0 is the true floor.
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

  return {
    unreachable: false,
    radius: best.radius,
    holdBase: best.holdBase,
    holdEdgeAt: best.holdEdgeAt,
    travel: best.travel,
    surface: best.surface,
    depths: {
      eye: best.eye.depth,
      nose: best.nose.depth,
      mouth: best.mouth.depth,
    },
    achieved: {
      eyeShift,
      farEyeRatio: best.ratio,
      silhouetteRatio: best.renderedSilhouetteRatio,
    },
    clamped,
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
 *  cylinder by ±15°. The nod cylinder — sized to the turn family's union,
 *  bangs included (`turnSetup`) — reaches up to the hair crown, which sits
 *  near 45° on it; a full 30° pitch there drops the
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
 * 2D bakes pin out of every group grid at full nod (`TurnSurface.nodBendAt`).
 * The nod bends at NOD_BEND of the angle, so this is
 * nodRadius · sin(30° · NOD_BEND), not nodRadius · sin(30°), with nodRadius
 * the head's half-height about the nod axis (`gridHalfHeight`, the turn
 * family's margined union — see `turnSetup`) with the no-fold margin.
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
 *  the bangs clear off them, which is why they had none.) Riding the rigid
 *  head rather than a grid, the bangs take it as a per-vertex warp that bakes
 *  the slide AND the surface's bend where the slide puts each vertex
 *  (`bakeNodWarp`), the composition a grid child gets from its binding and
 *  the grid. The turn lead stays a root-pinned warp: on the turn the crown
 *  sits on the axis and must not slide. */
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
 * The nod's depth-parallax translate binding of a facial feature, or [] for
 * any other role, whenever the unit is absent (a unit-less call is a rig
 * without a head to nod on), and whenever the rig has no nose layer to lead
 * (see FEATURE_NOD_DEPTH). Symmetric about zero, so the rest pose — the one
 * every proportion is judged on — is untouched.
 *
 * The TURN has no binding here: its depth is SOLVED per layer set from the
 * measured cues and baked into the feature's own group grid as keyform
 * geometry (`bakeTurnGroupWarp2D`'s `shiftAt`), so the part binds at its rest
 * position and the grid carries it — the landing a translate-then-bind gave,
 * now read by the solve through that very grid (`TurnLandmark.carrier`). The
 * nod's depth is the tuned table and stays a translate: it binds a nodded
 * vertex at `y + t` on its group grid exactly as it did on the shared one.
 */
function featureParallaxBindings(
  role: string,
  options: {
    parallaxUnitY?: number;
    hasNose?: boolean;
  },
): IkiBinding[] {
  if (!options.hasNose) return [];
  // The nod's table is also the role gate: a family with no depth in it is not
  // a feature painted on the face, and does not slide.
  const nodDepth = FEATURE_NOD_DEPTH[roleFamily(role)];
  if (nodDepth === undefined) return [];
  const shiftY = nodDepth * (options.parallaxUnitY ?? 0);
  if (shiftY === 0) return [];
  return [
    {
      parameter: StandardParameter.AngleY,
      channel: "translateY",
      from: -shiftY,
      to: shiftY,
    },
  ];
}

/**
 * Derive the IkiBinding[] for a part from its role spec and crop dimensions.
 *
 * - face → no bindings: the contour is the cylinder itself, pinned by the bake
 * - every feature on that contour — eye stack, lashes, brows, both mouths,
 *     nose, blush — carries the AngleY translateY nod parallax from
 *     FEATURE_NOD_DEPTH (needs `parallaxUnitY` and `hasNose`) on top of
 *     whatever its role adds below; its TURN parallax is no binding but its
 *     group grid's own keyform geometry (see featureParallaxBindings)
 * - hair_front: no bindings. Every motion of its own is a per-vertex warp
 *     attached in generateIkiFromLayerSet: the sway and the AngleX turn lead
 *     are root-pinned (a rigid translate/rotate would carry the whole sheet,
 *     crown included, with the fringe tips, instead of leading from them),
 *     the silhouette hold sits on the rendered plate, and the nod follow at
 *     the brows' depth (HAIR_FRONT_NOD_DEPTH, same `hasNose` gate as the
 *     brows) is baked with the head's own bend (`bakeNodWarp`)
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
    parallaxUnitY?: number;
    /** Whether the layer set has a `nose` role — the feature parallax's gate. */
    hasNose?: boolean;
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

  if (role === "hair_back") {
    // Nothing on the TURN: it holds the head's outline still while the face
    // slides inside it. On the nod it follows the bent crown down to stay
    // tucked beneath it — see HAIR_BACK_NOD_DEPTH.
    const shiftY = HAIR_BACK_NOD_DEPTH * (options.parallaxUnitY ?? 0);
    if (shiftY === 0) return [];
    return [
      {
        parameter: StandardParameter.AngleY,
        channel: "translateY",
        from: -shiftY,
        to: shiftY,
      },
    ];
  }

  // face, blush_*, nose → nothing of their own; hair_front's every motion is
  // a warp (see the doc above)
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

// ── bakeNodWarp ──────────────────────────────────────────────────────────────

/**
 * The nod of a part that rides the rigid head rather than a grid, as a
 * per-vertex AngleY warp keyed on HEAD_TURN_STOPS: what a grid child gets from
 * its nod translate binding and the grid together — translated by `t`, the
 * part's own share of the nod at that stop (`nodTravel · deg / 30`), THEN bent
 * where the translate put it, `surface.nodBendAt(y + t)` — baked at each
 * vertex's own rest y, `partY + vy`. Off the grid the bend is the analytic
 * surface itself, not a grid's chord of it. dx is zero; the rest keyform is a
 * literal zero rather than the bend's ≈3e-14 residue at 0 (see
 * `bakeTurnGroupWarp2D`).
 *
 * Offsets are in the mesh's own pixel frame — pass the SAME mesh the part
 * renders. headDeformer's own rigid nod translate rides on top, as it does for
 * every child of the head. Exported at module level for the tests, not from
 * the package.
 */
export function bakeNodWarp(
  mesh: IkiMesh,
  partY: number,
  surface: TurnSurface,
  nodTravel: number,
): IkiWarp {
  const keyforms = HEAD_TURN_STOPS.map((deg) => {
    const t = (nodTravel * deg) / HEAD_TURN_MAX_DEG;
    const offsets: number[] = [];
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      const y = partY + mesh.vertices[i + 1];
      offsets.push(0, deg === 0 ? 0 : t + surface.nodBendAt(y + t, deg));
    }
    return { value: deg, offsets };
  });
  return { parameter: StandardParameter.AngleY, keyforms };
}

// ── bakeHairFrontSilhouetteWarp ──────────────────────────────────────────────

/**
 * How far the face plate's painted edge EVER lands from the face centre over
 * the turn, either side, as the plate RENDERS — the floor under any hold edge.
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
  plateLandingAt: (deg: number, x: number, y: number) => number,
  faceCenterX: number,
  edgeAt: (y: number) => number,
  plateGuardRows: number[],
): number {
  let reach = 0;
  for (const deg of HEAD_TURN_STOPS) {
    reach = Math.max(
      reach,
      plateReachAt(plateLandingAt, faceCenterX, edgeAt, plateGuardRows, deg),
    );
  }
  return reach;
}

/** How far the plate's painted edge on ONE side lands from the face centre at
 *  one stop: the furthest over the guard rows, each row's own painted edge
 *  read where the rendered plate lands it. */
function plateSideReachAt(
  plateLandingAt: (deg: number, x: number, y: number) => number,
  faceCenterX: number,
  edgeAt: (y: number) => number,
  plateGuardRows: number[],
  deg: number,
  side: -1 | 1,
): number {
  let reach = 0;
  for (const y of plateGuardRows) {
    const dest = plateLandingAt(deg, faceCenterX + side * edgeAt(y), y);
    reach = Math.max(reach, Math.abs(dest - faceCenterX));
  }
  return reach;
}

/**
 * `plateReach` at ONE stop: how far the plate's painted edge lands from the
 * face centre, whichever side and whichever guard row lands further out.
 *
 * Every gate on the hold edge is this number — the bake's own guard, and the
 * solver's check that a radius can hold the silhouette it was asked for — read
 * at ONE list of rows (`plateGuardRowsFor`) through ONE rendered plate. They
 * have to agree: a radius the solver accepts and the bake then refuses is a
 * generator that throws from inside its own answer.
 */
export function plateReachAt(
  plateLandingAt: (deg: number, x: number, y: number) => number,
  faceCenterX: number,
  edgeAt: (y: number) => number,
  plateGuardRows: number[],
  deg: number,
): number {
  return Math.max(
    plateSideReachAt(
      plateLandingAt,
      faceCenterX,
      edgeAt,
      plateGuardRows,
      deg,
      -1,
    ),
    plateSideReachAt(
      plateLandingAt,
      faceCenterX,
      edgeAt,
      plateGuardRows,
      deg,
      1,
    ),
  );
}

/**
 * The head's OUTLINE, held through the turn by the part that draws it — the
 * bangs — as a per-vertex AngleX warp on hair_front, keyed on HEAD_TURN_STOPS.
 *
 * The face warp bends AND slides everything riding its grid, so side strands
 * riding it would squeeze in with the plate and travel off with it: the head
 * would narrow and shift instead of turning. hair_front therefore binds to no
 * grid — it rides the rigid head — and this warp sends each vertex DIRECTLY to
 * where the outline wants it, in ABSOLUTE model x (`partX + vx`) throughout.
 *
 * The destination is `hairFrontHoldTarget`'s MONOTONE three-zone function of
 * the vertex's REST distance from the face centre, so the warp can never fold
 * a hair cell: over the painted plate (within `edgeAt(y)` on the vertex's own
 * row) a vertex lands where the RENDERED plate lands that point —
 * `plateLandingAt`, the face's own mesh and grid, so the bangs sit on the face
 * they cover through the whole turn — from there out to `holdBase` a straight
 * ramp onto the hold edge's destination `holdEdgeAt(deg)`, and beyond it the
 * hold edge's own displacement, slope 1, so the outer strands carry whatever
 * silhouette change the caller asked for. The zone boundaries are REST
 * distances and do not move with the stop — only the destinations do, which
 * is what keeps the ramp and the outer zone continuous at every stop. A
 * destination that MOVES is the point of `holdEdgeAt`: a caller that has
 * measured the head's width and wants a specific silhouette ratio at full
 * turn narrows it per stop, while the boundary it pivots on stays put.
 * `holdEdgeAt(0)` must therefore be `holdBase` — enforced, since anything
 * else displaces the bangs in the rest pose, where every proportion was
 * judged — and the rest keyform is written as a literal zero: every zone is
 * the identity there, and the plate's own map leaves a bend residue at 0.
 *
 * The fold guard: at every stop, on both sides, the hold edge has to sit
 * outside the plate's rendered painted edge on EVERY row of `plateGuardRows`
 * — the same list, through the same `plateLandingAt`, that
 * `evaluateTurnCandidate` fitted the hold against, so a hold the solver ships
 * is one this bake can build. A vertex exactly on the axis never leaves the
 * first zone, so its zero `side` is never read.
 */
export function bakeHairFrontSilhouetteWarp(
  mesh: IkiMesh,
  partX: number,
  partY: number,
  faceCenterX: number,
  plateLandingAt: (deg: number, x: number, y: number) => number,
  edgeAt: (y: number) => number,
  holdBase: number,
  holdEdgeAt: (deg: number) => number,
  plateGuardRows: number[],
): IkiWarp {
  if (holdEdgeAt(0) !== holdBase) {
    throw new Error(
      `auto-rig: bakeHairFrontSilhouetteWarp: holdEdgeAt(0) is ${holdEdgeAt(0)}, not the hold edge's own rest distance ${holdBase}, so the bangs would move in the rest pose`,
    );
  }
  const keyforms = HEAD_TURN_STOPS.map((deg) => {
    const holdEdge = holdEdgeAt(deg);
    // A hold edge inside the plate's rendered painted edge on any row would
    // run the ramp between them backwards and fold the strands onto the
    // cheek. Which stop catches it moves with the radius — see plateReach.
    const reach = ([-1, 1] as const).map((side) =>
      plateSideReachAt(
        plateLandingAt,
        faceCenterX,
        edgeAt,
        plateGuardRows,
        deg,
        side,
      ),
    );
    const reached = Math.max(reach[0], reach[1]);
    if (holdEdge <= reached) {
      const side = reach[1] > reach[0] ? 1 : -1;
      throw new Error(
        `auto-rig: bakeHairFrontSilhouetteWarp: at ${deg}° on the ${side < 0 ? "-x" : "+x"} side the hold edge sits ${holdEdge} from the face centre but the plate's edge maps to ${reached}, so the ramp between them would fold`,
      );
    }
    const offsets: number[] = [];
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      const x = partX + mesh.vertices[i];
      const y = partY + mesh.vertices[i + 1];
      // Shared with evaluateTurnCandidate's own silhouette-centre reading, so
      // the two cannot drift apart on what a vertex's target actually is. dy
      // is zero — the hold is horizontal.
      offsets.push(
        deg === 0
          ? 0
          : hairFrontHoldTarget(
              x,
              y,
              deg,
              faceCenterX,
              plateLandingAt,
              edgeAt,
              holdBase,
              holdEdge,
            ) - x,
        0,
      );
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
 * grid (`TurnSurface.travel`, sampled by `bakeTurnGroupWarp2D`) it moves the
 * face inside a held silhouette and IS the floor under that cue — an absolute
 * px value would be a quarter of one plate's half-width and the whole of a
 * smaller one's. 0.25 was judged in the playground on a 400 px-wide plate,
 * where it is the 50 px that shipped.
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

// ── turnSolveInputs ───────────────────────────────────────────────────────────

/** What `solveTurnModel` is handed after the targets, in its own parameter
 *  order, so it spreads straight in. */
type TurnSolveInputs = [
  landmarks: TurnLandmarkSet,
  lattice: IkiWarpGrid,
  faceCenterX: number,
  faceHalfWidth: number,
  faceCenterY: number,
  nodRadius: number,
  carriers: ReadonlyMap<string, TurnCarrier>,
  profile: FaceRowProfile | undefined,
  hairFront:
    | { x: number; centerY: number; cropW: number; cropH: number }
    | undefined,
];

/** The standard parameters every generated rig declares — ids and ranges
 *  verbatim from sample-model.ts; the hair-sway pair joins them per rig
 *  (`generateIkiFromLayerSet`). Also where a binding's default-pose value is
 *  read from (`defaultPoseOf`). */
const STANDARD_PARAMETERS: readonly IkiParameter[] = [
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

/**
 * `evaluateTransform`'s additive rule, mirrored (the engine is not a
 * dependency of this package): scale starts at 1 and adds each binding's
 * value, rotation and translate sum, opacity moves nothing. `valueOf` picks
 * each binding's value — a `from`/`to` extreme for a bound, the default-pose
 * value for the pose the renderer rests in.
 */
function transformUnder(
  bindings: readonly IkiBinding[],
  valueOf: (binding: IkiBinding, index: number) => number,
): { x: number; y: number; rotation: number; scaleX: number; scaleY: number } {
  const trs = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  bindings.forEach((binding, i) => {
    const value = valueOf(binding, i);
    switch (binding.channel) {
      case "translateX":
        trs.x += value;
        break;
      case "translateY":
        trs.y += value;
        break;
      case "rotate":
        trs.rotation += value;
        break;
      case "scaleX":
        trs.scaleX += value;
        break;
      case "scaleY":
        trs.scaleY += value;
        break;
      case "opacity":
        break;
    }
  });
  return trs;
}

/** The TRS a part's bindings give it with every parameter at its declared
 *  default — what `evaluateTransform` returns on a freshly loaded rig, the
 *  pose every `RenderedPart` is read in. A binding's value there is its
 *  range at `ParameterStore.normalized`'s own `(default − min) / (max − min)`
 *  (no standard parameter is zero-width). */
function defaultPoseOf(bindings: readonly IkiBinding[]) {
  return transformUnder(bindings, (binding) => {
    const p = STANDARD_PARAMETERS.find((p) => p.id === binding.parameter);
    if (p === undefined) {
      throw new Error(
        `auto-rig: defaultPoseOf: "${binding.parameter}" is not a standard parameter`,
      );
    }
    const t = (p.default - p.min) / (p.max - p.min);
    return binding.from + (binding.to - binding.from) * t;
  });
}

/** A face-family layer as the generator rigs it: the crop's placement, the
 *  part as it renders (`RenderedPart`, the default pose on that placement),
 *  the mesh it renders with, the role's OWN bindings — `bindingsForRole`
 *  without the parallax units, the expression it has whatever the turn does
 *  — and its part warps (the eyelid fold on a white or a lash, else none).
 *  Everything its group grid is sized from (`groupGridFor`) and its carrier
 *  reads with, built once for the solve and the parts alike. Exported at
 *  module level for the tests, not from the package. */
export interface TurnGroupMember {
  role: string;
  group: TurnGroupId;
  /** The crop's own placement (`bboxToTransform`), what the bindings add to. */
  transform: { x: number; y: number };
  part: RenderedPart;
  mesh: IkiMesh;
  bindings: readonly IkiBinding[];
  warps: readonly IkiWarp[];
}

/**
 * One turn group's grid: the members' PRE-BIND extent — where the engine
 * binds their vertices to it (`applyWarpToChild`: part warps, then the TRS
 * the bindings give) — grown by the family's turn and nod shifts and then by
 * GRID_MARGIN of its span per axis plus a pixel, over `cells` × `cells`
 * uniform cells (the format allows uneven columns; nothing here needs them).
 *
 * The extent is the union, over every member, of its mesh under each part
 * warp's keyforms — the rest mesh, and the mesh with each keyform's offsets
 * added (the fold's closed shape; a blend of two keyforms lies inside the box
 * of their union, and a member carries one warp at most) — placed by EVERY
 * combination of its geometric bindings' `from`/`to` extremes through
 * `evaluateTransform`'s additive rule (`transformUnder`: scale = 1 + Σ
 * values, so a `mouth` without an open drawing reaches scaleY 4 and scaleX
 * 1.4; rotation = Σ, so a ±12° brow grows its y extent by its half-width's
 * sine; a translate sums; opacity moves nothing and is skipped). The extremes
 * are at the corners: each channel is affine in its bindings, and the
 * rotations are small enough that a corner's x and y are monotone in the
 * angle to within a fraction of a pixel (a brow flatter than tan 12° peaks a
 * little inside ±12° and overshoots its corner by under 0.1 px), far under
 * the margin. `turnShiftPx` is the furthest the family's solved depth can carry a
 * node — the depth solver's own cap in px — and `nodShiftPx` its nod
 * translate; both are added on both sides, every stop being ±.
 *
 * The margin is what keeps a vertex off the grid boundary, where
 * `bindPointToRestGrid` would clamp it. The face — no binding, no warp, no
 * shift — gets its crop plus the margin and nothing else, symmetric about its
 * centre, so the plate's axis is a node. Exported at module level for the
 * tests, not from the package.
 */
export function groupGridFor(
  members: readonly TurnGroupMember[],
  cells: number,
  turnShiftPx: number,
  nodShiftPx: number,
): IkiWarpGrid {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const member of members) {
    const rest = member.mesh.vertices;
    const shapes = [rest];
    for (const warp of member.warps) {
      for (const keyform of warp.keyforms) {
        shapes.push(rest.map((v, i) => v + keyform.offsets[i]));
      }
    }
    const geometric = member.bindings.filter((b) => b.channel !== "opacity");
    for (let corner = 0; corner < 1 << geometric.length; corner++) {
      const trs = transformUnder(geometric, (b, i) =>
        (corner & (1 << i)) === 0 ? b.from : b.to,
      );
      const cos = Math.cos(trs.rotation * (Math.PI / 180));
      const sin = Math.sin(trs.rotation * (Math.PI / 180));
      for (const shape of shapes) {
        for (let i = 0; i < shape.length; i += 2) {
          // The engine's order: scale, rotate, translate — about the part's
          // own centre, where the crop places it.
          const sx = shape[i] * trs.scaleX;
          const sy = shape[i + 1] * trs.scaleY;
          const x = member.transform.x + trs.x + cos * sx - sin * sy;
          const y = member.transform.y + trs.y + sin * sx + cos * sy;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
  }
  minX -= turnShiftPx;
  maxX += turnShiftPx;
  minY -= nodShiftPx;
  maxY += nodShiftPx;
  const marginX = (maxX - minX) * GRID_MARGIN + 1;
  const marginY = (maxY - minY) * GRID_MARGIN + 1;
  return {
    cols: cells,
    rows: cells,
    points: generateGridPoints(
      cells,
      cells,
      minX - marginX,
      maxX + marginX,
      minY - marginY,
      maxY + marginY,
    ),
  };
}

/** The eyelid fold of an eye white or a lash, or undefined for any other
 *  role: both fold to the WHITE's crease on that side — EYELID_FOLD_CREASE
 *  below the white's own centre — on that side's EyeOpen, so the lash lands
 *  on top of the cut eyeball and covers the seam. The lash keeps LASH_FOLD_K
 *  of its height; the white EYELID_FOLD_K, or nothing at all when a lash
 *  supplies the closed line (a strip of iris must not show under it). Both
 *  whites are REQUIRED_ROLES, so the crease always has one to read. `t` is
 *  the part's placement and `mesh` the mesh it renders with. */
function eyelidFoldFor(
  layers: LayerInput[],
  layer: LayerInput,
  mesh: IkiMesh,
  t: { x: number; y: number },
): IkiWarp | undefined {
  const side = ROLE_TABLE[layer.role].eyeSide;
  const isLash = layer.role.startsWith("lash_");
  if (side === undefined || !(layer.role.startsWith("eye_") || isLash)) {
    return undefined;
  }
  const white = layers.find((l) => l.role === `eye_${side}`)!;
  const creaseWorldY =
    bboxToTransform(white.bbox, white.canvasW, white.canvasH, white.role).y -
    EYELID_FOLD_CREASE * white.cropH;
  const hasLash = layers.some((l) => l.role === `lash_${side}`);
  return bakeEyelidFoldWarp(
    mesh,
    side === "L"
      ? StandardParameter.EyeOpenLeft
      : StandardParameter.EyeOpenRight,
    creaseWorldY - t.y,
    isLash ? LASH_FOLD_K : hasLash ? 0 : EYELID_FOLD_K,
  );
}

/** Everything `turnSetup` derives from a layer set, by name: what the solve
 *  is handed (`solveInputsOf` lines the first nine up in `solveTurnModel`'s
 *  order), the plate guards derived once for the solve and the bake alike,
 *  and what the generator ships and bakes from — the members' meshes and
 *  warps, each group's grid, the nod's parallax unit off the same head
 *  half-height as the nod radius — so the two read one set of values. */
interface TurnSetup {
  landmarks: TurnLandmarkSet;
  lattice: IkiWarpGrid;
  faceCenterX: number;
  faceHalfWidth: number;
  faceCenterY: number;
  nodRadius: number;
  carriers: ReadonlyMap<string, TurnCarrier>;
  /** The face layer's own row profile, when it measured one. */
  profile: FaceRowProfile | undefined;
  hairFront:
    | { x: number; centerY: number; cropW: number; cropH: number }
    | undefined;
  /** The eye pair's mean y — the row the cues are measured on and a row
   *  profile is normalised at, as `solveTurnModel` reads it off the same
   *  landmarks; the generator's own surface, when nothing is solved, is
   *  normalised there too. */
  eyeRowY: number;
  /** The plate and its guards, `plateGuardsOf` — see that function. */
  plate: TurnCarrier;
  edgeAt: (y: number) => number;
  plateGuardRows: number[];
  members: readonly TurnGroupMember[];
  groupGrids: ReadonlyMap<TurnGroupId, IkiWarpGrid>;
  parallaxUnitY: number;
  hasNose: boolean;
  hasMouthOpen: boolean;
}

/**
 * The turn's geometry for a layer set, in the order nothing may depend on the
 * solve: every face-family layer's placement, role bindings and part warps
 * (pure — no unit, no depth) → each group's grid from its members
 * (`groupGridFor`) → the virtual lattice from those grids → the landmarks on
 * their carriers. The solve then runs on exactly these, and the bakes sample
 * exactly these, which is what lets the report equal the render.
 *
 * The head's vertical reach — the nod cylinder's radius and its parallax unit
 * — is the TURN FAMILY's union on y (every group member plus the bangs,
 * transform ± crop/2, the centred pixel-mesh convention) grown by GRID_MARGIN,
 * about the face centre: the rows the shared face grid had, kept as the one
 * head-level value however the groups are cut.
 *
 * A family's shift bound is the depth solver's own cap in px — its landmarks'
 * far edge to the plate's edge (`solveTurnDepthSigned`) — and 0 when nothing
 * is solved (no nose, FEATURE_NOD_DEPTH's gate); the brows and the blush ride
 * with the eyes (`turnFamily`), the plate has none. Each group's grid takes its
 * family's, and the lattice — one row of TURN_LATTICE_CELL_PX columns
 * anchored on the face centre — is widened so every grid's every node,
 * shifted by the LARGEST bound either way, sits strictly inside its outer
 * columns, snapped outward to the next anchored column: `mapX` pins anything
 * outside onto the edge column, which would deform a node even at rest. The
 * lattice's height is the union's; `turnColumnMap` reads row 0 only.
 *
 * The face's row profile (`faceRowProfile`), when its layer carries one, is
 * read here and handed to the solve and the generator alike, and the plate's
 * guards are derived from it once (`plateGuardsOf`).
 */
function turnSetup(layers: LayerInput[]): TurnSetup {
  // validateLayerInputs guarantees "face" is present — safe to assert here.
  const faceLayer = layers.find((l) => l.role === "face")!;
  const faceTransform = bboxToTransform(
    faceLayer.bbox,
    faceLayer.canvasW,
    faceLayer.canvasH,
    "face",
  );
  // Source-placed face centre in model space (unshifted).
  const faceCenterX = faceTransform.x;
  const faceCenterY = faceTransform.y;
  const faceHalfWidth = faceLayer.cropW / 2;
  const plateEdgeX = faceCenterX - faceHalfWidth;
  // The feature parallax's gate — see FEATURE_NOD_DEPTH.
  const hasNose = layers.some((l) => l.role === "nose");
  const hasMouthOpen = layers.some((l) => l.role === "mouth_open");

  // ── The head's vertical reach ─────────────────────────────────────────────
  // The face is required and a group member, so the union is never empty.
  const turnLayers = layers.filter(
    (l) => isTurnGroup(ROLE_TABLE[l.role].deformer) || l.role === "hair_front",
  );
  const turnYs = turnLayers.map((l) => ({
    y: bboxToTransform(l.bbox, l.canvasW, l.canvasH, l.role).y,
    h: l.cropH,
  }));
  let unionMinY = Math.min(...turnYs.map(({ y, h }) => y - h / 2));
  let unionMaxY = Math.max(...turnYs.map(({ y, h }) => y + h / 2));
  const spanY = unionMaxY - unionMinY;
  unionMinY -= spanY * GRID_MARGIN;
  unionMaxY += spanY * GRID_MARGIN;
  // The larger of the two distances from the nod axis, so a union that is not
  // symmetric about it still keeps every row within the cylinder's bound.
  const halfH = Math.max(faceCenterY - unionMinY, unionMaxY - faceCenterY);
  const nodRadius = halfH * HEAD_CYLINDER_RADIUS_FACTOR;
  const parallaxUnitY = headNodParallaxUnit(halfH);

  // ── The members ───────────────────────────────────────────────────────────
  const members: TurnGroupMember[] = [];
  for (const layer of layers) {
    const spec = ROLE_TABLE[layer.role];
    if (!isTurnGroup(spec.deformer)) continue;
    const { role, cropW, cropH } = layer;
    const t = bboxToTransform(layer.bbox, layer.canvasW, layer.canvasH, role);
    const { cols, rows } = meshCellsFor(cropW, cropH);
    const mesh = createPixelGridMesh(cols, rows, cropW, cropH);
    const bindings = bindingsForRole(spec, role, cropW, cropH, {
      hasMouthOpen,
    });
    const fold = eyelidFoldFor(layers, layer, mesh, t);
    const pose = defaultPoseOf(bindings);
    members.push({
      role,
      group: spec.deformer,
      transform: t,
      part: {
        x: t.x + pose.x,
        y: t.y + pose.y,
        cropW,
        cropH,
        cols,
        rows,
        scaleX: pose.scaleX,
        scaleY: pose.scaleY,
        rotation: pose.rotation,
      },
      mesh,
      bindings,
      warps: fold === undefined ? [] : [fold],
    });
  }

  // ── Each family's shift bounds ────────────────────────────────────────────
  const landmarks = turnLandmarks(layers);
  const turnShiftOf = (marks: TurnLandmark[]) =>
    hasNose && marks.length > 0 ? familyReachPx(marks, plateEdgeX) : 0;
  const turnShift: Record<keyof TurnDepths, number> = {
    eye: turnShiftOf(landmarks.eye),
    nose: turnShiftOf(landmarks.nose),
    mouth: turnShiftOf(landmarks.mouth),
  };

  // ── The group grids and the carriers ──────────────────────────────────────
  const groupGrids = new Map<TurnGroupId, IkiWarpGrid>();
  for (const { group, role } of members) {
    if (groupGrids.has(group)) continue;
    const own = members.filter((m) => m.group === group);
    const isPlate = group === "faceWarp";
    // The nod translate the members will carry (featureParallaxBindings) —
    // one depth per group, taken as the members' largest all the same.
    const nodShiftPx = hasNose
      ? Math.max(
          ...own.map((m) => FEATURE_NOD_DEPTH[roleFamily(m.role)] ?? 0),
        ) * parallaxUnitY
      : 0;
    groupGrids.set(
      group,
      groupGridFor(
        own,
        isPlate ? FACE_PLATE_CELLS : FEATURE_GRID_CELLS,
        isPlate ? 0 : turnShift[turnFamily(role)],
        nodShiftPx,
      ),
    );
  }
  const carriers = new Map<string, TurnCarrier>(
    members.map((m) => [
      m.role,
      { grid: groupGrids.get(m.group)!, part: m.part },
    ]),
  );

  // ── The lattice ───────────────────────────────────────────────────────────
  const maxShift = Math.max(turnShift.eye, turnShift.nose, turnShift.mouth);
  let reach = 0;
  for (const grid of groupGrids.values()) {
    reach = Math.max(
      reach,
      faceCenterX - grid.points[0] + maxShift,
      grid.points[grid.cols * 2] - faceCenterX + maxShift,
    );
  }
  const halfCells = Math.floor(reach / TURN_LATTICE_CELL_PX) + 1;
  // Columns at faceCenterX ± k·pitch outright, not a span divided up, so the
  // axis column IS faceCenterX to the last bit; row 0 is the top row.
  const points: number[] = [];
  for (const y of [unionMaxY, unionMinY]) {
    for (let k = -halfCells; k <= halfCells; k++) {
      points.push(faceCenterX + k * TURN_LATTICE_CELL_PX, y);
    }
  }
  const lattice: IkiWarpGrid = { cols: 2 * halfCells, rows: 1, points };

  const hairFrontLayer = layers.find((l) => l.role === "hair_front");
  const hairFront =
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
    })();

  const eyeRowY = eyeRowOf(landmarks, faceCenterY);
  const profile = faceRowProfile(faceLayer, faceCenterY);

  return {
    landmarks: turnLandmarks(layers, carriers),
    lattice,
    faceCenterX,
    faceHalfWidth,
    faceCenterY,
    nodRadius,
    carriers,
    profile,
    hairFront,
    eyeRowY,
    ...plateGuardsOf(carriers, faceHalfWidth, profile, hairFront),
    members,
    groupGrids,
    parallaxUnitY,
    hasNose,
    hasMouthOpen,
  };
}

/**
 * Everything `generateIkiFromLayerSet` hands `solveTurnModel` for a layer set,
 * the targets and the caller's `headEdges` excepted (they are the caller's
 * own) — built by `turnSetup` and nowhere else, so a test that solves a layer
 * set directly solves exactly the turn the generator solves, on the very
 * grids and carriers it ships. Exported at module level for those tests, not
 * from the package.
 */
export function turnSolveInputs(layers: LayerInput[]): TurnSolveInputs {
  return solveInputsOf(turnSetup(layers));
}

/** A setup's fields in `solveTurnModel`'s positional order — spelled here
 *  once, since four adjacent numbers in it are not told apart by type. */
function solveInputsOf(s: TurnSetup): TurnSolveInputs {
  return [
    s.landmarks,
    s.lattice,
    s.faceCenterX,
    s.faceHalfWidth,
    s.faceCenterY,
    s.nodRadius,
    s.carriers,
    s.profile,
    s.hairFront,
  ];
}

// ── generateIkiFromLayerSet ───────────────────────────────────────────────────

/**
 * Auto-rig: given decoded layer inputs and the shared canvas size, produce a
 * valid IkiModel ready for parseIkiModel.
 *
 *   - Validate all inputs before deriving anything.
 *   - Place parts at source-derived positions (bboxToTransform, unshifted).
 *   - Emit the standard parameters (STANDARD_PARAMETERS), plus a conditional
 *     HairSwayX/Z pair + hair-sway physics rigs when a hair_front layer is
 *     present.
 *   - Size every turn group's grid to its own members and the virtual lattice
 *     to those grids, then solve the turn on them (turnSetup, solveTurnModel):
 *     one surface — radius, travel, the head-level nod radius — that every
 *     bake below samples.
 *   - Build headDeformer (matrix, neck pivot, nod/tilt/breath bindings — the
 *     turn translates nothing rigidly; its travel is in the group grids), one
 *     warp deformer per turn group present — `faceWarp` for the plate,
 *     `eyeWarp_L/R`, `mouthWarp`, `noseWarp`, `browWarp_L/R`, `blushWarp_L/R`
 *     — each a warp2d over its own grid baked from that surface with the
 *     family's solved depth as keyform geometry (bakeTurnGroupWarp2D), and
 *     bodyDeformer when a body layer is present (matrix, torso-base pivot,
 *     AngleX follow + Breath follow).
 *   - Mesh parts (spec.mesh===true) → width:1, height:1, pixel grid mesh sized by
 *     meshCellsFor + role bindings, each face-family part on its group's warp.
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
  const bodyLayer = layers.find((l) => l.role === "body");

  // ── Standard parameters ───────────────────────────────────────────────────
  const parameters: IkiParameter[] = [...STANDARD_PARAMETERS];

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

  // ── The face, its groups, the lattice and the turn ────────────────────────
  // Exactly what the solve is handed, and the members and group grids it was
  // built from — built once in turnSetup, so a test that solves this layer
  // set directly (turnSolveInputs) solves this very turn on these very grids.
  const setup = turnSetup(layers);
  const {
    lattice,
    faceCenterX,
    faceHalfWidth,
    faceCenterY,
    nodRadius,
    profile,
    eyeRowY,
    plate,
    edgeAt,
    plateGuardRows,
    members,
    groupGrids,
    parallaxUnitY,
    hasNose,
    hasMouthOpen,
  } = setup;
  const faceCropH = plate.part.cropH;

  // The head cylinder's turn radius, the face's sideways travel and how far in
  // front of the axis each feature sits: SOLVED from the turn cues, on the
  // very surface every group grid is baked from, so what the targets promise
  // is what the keyforms do. Without a nose there is no feature slide to fit
  // (see FEATURE_NOD_DEPTH) and nothing to solve the radius against.
  const turn = hasNose
    ? solveTurnModel(
        resolveTurnTargets(options.turnTargets),
        ...solveInputsOf(setup),
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
  // The analytic head every bake below samples — every group's grid, the
  // bangs' hold and the body's follow all read this ONE surface, so nothing
  // renders a turn the cues were not measured on. Solved when there was a
  // nose; without one, the lattice's own reach about the face centre with the
  // no-fold margin (on a row reading aMax the bound lands beyond every node
  // any grid reads, so those rows never leave the surface; a narrower profile
  // row's bound is nearer — ≈ 150 px on a 96 px band, against plate nodes at
  // ±250 — so its transparent-margin nodes ride the rigid branch: monotone,
  // so fold-free, and beyond the painted edge, so nothing reads them, as
  // Decision 5 accepts) and the plate's own uncut travel ask, there being no
  // held silhouette to size it against; the face's own row profile, when it
  // has one, bends that surface's rows the same way it would a solved one's.
  // Its nod radius is the head's, the one the solve was handed. The turn's
  // depth-parallax unit comes off the same cylinder the bakes bend.
  const latticeReach = Math.max(
    faceCenterX - lattice.points[0],
    lattice.points[lattice.cols * 2] - faceCenterX,
  );
  const surface =
    turn?.surface ??
    turnSurface({
      faceCenterX,
      faceCenterY,
      radius: latticeReach * HEAD_CYLINDER_RADIUS_FACTOR,
      travel: headTurnTravel(faceHalfWidth),
      nodRadius,
      lattice,
      profile,
      eyeRowY,
    });
  const parallaxUnit = headTurnParallaxUnit(surface.radius);
  // The plate as it RENDERS on that surface — its own mesh over its own grid,
  // the carrier. Its painted edge per row (`edgeAt`) and the rows it is
  // guarded at (`plateGuardRows`) are the setup's own, the very ones the solve
  // read (`plateGuardsOf`), so the hold the solve fitted is the hold the bake
  // below can build.
  const plateLandingAt = plateLandingOn(plate, rowMapsOf(surface));

  // ── headDeformer pivot (neck): slightly below the face bottom ─────────────
  // faceBottom is the model-space y of the bottom edge of the face crop.
  // The neck pivot sits 15% of the face crop height below the face bottom.
  const faceBottom = faceCenterY - faceCropH / 2;
  const neckPivot = {
    x: faceCenterX,
    y: faceBottom - faceCropH * 0.15, // 15% below face bottom = neck
  };

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
        // travel is baked into every group grid (the surface's `travel`, see
        // bakeTurnGroupWarp2D) so the face slides inside a silhouette the
        // bangs hold; a translate here would take the hair shell with it. Nor
        // is the turn a roll — the sample model's ±6° "lean into the turn" was
        // tried here and dropped, since rotating about the neck pivot swings
        // the crown (~500px above it) far more than the chin, so the top of
        // the head appeared to lunge ahead of the face on every turn. Roll is
        // AngleZ's job, below.

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
  ];

  // One cylinder-bend warp per turn group present, parented to headDeformer:
  // the group's own grid (`groupGridFor`, the very carrier the solve read its
  // parts through), every node sampling the surface at its own rest position
  // — shifted, at each turn stop, by the family's solved depth share of the
  // parallax unit, so the depth is the grid's keyform geometry rather than a
  // translate on the parts (see featureParallaxBindings). The plate has no
  // depth: it IS the cylinder. Without a solve no depth is known and every
  // group reads the surface unshifted. One 2D warp carries both the turn and
  // the nod (a deformer holds either `warps` or `warp2d`, never both).
  for (const [group, grid] of groupGrids) {
    const family = turnFamily(members.find((m) => m.group === group)!.role);
    const depth = group === "faceWarp" ? 0 : (turn?.depths[family] ?? 0);
    deformers.push({
      kind: "warp" as const,
      id: group,
      parent: "headDeformer",
      grid,
      warp2d: bakeTurnGroupWarp2D(
        grid,
        StandardParameter.AngleX,
        StandardParameter.AngleY,
        surface,
        (deg) => (depth * parallaxUnit * deg) / HEAD_TURN_MAX_DEG,
      ),
    });
  }

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
          from: -BODY_TURN_FOLLOW * surface.travel,
          to: BODY_TURN_FOLLOW * surface.travel,
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

  // ── Parts ─────────────────────────────────────────────────────────────────
  const memberByRole = new Map(members.map((m) => [m.role, m]));
  const parts: IkiPart[] = layers.map((layer) => {
    const { role, bbox, cropW, cropH, canvasW, canvasH } = layer;
    const spec = ROLE_TABLE[role];
    const t = bboxToTransform(bbox, canvasW, canvasH, role);
    const roleBindings = bindingsForRole(spec, role, cropW, cropH, {
      hasMouthOpen,
      parallaxUnitY,
      hasNose,
    });
    // `IkiPart.deformer` is optional, so a "none" role states its detachment by
    // leaving the field off rather than naming a deformer that must exist.
    const deformerId = spec.deformer === "none" ? undefined : spec.deformer;

    if (spec.mesh) {
      // Mesh part: width:1, height:1 with a pixel grid mesh centered at the
      // crop center; the engine applies the part transform to position it. A
      // group member renders on the very mesh its carrier was read with.
      const member = memberByRole.get(role);
      const { cols, rows } = meshCellsFor(cropW, cropH);
      const mesh =
        member?.mesh ?? createPixelGridMesh(cols, rows, cropW, cropH);
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
        // Both hair parts ride the rigid head, with no grid edge under them
        // to clamp a swing, so the full fraction of the height swings on
        // both. Warp order in the array doesn't matter; they sum.
        const tipShift = HAIR_SWAY_TIP_FRACTION * cropH;
        const ownWarps: IkiWarp[] = [];
        if (role === "hair_front") {
          // The bangs' turn lead: root-pinned like the sway, keyed to
          // HEAD_TURN_MAX_DEG instead of a sway spring's range — see
          // bindingsForRole's doc for why this is a warp, not a binding.
          ownWarps.push(
            bakeHairSwayWarp(
              mesh,
              StandardParameter.AngleX,
              HAIR_FRONT_DEPTH * parallaxUnit,
              HEAD_TURN_MAX_DEG,
            ),
          );
          // The bangs draw the head's outline, so they hold it through the
          // turn instead of squeezing in with the plate beneath them — their
          // inner strands on the RENDERED plate, their outer ones on the hold
          // edge. The solve already picked the hold's zone for the radius it
          // picked: the head's measured half-width when it had one, and a
          // destination that carries the silhouette ratio through the turn.
          // Without a solve nothing here has measured where the outline
          // actually is, so the hold edge is the outermost the plate ever
          // reaches, clear of it by a pixel, and it holds its rest position:
          // the silhouette stops narrowing without being asked to move. That
          // reach already covers the rest pose (its 0° stop is the identity),
          // and anything inside it would fold the ramp.
          const holdBase =
            turn?.holdBase ??
            plateReach(plateLandingAt, faceCenterX, edgeAt, plateGuardRows) +
              HOLD_CLEARANCE;
          ownWarps.push(
            bakeHairFrontSilhouetteWarp(
              mesh,
              t.x,
              t.y,
              faceCenterX,
              plateLandingAt,
              edgeAt,
              holdBase,
              turn?.holdEdgeAt ?? (() => holdBase),
              plateGuardRows,
            ),
          );
          // On the nod the bangs slide with the brows they hang over — only
          // when the brows slide, i.e. with a nose to lead them — and bend on
          // the same surface the plate does; see HAIR_FRONT_NOD_DEPTH.
          ownWarps.push(
            bakeNodWarp(
              mesh,
              t.y,
              surface,
              hasNose ? HAIR_FRONT_NOD_DEPTH * parallaxUnitY : 0,
            ),
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
          ...ownWarps,
        ];
      }
      // Eye blink = fold: the white (eye_) and the lash (lash_) fold shut via a
      // warp toward the shared crease — the one their member was built with
      // (eyelidFoldFor), so the grid that bounds them saw the same fold;
      // iris/pupil/highlight clip to the white, so the closing white CUTS them
      // away (round, not squashed) and the lash lands on top to cover the
      // seam. The white is a required role (clip mask exists).
      if (spec.eyeSide !== undefined) {
        if (role.startsWith("eye_") || role.startsWith("lash_")) {
          part.warps = [...member!.warps];
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
