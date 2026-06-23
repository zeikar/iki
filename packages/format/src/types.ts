/**
 * The `.iki` model format, version 1.
 *
 * A model is a flat list of drawable {@link IkiPart}s composited back-to-front,
 * plus a list of {@link IkiParameter}s (the controllable knobs) wired to those
 * parts through linear {@link IkiBinding}s. Parts may optionally carry a
 * triangle {@link IkiMesh} with per-vertex UV and per-parameter warp keyforms
 * ({@link IkiWarp}/{@link IkiKeyform}) — both are part of the v1 contract.
 * Two-parameter (joint X+Y) grid warps via {@link IkiGrid2DWarp} (`warp2d`) are supported; each deformer carries
 * either a 1D warp (`warps`) or a 2D warp (`warp2d`), not both. Multi-grid composition and further advanced warp
 * types remain deferred. Group warp deformers ({@link IkiWarpDeformer}) are part of the v1 contract.
 */
export const IKI_FORMAT_VERSION = 1;

/**
 * A sub-rectangle of a texture atlas in normalized UV space (0..1).
 * `x`/`y` is the top-left corner; `width`/`height` extend right/down.
 */
export interface IkiUvRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A triangle mesh in part LOCAL space.
 *
 * `vertices` and `uvs` are parallel flat arrays: vertex `i` is at
 * `vertices[2i], vertices[2i+1]` and samples the atlas at `uvs[2i], uvs[2i+1]`.
 */
export interface IkiMesh {
  /** Flat `[x0,y0, x1,y1, ...]` in part LOCAL ±0.5 unit space; the same frame
   *  the engine already uses so width/height scaling applies downstream. */
  vertices: number[];
  /** Flat `[u0,v0, u1,v1, ...]`, 0..1 top-left, same atlas-space normalization
   *  as {@link IkiUvRect}; used directly with no flip. */
  uvs: number[];
  /** Triangle list of indices into `vertices`; length must be a multiple of 3. */
  indices: number[];
}

/**
 * A single authored pose within a {@link IkiWarp}.
 */
export interface IkiKeyform {
  /** The parameter's own-range value this pose is authored at — NOT normalized. */
  value: number;
  /** Flat per-vertex delta `[dx0,dy0, dx1,dy1, ...]`, same length and order as
   *  `mesh.vertices`; ADDED to the rest mesh to produce the deformed positions. */
  offsets: number[];
}

/**
 * Per-vertex warp driven by one parameter.
 *
 * At runtime the live parameter value is clamped to `[keyforms[0].value,
 * keyforms[last].value]` and then linearly interpolated between the bracketing
 * pair of keyforms.
 */
export interface IkiWarp {
  /** Id of the parameter that drives this warp. */
  parameter: string;
  /** Non-empty list of keyforms sorted ascending by `value`. */
  keyforms: IkiKeyform[];
}

/**
 * A texture entry in the model's atlas table.
 * v1 validates and accepts `data:image/` URIs only; `source` is a plain string
 * so loosening validation to allow external paths later is a non-breaking addition.
 */
export interface IkiTexture {
  source: string;
}

/** A controllable knob on the model (e.g. mouth open, head angle). */
export interface IkiParameter {
  /** Stable id used by bindings and runtime control. */
  id: string;
  /** Human-readable label for editors. */
  name?: string;
  min: number;
  max: number;
  /** Resting value the runtime starts from. */
  default: number;
}

/** Which channel of a part's transform a binding drives. */
export type IkiTransformChannel =
  | "translateX"
  | "translateY"
  | "rotate"
  | "scaleX"
  | "scaleY"
  | "opacity";

/**
 * Linear mapping from one parameter's range onto a transform channel.
 *
 * The parameter's current value is normalized to 0..1 across its [min, max],
 * then mapped to `[from, to]`. For translate/rotate/scale channels the result
 * is summed onto the part's base transform; for `opacity` it is multiplied.
 */
