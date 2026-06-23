// The playground's hand-authored demo model (canonical source; the editor keeps
// a local copy of this file).
import {
  StandardParameter,
  type IkiBinding,
  type IkiDeformerBinding,
  type IkiMatrixDeformer,
  type IkiMesh,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiPhysicsChain,
  type IkiPhysicsChainSegment,
  type IkiWarpGrid,
} from "@iki/format";
import { bakeHeadTurnGridWarp2D } from "./mesh-generator";

/**
 * A hand-authored flat-shaded ("vector") anime face, built entirely from
 * solid-color polygon meshes — no texture assets. It exists to make the default
 * model read as a real character while still exercising the whole rig: blink
 * (eye scaleY), gaze (iris/pupil translate), lip-sync (mouth scale), head-turn
 * (faceWarp cylinder bend), and breath (head bob).
 *
 * Authoring convention: every mesh is built in MODEL-PIXEL units centered on the
 * part's local origin, and each part uses `width: 1, height: 1` so the mesh
 * coordinates pass through untouched except for the part `transform`. That keeps
 * `scaleX`/`scaleY` bindings (blink, mouth) scaling about each part's own
 * center, and `translateX/Y` bindings (gaze) moving a part as a whole.
 */

// --- palette (RGBA, 0..1) ---------------------------------------------------
const SKIN: [number, number, number, number] = [1.0, 0.89, 0.82, 1];
const SKIN_SHADOW: [number, number, number, number] = [0.96, 0.8, 0.73, 1];
const HAIR: [number, number, number, number] = [0.46, 0.31, 0.27, 1];
const HAIR_DARK: [number, number, number, number] = [0.37, 0.24, 0.21, 1];
const WHITE: [number, number, number, number] = [0.99, 0.99, 1.0, 1];
const IRIS: [number, number, number, number] = [0.31, 0.57, 0.86, 1];
const PUPIL: [number, number, number, number] = [0.13, 0.13, 0.18, 1];
const LASH: [number, number, number, number] = [0.18, 0.13, 0.16, 1];
const BLUSH: [number, number, number, number] = [1.0, 0.62, 0.62, 0.55];
const NOSE: [number, number, number, number] = [0.92, 0.72, 0.66, 1];
const LIP: [number, number, number, number] = [0.83, 0.36, 0.42, 1];
const HIGHLIGHT: [number, number, number, number] = [1.0, 1.0, 1.0, 0.92];

// --- mesh helpers -----------------------------------------------------------
// uvs are required by the format (length === vertices length, each in 0..1) but
// unused for color-only parts, so every vertex gets a harmless (0.5, 0.5).

/** A filled ellipse (radii in model px), fan-triangulated from its center. */
function ellipseMesh(rx: number, ry: number, segments = 28): IkiMesh {
  const vertices: number[] = [0, 0];
  const uvs: number[] = [0.5, 0.5];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    vertices.push(Math.cos(a) * rx, Math.sin(a) * ry);
    uvs.push(0.5, 0.5);
  }
  const indices: number[] = [];
  for (let i = 1; i <= segments; i++) {
    const next = i === segments ? 1 : i + 1;
    indices.push(0, i, next);
  }
  return { vertices, uvs, indices };
}

/**
 * A solid hair fringe: a band between a straight top edge (`topY`) and a
 * scalloped bottom edge (`bottomYs`, one per `xs` column). Strip-triangulated so
 * there are NO interior gaps — the forehead only shows BELOW the bottom edge,
 * which is the intended anime-bang silhouette.
 */
function fringeMesh(xs: number[], topY: number, bottomYs: number[]): IkiMesh {
  const n = xs.length;
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < n; i++) {
    vertices.push(xs[i], topY);
    uvs.push(0.5, 0.5);
  }
  for (let i = 0; i < n; i++) {
    vertices.push(xs[i], bottomYs[i]);
    uvs.push(0.5, 0.5);
  }
  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const t0 = i;
    const t1 = i + 1;
    const b0 = n + i;
    const b1 = n + i + 1;
    indices.push(t0, t1, b1);
    indices.push(t0, b1, b0);
  }
  return { vertices, uvs, indices };
}

