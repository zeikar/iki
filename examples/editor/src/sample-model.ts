// Local copy of examples/playground/src/sample-model.ts for the editor
// (no shared example package yet). The initial EditorDocument source.
import {
  StandardParameter,
  type IkiBinding,
  type IkiMesh,
  type IkiModel,
  type IkiPart,
  type IkiWarp,
  type IkiWarpGrid,
} from "@iki/format";
import { bakeHeadTurnGridWarp } from "./mesh-generator";

/**
 * A hand-authored flat-shaded ("vector") anime face, built entirely from
 * solid-color polygon meshes — no texture assets. It exists to make the default
 * model read as a real character while still exercising the whole rig: blink
 * (eyelid fold), gaze (iris/pupil translate), lip-sync (mouth scale), head-turn
 * (faceWarp cylinder bend), and breath (head bob).
 *
 * Authoring convention: every mesh is built in MODEL-PIXEL units centered on the
 * part's local origin, and each part uses `width: 1, height: 1` so the mesh
 * coordinates pass through untouched except for the part `transform`. That keeps
 * `scaleX`/`scaleY` bindings (mouth) scaling about each part's own center,
 * `translateX/Y` bindings (gaze) moving a part as a whole, and `warps` keyforms
 * (eyelid fold) deforming a mesh per-vertex.
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

/** A filled CONVEX polygon (points in model px), fan-triangulated from points[0]. */
function polygonMesh(
  points: ReadonlyArray<readonly [number, number]>,
): IkiMesh {
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (const [x, y] of points) {
    vertices.push(x, y);
    uvs.push(0.5, 0.5);
  }
  const indices: number[] = [];
  for (let i = 1; i < points.length - 1; i++) indices.push(0, i, i + 1);
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

// --- per-feature binding builders ------------------------------------------
// Model-space y of the closed-eye seam (where the upper lid folds down to). The
// eye parts collapse toward this line as the eye shuts.
const EYE_CREASE_Y = 38;

/**
 * Eyelid FOLD blink (Live2D-style): instead of sliding a lid down, the eye part
 * deforms — as EyeOpen → 0 the part's CENTER maps onto the shared crease line
 * `worldAnchorY` and its height scales by `k` (0 = flat line, ~0.18 = a thin
 * band). Because every eye part collapses to the SAME seam, the lash covers the
 * flattened eyeball. EyeOpen=1 → rest (zero offsets = the authored open shape);
 * =0 → folded. This differs from the old scaleY blink, which shrank the whole
 * eye about its own center IN PLACE (no shared seam, no fold).
 */
function foldWarp(
  parameter: string,
  worldAnchorY: number,
  partCenterY: number,
  mesh: IkiMesh,
  k = 0.02,
): IkiWarp {
  const closed: number[] = [];
  const zeros: number[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    const vy = mesh.vertices[i + 1];
    // closed y = worldAnchorY + vy*k → dy added to the rest vertex (partCenterY + vy)
    closed.push(0, worldAnchorY - partCenterY - (1 - k) * vy);
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

// Face warp grid: 4×4 cells (5×5 control points), spanning the face area.
const faceGrid: IkiWarpGrid = {
  cols: 4,
  rows: 4,
  points: generateGridPoints(4, 4, -260, 260, -310, 310),
};
// Cylinder-bend keyforms for the group warp — curvature lives here only; the
// rigid turn/translate stays on headDeformer (no double-apply).
const faceWarp = bakeHeadTurnGridWarp(faceGrid, StandardParameter.AngleX);

// A face feature: a color mesh part on faceWarp at width/height 1.
function feature(
  id: string,
  color: [number, number, number, number],
  order: number,
  x: number,
  y: number,
  mesh: IkiMesh,
  bindings?: IkiBinding[],
  clip?: IkiPart["clip"],
  warps?: IkiWarp[],
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
    ...(clip ? { clip } : {}),
    ...(warps ? { warps } : {}),
  };
}

// A hair part rides the rigid headDeformer (no cylinder bend needed for hair).
function hair(
  id: string,
  color: [number, number, number, number],
  order: number,
  x: number,
  y: number,
  mesh: IkiMesh,
): IkiPart {
  return {
    id,
    color,
    width: 1,
    height: 1,
    order,
    transform: { x, y },
    deformer: "headDeformer",
    mesh,
  };
}

// Eye meshes are shared between each part and its fold warp: the warp's per-vertex
// offsets must line up with the part's own mesh vertices.
const eyeWhiteMeshL = ellipseMesh(54, 46);
const eyeWhiteMeshR = ellipseMesh(54, 46);
const lashMeshL = ellipseMesh(58, 11);
const lashMeshR = ellipseMesh(58, 11);

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
      warps: [faceWarp],
    },
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

    // eye whites (sclera). They double as the clip mask for iris/pupil/highlight
    // AND fold closed on blink: collapsing the white shuts the clip region, so
    // the eyeball vanishes under the descending lid (Live2D-style).
    feature(
      "eyeWhiteL",
      WHITE,
      4,
      -108,
      52,
      eyeWhiteMeshL,
      undefined,
      undefined,
      [
        foldWarp(
          StandardParameter.EyeOpenLeft,
          EYE_CREASE_Y,
          52,
          eyeWhiteMeshL,
        ),
      ],
    ),
    feature(
      "eyeWhiteR",
      WHITE,
      4,
      108,
      52,
      eyeWhiteMeshR,
      undefined,
      undefined,
      [
        foldWarp(
          StandardParameter.EyeOpenRight,
          EYE_CREASE_Y,
          52,
          eyeWhiteMeshR,
        ),
      ],
    ),

    // iris / pupil / highlight are clipped to the eye-white sclera. They stay
    // STATIC and round — they do NOT fold. As the white folds shut, its clip
    // region closes top-down and CUTS the round iris away (it is hidden, never
    // squashed). They also keep gaze (translate within the open sclera).
    feature("irisL", IRIS, 5, -108, 50, ellipseMesh(40, 44), gaze(), {
      masks: ["eyeWhiteL"],
    }),
    feature("irisR", IRIS, 5, 108, 50, ellipseMesh(40, 44), gaze(), {
      masks: ["eyeWhiteR"],
    }),

    // pupil
    feature("pupilL", PUPIL, 6, -108, 48, ellipseMesh(18, 24), gaze(), {
      masks: ["eyeWhiteL"],
    }),
    feature("pupilR", PUPIL, 6, 108, 48, ellipseMesh(18, 24), gaze(), {
      masks: ["eyeWhiteR"],
    }),

    // eye highlight (sparkle, upper-left of each pupil)
    feature("highlightL", HIGHLIGHT, 7, -120, 68, ellipseMesh(16, 18), gaze(), {
      masks: ["eyeWhiteL"],
    }),
    feature("highlightR", HIGHLIGHT, 7, 96, 68, ellipseMesh(16, 18), gaze(), {
      masks: ["eyeWhiteR"],
    }),

    // upper lash line — rests as the arc over the open eye, then FOLDS down to
    // the crease as the eye closes (the visible closed-eye line). Same fold as
    // the sclera, so they shut together.
    feature("lashL", LASH, 7.6, -108, 84, lashMeshL, undefined, undefined, [
      foldWarp(
        StandardParameter.EyeOpenLeft,
        EYE_CREASE_Y,
        84,
        lashMeshL,
        0.18,
      ),
    ]),
    feature("lashR", LASH, 7.6, 108, 84, lashMeshR, undefined, undefined, [
      foldWarp(
        StandardParameter.EyeOpenRight,
        EYE_CREASE_Y,
        84,
        lashMeshR,
        0.18,
      ),
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

    // side framing locks tapering down the cheeks
    hair(
      "sideLockL",
      HAIR,
      9,
      0,
      0,
      polygonMesh([
        [-250, 206],
        [-202, 212],
        [-188, -70],
        [-232, -30],
      ]),
    ),
    hair(
      "sideLockR",
      HAIR,
      9,
      0,
      0,
      polygonMesh([
        [202, 212],
        [250, 206],
        [232, -30],
        [188, -70],
      ]),
    ),
  ],
};