export interface IkiBinding {
  /** Id of the parameter this binding listens to. */
  parameter: string;
  channel: IkiTransformChannel;
  from: number;
  to: number;
}

/** A part's base transform in model space, before bindings apply. */
export interface IkiTransform {
  /** Center position, model-space units, origin at canvas center, +y up. */
  x: number;
  y: number;
  /** Degrees, counter-clockwise positive. */
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  /** 0..1, default 1. */
  opacity?: number;
}

/** A drawable piece of the character. */
export interface IkiPart {
  id: string;
  /** RGBA solid fill, each channel 0..1. Acts as a tint multiplier when `texture` is present ([1,1,1,1] = original). */
  color: [number, number, number, number];
  /** Width in model-space units. */
  width: number;
  /** Height in model-space units. */
  height: number;
  transform: IkiTransform;
  /** Paint order; lower draws first (further back). */
  order: number;
  bindings?: IkiBinding[];
  /**
   * Texture reference. `index` selects the atlas texture for BOTH quad and mesh
   * parts. `uv` drives only IMPLICIT-QUAD parts; a MESH part instead carries
   * per-vertex UV in `mesh.uvs` and ignores `texture.uv` (the engine ignores
   * `u_uvOffset`/`u_uvScale` on the mesh path).
   */
  texture?: { index: number; uv: IkiUvRect };
  /** Id of the deformer this part hangs from. */
  deformer?: string;
  /** Render as this mesh instead of the implicit unit quad. */
  mesh?: IkiMesh;
  /** Per-vertex warp keyforms applied to `mesh` each frame; requires `mesh`. */
  warps?: IkiWarp[];
  /**
   * Clipping mask. This part renders only inside the (union of the) alpha
   * coverage of the referenced mask parts — e.g. an iris clipped to the eye
   * sclera so it never spills past the eye at extreme gaze. Each id must
   * reference another part that carries a `mesh` and is not itself clipped
   * (masks are flat — no nesting). Mask parts still render normally in their
   * own `order` slot. The object shape leaves room for additive options
   * (e.g. `inverted`) without a breaking reshape.
   */
  clip?: { masks: string[] };
}

/** Matrix-only subset of {@link IkiTransformChannel} — opacity is not representable as a matrix. */
export type IkiMatrixChannel = Exclude<IkiTransformChannel, "opacity">;

/** Base transform for a deformer (no opacity — a matrix cannot represent opacity). */
export type IkiDeformerTransform = Omit<IkiTransform, "opacity">;

/** A binding on a deformer; drives only matrix channels (no opacity). */
export interface IkiDeformerBinding {
  parameter: string;
  channel: IkiMatrixChannel;
  from: number;
  to: number;
}

/** A deformer node in the rig hierarchy; matrix-only (no opacity). */
export interface IkiMatrixDeformer {
  kind?: "matrix";
  id: string;
  /** Id of the parent deformer; omit for a root deformer. */
  parent?: string;
  /** Pivot point in model space (origin = canvas center, +y up). */
  pivot: { x: number; y: number };
  transform?: IkiDeformerTransform;
  bindings?: IkiDeformerBinding[];
}

/**
 * A 2D control-point grid in MODEL space (origin = canvas center, +y up),
 * row-major. `cols`/`rows` are CELL counts (same convention as
 * `generateGridMesh`); there are `(cols+1)*(rows+1)` control points.
 *
 * The REST grid MUST be a regular axis-aligned lattice with this EXACT ordering
 * (the validator enforces it; binding + sampling assume it):
 *   - column 0 has the smallest x; x strictly INCREASES with column index;
 *   - row 0 has the largest y (TOP, since +y is up); y strictly DECREASES with
 *     row index;
 *   - every cell has nonzero width and height.
 * Keyforms (`IkiGridWarp`) may then deform this regular rest grid arbitrarily.
 */
export interface IkiWarpGrid {
  cols: number;
  rows: number;
  /** Flat `[x0,y0, x1,y1, ...]` of (cols+1)*(rows+1) points, MODEL space. */
  points: number[];
}