/**
 * A tapering hair strand following a vertical-ish `centerline` (top→bottom), each
 * point with its own `halfWidths` — strip-triangulated down the strand so it can
 * KINK / bend mid-length (a non-convex silhouette a single convex polygon can't
 * make). Width is applied as a horizontal ±x offset (fine for near-vertical
 * strands). Vertices are [L0,R0,L1,R1,…] so segment i uses 2i..2i+3.
 */
function strandMesh(
  centerline: ReadonlyArray<readonly [number, number]>,
  halfWidths: number[],
): IkiMesh {
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < centerline.length; i++) {
    const [x, y] = centerline[i];
    const w = halfWidths[i];
    vertices.push(x - w, y, x + w, y);
    uvs.push(0.5, 0.5, 0.5, 0.5);
  }
  const indices: number[] = [];
  for (let i = 0; i < centerline.length - 1; i++) {
    const l0 = 2 * i;
    const r0 = 2 * i + 1;
    const l1 = 2 * i + 2;
    const r1 = 2 * i + 3;
    indices.push(l0, r0, r1);
    indices.push(l0, r1, l1);
  }
  return { vertices, uvs, indices };
}

// --- per-feature binding builders ------------------------------------------
const blink = (eye: string): IkiBinding => ({
  parameter: eye,
  channel: "scaleY",
  from: -0.85,
  to: 0,
});
const gaze = (): IkiBinding[] => [
  {
    parameter: StandardParameter.EyeballX,
    channel: "translateX",
    from: -22,
    to: 22,
  },
  {
    parameter: StandardParameter.EyeballY,
    channel: "translateY",
    from: -16,
    to: 16,
  },
];

// --- warp grid (head-turn) --------------------------------------------------
/**
 * Generate (cols+1)*(rows+1) MODEL-space grid control points, row-major.
 * Row 0 is the TOP (y = maxY); y decreases with row index (+y up).
 * Column 0 is left (x = minX); x increases with column index.
 */
function generateGridPoints(
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
    const y = maxY - t * (maxY - minY);
    for (let col = 0; col <= cols; col++) {
      const s = col / cols;
      const x = minX + s * (maxX - minX);
      pts.push(x, y);
    }
  }
  return pts;
}

// Head warp grid: 4×4 cells (5×5 control points), spanning the WHOLE head —
// face AND hair — so the head turns as one body (the hair foreshortens with the
// face instead of staying a rigid blob). Bounds enclose backHair (±305 wide,
// y ∈ [-320, 370]) with a small margin; the grid center (0, 25) is the head's
// turn pivot for the center-relative bake.
const faceGrid: IkiWarpGrid = {
  cols: 4,
  rows: 4,
  points: generateGridPoints(4, 4, -310, 310, -325, 375),
};
// 2D cylinder-bend keyforms (AngleX × AngleY) — curvature lives here only; the
// rigid turn/translate stays on headDeformer (no double-apply, same contract as
// the 1D AngleX split). The 3×3 lattice captures horizontal AND vertical bends.
const faceWarp2d = bakeHeadTurnGridWarp2D(
  faceGrid,
  StandardParameter.AngleX,
  StandardParameter.AngleY,
);

// A face feature: a color mesh part on faceWarp at width/height 1.
function feature(
  id: string,
  color: [number, number, number, number],
  order: number,
  x: number,
  y: number,
  mesh: IkiMesh,
  bindings?: IkiBinding[],
): IkiPart {
  return {
    id,
    color,
    width: 1,
    height: 1,
    order,
    transform: { x, y },
    deformer: "faceWarp",
    mesh,
    ...(bindings ? { bindings } : {}),
  };
}

// A hair part rides faceWarp too, so the hair foreshortens with the head turn
// as one body (same deformer as the face features — only the draw order differs).
function hair(
  id: string,
  color: [number, number, number, number],
  order: number,
  x: number,
  y: number,
  mesh: IkiMesh,
  bindings?: IkiBinding[],
): IkiPart {
  return {
    id,
    color,
    width: 1,
    height: 1,
    order,
    transform: { x, y },
    deformer: "faceWarp",
    mesh,
    ...(bindings ? { bindings } : {}),
  };
}

