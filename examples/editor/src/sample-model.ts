// Local copy of examples/playground/src/sample-model.ts for the editor
// (no shared example package yet). The initial EditorDocument source.
import {
  StandardParameter,
  type IkiBinding,
  type IkiMesh,
  type IkiModel,
  type IkiPart,
  type IkiWarpGrid,
} from "@iki/format";
import { bakeHeadTurnGridWarp } from "./mesh-generator";

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