/** A single authored pose of a warp grid within an {@link IkiGridWarp}. */
export interface IkiGridKeyform {
  /** The driving parameter's own-range value (NOT normalized). */
  value: number;
  /** Flat per-control-point delta, same length as `grid.points`; ADDED to the rest grid. */
  offsets: number[];
}

/**
 * A single authored pose within an {@link IkiGrid2DWarp} at one (valuesX[i], valuesY[j]) cell.
 * No per-entry `value` — the (i,j) lattice index plus valuesX/valuesY carry the parameter values.
 */
export interface IkiGrid2DKeyform {
  /** Flat per-control-point delta, same length as `grid.points`; ADDED to the rest grid. */
  offsets: number[];
}

/**
 * Per-control-point grid warp driven by TWO parameters (a 2D parameter grid).
 *
 * Layout (row-major):
 * - `keyforms2d.length === valuesX.length * valuesY.length`
 * - Cell index: `k(i, j) = j * valuesX.length + i`
 *   where `i` indexes `valuesX` (X-axis parameter) and `j` indexes `valuesY` (Y-axis parameter).
 * - `valuesX` and `valuesY` are each strictly ascending, length ≥ 2; asymmetric N×M grids
 *   (N,M ≥ 2) are allowed.
 * - `parameter !== parameterY` (validator-enforced).
 *
 * These are documented invariants enforced by the validator (Task 2); the type itself is structural.
 */
export interface IkiGrid2DWarp {
  /** Id of the driving parameter along the X axis. */
  parameter: string;
  /** Id of the driving parameter along the Y axis. */
  parameterY: string;
  /** Strictly ascending parameter values along the X axis (length ≥ 2). */
  valuesX: number[];
  /** Strictly ascending parameter values along the Y axis (length ≥ 2). */
  valuesY: number[];
  /**
   * Row-major grid of keyforms; `length === valuesX.length * valuesY.length`.
   * Cell (i, j) is at index `j * valuesX.length + i`.
   */
  keyforms2d: IkiGrid2DKeyform[];
}

/**
 * Per-control-point grid warp driven by one parameter. Same clamp+lerp runtime
 * semantics as {@link IkiWarp}, but targets grid control points, not mesh vertices.
 */
export interface IkiGridWarp {
  parameter: string;
  /** Non-empty list of keyforms sorted ascending by `value`. */
  keyforms: IkiGridKeyform[];
}

/**
 * A warp deformer: bends its child parts through `grid`. Children reference it
 * via `part.deformer` and MUST carry a `mesh`. Its parent (if any) must be a
 * matrix deformer (validator-enforced) — e.g. a neck-rotation `headDeformer`:
 * the rigid turn stays on the parent, curvature lives in the grid keyforms.
 *
 * A deformer carries EITHER `warps` (one 1D grid warp) XOR `warp2d` (one 2D grid warp),
 * never both (validator-enforced). The 2D warp's two axes together act as its single
 * compound driver, preserving the one-warp-per-deformer intent.
 */
export interface IkiWarpDeformer {
  kind: "warp";
  id: string;
  /** Id of the parent deformer; omit for a root deformer. */
  parent?: string;
  grid: IkiWarpGrid;
  /**
   * Grid keyforms applied each frame; optional (rest grid if absent). At most ONE
   * grid warp in this milestone — multi-parameter grid composition is deferred
   * (validator-enforced).
   */
  warps?: IkiGridWarp[];
  /**
   * Two-parameter (2D) grid warp; mutually exclusive with `warps` (validator-enforced).
   * Absent means rest grid (same as omitting `warps`).
   */
  warp2d?: IkiGrid2DWarp;
}

/** A deformer node: a rigid matrix deformer (#4a) or a group warp deformer (#4c). */
export type IkiDeformer = IkiMatrixDeformer | IkiWarpDeformer;