// Side-lock chain params. Each segment emits its angular displacement θ
// (degrees) via HairChainMotion. The rotate binding maps the param 1:1 to
// degrees because the binding range {from:-60,to:60} equals the param's own
// [min,max], so evaluateTransform lerps from→to across the normalized [0,1]
// range giving exactly θ degrees of rotation.
const LOCK_PARAM_MIN = -60;
const LOCK_PARAM_MAX = 60;

// The chain rides headDeformer's rigid matrix, NOT faceWarp's cylinder bend, so
// on a head turn the lock would float off the warp-COMPRESSED face edge (the
// receding side compresses inward, the lock does not). This AngleX-driven
// translateX on each lock's ROOT segment pulls the strand back toward the face
// to track that compression (a position counterpart of the head-roll counter on
// the old single-strand locks). Antisymmetric + zero at AngleX=0, so the rest
// pose is unchanged; each lock pulls inward on the turn that makes its side recede.
const LOCK_TURN_TRACK = 42;

// --- side-lock strand (Hiyori-style smooth, single-piece lock) --------------
// A single conceptual strand is SLICED into many short bands, each band riding
// one matrix deformer in a parent chain (seg0 → seg1 → … off the head). Adjacent
// bands SHARE the joint vertex row, and each segment's pivot sits exactly on its
// band's top row, so a segment rotates about that shared point — WELDING the seam
// (no gap) while the strand bends smoothly across many joints. This is the
// slice-and-glue approach Live2D Cubism "skinning" actually uses (not per-vertex
// LBS); HairChainMotion drives each band's rotation param. Solid color + many
// fine bands ⇒ the slices read as one continuous flowing lock.

// Strand centerline in part-LOCAL model px (top → tip) for the LEFT lock, each
// point with a half-width (taper). Band count = points − 1. Right lock mirrors x.
const LOCK_CENTERLINE: ReadonlyArray<readonly [number, number]> = [
  [-12, 4],
  [-12, -90],
  [-8, -190],
  [0, -290],
  [12, -380],
  [28, -460],
  [48, -540],
];
const LOCK_HALF_WIDTHS = [30, 33, 32, 28, 22, 15, 8];
// Part transform placing the local strand at the LEFT temple (right negates x).
const LOCK_ORIGIN = { x: -215, y: 215 };
// Per-band physics (length = band count). θ ACCUMULATES down the chain, so the
// tip already moves most on its own — the ramp therefore FIRMS the lower bands
// (rising damping + held-up stiffness toward the tip) so the tip swishes gently
// instead of whipping. Upper bands stay a touch looser to carry the lead sway.
const LOCK_STIFFNESS = [10, 9, 8, 7, 7, 6];
const LOCK_DAMPING = [7, 8, 9, 10, 10, 11];

// Build one side-lock's params, deformer chain, mesh bands, and physics chain
// from the shared centerline. seg ids/params are `lock{L|R}_seg{i}` /
// `ParamLock{L|R}{i}` (chain-only outputs, not host-driven).
function buildLock(side: "L" | "R"): {
  params: IkiParameter[];
  deformers: IkiMatrixDeformer[];
  parts: IkiPart[];
  chain: IkiPhysicsChain;
} {
  const sign = side === "L" ? 1 : -1;
  const origin = { x: LOCK_ORIGIN.x * sign, y: LOCK_ORIGIN.y };
  const centerline = LOCK_CENTERLINE.map(([x, y]) => [x * sign, y] as const);
  const bandCount = centerline.length - 1;

  const params: IkiParameter[] = [];
  const deformers: IkiMatrixDeformer[] = [];
  const parts: IkiPart[] = [];
  const segments: IkiPhysicsChainSegment[] = [];

  for (let i = 0; i < bandCount; i++) {
    const paramId = `ParamLock${side}${i}`;
    params.push({
      id: paramId,
      name: `Lock ${side} seg${i}`,
      min: LOCK_PARAM_MIN,
      max: LOCK_PARAM_MAX,
      default: 0,
    });

    // rotate binding maps the param 1:1 to degrees (from/to == param [min,max]).
    const bindings: IkiDeformerBinding[] = [
      {
        parameter: paramId,
        channel: "rotate",
        from: LOCK_PARAM_MIN,
        to: LOCK_PARAM_MAX,
      },
    ];
    // Only the ROOT band tracks the warped face edge on a turn (see LOCK_TURN_TRACK);
    // child bands inherit it through the parent chain. Same sign on both locks.
    if (i === 0) {
      bindings.push({
        parameter: StandardParameter.AngleX,
        channel: "translateX",
        from: LOCK_TURN_TRACK,
        to: -LOCK_TURN_TRACK,
      });
    }
    deformers.push({
      id: `lock${side}_seg${i}`,
      parent: i === 0 ? "headDeformer" : `lock${side}_seg${i - 1}`,
      // Pivot at the band's TOP row (= the joint shared with the previous band),
      // in model space (part transform + local), so rotation welds the seam.
      pivot: { x: origin.x + centerline[i][0], y: origin.y + centerline[i][1] },
      bindings,
    });

    parts.push({
      id: `sideLock${side}_${i}`,
      color: HAIR,
      width: 1,
      height: 1,
      order: 9,
      transform: { ...origin },
      deformer: `lock${side}_seg${i}`,
      mesh: strandMesh(
        [centerline[i], centerline[i + 1]],
        [LOCK_HALF_WIDTHS[i], LOCK_HALF_WIDTHS[i + 1]],
      ),
    });

    segments.push({
      output: { parameter: paramId, scale: 1 },
      // seg0 rest world direction is straight DOWN (-90 = gravity.angle) → zero
      // gravity torque at rest. Child bands continue straight (restAngle 0).
      ...(i === 0 ? { restAngle: -90 } : {}),
      mass: 1,
      stiffness: LOCK_STIFFNESS[i],
      damping: LOCK_DAMPING[i],
    });
  }

  return {
    params,
    deformers,
    parts,
    chain: {
      id: `lock${side}`,
      anchorDeformer: "headDeformer",
      // gravity.strength ≫ stiffness so the lock hangs ≈vertical under any head angle.
      gravity: { angle: -90, strength: 50 },
      segments,
    },
  };
}

const lockL = buildLock("L");
const lockR = buildLock("R");