/**
 * A 1D spring-mass-damper secondary-motion rig.
 *
 * `input.parameter` drives the spring: its current value is signed-normalized
 * around its engine-effective default and multiplied by `weight` to form the
 * spring's target. The spring's lagging position is multiplied by `output.scale`
 * and added onto `output.parameter`'s engine-effective default — so the output
 * param lags and overshoots the input (hair/accessory sway). "Engine-effective
 * default" means the declared `default` clamped into `[min, max]`, matching how
 * the runtime parameter store rests an out-of-range default; host adapters must
 * clamp likewise. Spring constants are SECONDS-based. This is secondary motion
 * only: it must not write a host-driven input param
 * (`input.parameter !== output.parameter`).
 */
export interface IkiPhysics {
  id: string;
  /** Driver parameter; its signed-normalized value × `weight` is the spring target. */
  input: { parameter: string; weight: number };
  /** Driven parameter; the spring position × `scale` is added onto its default. */
  output: { parameter: string; scale: number };
  /** Spring mass (> 0). */
  mass: number;
  /** Spring stiffness (> 0). */
  stiffness: number;
  /** Damping coefficient (>= 0). */
  damping: number;
}

/**
 * One segment in a multi-segment angular-pendulum chain rig ({@link IkiPhysicsChain}).
 *
 * ANGLE CONVENTION: θ is the segment's DISPLACEMENT from its authored rest
 * orientation. The spring restores θ → 0 (NOT toward `restAngle`). The OUTPUT
 * PARAM receives θ in DEGREES so a `rotate` binding at rest reads 0. `restAngle`
 * (in degrees) enters ONLY the world-angle sum used for gravity:
 *   Φ_i = anchorWorldAngle + Σ_{j≤i}(restAngle_j + θ_j)
 * Absence of `restAngle` is preserved — the driver defaults it to 0 at runtime.
 */
export interface IkiPhysicsChainSegment {
  /** Driven parameter; receives θ (displacement from rest) in DEGREES. */
  output: { parameter: string; scale: number };
  /**
   * Authored local rest angle of this segment in DEGREES. Optional — absence
   * means the driver uses 0. Appears only in the world-angle sum for gravity,
   * NOT in the spring term.
   */
  restAngle?: number;
  /** Segment mass (> 0). */
  mass: number;
  /** Spring stiffness (>= 0; 0 = pure gravity-hang, no spring). */
  stiffness: number;
  /** Damping coefficient (>= 0). */
  damping: number;
}

/**
 * A multi-segment angular-pendulum chain secondary-motion rig.
 *
 * The chain follows the anchor deformer's MATRIX transform only — it does not
 * ride a warp deformer's foreshorten, so the strand hangs in world space.
 * Segments are ordered root → tip; each emits its angular displacement θ (in
 * degrees) on its output parameter.
 */
export interface IkiPhysicsChain {
  id: string;
  /**
   * Id of the matrix deformer that acts as the attachment point (root pivot).
   * Must reference a declared matrix deformer (not a warp deformer).
   */
  anchorDeformer: string;
  /**
   * World gravity direction and strength.
   * `angle` = the downward direction in degrees (e.g. -90 = straight down in
   * +y-up space); `strength` >= 0.
   */
  gravity: { angle: number; strength: number };
  /** Non-empty ordered list of chain segments (root → tip). */
  segments: IkiPhysicsChainSegment[];
}

/** A complete `.iki` puppet model. */
export interface IkiModel {
  /** Format version; see {@link IKI_FORMAT_VERSION}. */
  version: number;
  name: string;
  /** Logical model-space canvas the parts are laid out in. */
  canvas: { width: number; height: number };
  parameters: IkiParameter[];
  /** Atlas table; parts reference entries by index. */
  textures?: IkiTexture[];
  parts: IkiPart[];
  deformers?: IkiDeformer[];
  /** Optional spring-mass-damper secondary-motion rigs. */
  physics?: IkiPhysics[];
  /** Optional multi-segment angular-chain secondary-motion rigs. */
  physicsChains?: IkiPhysicsChain[];
}