export const sampleModel: IkiModel = {
  version: 1,
  name: "Anime Face",
  canvas: { width: 1000, height: 1000 },
  textures: [],
  parameters: [
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
      name: "Head Angle X",
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
      id: StandardParameter.Breath,
      name: "Breath",
      min: 0,
      max: 1,
      default: 0,
    },
    // Chain segment output params (driven by HairChainMotion, not the host) —
    // one per band, generated per side lock by buildLock. Range ±60° covers the
    // expected pendulum deviation under gravity.
    ...lockL.params,
    ...lockR.params,
  ],
  // headDeformer rotates/bobs the whole head as one rigid body about the neck
  // pivot. faceWarp (parented to it) adds cylinder-bend curvature on top.
  deformers: [
    {
      id: "headDeformer",
      pivot: { x: 0, y: -350 },
      bindings: [
        {
          parameter: StandardParameter.AngleX,
          channel: "rotate",
          from: 6,
          to: -6,
        },
        {
          parameter: StandardParameter.AngleX,
          channel: "translateX",
          from: -50,
          to: 50,
        },
        // AngleY vertical pitch: uses translateY + faceWarp2d curvature only.
        // No rotate binding — AngleX already owns the rotate channel; adding AngleY
        // rotate would cause the two rigid rotations to sum at diagonal poses (yaw
        // and pitch collapsing into one roll scalar).
        {
          parameter: StandardParameter.AngleY,
          channel: "translateY",
          from: -50,
          to: 50,
        },
        {
          parameter: StandardParameter.Breath,
          channel: "translateY",
          from: 0,
          to: -12,
        },
      ],
    },
    {
      kind: "warp" as const,
      id: "faceWarp",
      parent: "headDeformer",
      grid: faceGrid,
      warp2d: faceWarp2d,
    },
    // Side-lock chain deformers (seg0 → seg1 → … off the head), one per band,
    // generated per side lock by buildLock — see the strand block above.
    ...lockL.deformers,
    ...lockR.deformers,
  ],
  parts: [
    // back hair mass (behind everything)
    hair("backHair", HAIR_DARK, 0, 0, 25, ellipseMesh(305, 345)),

    // ears (ride the face turn)
    feature("earL", SKIN_SHADOW, 1, -222, 5, ellipseMesh(34, 48)),
    feature("earR", SKIN_SHADOW, 1, 222, 5, ellipseMesh(34, 48)),

    // face skin
    feature("faceSkin", SKIN, 2, 0, -8, ellipseMesh(220, 286)),

    // blush
    feature("blushL", BLUSH, 3, -128, -54, ellipseMesh(46, 26)),
    feature("blushR", BLUSH, 3, 128, -54, ellipseMesh(46, 26)),

    // eye whites
    feature("eyeWhiteL", WHITE, 4, -108, 52, ellipseMesh(54, 46), [
      blink(StandardParameter.EyeOpenLeft),
    ]),
    feature("eyeWhiteR", WHITE, 4, 108, 52, ellipseMesh(54, 46), [
      blink(StandardParameter.EyeOpenRight),
    ]),

    // iris
    feature("irisL", IRIS, 5, -108, 50, ellipseMesh(40, 44), [
      blink(StandardParameter.EyeOpenLeft),
      ...gaze(),
    ]),
    feature("irisR", IRIS, 5, 108, 50, ellipseMesh(40, 44), [
      blink(StandardParameter.EyeOpenRight),
      ...gaze(),
    ]),

    // pupil
    feature("pupilL", PUPIL, 6, -108, 48, ellipseMesh(18, 24), [
      blink(StandardParameter.EyeOpenLeft),
      ...gaze(),
    ]),
    feature("pupilR", PUPIL, 6, 108, 48, ellipseMesh(18, 24), [
      blink(StandardParameter.EyeOpenRight),
      ...gaze(),
    ]),

    // eye highlight (sparkle, upper-left of each pupil)
    feature("highlightL", HIGHLIGHT, 7, -120, 68, ellipseMesh(16, 18), [
      blink(StandardParameter.EyeOpenLeft),
      ...gaze(),
    ]),
    feature("highlightR", HIGHLIGHT, 7, 96, 68, ellipseMesh(16, 18), [
      blink(StandardParameter.EyeOpenRight),
      ...gaze(),
    ]),

    // upper lash line (drops a touch when the eye closes)
    feature("lashL", LASH, 7, -108, 84, ellipseMesh(58, 11), [
      {
        parameter: StandardParameter.EyeOpenLeft,
        channel: "translateY",
        from: -30,
        to: 0,
      },
    ]),
    feature("lashR", LASH, 7, 108, 84, ellipseMesh(58, 11), [
      {
        parameter: StandardParameter.EyeOpenRight,
        channel: "translateY",
        from: -30,
        to: 0,
      },
    ]),

    // eyebrows
    feature("browL", HAIR, 8, -108, 120, ellipseMesh(44, 8)),
    feature("browR", HAIR, 8, 108, 120, ellipseMesh(44, 8)),

    // nose (subtle)
    feature("nose", NOSE, 5, 0, -12, ellipseMesh(7, 9)),

    // mouth
    feature("mouth", LIP, 6, 0, -120, ellipseMesh(38, 12), [
      {
        parameter: StandardParameter.MouthOpen,
        channel: "scaleY",
        from: 0,
        to: 3,
      },
      {
        parameter: StandardParameter.MouthForm,
        channel: "scaleX",
        from: -0.2,
        to: 0.4,
      },
    ]),

    // scalp / hairline cap (in front of the upper face)
    hair("topHair", HAIR, 10, 0, 246, ellipseMesh(256, 118)),

    // front bangs — one solid scalloped fringe (no skin gaps between locks)
    hair(
      "bangFront",
      HAIR,
      11,
      0,
      0,
      fringeMesh(
        [-215, -160, -108, -54, 0, 54, 108, 160, 215],
        262,
        [120, 96, 128, 100, 132, 100, 128, 96, 120],
      ),
    ),

    // Side-lock strands — each sliced into welded bands on its deformer chain,
    // generated per side by buildLock (see the strand block above). Drawn at
    // order 9 (over the back hair / face, under the front bangs and scalp).
    ...lockL.parts,
    ...lockR.parts,
  ],
  // Gravity-hung angular chain for each side lock (one segment per band),
  // generated by buildLock. Anchored to headDeformer (locks follow the head) and
  // driving the lock{L,R} band rotation params via HairChainMotion. gravity.strength
  // (50) ≫ the per-band stiffness ramp, so each lock hangs ≈vertical at any head angle.
  physicsChains: [lockL.chain, lockR.chain],
};
