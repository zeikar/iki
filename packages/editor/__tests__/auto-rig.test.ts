import { StandardParameter, parseIkiModel } from "@ikijs/format";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_TARGETS,
  ROLE_TABLE,
  TurnTargetError,
  bakeEyelidFoldWarp,
  bakeHairFrontSilhouetteWarp,
  bakeHairSwayWarp,
  bakeHeadTurnGridWarpCentered,
  bakeNodWarp,
  bakeTurnGroupWarp2D,
  bboxToTransform,
  bindingsForRole,
  bisectTurnRadius,
  createPixelGridMesh,
  facePlate,
  faceRowProfile,
  generateGridPoints,
  generateIkiFromLayerSet,
  headNodParallaxUnit,
  headTurnParallaxUnit,
  isTurnGroup,
  meshCellsFor,
  parseLayerRoles,
  plateGuardRowsFor,
  plateLandingOn,
  plateReach,
  plateReachAt,
  resolveTurnTargets,
  solveTurnDepth,
  solveTurnModel,
  strandPreferredCandidates,
  turnColumnMap,
  turnLandmarks,
  turnSolveInputs,
  turnSurface,
  validateLayerInputs,
  type IrisStrand,
  type LayerInput,
  type StrandOverlap,
  type TurnSolveReport,
  type TurnTargets,
} from "../src/auto-rig";
import {
  type ParamValues,
  deformedGrid,
  landVertices,
  landedCentroidX,
  landedCentroidY,
  landedXAt,
  landedYAt,
  preBindVertices,
} from "./helpers/render-oracle";

/** Mirror of auto-rig's private HEAD_CYLINDER_RADIUS_FACTOR: the margin
 *  between a cylinder's radius and the reach it covers. Tests pick the turn
 *  radius the generator picks by scaling a half-width by it. */
const RADIUS_FACTOR = 0.6 / 0.5;

/** Mirror of auto-rig's private HOLD_CLEARANCE: how far past the plate's own
 *  landing the held silhouette edge has to sit. */
const HOLD_CLEARANCE = 1;

/** Mirror of auto-rig's private BODY_TURN_FOLLOW: the torso's share of the
 *  face's turn travel — the one rigid share of it left. */
const BODY_TURN_FOLLOW = 0.3;

/** Mirror of auto-rig's private HAIR_SWAY_TIP_FRACTION: how far a hair part's
 *  tips swing at the end of a sway's range, as a fraction of its crop height. */
const HAIR_SWAY_TIP_FRACTION = 0.09;

/** Mirror of auto-rig's private HAIR_SWAY_CURL: the exponent on a root-pinned
 *  hair warp's distance from the root, the sway's and the turn lead's alike. */
const HAIR_SWAY_CURL = 1.5;

/** Mirror of auto-rig's private HAIR_FRONT_DEPTH: the bangs' turn lead at
 *  the fringe tips, as a fraction of the parallax unit. Pinned here, not
 *  imported — it isn't exported — so the lead's exact value can be checked
 *  against the unit recovered from the rig's own turn radius. */
const HAIR_FRONT_DEPTH = 0.1;

/** Mirror of auto-rig's private MOUTH_TURN_TILT_DEG: how far the mouth family
 *  tilts about its anchor at full turn, degrees, its near end down. */
const MOUTH_TURN_TILT_DEG = 5;

/** The 1000×1000 canvas every layer fixture in this file is painted on. */
const canvas1000 = { width: 1000, height: 1000 };

/** The 4×4 grid the turn and nod bakes are exercised on: its middle row sits
 *  exactly on centerY = 0 and its middle column on centerX = 0, so both pinned
 *  axes are real control points and the slide shows on the axis column neat. */
const axisGrid = {
  cols: 4,
  rows: 4,
  points: generateGridPoints(4, 4, -400, 400, -300, 300),
};

/** The turn radius the rig would pick for `axisGrid`: its own x-reach about
 *  centerX = 0 with the no-fold margin. */
const axisGridRadiusX = 400 * RADIUS_FACTOR;

/** A surface to bake `grid` from: `radiusX` and `travel` the caller's, the
 *  nod radius the grid's own y reach about `centre` with the no-fold margin
 *  (300 · RADIUS_FACTOR on `axisGrid`) — the rule the generator applied to
 *  the shared face grid it used to ship, which is what keeps the primitive
 *  suites' expectations standing. It is the GRID's reach, not the head's: the
 *  generator's nod radius is the head's own `halfH · F` (`headNodRadiusOf`)
 *  and differs from what this derives for a group grid, so a caller baking
 *  such a grid has to pass that radius rather than lean on this. `centre`
 *  defaults to the origin, where `axisGrid`'s two axes sit. */
const surfaceOn = (
  grid: { cols: number; rows: number; points: number[] },
  radiusX: number,
  travel: number,
  centre = { x: 0, y: 0 },
) => {
  let reachY = 0;
  for (let i = 1; i < grid.points.length; i += 2) {
    reachY = Math.max(reachY, Math.abs(grid.points[i] - centre.y));
  }
  return turnSurface({
    faceCenterX: centre.x,
    faceCenterY: centre.y,
    radius: radiusX,
    travel,
    nodRadius: reachY * RADIUS_FACTOR,
    lattice: grid,
  });
};

/** One cell of a 2D bake, by angle VALUES (degrees), not lattice indices. */
const cell = (
  w: {
    valuesX: number[];
    valuesY: number[];
    keyforms2d: { offsets: number[] }[];
  },
  angleX: number,
  angleY: number,
) => {
  const ix = w.valuesX.indexOf(angleX);
  const iy = w.valuesY.indexOf(angleY);
  if (ix < 0) throw new Error(`cell: angleX stop ${angleX} not found`);
  if (iy < 0) throw new Error(`cell: angleY stop ${angleY} not found`);
  return w.keyforms2d[iy * w.valuesX.length + ix];
};

/** A generated rig's turn deformer of one group — the face PLATE's
 *  (`faceWarp`) by default — with the grid and 2D bake it ships. */
const groupWarpOf = (
  model: ReturnType<typeof generateIkiFromLayerSet>,
  id = "faceWarp",
) =>
  model.deformers!.find((d) => d.id === id) as {
    grid: { cols: number; rows: number; points: number[] };
    warp2d: {
      valuesX: number[];
      valuesY: number[];
      keyforms2d: { offsets: number[] }[];
    };
  };
const faceWarpOf = (model: ReturnType<typeof generateIkiFromLayerSet>) =>
  groupWarpOf(model);

/** The plate grid's middle-column dx at one AngleX stop, AngleY = 0: the
 *  head's uniform sideways slide on its own, the bend being zero on the
 *  cylinder's own axis column. */
const centreSlideOf = (
  model: ReturnType<typeof generateIkiFromLayerSet>,
  angleX: number,
): number => {
  const faceWarpDef = faceWarpOf(model);
  const faceCenterX = model.parts.find((p) => p.id === "face")!.transform!.x;
  // The plate grid has an even column count and is symmetric about the face
  // centre, so its middle column IS the axis — assert both before reading
  // the slide off it.
  expect(faceWarpDef.grid.cols % 2).toBe(0);
  const col = faceWarpDef.grid.cols / 2;
  expect(faceWarpDef.grid.points[col * 2]).toBeCloseTo(faceCenterX, 10);
  return cell(faceWarpDef.warp2d, angleX, 0).offsets[col * 2];
};

/** The sideways travel a generated rig ACTUALLY carries at full turn, px: the
 *  slide the plate grid's axis column shows at the −30° stop, negated. Read
 *  off the bake rather than recomputed from the plate's half-width, because
 *  the solve caps that ask to what the held shell can swallow — a mirrored
 *  ratio would reconstruct a turn the rig does not have. Anything measuring a
 *  generated rig through `turnColumnMap` has to be given this. */
const travelOf = (model: ReturnType<typeof generateIkiFromLayerSet>) =>
  -centreSlideOf(model, -30);

/** The virtual lattice the generator solves and bakes a layer set on — what
 *  `turnColumnMap` has to be given to describe a generated rig's turn. */
const latticeOf = (layers: LayerInput[]) => turnSolveInputs(layers)[1];

/** The head's reach about the face centre on the lattice: the larger of its
 *  two half-spans. The generator's fallback turn radius, without a nose to
 *  solve against, is this with the no-fold margin. */
const latticeReachOf = (layers: LayerInput[]) => {
  const lattice = latticeOf(layers);
  const faceCenterX = turnSolveInputs(layers)[2];
  return Math.max(
    faceCenterX - lattice.points[0],
    lattice.points[lattice.cols * 2] - faceCenterX,
  );
};

/** A generated rig and the turn radius it was built on.
 *
 *  Nothing in the shipped model spells that radius out any more (hair_back's
 *  own turn binding carried it until the back hair went static on the turn),
 *  so it is captured from the solve's own report. A layer set that solves no
 *  turn at all — no nose layer — falls back to what generateIkiFromLayerSet
 *  falls back to: the virtual LATTICE's own reach about the face centre with
 *  the no-fold margin. */
const solvedRig = (
  layers: LayerInput[],
  canvas: { width: number; height: number },
  options: Parameters<typeof generateIkiFromLayerSet>[2] = {},
) => {
  let solved: number | undefined;
  const model = generateIkiFromLayerSet(layers, canvas, {
    ...options,
    onTurnSolved: (report) => {
      solved = report.radius;
      options.onTurnSolved?.(report);
    },
  });
  return { model, radius: solved ?? latticeReachOf(layers) * RADIUS_FACTOR };
};

/** The generator's nod radius for a layer set, mirrored: the turn family's
 *  union on y — every part on a turn group plus the bangs, transform ± crop/2
 *  — grown by 12 % of its span, its larger distance from the face centre,
 *  with the no-fold margin. One head-level value, however the groups are cut. */
const headNodRadiusOf = (layers: LayerInput[]) => {
  const faceY = turnSolveInputs(layers)[4];
  const ys = layers
    .filter(
      (l) =>
        isTurnGroup(ROLE_TABLE[l.role].deformer) || l.role === "hair_front",
    )
    .map((l) => ({
      y: bboxToTransform(l.bbox, l.canvasW, l.canvasH, l.role).y,
      h: l.cropH,
    }));
  let minY = Math.min(...ys.map(({ y, h }) => y - h / 2));
  let maxY = Math.max(...ys.map(({ y, h }) => y + h / 2));
  const margin = (maxY - minY) * 0.12;
  minY -= margin;
  maxY += margin;
  return Math.max(faceY - minY, maxY - faceY) * RADIUS_FACTOR;
};

/** The engine's own read of a warp child's vertex at pre-bind `(x, y)` on a
 *  grid whose node at `(nx, ny)` lands at `nodeLanding(nx, ny)` on x —
 *  `bindPointToRestGrid`'s cell (the first whose right edge is past x, the
 *  first whose bottom edge is below y, else the end cell) and
 *  `sampleWarpGrid`'s bilinear blend with the fractions clamped to [0, 1] —
 *  mirrored here so a test can say where a node-wise bake lands a vertex
 *  without the oracle's help. */
const gridBilinearX = (
  grid: { cols: number; rows: number; points: number[] },
  nodeLanding: (nx: number, ny: number) => number,
  x: number,
  y: number,
) => {
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
  const xl = points[col * 2];
  const xr = points[(col + 1) * 2];
  const yt = points[row * stride * 2 + 1];
  const yb = points[(row + 1) * stride * 2 + 1];
  const s = Math.max(0, Math.min(1, (x - xl) / (xr - xl)));
  const t = Math.max(0, Math.min(1, (yt - y) / (yt - yb)));
  const at = (c: number, r: number) =>
    nodeLanding(points[(r * stride + c) * 2], points[(r * stride + c) * 2 + 1]);
  const top = at(col, row) + (at(col + 1, row) - at(col, row)) * s;
  const bot = at(col, row + 1) + (at(col + 1, row + 1) - at(col, row + 1)) * s;
  return top + (bot - top) * t;
};

/**
 * Where the mouth family's anchored rule lands a `mouthWarp` node resting at
 * `(x, y)` at the stop `deg`, rebuilt off the surface's maps (`mapAt(row)`)
 * rather than read off the rig: the pivot P is where the family's shifted
 * map puts the anchor, the node takes the map's own shape about the anchor's
 * REST position and slides with it, X = M_y(x) + P − M_{a.y}(a.x), and
 * (X, y) is rotated about (P, a.y) by MOUTH_TURN_TILT_DEG · deg / 30,
 * counter-clockwise positive in model y-up.
 */
const anchoredLanding = (
  mapAt: (row: number) => { mapX(x: number): number },
  anchor: { x: number; y: number },
  deg: number,
  shift: number,
  x: number,
  y: number,
) => {
  const pivot = mapAt(anchor.y).mapX(anchor.x + shift);
  const slid = mapAt(y).mapX(x) + pivot - mapAt(anchor.y).mapX(anchor.x);
  const phi = ((MOUTH_TURN_TILT_DEG * deg) / 30) * (Math.PI / 180);
  return {
    x: pivot + Math.cos(phi) * (slid - pivot) - Math.sin(phi) * (y - anchor.y),
    y:
      anchor.y +
      Math.sin(phi) * (slid - pivot) +
      Math.cos(phi) * (y - anchor.y),
  };
};

/** hair_front's own rest geometry — transform x/y and crop size, the shape
 *  `turnSolveInputs` hands the solve as its `hairFront` entry — for a test
 *  that places a point against the bangs' own mesh columns. Every direct
 *  `solveTurnModel` call in this file spreads `turnSolveInputs` instead. */
const hairFrontOf = (layers: LayerInput[]) => {
  const layer = layers.find((l) => l.role === "hair_front");
  if (!layer) return undefined;
  const t = bboxToTransform(
    layer.bbox,
    layer.canvasW,
    layer.canvasH,
    "hair_front",
  );
  return { x: t.x, centerY: t.y, cropW: layer.cropW, cropH: layer.cropH };
};

/** `layers` with `rows` as the FACE layer's `rowHalfWidths`. */
const withProfile = (layers: LayerInput[], rows: number[]): LayerInput[] =>
  layers.map((l) => (l.role === "face" ? { ...l, rowHalfWidths: rows } : l));

/** Full turn toward −x: the pose every turn cue is measured in. */
const turned = { [StandardParameter.AngleX]: -30 };

/** Mirror of the `headEdges` shape auto-rig.ts declares inline three times and
 *  exports nowhere — `generateIkiFromLayerSet`'s `options.headEdges` (:3345),
 *  `solveTurnModel`'s parameter (:2395) and `TurnSolveContext.headEdges`
 *  (:1393) — so it has to track `src`: every role's own extent in the eye-row
 *  band, per side, in model x. */
type HeadEdges = {
  left: { role: string; x: number }[];
  right: { role: string; x: number }[];
};

/** Mirror of the `strandEdges` shape `generateIkiFromLayerSet`'s options and
 *  `solveTurnModel` declare inline: each side's iris and the bangs' run it
 *  would slide under, on the iris row, in model coordinates. */
type StrandEdges = { left?: IrisStrand; right?: IrisStrand };

/**
 * The cues a generated rig actually renders at full turn, read off the landed
 * geometry the way `measure_turn_reference` reads a render — and off nothing
 * of the solver's, whose `achieved` these are checked against.
 *
 * Each eye white is read where its mesh lands it: the width between its two
 * edges on its own centre row, at rest and turned, and its centre's slide. A
 * −30° turn foreshortens the −x side, whichever character side that is, so
 * `farEyeRatio` is the −x white's width over the +x one's, turned over rest.
 *
 * The silhouette is each side's outermost landing among the parts that own
 * it — whatever `headEdges` names (the list the solve itself was handed), each
 * read at its own rest x, else hair_front's crop edges, which ARE that edge
 * for every fixture without one: a measured `headHalfWidth` is sized to the
 * bangs' half-width, and an unmeasured `holdBase` falls back to the plate's
 * own reach, which `hairFrontLayers()` draws bangs out past. Read on the eye
 * row against that side's outermost rest x, as the mcp reads a render's opaque
 * span.
 *
 * `eyeShift` is positive toward the far side — the report's own
 * `(−achieved + silhouetteCenterShift) / hh`, `achieved` being the pair's
 * signed slide against the face centre: the mcp reads the eye pair against
 * each pose's OWN silhouette centre, not the face centre.
 */
const cuesOf = (
  model: ReturnType<typeof generateIkiFromLayerSet>,
  layers: LayerInput[],
  hh: number,
  headEdges?: HeadEdges,
) => {
  const white = (role: string) => {
    const { x, y } = model.parts.find((p) => p.id === role)!.transform;
    const w = layers.find((l) => l.role === role)!.cropW;
    const widthAt = (params?: ParamValues) =>
      landedXAt(model, role, x + w / 2, y, params) -
      landedXAt(model, role, x - w / 2, y, params);
    return {
      x,
      y,
      rest: widthAt(),
      turned: widthAt(turned),
      centreShift: landedXAt(model, role, x, y, turned) - x,
    };
  };
  const [far, near] = ["eye_L", "eye_R"].map(white).sort((a, b) => a.x - b.x);
  const eyeRowY = (far.y + near.y) / 2;

  const edges =
    headEdges ??
    (() => {
      const x = model.parts.find((p) => p.id === "hair_front")!.transform.x;
      const halfW = layers.find((l) => l.role === "hair_front")!.cropW / 2;
      return {
        left: [{ role: "hair_front", x: x - halfW }],
        right: [{ role: "hair_front", x: x + halfW }],
      };
    })();
  const side = (
    candidates: { role: string; x: number }[],
    outermost: (...xs: number[]) => number,
  ) => ({
    landed: outermost(
      ...candidates.map((c) => landedXAt(model, c.role, c.x, eyeRowY, turned)),
    ),
    rest: outermost(...candidates.map((c) => c.x)),
  });
  const left = side(edges.left, Math.min);
  const right = side(edges.right, Math.max);
  const silhouetteCenterShift =
    (left.landed + right.landed) / 2 - (left.rest + right.rest) / 2;
  const pairShift = (far.centreShift + near.centreShift) / 2;
  return {
    eyeShift: (silhouetteCenterShift - pairShift) / hh,
    farEyeRatio: far.turned / near.turned / (far.rest / near.rest),
    silhouetteRatio: (right.landed - left.landed) / (right.rest - left.rest),
    silhouetteCenterShift,
  };
};

// ── Minimal valid filenames (all required roles present) ─────────────────────

/** A minimal set of filenames that satisfies all required-role constraints. */
function minimalFileNames(): string[] {
  return ["face.png", "eye_L.png", "eye_R.png", "mouth.png"];
}

// ── describe("roles") ────────────────────────────────────────────────────────

describe("roles", () => {
  it("all-required-present passes without throwing", () => {
    expect(() => parseLayerRoles(minimalFileNames())).not.toThrow();
  });

  it("returns correct role/fileName pairs", () => {
    const result = parseLayerRoles(minimalFileNames());
    expect(result).toEqual([
      { role: "face", fileName: "face.png" },
      { role: "eye_L", fileName: "eye_L.png" },
      { role: "eye_R", fileName: "eye_R.png" },
      { role: "mouth", fileName: "mouth.png" },
    ]);
  });

  it("unknown role throws with the offending file name in the message", () => {
    const files = [...minimalFileNames(), "dragon.png"];
    expect(() => parseLayerRoles(files)).toThrow(
      /unknown role "dragon" from file "dragon\.png"/,
    );
  });

  it("missing face throws", () => {
    const files = ["eye_L.png", "eye_R.png", "mouth.png"];
    expect(() => parseLayerRoles(files)).toThrow(
      /missing required role "face"/,
    );
  });

  it("missing mouth throws", () => {
    const files = ["face.png", "eye_L.png", "eye_R.png"];
    expect(() => parseLayerRoles(files)).toThrow(
      /missing required role "mouth"/,
    );
  });

  it("missing eye_L throws", () => {
    const files = ["face.png", "eye_R.png", "mouth.png"];
    expect(() => parseLayerRoles(files)).toThrow(
      /missing required role "eye_L"/,
    );
  });

  it("missing eye_R throws", () => {
    const files = ["face.png", "eye_L.png", "mouth.png"];
    expect(() => parseLayerRoles(files)).toThrow(
      /missing required role "eye_R"/,
    );
  });

  it("both eyes missing throws", () => {
    const files = ["face.png", "mouth.png"];
    expect(() => parseLayerRoles(files)).toThrow(
      /missing required role "eye_L"/,
    );
  });

  it("duplicate role throws", () => {
    const files = [
      "face.png",
      "face.png",
      "eye_L.png",
      "eye_R.png",
      "mouth.png",
    ];
    expect(() => parseLayerRoles(files)).toThrow(/duplicate role "face"/);
  });

  it("normalizes Eye-L.png → eye_L", () => {
    const files = ["face.png", "Eye-L.png", "eye_R.png", "mouth.png"];
    const result = parseLayerRoles(files);
    const eyeL = result.find((p) => p.fileName === "Eye-L.png");
    expect(eyeL?.role).toBe("eye_L");
  });

  it("normalizes Brow_R.png → brow_R", () => {
    const files = [...minimalFileNames(), "Brow_R.png"];
    const result = parseLayerRoles(files);
    const brow = result.find((p) => p.fileName === "Brow_R.png");
    expect(brow?.role).toBe("brow_R");
  });

  it("optional role hair_front is accepted alongside all required roles", () => {
    const files = [...minimalFileNames(), "hair_front.png"];
    const result = parseLayerRoles(files);
    expect(result.some((p) => p.role === "hair_front")).toBe(true);
  });

  it("optional role iris_L is accepted alongside all required roles", () => {
    const files = [...minimalFileNames(), "iris_L.png"];
    const result = parseLayerRoles(files);
    expect(result.some((p) => p.role === "iris_L")).toBe(true);
  });
});

// ── describe("alias map") ────────────────────────────────────────────────────

describe("alias map", () => {
  // Each entry: [aliased filename, expected canonical role]
  const cases: [string, string][] = [
    ["eyebrow_L.png", "brow_L"],
    ["eyebrow_R.png", "brow_R"],
    ["eye_white_L.png", "eye_L"],
    ["eye_white_R.png", "eye_R"],
  ];

  for (const [fileName, expectedRole] of cases) {
    it(`"${fileName}" normalizes to "${expectedRole}"`, () => {
      // Build a valid required set, replacing the canonical role the alias maps
      // to with the aliased filename so the required-roles check still passes.
      const base = ["face.png", "eye_L.png", "eye_R.png", "mouth.png"];
      // Remove the file that would collide (same canonical role as the alias).
      const withoutCanonical = base.filter((f) => f !== `${expectedRole}.png`);
      const files = [...withoutCanonical, fileName];
      const result = parseLayerRoles(files);
      const entry = result.find((p) => p.fileName === fileName);
      expect(entry?.role).toBe(expectedRole);
    });
  }
});

// ── describe("ROLE_TABLE invariants") ────────────────────────────────────────

describe("ROLE_TABLE invariants", () => {
  const EYE_FAMILY_PREFIXES = ["eye_", "iris_", "pupil_", "highlight_"];

  it("every eye-family _L role has eyeSide === 'L'", () => {
    for (const [role, spec] of Object.entries(ROLE_TABLE)) {
      if (
        EYE_FAMILY_PREFIXES.some((p) => role.startsWith(p)) &&
        role.endsWith("_L")
      ) {
        expect(spec.eyeSide, `${role}.eyeSide`).toBe("L");
      }
    }
  });

  it("every eye-family _R role has eyeSide === 'R'", () => {
    for (const [role, spec] of Object.entries(ROLE_TABLE)) {
      if (
        EYE_FAMILY_PREFIXES.some((p) => role.startsWith(p)) &&
        role.endsWith("_R")
      ) {
        expect(spec.eyeSide, `${role}.eyeSide`).toBe("R");
      }
    }
  });

  it("non-eye-family roles have eyeSide undefined", () => {
    const NON_EYE = [
      "brow_L",
      "brow_R",
      "blush_L",
      "blush_R",
      "face",
      "mouth",
      "nose",
      "hair_front",
      "hair_back",
      "body",
    ];
    for (const role of NON_EYE) {
      expect(ROLE_TABLE[role].eyeSide, `${role}.eyeSide`).toBeUndefined();
    }
  });
});

// ── describe("transform") ────────────────────────────────────────────────────

describe("transform", () => {
  it("bbox centered on a 1000×1000 canvas yields {x:0, y:0}", () => {
    // bbox: x=375, y=375, w=250, h=250  → center=(500,500) = canvas center
    const result = bboxToTransform(
      { x: 375, y: 375, w: 250, h: 250 },
      1000,
      1000,
    );
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("top-left quadrant bbox produces correct signed values with +y flip", () => {
    // bbox at top-left: x=0, y=0, w=200, h=200 on 1000×1000 canvas
    // center = (100, 100) in image coords
    // x = 100 - 500 = -400
    // y = 500 - 100 = 400  (flipped: image top → model positive y)
    const result = bboxToTransform({ x: 0, y: 0, w: 200, h: 200 }, 1000, 1000);
    expect(result).toEqual({ x: -400, y: 400 });
  });

  it("fractional center is preserved (no rounding)", () => {
    // bbox: x=0, y=0, w=1, h=1 on 1000×1000 canvas
    // center = (0.5, 0.5)
    // x = 0.5 - 500 = -499.5
    // y = 500 - 0.5 = 499.5
    const result = bboxToTransform({ x: 0, y: 0, w: 1, h: 1 }, 1000, 1000);
    expect(result.x).toBe(-499.5);
    expect(result.y).toBe(499.5);
  });

  it("y === 12.5 for a bbox whose center falls at canvasH/2 - 12.5", () => {
    // canvasH=1000, want y=12.5 → bboxCenterY = 500 - 12.5 = 487.5
    // bbox: y=462.5 (odd but valid), h=50 → center=487.5
    // x: canvasW=1000, bbox centered horizontally → x=0
    const result = bboxToTransform(
      { x: 475, y: 462.5, w: 50, h: 50 },
      1000,
      1000,
    );
    expect(result.x).toBe(0);
    expect(result.y).toBe(12.5);
  });

  it("zero-width bbox throws with the provided label", () => {
    expect(() =>
      bboxToTransform({ x: 0, y: 0, w: 0, h: 100 }, 1000, 1000, "eye_L"),
    ).toThrow(/auto-rig: empty bbox for eye_L/);
  });

  it("zero-height bbox throws with the provided label", () => {
    expect(() =>
      bboxToTransform({ x: 0, y: 0, w: 100, h: 0 }, 1000, 1000, "mouth"),
    ).toThrow(/auto-rig: empty bbox for mouth/);
  });

  it("zero-size bbox without label throws with 'layer' in message", () => {
    expect(() =>
      bboxToTransform({ x: 0, y: 0, w: 0, h: 0 }, 1000, 1000),
    ).toThrow(/auto-rig: empty bbox for layer/);
  });
});

// ── describe("validate") ─────────────────────────────────────────────────────

/** Build a minimal valid LayerInput[] (face + eye_L + eye_R + mouth). */
function minimalLayers(canvasW = 1000, canvasH = 1000): LayerInput[] {
  return [
    {
      role: "face",
      fileName: "face.png",
      canvasW,
      canvasH,
      bbox: { x: 200, y: 200, w: 600, h: 600 },
      cropW: 600,
      cropH: 600,
    },
    {
      role: "eye_L",
      fileName: "eye_L.png",
      canvasW,
      canvasH,
      bbox: { x: 300, y: 300, w: 150, h: 100 },
      cropW: 150,
      cropH: 100,
    },
    {
      role: "eye_R",
      fileName: "eye_R.png",
      canvasW,
      canvasH,
      bbox: { x: 550, y: 300, w: 150, h: 100 },
      cropW: 150,
      cropH: 100,
    },
    {
      role: "mouth",
      fileName: "mouth.png",
      canvasW,
      canvasH,
      bbox: { x: 400, y: 600, w: 200, h: 80 },
      cropW: 200,
      cropH: 80,
    },
  ];
}

describe("validate", () => {
  it("valid layers pass without throwing", () => {
    expect(() =>
      validateLayerInputs(minimalLayers(), { width: 1000, height: 1000 }),
    ).not.toThrow();
  });

  it("empty layers array throws", () => {
    expect(() =>
      validateLayerInputs([], { width: 1000, height: 1000 }),
    ).toThrow(/empty/);
  });

  it("unknown role throws with the offending role in the message", () => {
    const layers = [
      ...minimalLayers(),
      {
        role: "dragon",
        fileName: "dragon.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 0, y: 0, w: 100, h: 100 },
        cropW: 100,
        cropH: 100,
      },
    ];
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/unknown role "dragon"/);
  });

  it("duplicate role throws with the role named", () => {
    const layers = [
      ...minimalLayers(),
      {
        role: "face",
        fileName: "face2.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 200, y: 200, w: 400, h: 400 },
        cropW: 400,
        cropH: 400,
      },
    ];
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/duplicate role "face"/);
  });

  it("missing face throws", () => {
    const layers = minimalLayers().filter((l) => l.role !== "face");
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/missing required role "face"/);
  });

  it("missing eye_L throws", () => {
    const layers = minimalLayers().filter((l) => l.role !== "eye_L");
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/missing required role "eye_L"/);
  });

  it("missing eye_R throws", () => {
    const layers = minimalLayers().filter((l) => l.role !== "eye_R");
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/missing required role "eye_R"/);
  });

  it("missing mouth throws", () => {
    const layers = minimalLayers().filter((l) => l.role !== "mouth");
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/missing required role "mouth"/);
  });

  it("non-positive bbox.w throws with role named", () => {
    const layers = minimalLayers();
    layers[0] = { ...layers[0], bbox: { ...layers[0].bbox, w: 0 } };
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/role "face".*bbox\.w/);
  });

  it("non-positive bbox.h throws with role named", () => {
    const layers = minimalLayers();
    layers[0] = { ...layers[0], bbox: { ...layers[0].bbox, h: -1 } };
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/role "face".*bbox\.h/);
  });

  it("non-positive cropW throws with role named", () => {
    const layers = minimalLayers();
    layers[1] = { ...layers[1], cropW: 0 };
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/role "eye_L".*cropW/);
  });

  it("non-positive cropH throws with role named", () => {
    const layers = minimalLayers();
    layers[1] = { ...layers[1], cropH: 0 };
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/role "eye_L".*cropH/);
  });

  it("layer canvas size mismatch vs canvas arg throws with role named", () => {
    const layers = minimalLayers();
    layers[2] = { ...layers[2], canvasW: 800, canvasH: 800 };
    expect(() =>
      validateLayerInputs(layers, { width: 1000, height: 1000 }),
    ).toThrow(/role "eye_R".*canvas size/);
  });

  it("layer canvas size mismatch vs peers throws with role named", () => {
    // All layers have canvasW/H = 800, but canvas arg is also 800, so
    // only the second layer differs from both arg and first peer.
    const layers = minimalLayers(800, 800);
    layers[1] = { ...layers[1], canvasW: 1000, canvasH: 1000 };
    expect(() =>
      validateLayerInputs(layers, { width: 800, height: 800 }),
    ).toThrow(/canvas size/);
  });

  /** minimalLayers()' face is 600 rows tall and 600 wide, so a valid profile
   *  is 600 entries in [0, 300]. */
  const validRows = () => Array.from({ length: 600 }, (_, i) => (i % 7) * 40);
  const canvas = { width: 1000, height: 1000 };

  it("a well-formed rowHalfWidths passes", () => {
    expect(() =>
      validateLayerInputs(withProfile(minimalLayers(), validRows()), canvas),
    ).not.toThrow();
  });

  it("rowHalfWidths that is not an array throws naming the role, before its length is read", () => {
    expect(() =>
      validateLayerInputs(
        withProfile(minimalLayers(), 300 as unknown as number[]),
        canvas,
      ),
    ).toThrow(/role "face" rowHalfWidths must be an array/);
  });

  it("rowHalfWidths of the wrong length throws naming the role and the crop height", () => {
    expect(() =>
      validateLayerInputs(
        withProfile(minimalLayers(), [100, 200, 300]),
        canvas,
      ),
    ).toThrow(/role "face" rowHalfWidths has 3 entries.*cropH 600/);
  });

  it("a negative rowHalfWidths entry throws naming the role and the row", () => {
    const rows = validRows();
    rows[17] = -1;
    expect(() =>
      validateLayerInputs(withProfile(minimalLayers(), rows), canvas),
    ).toThrow(/role "face" rowHalfWidths\[17\] is -1/);
  });

  it("a rowHalfWidths entry past half the crop's width throws naming the role and the bound", () => {
    const rows = validRows();
    rows[599] = 300.5;
    expect(() =>
      validateLayerInputs(withProfile(minimalLayers(), rows), canvas),
    ).toThrow(/role "face" rowHalfWidths\[599\] is 300.5.*\[0, 300\]/);
  });

  it("a NaN rowHalfWidths entry throws naming the role and the row", () => {
    const rows = validRows();
    rows[0] = Number.NaN;
    expect(() =>
      validateLayerInputs(withProfile(minimalLayers(), rows), canvas),
    ).toThrow(/role "face" rowHalfWidths\[0\] is NaN/);
  });

  // ── strandEdges ───────────────────────────────────────────────────────────
  // heroLikeLayers()' −x iris (iris_R) spans model x −149…−75 about −112 and
  // rows 38…112 of model y, the other iris is centred on +112, and hair_front
  // spans −331…331 and model y −486…505.

  /** `generateIkiFromLayerSet` on `layers` with `HERO_STRAND.left` changed by
   *  `change`, as the only side. */
  const rigWithLeft =
    (change: Partial<IrisStrand>, layers: LayerInput[] = heroLikeLayers()) =>
    () =>
      generateIkiFromLayerSet(layers, canvas1100, {
        strandEdges: { left: { ...HERO_STRAND.left, ...change } },
      });

  it("strandEdges: a non-finite runFace throws naming the side and the field", () => {
    expect(rigWithLeft({ runFace: Number.NaN })).toThrow(
      /^auto-rig: validateStrandEdges: strandEdges\.left\.runFace is NaN, not a finite number or null$/,
    );
  });

  it("strandEdges: a runFace past the other iris's centre throws naming the side and the field", () => {
    expect(rigWithLeft({ runFace: 120 })).toThrow(
      /strandEdges\.left\.runFace \(120\) must lie strictly on this side of the "iris_L" crop's centre \(112\)/,
    );
  });

  it("strandEdges: a runFace outside hair_front's crop throws naming the side and the field", () => {
    expect(rigWithLeft({ runFace: -400 })).toThrow(
      /strandEdges\.left\.runFace \(-400\) lies outside the "hair_front" crop's columns/,
    );
  });

  it("strandEdges: a runOuter inward of its runFace throws naming the side and the field", () => {
    expect(rigWithLeft({ runOuter: -150 })).toThrow(
      /strandEdges\.left\.runOuter \(-150\) must lie strictly outward of strandEdges\.left\.runFace \(-160\)/,
    );
  });

  it("strandEdges: a spanning run whose runOuter is inward of its own iris's centre throws naming the side and the field", () => {
    expect(rigWithLeft({ runOuter: -100, runFace: null })).toThrow(
      /strandEdges\.left\.runOuter \(-100\) must lie strictly outward of the "iris_R" crop's centre \(-112\)/,
    );
  });

  it("strandEdges: iris edges off their own iris throw naming the side and the field", () => {
    expect(rigWithLeft({ irisOuter: -60 })).toThrow(
      /strandEdges\.left\.irisOuter \(-60\) lies outside the "iris_R" crop's columns/,
    );
    expect(rigWithLeft({ irisInner: -150 })).toThrow(
      /strandEdges\.left\.irisInner \(-150\) lies outside the "iris_R" crop's columns/,
    );
  });

  it("strandEdges: iris edges inside their iris but in the wrong order throw naming the side and the field", () => {
    expect(rigWithLeft({ irisOuter: -140, irisInner: -145 })).toThrow(
      /strandEdges\.left\.irisOuter \(-140\) must lie strictly outward of strandEdges\.left\.irisInner \(-145\)/,
    );
  });

  it("strandEdges: a row outside the iris's or hair_front's crop throws naming the side and the field", () => {
    expect(rigWithLeft({ y: 200 })).toThrow(
      /strandEdges\.left\.y \(200\) lies outside the "iris_R" crop's rows/,
    );
    // Bangs that end 30 px above the iris row: canvas rows 45…444, model y
    // 105…505.
    const shortBangs = heroLikeLayers().map((l) =>
      l.role === "hair_front"
        ? { ...l, bbox: { ...l.bbox, h: 400 }, cropH: 400 }
        : l,
    );
    expect(rigWithLeft({}, shortBangs)).toThrow(
      /strandEdges\.left\.y \(74\.5\) lies outside the "hair_front" crop's rows/,
    );
  });

  it("strandEdges: a side on a layer set without hair_front or without iris_L throws naming the missing role", () => {
    for (const missing of ["hair_front", "iris_L"]) {
      expect(
        rigWithLeft(
          {},
          heroLikeLayers().filter((l) => l.role !== missing),
        ),
        missing,
      ).toThrow(
        new RegExp(
          `strandEdges\\.left needs a "${missing}" layer to be measured on`,
        ),
      );
    }
  });

  it("strandEdges: a spanning run (runFace null) passes, and {} needs no irises or bangs at all", () => {
    expect(rigWithLeft({ runFace: null })).not.toThrow();
    expect(() =>
      generateIkiFromLayerSet(minimalLayers(), canvas, { strandEdges: {} }),
    ).not.toThrow();
  });

  it("strandEdges: an iris span that does not straddle its crop's centre passes, and is checked on a layer set with no nose too", () => {
    // −100…−80 sits inside the iris's crop but wholly face-ward of its centre
    // (−112), as a row's opaque span may: the crop columns and the outer/inner
    // order are what tie the edges to their iris. Without a nose the option
    // is still validated, though no turn reads it.
    const noseless = heroLikeLayers().filter((l) => l.role !== "nose");
    expect(
      rigWithLeft({ irisOuter: -100, irisInner: -80 }, noseless),
    ).not.toThrow();
    expect(rigWithLeft({ runFace: 120 }, noseless)).toThrow(
      /strandEdges\.left\.runFace \(120\)/,
    );
  });
});

// ── describe("assembly") ─────────────────────────────────────────────────────

/** One fixture layer: `role.png`, its bbox on `canvas`, cropped to that bbox. */
function layer(
  canvas: { width: number; height: number },
  role: string,
  x: number,
  y: number,
  w: number,
  h: number,
): LayerInput {
  return {
    role,
    fileName: `${role}.png`,
    canvasW: canvas.width,
    canvasH: canvas.height,
    bbox: { x, y, w, h },
    cropW: w,
    cropH: h,
  };
}

/** Fixture layers for assembly tests: face + eye_L + eye_R + mouth + hair_back */
function assemblyLayers(): LayerInput[] {
  return [
    {
      role: "face",
      fileName: "face.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 200, y: 200, w: 600, h: 600 },
      cropW: 600,
      cropH: 600,
    },
    {
      role: "eye_L",
      fileName: "eye_L.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 300, y: 300, w: 150, h: 100 },
      cropW: 150,
      cropH: 100,
    },
    {
      role: "eye_R",
      fileName: "eye_R.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 550, y: 300, w: 150, h: 100 },
      cropW: 150,
      cropH: 100,
    },
    {
      role: "mouth",
      fileName: "mouth.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 400, y: 600, w: 200, h: 80 },
      cropW: 200,
      cropH: 80,
    },
    {
      role: "hair_back",
      fileName: "hair_back.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 100, y: 50, w: 800, h: 700 },
      cropW: 800,
      cropH: 700,
    },
  ];
}

/**
 * assemblyLayers() + a body layer that deliberately spans nearly the whole
 * canvas — the shape most likely to contaminate the plate grid.
 */
function bodyLayers(): LayerInput[] {
  return [
    ...assemblyLayers(),
    {
      role: "body",
      fileName: "body.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 20, y: 600, w: 960, h: 390 },
      cropW: 960,
      cropH: 390,
    },
  ];
}

/** assemblyLayers() + a hair_front layer (the base fixture has hair_back only). */
function hairFrontLayers(): LayerInput[] {
  return [
    ...assemblyLayers(),
    {
      role: "hair_front",
      fileName: "hair_front.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 150, y: 60, w: 700, h: 400 },
      cropW: 700,
      cropH: 400,
    },
  ];
}

/** A nose between assemblyLayers()' eyes and above its mouth — the layer that
 *  gates the feature depth parallax. */
function noseLayer(): LayerInput {
  return {
    role: "nose",
    fileName: "nose.png",
    canvasW: 1000,
    canvasH: 1000,
    bbox: { x: 480, y: 420, w: 40, h: 60 },
    cropW: 40,
    cropH: 60,
  };
}

/** hairFrontLayers() + noseLayer() + the rest of what a face carries: irises
 *  inside the whites (narrower), lashes over the whites' top halves, brows
 *  above them and an open mouth on the closed one's bbox. Symmetric about the
 *  canvas centre like the layers it extends, so a part's −30° landing is the
 *  other side's +30° landing mirrored. */
function fullFaceLayers(): LayerInput[] {
  return [
    ...hairFrontLayers(),
    noseLayer(),
    layer(canvas1000, "iris_L", 340, 310, 70, 80),
    layer(canvas1000, "iris_R", 590, 310, 70, 80),
    layer(canvas1000, "lash_L", 300, 300, 150, 50),
    layer(canvas1000, "lash_R", 550, 300, 150, 50),
    layer(canvas1000, "brow_L", 300, 270, 150, 25),
    layer(canvas1000, "brow_R", 550, 270, 150, 25),
    layer(canvas1000, "mouth_open", 400, 600, 200, 80),
  ];
}

// ── describe("head nod (AngleY)") ────────────────────────────────────────────

describe("head nod (AngleY)", () => {
  // Every bake in this block passes travel 0: they exercise the primitive on a
  // grid built by hand, with no rig behind it to size a head's slide, so what
  // is under test is the pure bend. The slide has its own describe below.

  it("bakes a 5×5 lattice at 15° stops in the format's row-major layout", () => {
    const w = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, 0),
      () => 0,
    );
    expect(w.valuesX).toEqual([-30, -15, 0, 15, 30]);
    expect(w.valuesY).toEqual([-30, -15, 0, 15, 30]);
    expect(w.keyforms2d).toHaveLength(25);
    for (const k of w.keyforms2d) {
      expect(k.offsets).toHaveLength(axisGrid.points.length);
    }
  });

  it("the AngleY=0 row IS the 1D turn bake once the slide is out of it", () => {
    // The 1D bake is the pure-bend reference, so the row matches it at travel
    // 0 and only there — what a shipped row adds on top is the uniform slide,
    // checked column by column in describe("head turn slide").
    const w = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, 0),
      () => 0,
    );
    const turn = bakeHeadTurnGridWarpCentered(
      axisGrid,
      "ax",
      0,
      axisGridRadiusX,
    );
    for (const angle of w.valuesX) {
      const k1d = turn.keyforms.find((k) => k.value === angle)!;
      const k2d = cell(w, angle, 0);
      for (let n = 0; n < k1d.offsets.length; n++) {
        expect(k2d.offsets[n]).toBeCloseTo(k1d.offsets[n], 9);
      }
    }
  });

  it("mid stops are the analytic bend, not the chord between ±30 and 0", () => {
    const w = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, 0),
      () => 0,
    );
    const R = axisGridRadiusX;
    const theta15 = 15 * (Math.PI / 180);
    const mid = cell(w, 15, 0);
    for (let i = 0; i < axisGrid.points.length / 2; i++) {
      const x = axisGrid.points[i * 2];
      const alpha = Math.asin(Math.max(-1, Math.min(1, x / R)));
      const expectedDx =
        R * Math.sin(alpha + theta15) - x - R * Math.sin(theta15);
      expect(mid.offsets[i * 2]).toBeCloseTo(expectedDx, 8);
    }
    // Guard against a lattice built by linear interpolation between ±30 and 0:
    // the analytic bend at the outer column differs from the chord's midpoint.
    const full = cell(w, 30, 0);
    let maxDiff = 0;
    for (let i = 0; i < axisGrid.points.length / 2; i++) {
      maxDiff = Math.max(
        maxDiff,
        Math.abs(mid.offsets[i * 2] - 0.5 * full.offsets[i * 2]),
      );
    }
    expect(maxDiff).toBeGreaterThan(1);
  });

  it("does not fold on a grid that is not symmetric about the axis", () => {
    // A radius taken from the grid's REACH about the centre, not from its
    // half-width, keeps |local|/radius ≤ 1/1.2 on the far-out side too.
    const lopsided = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -100, 500, -50, 350),
    };
    const lopsidedRadius = 500 * RADIUS_FACTOR;
    const w2 = bakeTurnGroupWarp2D(
      lopsided,
      "ax",
      "ay",
      surfaceOn(lopsided, lopsidedRadius, 0),
      () => 0,
    );
    const stride = 5;
    for (const k of w2.keyforms2d) {
      for (let row = 0; row <= 4; row++) {
        let prev = -Infinity;
        for (let col = 0; col <= 4; col++) {
          const p = row * stride + col;
          const x = lopsided.points[p * 2] + k.offsets[p * 2];
          expect(x).toBeGreaterThan(prev);
          prev = x;
        }
      }
    }
    const w1 = bakeHeadTurnGridWarpCentered(lopsided, "ax", 0, lopsidedRadius);
    for (const k of w1.keyforms) {
      let prev = -Infinity;
      for (let col = 0; col <= 4; col++) {
        const p = 2 * stride + col;
        const x = lopsided.points[p * 2] + k.offsets[p * 2];
        expect(x).toBeGreaterThan(prev);
        prev = x;
      }
    }
  });

  it("does not fold on a grid wider than the radius can carry", () => {
    // A caller's radius need not cover the grid: a tighter cylinder than the
    // grid is wide leaves whole columns past the cylinder's edge, where the
    // raw bend piles them onto one x — the silhouette. Bounded, they ride
    // along behind it instead.
    const wide = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -1000, 1000, -1000, 1000),
    };
    const tight = 300; // bound = 250, so only the centre column is on surface
    const stride = 5;
    const ordered = (offsets: number[]) => {
      for (let row = 0; row <= 4; row++) {
        let prev = -Infinity;
        for (let col = 0; col <= 4; col++) {
          const p = row * stride + col;
          const x = wide.points[p * 2] + offsets[p * 2];
          expect(x).toBeGreaterThan(prev);
          prev = x;
        }
        // Slope 1 outside the bound: columns ±500 and ±1000 are both past it,
        // so the pair keeps its rest spacing — rigid, not merely ordered.
        const at = (col: number) =>
          wide.points[(row * stride + col) * 2] +
          offsets[(row * stride + col) * 2];
        expect(at(4) - at(3)).toBeCloseTo(500, 9);
        expect(at(1) - at(0)).toBeCloseTo(500, 9);
      }
    };
    for (const k of bakeTurnGroupWarp2D(
      wide,
      "ax",
      "ay",
      surfaceOn(wide, tight, 0),
      () => 0,
    ).keyforms2d) {
      ordered(k.offsets);
    }
    for (const k of bakeHeadTurnGridWarpCentered(wide, "ax", 0, tight)
      .keyforms) {
      ordered(k.offsets);
    }
  });

  it("pins the axis row: points on centerY never move vertically", () => {
    const w = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, 0),
      () => 0,
    );
    for (const k of w.keyforms2d) {
      for (let p = 0; p < axisGrid.points.length / 2; p++) {
        if (axisGrid.points[p * 2 + 1] === 0) {
          expect(k.offsets[p * 2 + 1]).toBeCloseTo(0, 10);
        }
      }
    }
  });

  it("a full nod foreshortens without folding, the far side most", () => {
    const w = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, 0),
      () => 0,
    );
    const up = cell(w, 0, 30); // AngleX=0, AngleY=+30
    const stride = axisGrid.cols + 1;
    for (let col = 0; col <= axisGrid.cols; col++) {
      const column = [];
      for (let row = 0; row <= axisGrid.rows; row++) {
        const p = row * stride + col;
        const restY = axisGrid.points[p * 2 + 1];
        column.push({ restY, y: restY + up.offsets[p * 2 + 1] });
      }
      column.sort((a, b) => a.restY - b.restY);
      // Order preserved along the column: no cell folds.
      for (let k = 1; k < column.length; k++) {
        expect(column[k].y).toBeGreaterThan(column[k - 1].y);
      }
      const bottom = column[0];
      const top = column[column.length - 1];
      // The whole column foreshortens...
      expect(top.y - bottom.y).toBeLessThan(top.restY - bottom.restY);
      // ...and looking up, the top edge (turning away) travels further than
      // the bottom edge (turning toward the viewer).
      expect(Math.abs(top.y - top.restY)).toBeGreaterThan(
        Math.abs(bottom.y - bottom.restY),
      );
    }
  });

  it("the generated model declares AngleY and drives faceWarp with a 2D warp", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas1000);
    expect(
      model.parameters.find((p) => p.id === StandardParameter.AngleY),
    ).toMatchObject({ min: -30, max: 30, default: 0 });
    const faceWarp = model.deformers!.find((d) => d.id === "faceWarp") as {
      warps?: unknown;
      warp2d?: { parameter: string; parameterY: string };
    };
    expect(faceWarp.warps).toBeUndefined();
    expect(faceWarp.warp2d).toMatchObject({
      parameter: StandardParameter.AngleX,
      parameterY: StandardParameter.AngleY,
    });
    // Still a valid model end to end.
    expect(() => parseIkiModel(structuredClone(model))).not.toThrow();
  });

  it("the head nods with a symmetric vertical translate and no second rotate", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas1000);
    const head = model.deformers!.find((d) => d.id === "headDeformer") as {
      bindings: {
        parameter: string;
        channel: string;
        from: number;
        to: number;
      }[];
    };
    const nod = head.bindings.filter(
      (b) => b.parameter === StandardParameter.AngleY,
    );
    expect(nod).toHaveLength(1);
    expect(nod[0].channel).toBe("translateY");
    expect(nod[0].to).toBeGreaterThan(0);
    expect(nod[0].from).toBeCloseTo(-nod[0].to, 10);
  });

  it("on the nod the bangs slide with the brows and the back hair follows the crown down", () => {
    const layers: LayerInput[] = [
      ...hairFrontLayers(),
      noseLayer(),
      {
        role: "brow_L",
        fileName: "brow_L.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 300, y: 260, w: 150, h: 30 },
        cropW: 150,
        cropH: 30,
      },
    ];
    const model = generateIkiFromLayerSet(layers, canvas1000);
    const nodOf = (id: string) =>
      (model.parts.find((p) => p.id === id)!.bindings ?? []).find(
        (b) =>
          b.parameter === StandardParameter.AngleY &&
          b.channel === "translateY",
      ) as { from: number; to: number } | undefined;
    // The bangs hang from the hairline, on the same surface as the brows: they
    // slide with them, WITH the head, or the fringe closes onto the brows
    // looking up and leaves a bare forehead looking down. Riding the rigid
    // head, they carry that slide in a per-vertex AngleY warp — no binding —
    // that bends the crown as well: looking up (+AngleY) bends it DOWN, so at
    // the root row the warp lands short of the brows' own slide.
    expect(nodOf("hair_front")).toBeUndefined();
    const front = model.parts.find((p) => p.id === "hair_front")!;
    const nod = front.warps!.find(
      (w) => w.parameter === StandardParameter.AngleY,
    )!;
    const browSlide = nodOf("brow_L")!.to;
    expect(browSlide).toBeGreaterThan(0);
    const up = nod.keyforms.find((k) => k.value === 30)!;
    const topY = Math.max(
      ...front.mesh!.vertices.filter((_, i) => i % 2 === 1),
    );
    for (let v = 0; v < front.mesh!.vertices.length / 2; v++) {
      if (front.mesh!.vertices[v * 2 + 1] !== topY) continue;
      expect(up.offsets[v * 2 + 1]).toBeLessThan(browSlide);
    }
    // The rigid back hair has to follow the bent crown down or it shows above
    // it as a second crown.
    const back = nodOf("hair_back")!;
    expect(back.to).toBeLessThan(0);
    expect(back.from).toBeCloseTo(-back.to, 10);
  });

  it("the nod bends the face gentler than the turn does", () => {
    // Same square grid, same radius on both axes: only NOD_BEND separates the
    // top edge's vertical travel from the right edge's horizontal travel.
    const square = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -400, 400, -400, 400),
    };
    const w = bakeTurnGroupWarp2D(
      square,
      "ax",
      "ay",
      // 400 reach × the margin — the same radius surfaceOn derives for the nod
      surfaceOn(square, axisGridRadiusX, 0),
      () => 0,
    );
    const stride = 5;
    const turn = cell(w, 30, 0); // AngleX=+30, AngleY=0
    const nod = cell(w, 0, 30); // AngleX=0, AngleY=+30
    const rightEdgeDx = Math.abs(turn.offsets[(2 * stride + 4) * 2]); // middle row, last col
    const topEdgeDy = Math.abs(nod.offsets[(0 * stride + 2) * 2 + 1]); // top row, middle col
    expect(topEdgeDy).toBeGreaterThan(0);
    expect(topEdgeDy).toBeLessThan(0.6 * rightEdgeDx);
  });
});

// ── describe("turnColumnMap") ────────────────────────────────────────────────

describe("turnColumnMap", () => {
  // The axis is off the grid's own centre (-100), not just off zero, so a map
  // that bent about the grid's midpoint instead of faceCenterX would fail.
  const faceCenterX = -40;
  const grid = {
    cols: 4,
    rows: 4,
    points: generateGridPoints(4, 4, -398, 198, -48, 448),
  };
  // Reach about the axis is the long side, 358, so the bound still covers
  // every column and nothing under test rides the rigid outside.
  const radiusX = 358 * RADIUS_FACTOR;
  // Travel: the first test sweeps 0 and 60 on purpose; every other test in
  // this block passes 0 — a grid built by hand, with no rig behind it to size
  // a slide, so what they read is the bend's own map.

  it("its warped columns are the bake's own, at every stop and either travel", () => {
    // The bake reads each node's dx as `mapAt(deg).mapX(x) − x` off this very
    // map, so "the map describes the turn the model ships" holds by
    // construction; the independent check that the map IS the cylinder bend
    // is the 1D-bake comparison in describe("head nod (AngleY)"). What this
    // still proves: row 0 of the grid is the map's columns, `mapX` at a node
    // is that node's own `warpedX` (to an ulp of the `− x` round trip), and
    // the literal-zero AngleX 0 stop agrees with `warpedX` at 0 — the bend on
    // its own, and the bend with the head's sideways travel summed into it.
    for (const travel of [0, 60]) {
      const w = bakeTurnGroupWarp2D(
        grid,
        "ax",
        "ay",
        surfaceOn(grid, radiusX, travel, { x: faceCenterX, y: 200 }),
        () => 0,
      );
      for (const angleX of w.valuesX) {
        const k = cell(w, angleX, 0);
        const map = turnColumnMap(grid, faceCenterX, radiusX, angleX, travel);
        for (let col = 0; col <= grid.cols; col++) {
          expect(map.restX[col]).toBe(grid.points[col * 2]);
          // Row 0 of the grid: point index === column index.
          expect(map.warpedX[col]).toBeCloseTo(
            grid.points[col * 2] + k.offsets[col * 2],
            9,
          );
        }
      }
    }
  });

  it("mapX matches how the engine samples the grid, edge clamp included", () => {
    const map = turnColumnMap(grid, faceCenterX, radiusX, 30, 0);
    // On a column: exactly that column's warped x.
    for (let col = 0; col <= grid.cols; col++) {
      expect(map.mapX(map.restX[col])).toBeCloseTo(map.warpedX[col], 9);
    }
    // Between columns: the chord, because the engine lerps within the cell.
    const mid = (map.restX[1] + map.restX[2]) / 2;
    expect(map.mapX(mid)).toBeCloseTo((map.warpedX[1] + map.warpedX[2]) / 2, 9);
    // Outside: bindPointToRestGrid clamps to the edge cell, so the edge
    // column's warped x — NOT an extrapolation of the bend.
    expect(map.mapX(map.restX[0] - 500)).toBe(map.warpedX[0]);
    expect(map.mapX(map.restX[grid.cols] + 500)).toBe(map.warpedX[grid.cols]);
  });

  it("invertX round-trips mapX inside the grid and clamps outside", () => {
    const map = turnColumnMap(grid, faceCenterX, radiusX, -30, 0);
    for (const x of [-398, -350, -249, -100, 0, 123.5, 198]) {
      expect(map.invertX(map.mapX(x))).toBeCloseTo(x, 9);
    }
    const last = grid.cols;
    expect(map.invertX(map.warpedX[0] - 500)).toBe(map.restX[0]);
    expect(map.invertX(map.warpedX[last] + 500)).toBe(map.restX[last]);
  });

  it("refuses an angle past the turn's range, where the columns fold", () => {
    // Beyond ~33.6° the warped columns stop being ordered and invertX's cell
    // scan would answer confidently and wrongly.
    expect(() => turnColumnMap(grid, faceCenterX, radiusX, 45, 0)).toThrow(
      /auto-rig: turnColumnMap/,
    );
  });
});

// ── describe("head turn slide") ──────────────────────────────────────────────

describe("head turn slide", () => {
  /** `axisGrid`'s middle column, the one sitting on the cylinder axis, where
   *  the bend is zero and the slide is all that is left. */
  const AXIS_COL = 2;
  /** A travel no bend on this grid produces on its own. */
  const TRAVEL = 60;

  /** Mirror of auto-rig's private HEAD_TURN_TRAVEL_RATIO: the head's sideways
   *  travel at full turn as a fraction of the face plate's own half-width.
   *  A generated model spells it out nowhere — the travel is summed into the
   *  grid's own offsets — so the checks on a generated rig below mirror it,
   *  the way this file already mirrors HAIR_FRONT_DEPTH. */
  const HEAD_TURN_TRAVEL_RATIO = 0.25;

  it("the 2D bake slides the centre column by the whole travel at full turn", () => {
    const w = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, TRAVEL),
      () => 0,
    );
    // On the axis the bend is zero, so the centre column shows the slide neat:
    // the whole travel at ±30, half of it at ±15, none at rest — and the same
    // at every nod stop, the slide being horizontal only.
    for (const angleY of w.valuesY) {
      expect(cell(w, -30, angleY).offsets[AXIS_COL * 2]).toBe(-TRAVEL);
      expect(cell(w, -15, angleY).offsets[AXIS_COL * 2]).toBe(-TRAVEL / 2);
      expect(cell(w, 0, angleY).offsets[AXIS_COL * 2]).toBe(0);
      expect(cell(w, 15, angleY).offsets[AXIS_COL * 2]).toBe(TRAVEL / 2);
      expect(cell(w, 30, angleY).offsets[AXIS_COL * 2]).toBe(TRAVEL);
    }
  });

  it("every other column is its own bend plus that same slide", () => {
    const slid = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, TRAVEL),
      () => 0,
    );
    // bakeHeadTurnGridWarpCentered is the pure-bend reference: the shipped row
    // is it plus a slide uniform across the whole grid, so the turn still
    // foreshortens exactly as it did — it just travels while doing it.
    const bend = bakeHeadTurnGridWarpCentered(
      axisGrid,
      "ax",
      0,
      axisGridRadiusX,
    );
    for (const angleX of slid.valuesX) {
      const slide = (TRAVEL * angleX) / 30;
      const k1d = bend.keyforms.find((k) => k.value === angleX)!;
      const k2d = cell(slid, angleX, 0);
      for (let i = 0; i < axisGrid.points.length / 2; i++) {
        expect(k2d.offsets[i * 2]).toBeCloseTo(k1d.offsets[i * 2] + slide, 9);
        // dy is the nod's alone — untouched at this row.
        expect(k2d.offsets[i * 2 + 1]).toBeCloseTo(0, 10);
      }
    }
  });

  it("the AngleX = 0 cells carry no slide at all", () => {
    const w = bakeTurnGroupWarp2D(
      axisGrid,
      "ax",
      "ay",
      surfaceOn(axisGrid, axisGridRadiusX, TRAVEL),
      () => 0,
    );
    for (const angleY of w.valuesY) {
      for (const dx of cell(w, 0, angleY).offsets.filter((_, n) => n % 2 === 0))
        expect(dx).toBe(0);
    }
    // And the rest cell stays the identity, nod included.
    for (const offset of cell(w, 0, 0).offsets) expect(offset).toBe(0);
  });

  it("turnColumnMap lands the axis column on the slide itself", () => {
    // The map has to describe the turn the rig actually ships, or everything
    // measured through it — the bangs' hold, the turn solve — is measured
    // against a turn nothing renders. Column for column that is the shared
    // check in describe("turnColumnMap"); on the axis, where the bend is zero,
    // what is left is the slide alone.
    const faceCenterX = 0;
    for (const angleX of [-30, -15, 0, 15, 30]) {
      const map = turnColumnMap(
        axisGrid,
        faceCenterX,
        axisGridRadiusX,
        angleX,
        TRAVEL,
      );
      expect(map.mapX(faceCenterX)).toBeCloseTo((TRAVEL * angleX) / 30, 9);
    }
  });

  it("a generated model slides the face grid by a quarter of the plate half-width", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas1000);
    // The fixture's face plate is 600 px wide.
    const faceHalfWidth =
      hairFrontLayers().find((l) => l.role === "face")!.cropW / 2;
    const travel = HEAD_TURN_TRAVEL_RATIO * faceHalfWidth;
    expect(centreSlideOf(model, -30)).toBeCloseTo(-travel, 9);
    expect(centreSlideOf(model, 30)).toBeCloseTo(travel, 9);
    expect(centreSlideOf(model, 0)).toBe(0);
    // Scale-relative, not px: a plate twice as wide travels twice as far.
    const wideFace = hairFrontLayers().map((l) =>
      l.role === "face"
        ? { ...l, bbox: { x: 0, y: 200, w: 1000, h: 600 }, cropW: 1000 }
        : l,
    );
    expect(
      centreSlideOf(generateIkiFromLayerSet(wideFace, canvas1000), -30),
    ).toBeCloseTo(-HEAD_TURN_TRAVEL_RATIO * 500, 9);
  });

  it("headDeformer carries no AngleX binding at all", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas1000);
    const head = model.deformers!.find((d) => d.id === "headDeformer") as {
      bindings: { parameter: string; channel: string }[];
    };
    expect(
      head.bindings.filter((b) => b.parameter === StandardParameter.AngleX),
    ).toHaveLength(0);
    // The rest of the head's rig is untouched: nod, tilt, breath.
    expect(head.bindings.map((b) => b.parameter)).toEqual([
      StandardParameter.AngleY,
      StandardParameter.AngleZ,
      StandardParameter.Breath,
    ]);
  });

  it("bodyDeformer follows that same slide at its own share of it", () => {
    const model = generateIkiFromLayerSet(bodyLayers(), canvas1000);
    const body = model.deformers!.find((d) => d.id === "bodyDeformer") as {
      bindings: {
        parameter: string;
        channel: string;
        from: number;
        to: number;
      }[];
    };
    const turn = body.bindings.filter(
      (b) => b.parameter === StandardParameter.AngleX,
    );
    expect(turn).toHaveLength(1);
    expect(turn[0].channel).toBe("translateX");
    expect(turn[0].to).toBeCloseTo(
      BODY_TURN_FOLLOW * centreSlideOf(model, 30),
      9,
    );
    expect(turn[0].from).toBeCloseTo(
      BODY_TURN_FOLLOW * centreSlideOf(model, -30),
      9,
    );
  });

  /** The travel-free landings of the face plate's two edges at one turn stop,
   *  as distances from the face centre — signed, the way the cap reads them:
   *  the same two numbers `plateReach` reduces to one absolute maximum. Read
   *  as the plate RENDERS them: the surface's map on `lattice`, read through
   *  `plateGrid`'s own cell at the edge (`gridBilinearX`; the map is the same
   *  on every row, and the plate's edge is a mesh column, so that read is the
   *  whole rendered landing). */
  const plateLandings = (
    plateGrid: { cols: number; rows: number; points: number[] },
    lattice: { cols: number; rows: number; points: number[] },
    faceCenterX: number,
    faceHalfWidth: number,
    radius: number,
    deg: number,
  ): [number, number] => {
    const map = turnColumnMap(lattice, faceCenterX, radius, deg, 0);
    return [-1, 1].map(
      (side) =>
        gridBilinearX(
          plateGrid,
          (nx) => map.mapX(nx),
          faceCenterX + side * faceHalfWidth,
          plateGrid.points[1],
        ) - faceCenterX,
    ) as [number, number];
  };

  /** The travel a shell `holdEdge` px from the face centre can swallow at one
   *  stop, expressed at FULL turn — auto-rig's own private `shellTravelCap`,
   *  re-derived here. The slide runs with the turn's own sign, so the edge it
   *  pushes further out is the one whose landing shares that sign. */
  const shellCapAt = (
    plateGrid: { cols: number; rows: number; points: number[] },
    lattice: { cols: number; rows: number; points: number[] },
    faceCenterX: number,
    faceHalfWidth: number,
    radius: number,
    holdEdge: number,
    deg: number,
  ): number => {
    const toward = Math.max(
      ...plateLandings(
        plateGrid,
        lattice,
        faceCenterX,
        faceHalfWidth,
        radius,
        deg,
      ).map((l) => Math.sign(deg) * l),
    );
    return (
      (Math.max(0, holdEdge - HOLD_CLEARANCE - toward) * 30) / Math.abs(deg)
    );
  };

  it("the worked case behind the held shell's cap: signed edge landings, not their max absolute", () => {
    // A 300 px half-plate on a 6-cell grid reaching ±434, bent on a 360 px
    // radius inside a shell 305 px out — a bend tight enough that the NEAR
    // edge is thrown well past that shell before any slide happens. The grid
    // is the plate's and the lattice at once: the read through it IS the map.
    const grid = {
      cols: 6,
      rows: 6,
      points: generateGridPoints(6, 6, -434, 434, -300, 300),
    };
    const faceHalfWidth = 300;
    const radius = 360;
    const shell = 305;
    const cap = (deg: number) =>
      shellCapAt(grid, grid, 0, faceHalfWidth, radius, shell, deg);

    // Far edge pulled in, near edge thrown out, at both turned stops.
    const [far30, near30] = plateLandings(
      grid,
      grid,
      0,
      faceHalfWidth,
      radius,
      -30,
    );
    const [far15, near15] = plateLandings(
      grid,
      grid,
      0,
      faceHalfWidth,
      radius,
      -15,
    );
    expect(far30).toBeCloseTo(-187.7, 1);
    expect(near30).toBeCloseTo(334.6, 1);
    expect(far15).toBeCloseTo(-252.1, 1);
    expect(near15).toBeCloseTo(328.1, 1);

    // A −30° slide pushes the FAR edge out and pulls the near one in, so the
    // far edge's own 187.7 px is what the shell has to swallow on top of.
    expect(cap(-30)).toBeCloseTo(116.3, 1);
    expect(cap(30)).toBeCloseTo(cap(-30), 9);
    // The mid stop gets half the travel, so its own 51.9 px of room buys twice
    // that at full turn — and it is the tighter of the two.
    expect(cap(-15)).toBeCloseTo(103.8, 1);
    expect(cap(15)).toBeCloseTo(cap(-15), 9);

    // So this plate's own ask — a quarter of its half-width — stands whole.
    const ask = HEAD_TURN_TRAVEL_RATIO * faceHalfWidth;
    expect(ask).toBe(75);
    expect(Math.min(cap(-30), cap(-15))).toBeGreaterThan(ask);
    // Read as a max-ABSOLUTE reach instead, the near edge the bend throws wide
    // — already outside the shell, and exactly what the slide pulls back in —
    // would floor the cap at 0 and refuse the radius the slide was rescuing.
    expect(
      shell - HOLD_CLEARANCE - Math.max(Math.abs(far30), near30),
    ).toBeLessThan(0);
  });

  /** The bangs of `hairFrontLayers()` draw a head 350 px half-wide; measured
   *  at 310 instead, the plate has 10 px of shell to slide inside. The flatter
   *  turn (0.9 against the default 0.67) is what makes the cap bite: it bends
   *  the plate's own edge in less, leaving less of the shell over for the
   *  slide. */
  const SHELL_TARGETS = { headHalfWidth: 310, farEyeRatio: 0.9 };

  /** That rig and the geometry a render reads it through: the plate grid its
   *  face rides, the virtual lattice the surface is mapped on, the turn radius
   *  the solve settled on, and the slide the plate's centre column carries at
   *  full turn. */
  const shellRig = () => {
    const layers = [...hairFrontLayers(), noseLayer()];
    const { model, radius } = solvedRig(layers, canvas1000, {
      turnTargets: SHELL_TARGETS,
    });
    return {
      model,
      faceCenterX: model.parts.find((p) => p.id === "face")!.transform!.x,
      faceHalfWidth:
        hairFrontLayers().find((l) => l.role === "face")!.cropW / 2,
      grid: faceWarpOf(model).grid,
      lattice: latticeOf(layers),
      radius,
      travel: travelOf(model),
    };
  };

  it("a head barely wider than its plate still rigs, and slides only as far as that shell swallows", () => {
    const { model, faceCenterX, faceHalfWidth, grid, lattice, radius } =
      shellRig();
    const ask = HEAD_TURN_TRAVEL_RATIO * faceHalfWidth;
    const slide = centreSlideOf(model, -30);
    // It still slides: a shell only 10 px wider than the plate is not a head
    // with no turn travel at all.
    expect(slide).toBeLessThan(0);
    expect(Math.abs(slide)).toBeLessThan(ask);
    // And what is left is exactly what the shell had room for: the ask, cut at
    // the tightest stop by the plate's own travel-free RENDERED landing — its
    // edge read through the plate grid — on the side the slide pushes out.
    const cap = Math.min(
      ...[-30, -15, 15, 30].map((deg) =>
        shellCapAt(
          grid,
          lattice,
          faceCenterX,
          faceHalfWidth,
          radius,
          SHELL_TARGETS.headHalfWidth,
          deg,
        ),
      ),
    );
    expect(cap).toBeLessThan(ask);
    expect(Math.abs(slide)).toBeCloseTo(cap, 6);
  });

  it("that rig's plate edges stay inside the held shell at every stop", () => {
    // `travel` is the rig's OWN slide, read back off the grid it ships.
    const { model, faceCenterX, faceHalfWidth, radius, travel } = shellRig();
    // silhouetteRatio defaults to 1, so the hold's boundary is that measured
    // head at every stop — the plate has to land inside it, clearance and all,
    // or the ramp from the plate's edge onto the strands runs backwards. The
    // plate's edge is read where the face RENDERS it (the plate grid's chord
    // of the surface, on a mesh column), which is what the cap was sized on.
    const shellLine = SHELL_TARGETS.headHalfWidth - HOLD_CLEARANCE;
    const faceY = model.parts.find((p) => p.id === "face")!.transform.y;
    let furthest = 0;
    for (const deg of [-30, -15, 0, 15, 30]) {
      for (const side of [-1, 1]) {
        const landing =
          landedXAt(model, "face", faceCenterX + side * faceHalfWidth, faceY, {
            [StandardParameter.AngleX]: deg,
          }) - faceCenterX;
        // Float32 landings: an ulp of 3e-5 at |x| < 512.
        expect(Math.abs(landing)).toBeLessThanOrEqual(shellLine + 1e-4);
        furthest = Math.max(furthest, Math.abs(landing));
      }
    }
    // The bare map on the lattice, with the rig's own radius and travel, puts
    // the same edge within the plate grid's chord of where it renders.
    const map = turnColumnMap(
      latticeOf([...hairFrontLayers(), noseLayer()]),
      faceCenterX,
      radius,
      -30,
      travel,
    );
    expect(
      Math.abs(
        landedXAt(model, "face", faceCenterX - faceHalfWidth, faceY, turned) -
          map.mapX(faceCenterX - faceHalfWidth),
      ),
    ).toBeLessThan(0.5);
    // And it lands ON that line at the stop that set the cap (the ±15 pair,
    // where the bend leaves the least room), which is what says the slide was
    // cut to the shell's own size and not to something smaller: a travel short
    // of the cap would leave slack at every stop. Float32 again.
    expect(furthest).toBeCloseTo(shellLine, 4);
  });
});

// ── describe("head tilt (AngleZ)") ───────────────────────────────────────────

describe("head tilt (AngleZ)", () => {
  const canvas = { width: 1000, height: 1000 };
  const headOf = (model: ReturnType<typeof generateIkiFromLayerSet>) =>
    model.deformers!.find((d) => d.id === "headDeformer") as {
      bindings: {
        parameter: string;
        channel: string;
        from: number;
        to: number;
      }[];
    };

  it("declares AngleZ and rolls the head one degree per degree", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    expect(
      model.parameters.find((p) => p.id === StandardParameter.AngleZ),
    ).toMatchObject({ min: -30, max: 30, default: 0 });
    const tilt = headOf(model).bindings.filter(
      (b) => b.parameter === StandardParameter.AngleZ,
    );
    expect(tilt).toHaveLength(1);
    expect(tilt[0].channel).toBe("rotate");
    expect(Math.abs(tilt[0].to - tilt[0].from)).toBe(60);
    expect(tilt[0].from).toBeCloseTo(-tilt[0].to, 10);
    expect(() => parseIkiModel(structuredClone(model))).not.toThrow();
  });

  it("positive AngleZ is clockwise: engine rotate is CCW-positive, so `to` is negative", () => {
    // Live2D's convention (its sample motions give AngleZ the sign of AngleX,
    // i.e. clockwise on a turn to the viewer's right). A host mapping
    // head-tracking roll onto AngleZ must land on the same side.
    const head = headOf(generateIkiFromLayerSet(hairFrontLayers(), canvas));
    const tilt = head.bindings.find(
      (b) => b.parameter === StandardParameter.AngleZ,
    )!;
    expect(tilt.from).toBe(30);
    expect(tilt.to).toBe(-30);
  });

  it("the tilt is the head's only rotation: the turn does not roll it", () => {
    // A roll riding on AngleX swung the crown ahead of the face on every turn
    // (the neck pivot sits ~a head below it), so the turn is a pure yaw.
    const head = headOf(generateIkiFromLayerSet(hairFrontLayers(), canvas));
    const rotates = head.bindings.filter((b) => b.channel === "rotate");
    expect(rotates.map((b) => b.parameter)).toEqual([StandardParameter.AngleZ]);
  });
});

// ── describe("head-turn depth parallax") ─────────────────────────────────────

describe("head-turn depth parallax", () => {
  const canvas = { width: 1000, height: 1000 };

  /** The AngleX translateX binding a hair part carries, or undefined. */
  const parallaxOf = (bindings: { parameter: string; channel: string }[]) =>
    bindings.find(
      (b) =>
        b.parameter === StandardParameter.AngleX && b.channel === "translateX",
    ) as { from: number; to: number } | undefined;

  it("bindingsForRole: neither hair part carries an AngleX translateX, with or without the nod unit", () => {
    const front = bindingsForRole(
      ROLE_TABLE["hair_front"],
      "hair_front",
      700,
      400,
      { hasNose: true },
    );
    const back = bindingsForRole(
      ROLE_TABLE["hair_back"],
      "hair_back",
      800,
      700,
      {
        hasNose: true,
      },
    );
    // The bangs' lead is a warp (attached in generateIkiFromLayerSet), not a
    // binding — hair_front carries none here.
    expect(front).toHaveLength(0);
    // And the back hair holds the head's outline: it rides a head that no
    // longer travels on the turn, so the turn buys it nothing at all (there is
    // no turn unit to hand a binding any more — the features' turn is grid
    // geometry). Its own depth binding is the NOD's, which needs
    // parallaxUnitY.
    expect(back).toHaveLength(0);
    expect(
      bindingsForRole(ROLE_TABLE["hair_back"], "hair_back", 800, 700, {
        parallaxUnitY: 120,
        hasNose: true,
      }).map((b) => [b.parameter, b.channel]),
    ).toEqual([[StandardParameter.AngleY, "translateY"]]);
  });

  it("the bangs lead the sliding face and the back hair stays put", () => {
    // No nose in this fixture, so no turn is solved and the radius is the
    // grid's own half-width with the margin — `solvedRig`'s own fallback.
    const { model, radius } = solvedRig(hairFrontLayers(), canvas);
    // The head's travel lives in the face grid now, so the back hair needs no
    // counter-slide to hold the head's outline — it carries nothing on the
    // turn at all (see describe("hair_back holds the turn's outline")).
    expect(
      parallaxOf(model.parts.find((p) => p.id === "hair_back")!.bindings ?? []),
    ).toBeUndefined();
    // The face underneath it does travel: that is what the bangs lead.
    expect(centreSlideOf(model, 30)).toBeGreaterThan(0);

    // The bangs' lead is a root-pinned warp on hair_front, not a binding.
    const front = model.parts.find((p) => p.id === "hair_front")!;
    const lead = front.warps!.find(
      (w) => w.parameter === StandardParameter.AngleX,
    )!;
    const atMax = lead.keyforms.find((k) => k.value === 30)!;
    const atMin = lead.keyforms.find((k) => k.value === -30)!;
    const topY = Math.max(
      ...front.mesh!.vertices.filter((_, i) => i % 2 === 1),
    );
    const bottomY = Math.min(
      ...front.mesh!.vertices.filter((_, i) => i % 2 === 1),
    );
    // The shared parallaxUnit, off that same cylinder radius.
    const parallaxUnit = headTurnParallaxUnit(radius);
    for (let v = 0; v < front.mesh!.vertices.length / 2; v++) {
      const vy = front.mesh!.vertices[v * 2 + 1];
      if (vy === topY) {
        // Root pinned: the crown row does not move, at either keyform.
        expect(atMax.offsets[v * 2]).toBe(0);
        expect(atMin.offsets[v * 2]).toBe(0);
      }
      if (vy === bottomY) {
        // Fringe tips carry the full lead, WITH the head.
        expect(atMax.offsets[v * 2]).toBeCloseTo(
          HAIR_FRONT_DEPTH * parallaxUnit,
          6,
        );
        expect(atMax.offsets[v * 2]).toBeGreaterThan(0);
      }
    }
    // -30 is the exact negation of +30, so rest (value 0, between the two
    // keyforms) nets zero. (Summed rather than toEqual(map(v => -v)): the y
    // channel is a literal 0 on one side and 0 - 0 on the other, +0 vs -0.)
    for (let i = 0; i < atMax.offsets.length; i++) {
      expect(atMin.offsets[i] + atMax.offsets[i]).toBeCloseTo(0, 10);
    }
  });

  it("rest is untouched: the back-hair nod binding is symmetric about zero", () => {
    // ParamAngleY defaults to 0, mid-range, so an asymmetric binding would
    // shift the hair in the rest pose — the pose every proportion is judged
    // on. The nod is the back hair's only depth binding now (it has nothing
    // on the turn); hair_front carries no binding at all, its rest being its
    // warp's mid-point between symmetric keyforms, asserted above.
    const b = bindingsForRole(ROLE_TABLE["hair_back"], "hair_back", 800, 700, {
      parallaxUnitY: 120,
    }).find(
      (x) =>
        x.parameter === StandardParameter.AngleY && x.channel === "translateY",
    )!;
    expect(b.from).toBeCloseTo(-b.to, 10);
  });

  it("headTurnParallaxUnit IS the axis shift the warp bake pins out", () => {
    // It stands in for the bake's own `radius * sin(theta)` term below. Both
    // take the radius, so feeding one number to both is the whole contract;
    // if it ever stops being one number the hair stops matching the face's
    // foreshortening.
    const halfW = 400;
    const radius = halfW * RADIUS_FACTOR;
    const grid = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -halfW, halfW, -300, 300),
    };
    const baked = bakeHeadTurnGridWarpCentered(
      grid,
      StandardParameter.AngleX,
      0,
      radius,
    );
    const at30 = baked.keyforms.find((k) => k.value === 30)!;

    const theta = (30 * Math.PI) / 180;
    // Re-derive the rightmost grid column's pinned dx from that radius.
    const alpha = Math.asin(halfW / radius);
    const expected =
      radius * Math.sin(alpha + theta) - halfW - headTurnParallaxUnit(radius);
    expect(at30.offsets[4 * 2]).toBeCloseTo(expected, 6);
  });

  it("the generated model leads hair_front with a warp and hair_back with nothing", () => {
    const layers = hairFrontLayers();
    const model = generateIkiFromLayerSet(layers, canvas);
    const front = model.parts.find((p) => p.id === "hair_front")!;
    const back = model.parts.find((p) => p.id === "hair_back")!;
    // hair_front has NO translateX binding: its lead is the warp checked above.
    expect(parallaxOf(front.bindings ?? [])).toBeUndefined();
    expect(
      front.warps!.some((w) => w.parameter === StandardParameter.AngleX),
    ).toBe(true);
    // The back hair gets neither: no turn binding, and no AngleX warp either.
    expect(parallaxOf(back.bindings ?? [])).toBeUndefined();
    expect(
      (back.warps ?? []).some((w) => w.parameter === StandardParameter.AngleX),
    ).toBe(false);
  });

  // One hair spring peaks near 11.2 of its ±20 range (ζ ≈ 0.56 on a ±10
  // steady state) — the furthest a sway actually drives the tips.
  const SPRING_PEAK = 11.2;

  /** Where every vertex on a part's bottom mesh row — the hair's tips, the row
   *  a root-pinned sway swings furthest — lands on x at `params`. */
  const tipLandingsX = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    partId: string,
    params: ParamValues = {},
  ) => {
    const verts = model.parts.find((p) => p.id === partId)!.mesh!.vertices;
    const bottomY = Math.min(...verts.filter((_, i) => i % 2 === 1));
    const landed = landVertices(model, partId, params);
    return verts.flatMap((v, i) =>
      i % 2 === 1 && v === bottomY ? [landed[i - 1]] : [],
    );
  };

  /** hair_front's tip swing on x out to HairSwayX `peak`, split at half the
   *  peak, per tip: `[half − rest, peak − half]`, at `pose` (rest by default).
   *  A swing that renders linear in the parameter gives two equal halves; a
   *  tip something clamped would gain less over the second half than over
   *  the first. */
  const tipSwingHalves = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    peak: number,
    pose: ParamValues = {},
  ) => {
    const sway = (v: number) => ({
      ...pose,
      [StandardParameter.HairSwayX]: v,
    });
    const rest = tipLandingsX(model, "hair_front", pose);
    const half = tipLandingsX(model, "hair_front", sway(peak / 2));
    const at = tipLandingsX(model, "hair_front", sway(peak));
    return at.map((x, i) => [half[i] - rest[i], x - half[i]] as const);
  };

  it("the hair_front tips swing linearly out to a spring's peak, the full fraction of their height", () => {
    // The bangs ride the rigid head with no grid under them, so nothing clamps
    // a swayed vertex: both halves of the swing are equal to float32 rounding
    // and the whole swing is the full fraction of the hair's height.
    const layers = hairFrontLayers();
    const model = generateIkiFromLayerSet(layers, canvas);
    const cropH = layers.find((l) => l.role === "hair_front")!.cropH;
    for (const peak of [SPRING_PEAK, -SPRING_PEAK]) {
      for (const [first, second] of tipSwingHalves(model, peak)) {
        expect(second).toBeCloseTo(first, 4);
        expect(first + second).toBeCloseTo(
          HAIR_SWAY_TIP_FRACTION * cropH * (peak / 20),
          4,
        );
      }
    }
  });

  it("the tips swing as far at full turn as at rest: no grid edge freezes them", () => {
    // A face-warp child's swayed vertices used to clamp at the grid's edge,
    // and at full turn the silhouette hold parked the outermost columns on
    // that edge, so their swing was swallowed there whatever the sway. Off
    // the grid, a spring's peak combined with AngleX ±30 still moves every
    // tip further out than half the peak does, by the same amount as the
    // first half: the hold and the lead are constant in the sway.
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    for (const angleX of [-30, 30]) {
      for (const peak of [SPRING_PEAK, -SPRING_PEAK]) {
        const halves = tipSwingHalves(model, peak, {
          [StandardParameter.AngleX]: angleX,
        });
        expect(halves.length).toBeGreaterThan(0);
        for (const [first, second] of halves) {
          expect(second * Math.sign(peak)).toBeGreaterThan(0);
          expect(second).toBeCloseTo(first, 4);
        }
      }
    }
  });

  it("tall bangs on a narrow face swing the full fraction of their height too", () => {
    // Hair much taller than the face is wide: its tips swing 9% of that height
    // — 50 px at a spring's peak — where a face-warp child would have hit the
    // grid's 12%-of-width margin and clamped between half the peak and the
    // peak. With no grid under the bangs both halves stay equal and the swing
    // is the same full fraction as the back hair's.
    const tall: LayerInput[] = [
      {
        role: "face",
        fileName: "face.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 300, y: 250, w: 400, h: 500 },
        cropW: 400,
        cropH: 500,
      },
      {
        role: "eye_L",
        fileName: "eye_L.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 380, y: 400, w: 80, h: 50 },
        cropW: 80,
        cropH: 50,
      },
      {
        role: "eye_R",
        fileName: "eye_R.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 540, y: 400, w: 80, h: 50 },
        cropW: 80,
        cropH: 50,
      },
      {
        role: "mouth",
        fileName: "mouth.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 460, y: 600, w: 80, h: 40 },
        cropW: 80,
        cropH: 40,
      },
      {
        role: "hair_back",
        fileName: "hair_back.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 250, y: 100, w: 500, h: 800 },
        cropW: 500,
        cropH: 800,
      },
      {
        role: "hair_front",
        fileName: "hair_front.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 300, y: 0, w: 400, h: 1000 },
        cropW: 400,
        cropH: 1000,
      },
    ];
    const model = generateIkiFromLayerSet(tall, canvas);
    const frontCropH = tall.find((l) => l.role === "hair_front")!.cropH;
    for (const peak of [SPRING_PEAK, -SPRING_PEAK]) {
      for (const [first, second] of tipSwingHalves(model, peak)) {
        expect(second).toBeCloseTo(first, 4);
        expect(first + second).toBeCloseTo(
          HAIR_SWAY_TIP_FRACTION * frontCropH * (peak / 20),
          4,
        );
      }
    }
    // The back hair's tips move the whole fraction of its crop height at the
    // end of the range, the same way.
    const backCropH = tall.find((l) => l.role === "hair_back")!.cropH;
    const rest = tipLandingsX(model, "hair_back");
    tipLandingsX(model, "hair_back", {
      [StandardParameter.HairSwayX]: 20,
    }).forEach((x, i) => {
      expect(x - rest[i]).toBeCloseTo(HAIR_SWAY_TIP_FRACTION * backCropH, 3);
    });
  });
});

// ── describe("hair_back holds the turn's outline") ───────────────────────────

describe("hair_back holds the turn's outline", () => {
  /** Every x displacement a part's OWN rig gives one of its vertices at one
   *  turn stop: each AngleX translateX binding, read across the parameter's
   *  own limits, plus each AngleX part warp's own offset for that vertex
   *  there. hair_back rides headDeformer, which carries no AngleX binding
   *  either (see "headDeformer carries no AngleX binding at all"), so this is
   *  the whole of what the turn can move it by. */
  const turnDisplacementAt = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    id: string,
    vertex: number,
    deg: number,
  ) => {
    const part = model.parts.find((p) => p.id === id)!;
    const angleX = model.parameters.find(
      (p) => p.id === StandardParameter.AngleX,
    )!;
    const t = (deg - angleX.min) / (angleX.max - angleX.min);
    const fromBindings = (part.bindings ?? [])
      .filter(
        (b) =>
          b.parameter === StandardParameter.AngleX &&
          b.channel === "translateX",
      )
      .reduce((sum, b) => sum + b.from + (b.to - b.from) * t, 0);
    const fromWarps = (part.warps ?? [])
      .filter((w) => w.parameter === StandardParameter.AngleX)
      .reduce((sum, w) => {
        const k = w.keyforms.find((x) => x.value === deg);
        if (!k) throw new Error(`no ${w.parameter} keyform at ${deg}`);
        return sum + k.offsets[vertex * 2];
      }, 0);
    return fromBindings + fromWarps;
  };

  it("carries no turn binding and no turn warp, so its outline holds at every stop", () => {
    const model = generateIkiFromLayerSet(
      [...hairFrontLayers(), noseLayer()],
      canvas1000,
    );
    const back = model.parts.find((p) => p.id === "hair_back")!;
    // It still follows the nod (its crown tucks under the bent bangs), so an
    // empty binding list would not be the same statement.
    expect((back.bindings ?? []).map((b) => b.parameter)).toContain(
      StandardParameter.AngleY,
    );
    expect((back.bindings ?? []).map((b) => b.parameter)).not.toContain(
      StandardParameter.AngleX,
    );
    // The sway springs are all its warps read: nothing on AngleX beside them.
    expect((back.warps ?? []).map((w) => w.parameter)).toEqual([
      StandardParameter.HairSwayX,
      StandardParameter.HairSwayZ,
    ]);
    // So the vertices that draw the head's outline — the outermost on each
    // side — hold their rest x through the whole turn, mid stops included.
    const xs = Array.from(
      { length: back.mesh!.vertices.length / 2 },
      (_, v) => back.mesh!.vertices[v * 2],
    );
    for (const vertex of [
      xs.indexOf(Math.min(...xs)),
      xs.indexOf(Math.max(...xs)),
    ]) {
      for (const deg of [-30, -15, 0, 15, 30]) {
        expect(turnDisplacementAt(model, "hair_back", vertex, deg)).toBe(0);
      }
    }
  });

  it("without bangs it ships no warps at all, not an empty list", () => {
    // The sway rig exists only with front hair, and the turn no longer adds a
    // warp of its own, so there is nothing left to put on the key.
    const bare = generateIkiFromLayerSet(assemblyLayers(), canvas1000);
    expect(bare.parts.find((p) => p.id === "hair_back")!.warps).toBeUndefined();
  });
});

describe("hair_front silhouette hold", () => {
  const canvas = { width: 1000, height: 1000 };

  /** Every layer's bbox pushed `dx` across the canvas, so the face centre — and
   *  with it the whole hold — sits off the model origin. */
  const shiftedBy = (layers: LayerInput[], dx: number): LayerInput[] =>
    layers.map((l) => ({ ...l, bbox: { ...l.bbox, x: l.bbox.x + dx } }));

  /** A generated rig, plus the pieces a silhouette assertion needs: the plate
   *  as it RENDERS on the solved surface and the rows its edge is guarded at,
   *  the hold zone the generator picks from them and where the hold sends its
   *  boundary at each stop, and the bangs' own rest mesh. */
  const rigOf = (layers: LayerInput[]) => {
    let report: TurnSolveReport | undefined;
    const { model, radius } = solvedRig(layers, canvas, {
      onTurnSolved: (r) => (report = r),
    });
    const faceWarp = faceWarpOf(model);
    const grid = faceWarp.grid;
    // The slide the shipped grid actually carries, not the plate's own
    // uncapped ask.
    const travel = travelOf(model);
    // Where the hold sends its boundary at each stop is the solve's own
    // `holdEdgeAt`, which the report does not carry: re-solve the identical
    // turn the generator did (`turnSolveInputs`, exactly what it handed the
    // solve) and check by radius, travel AND hold base that it IS this rig's —
    // the landing asserted below mixes its `holdEdgeAt` with the `holdBase`
    // below, and the radius alone (fitted to the eye ratio) does not pin the
    // travel (capped separately) or the hold base built on it.
    const inputs = turnSolveInputs(layers);
    const [, lattice, faceCenterX, faceHalfWidth, , , carriers, , hairFront] =
      inputs;
    const turn = solveTurnModel(resolveTurnTargets({}), ...inputs);
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(turn.radius).toBe(radius);
    expect(turn.travel).toBeCloseTo(travel, 6);
    // The plate the generator renders — its own mesh over its own plate grid,
    // the carrier the solve read it through — on the solved surface, and the
    // rows every guard reads its painted edge at, built from the same inputs
    // the generator builds them from. The shipped `faceWarp` grid IS that
    // carrier's grid. Without a measured head the hold base is that rendered
    // edge's furthest reach over the turn plus the clearance.
    const plate = carriers.get("face")!.part;
    expect(carriers.get("face")!.grid).toEqual(grid);
    const plateLandingAt = plateLandingOn(
      { grid, part: plate },
      turn.surface.mapAt,
    );
    const edgeAt = () => faceHalfWidth;
    const plateGuardRows = plateGuardRowsFor(plate, hairFront);
    const holdBase =
      plateReach(plateLandingAt, faceCenterX, edgeAt, plateGuardRows) +
      HOLD_CLEARANCE;
    expect(turn.holdBase).toBeCloseTo(holdBase, 9);
    const hair = model.parts.find((p) => p.id === "hair_front")!;
    const partX = hair.transform!.x;
    const partY = hair.transform!.y;
    /** Absolute rest x / y of mesh vertex `v`. */
    const restX = (v: number) => partX + hair.mesh!.vertices[v * 2];
    const restY = (v: number) => partY + hair.mesh!.vertices[v * 2 + 1];
    const hairLayer = layers.find((l) => l.role === "hair_front")!;
    const { cols, rows } = meshCellsFor(hairLayer.cropW, hairLayer.cropH);
    return {
      model,
      grid,
      lattice,
      faceCenterX,
      faceHalfWidth,
      holdBase,
      holdEdgeAt: turn.holdEdgeAt,
      surface: turn.surface,
      plate,
      plateLandingAt,
      edgeAt,
      plateGuardRows,
      /** The parallax unit the bangs' lead is a fraction of. */
      unit: headTurnParallaxUnit(radius),
      stops: faceWarp.warp2d.valuesX,
      hair,
      partX,
      partY,
      restX,
      restY,
      cols,
      rows,
      /** The bangs' ROOT row — mesh row 0, the top, the row the lead pins
       *  (`bakeHairSwayWarp` swings by `u^CURL` of the distance from it, 0
       *  there) — so a root-row vertex lands where the hold alone sends it. */
      rootRow: Array.from({ length: cols + 1 }, (_, v) => v),
      vertexCount: hair.mesh!.vertices.length / 2,
      report: report!,
    };
  };

  const fixtures: [string, LayerInput[]][] = [
    ["face centred on the canvas", [...hairFrontLayers(), noseLayer()]],
    ["face off-centre", shiftedBy([...hairFrontLayers(), noseLayer()], 60)],
  ];

  /** Where the bangs' vertices land at one AngleX stop. */
  const landedAt = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    deg: number,
  ) => landVertices(model, "hair_front", { [StandardParameter.AngleX]: deg });

  for (const [label, layers] of fixtures) {
    it(`carries every root-row strand past the hold edge by that side's own displacement, at every stop (${label})`, () => {
      const r = rigOf(layers);
      // The fixture's bangs put one mesh column past the hold edge each side.
      const outer = r.rootRow.filter(
        (v) => Math.abs(r.restX(v) - r.faceCenterX) > r.holdBase,
      );
      expect(outer.map((v) => Math.sign(r.restX(v) - r.faceCenterX))).toEqual([
        -1, 1,
      ]);
      for (const deg of r.stops) {
        const landed = landedAt(r.model, deg);
        for (const v of outer) {
          const x = r.restX(v);
          const side = Math.sign(x - r.faceCenterX);
          // Past the hold's own boundary every strand takes the boundary's
          // own displacement — slope 1 in rest x — so the spacing between
          // them survives the turn whatever the hold is set to; at 0° that
          // displacement is zero and the strands sit where they are drawn.
          // The rows below the root carry the lead as well; where THEY land
          // is Task 5's, here they only have to stay in order (the order
          // test). Landings are float32 (an ulp of 3e-5 at |x| < 512): the
          // two agree to that rounding (under two ulps, a deterministic
          // margin).
          expect(landed[v * 2], `${deg}° vertex ${v}`).toBeCloseTo(
            x + side * (r.holdEdgeAt(deg) - r.holdBase),
            4,
          );
        }
      }
      // What the turned stops' displacement is FOR: the hold is fitted until a
      // render measures the silhouette ratio asked for, which here is the
      // default's own 1 — and a render does measure it, to the oracle's
      // float32 rounding. Holding each strand at its rest x instead would land
      // a hair under it — the bangs' own lead pulls the measured edge in.
      expect(r.report.achieved.silhouetteRatio).toBeCloseTo(1, 8);
      expect(
        cuesOf(r.model, layers, r.faceHalfWidth).silhouetteRatio,
      ).toBeCloseTo(1, 6);
      expect(r.report.clamped).not.toContain("silhouetteRatio");
    });

    it(`lands the root-row vertices on the face plate where the RENDERED plate lands them (${label})`, () => {
      const r = rigOf(layers);
      const onPlate = r.rootRow.filter(
        (v) => Math.abs(r.restX(v) - r.faceCenterX) <= r.faceHalfWidth,
      );
      expect(onPlate.length).toBeGreaterThan(0);
      for (const deg of r.stops) {
        const params = { [StandardParameter.AngleX]: deg };
        const landed = landedAt(r.model, deg);
        for (const v of onPlate) {
          // A bangs vertex over the plate lands where the FACE lands that
          // same point of itself — read off the face's own landed mesh, so
          // the bangs sit on the face they cover however the plate's grid and
          // mesh chord the surface. The root row sits above the plate's top,
          // so both read the face's top row, the nearest point it draws. The
          // hold is horizontal, so the row stays. To float32 rounding again.
          expect(landed[v * 2], `${deg}° vertex ${v}`).toBeCloseTo(
            landedXAt(r.model, "face", r.restX(v), r.restY(v), params),
            4,
          );
          expect(landed[v * 2 + 1], `${deg}° vertex ${v}`).toBeCloseTo(
            r.restY(v),
            4,
          );
        }
      }
    });

    it(`lands every strand past the hold edge, on EVERY row, at the boundary's displacement plus that row's own lead (${label})`, () => {
      const r = rigOf(layers);
      const stride = r.cols + 1;
      const outer = Array.from({ length: r.vertexCount }, (_, v) => v).filter(
        (v) => Math.abs(r.restX(v) - r.faceCenterX) > r.holdBase,
      );
      // One mesh column past the hold edge each side, every row of it.
      expect(outer).toHaveLength(2 * (r.rows + 1));
      for (const deg of r.stops) {
        const landed = landedAt(r.model, deg);
        for (const v of outer) {
          const x = r.restX(v);
          const side = Math.sign(x - r.faceCenterX);
          // The lead is root-pinned — `u^CURL` of the row's distance from the
          // root, the full HAIR_FRONT_DEPTH share of the unit at ±30 and
          // linear between — and sums onto the hold UNSCALED: no grid's local
          // slope multiplies it any more, so the row's landing is the
          // boundary's displacement plus exactly that lead.
          const u = Math.floor(v / stride) / r.rows;
          const lead =
            (deg / 30) *
            HAIR_FRONT_DEPTH *
            r.unit *
            Math.pow(u, HAIR_SWAY_CURL);
          expect(landed[v * 2], `${deg}° vertex ${v}`).toBeCloseTo(
            x + side * (r.holdEdgeAt(deg) - r.holdBase) + lead,
            4,
          );
        }
      }
    });

    it(`keeps every row's landing order at every stop and between them — no folded cell (${label})`, () => {
      const r = rigOf(layers);
      const stride = r.cols + 1;
      // The stops, and the midpoints the engine blends to between them, where
      // the hold's and the grid's linear keyform blends meet the lead's.
      for (const deg of [-30, -22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30]) {
        const landed = landedAt(r.model, deg);
        for (let v = 1; v < r.vertexCount; v++) {
          if (v % stride === 0) continue; // first vertex of a row
          expect(landed[v * 2], `${deg}° vertex ${v}`).toBeGreaterThan(
            landed[(v - 1) * 2],
          );
        }
      }
    });

    it(`is inert at rest: every vertex lands where it is drawn (${label})`, () => {
      const r = rigOf(layers);
      // Every parameter at its default: the hold's rest keyform, the lead's
      // and the sways' zero, the grid's rest cell and headDeformer's identity
      // leave the mesh where the crop puts it — to float32 rounding, the row
      // pitch (400 / 6 px) not being representable.
      const landed = landVertices(r.model, "hair_front");
      for (let v = 0; v < r.vertexCount; v++) {
        expect(landed[v * 2], `vertex ${v}`).toBeCloseTo(r.restX(v), 4);
        expect(landed[v * 2 + 1], `vertex ${v}`).toBeCloseTo(r.restY(v), 4);
      }
    });
  }

  it("rides the head: hair_front is a headDeformer child with no bindings, every motion of its own a warp", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    expect(r.hair.deformer).toBe("headDeformer");
    expect(r.hair.bindings).toBeUndefined();
    // Sway X, sway Z, the turn lead, the silhouette hold and the nod — the
    // two-keyform ones swing between ±range, the five-keyform ones sit on the
    // turn stops. Warps sum, so their order is not part of the contract.
    const warps = r.hair.warps!.map(
      (w) => `${w.parameter}:${w.keyforms.length}`,
    );
    expect(warps).toHaveLength(5);
    expect(warps).toEqual(
      expect.arrayContaining([
        `${StandardParameter.HairSwayX}:2`,
        `${StandardParameter.HairSwayZ}:2`,
        `${StandardParameter.AngleX}:2`,
        `${StandardParameter.AngleX}:5`,
        `${StandardParameter.AngleY}:5`,
      ]),
    );
  });

  /** How far the plate's edge lands from the face centre at `deg` through a
   *  column map read the way the plate's own grid reads it — the map at the
   *  grid's two columns either side of the edge, interpolated (the map is the
   *  same on every row, and the edge is a mesh column, so that is the whole
   *  rendered landing) — whichever side lands further out. The two sides race
   *  each other: the bend pulls the far one in while the slide pushes it
   *  out, and the near one the other way round. */
  const plateEdgeThrough = (
    columnMapAt: (deg: number) => ReturnType<typeof turnColumnMap>,
    plateGrid: { cols: number; rows: number; points: number[] },
    faceCenterX: number,
    faceHalfWidth: number,
    deg: number,
  ) =>
    Math.max(
      ...[-1, 1].map((side) =>
        Math.abs(
          gridBilinearX(
            plateGrid,
            (nx) => columnMapAt(deg).mapX(nx),
            faceCenterX + side * faceHalfWidth,
            plateGrid.points[1],
          ) - faceCenterX,
        ),
      ),
    );

  /** That reach on a generated rig's own RENDERED plate — `plateReachAt`'s
   *  quantity, the reach a hold edge has to clear at that stop. */
  const plateEdgeAt = (r: ReturnType<typeof rigOf>, deg: number) =>
    plateReachAt(
      r.plateLandingAt,
      r.faceCenterX,
      r.edgeAt,
      r.plateGuardRows,
      deg,
    );

  it("takes its hold edge from the plate's reach over ALL the stops, mid ones included", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    const reach = plateReach(
      r.plateLandingAt,
      r.faceCenterX,
      r.edgeAt,
      r.plateGuardRows,
    );
    // On THIS rig the slide pulls the near edge back inside its own rest
    // half-width faster than the bend throws it out, so every turned stop
    // lands short of the rest pose and the reach is the plate's own 300.
    expect(reach).toBeCloseTo(r.faceHalfWidth, 9);
    expect(plateEdgeAt(r, -15)).toBeLessThan(reach);
    expect(plateEdgeAt(r, -30)).toBeLessThan(plateEdgeAt(r, -15));
    expect(r.holdBase).toBeCloseTo(reach + HOLD_CLEARANCE, 9);
    // The rendered plate's edge is the plate CARRIER's read of the surface:
    // the face mesh has a vertex column at the edge and every row reads the
    // same map on the lattice, so the mesh chords nothing there — but the
    // plate grid does, the edge sitting inside one of its cells: the landing
    // is the map at that cell's two columns, interpolated (`gridBilinearX`,
    // the engine's own bind-and-sample), to full precision, and differs from
    // the bare map at the edge by that chord (under half a pixel here, the
    // 12 % margin putting a column 74 px past the edge).
    const mapAt = (deg: number) =>
      turnColumnMap(
        r.lattice,
        r.faceCenterX,
        r.report.radius,
        deg,
        travelOf(r.model),
      );
    for (const deg of r.stops) {
      expect(plateEdgeAt(r, deg)).toBeCloseTo(
        plateEdgeThrough(mapAt, r.grid, r.faceCenterX, r.faceHalfWidth, deg),
        9,
      );
      const bare = Math.max(
        ...[-1, 1].map((side) =>
          Math.abs(
            mapAt(deg).mapX(r.faceCenterX + side * r.faceHalfWidth) -
              r.faceCenterX,
          ),
        ),
      );
      expect(Math.abs(plateEdgeAt(r, deg) - bare)).toBeLessThan(0.5);
    }

    // Which stop reaches furthest moves with the radius (see `plateReach`),
    // so the all-stops scan is what makes the hold edge safe: flatten the
    // same plate's cylinder to 4 half-widths, keep its own 75 px of travel,
    // and a MID stop wins — 317.4 px against the rest pose's 300 and full
    // turn's 315.7, the worked case `plateReach`'s own doc quotes (the
    // analytic bend, the plate grid's chord of it under 0.05 px).
    const flat = plateLandingOn(
      { grid: r.grid, part: r.plate },
      turnSurface({
        faceCenterX: r.faceCenterX,
        faceCenterY: r.surface.faceCenterY,
        radius: 4 * r.faceHalfWidth,
        travel: 75,
        nodRadius: r.surface.nodRadius,
        lattice: r.lattice,
      }).mapAt,
    );
    const flatAt = (deg: number) =>
      plateReachAt(flat, r.faceCenterX, r.edgeAt, r.plateGuardRows, deg);
    const flatReach = plateReach(
      flat,
      r.faceCenterX,
      r.edgeAt,
      r.plateGuardRows,
    );
    expect(flatReach).toBeCloseTo(flatAt(15), 9);
    expect(flatReach).toBeCloseTo(317.4, 1);
    expect(flatAt(0)).toBeCloseTo(r.faceHalfWidth, 9);
    expect(flatAt(30)).toBeCloseTo(315.7, 1);
    expect(flatReach).toBeGreaterThan(flatAt(30));
  });

  it("the bake's fold guard reads the very reach the solve accepted, at every stop", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    // Provoke the guard at ONE stop — a hold edge of 1 px there, the boundary
    // itself everywhere else so the rest-pose check passes — and read the
    // reach it names off its message.
    const guardReachAt = (stop: number) => {
      try {
        bakeHairFrontSilhouetteWarp(
          r.hair.mesh!,
          r.partX,
          r.partY,
          r.faceCenterX,
          r.plateLandingAt,
          r.edgeAt,
          r.holdBase,
          (deg) => (deg === stop ? 1 : r.holdBase),
          r.plateGuardRows,
        );
      } catch (e) {
        return Number(/maps to ([\d.]+)/.exec((e as Error).message)![1]);
      }
      throw new Error(`expected the guard to fire at ${stop}°`);
    };
    const turnedStops = [-30, -15, 15, 30];
    for (const deg of turnedStops) {
      // The same list of rows through the same rendered plate: equal bytes,
      // not a tolerance.
      expect(guardReachAt(deg)).toBe(plateEdgeAt(r, deg));
    }
    // And the solve's own hold base is the largest of them (the rest pose's
    // own half-width included) plus the clearance — so a hold the solve ships
    // is one the bake can build.
    expect(r.report.holdBase).toBeCloseTo(
      Math.max(...turnedStops.map(guardReachAt), r.faceHalfWidth) +
        HOLD_CLEARANCE,
      9,
    );
  });

  it("refuses a hold edge inside the plate's rendered edge, naming the stop and both numbers", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    // Well inside the plate's own landing at every stop: the ramp between
    // them would run backwards. The scan starts at −30, so that is the stop
    // the message names, and there the FAR (−x) edge is the one that lands
    // furthest out — the slide pushes it while the bend pulls it in.
    expect(() =>
      bakeHairFrontSilhouetteWarp(
        r.hair.mesh!,
        r.partX,
        r.partY,
        r.faceCenterX,
        r.plateLandingAt,
        r.edgeAt,
        200,
        () => 200,
        r.plateGuardRows,
      ),
    ).toThrow(
      `auto-rig: bakeHairFrontSilhouetteWarp: at -30° on the -x side the hold edge sits 200 from the face centre but the plate's edge maps to ${plateEdgeAt(r, -30)}`,
    );
  });

  it("refuses a hold edge only the MID stops overshoot", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    // Between the fixture's full-turn reach and its mid-stop one: a guard that
    // checked ±30 only would pass this and fold the strands at half turn.
    expect(plateEdgeAt(r, -15)).toBeGreaterThan(plateEdgeAt(r, -30));
    const holdBase = (plateEdgeAt(r, -30) + plateEdgeAt(r, -15)) / 2;
    expect(() =>
      bakeHairFrontSilhouetteWarp(
        r.hair.mesh!,
        r.partX,
        r.partY,
        r.faceCenterX,
        r.plateLandingAt,
        r.edgeAt,
        holdBase,
        () => holdBase,
        r.plateGuardRows,
      ),
    ).toThrow(/at -15°/);
  });

  it("refuses a hold edge that does not start on its own boundary", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    // A rest destination off the boundary is a nonzero rest keyform: the bangs
    // would sit somewhere else in the pose every proportion was judged on.
    expect(() =>
      bakeHairFrontSilhouetteWarp(
        r.hair.mesh!,
        r.partX,
        r.partY,
        r.faceCenterX,
        r.plateLandingAt,
        r.edgeAt,
        r.holdBase,
        () => r.holdBase - 1,
        r.plateGuardRows,
      ),
    ).toThrow(/auto-rig: bakeHairFrontSilhouetteWarp: holdEdgeAt\(0\)/);
  });

  /** A hand-built plate for the direct bake tests: 200 px half-wide and 200
   *  tall about the origin, over a 4×4 grid, on a surface with travel 0 —
   *  no rig behind it to size a slide, the bend alone — and the guard rows
   *  of a 1000×100 bangs mesh over it. */
  const handPlate = () => {
    const grid = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -800, 800, -400, 400),
    };
    const plate = facePlate(0, 0, 200, 200);
    const surface = turnSurface({
      faceCenterX: 0,
      faceCenterY: 0,
      radius: 800 * RADIUS_FACTOR,
      travel: 0,
      nodRadius: 400 * RADIUS_FACTOR,
      lattice: grid,
    });
    return {
      grid,
      plate,
      plateLandingAt: plateLandingOn({ grid, part: plate }, surface.mapAt),
      edgeAt: () => 200,
      plateGuardRows: plateGuardRowsFor(plate, {
        centerY: 0,
        cropW: 1000,
        cropH: 100,
      }),
      columnMapAt: (deg: number) =>
        turnColumnMap(grid, 0, 800 * RADIUS_FACTOR, deg, 0),
      // Vertex xs every 50 from -500 to 500: the plate (0, 200), the ramp
      // (300), the boundary (400) and two strands beyond it (450, 500).
      mesh: createPixelGridMesh(20, 2, 1000, 100),
      col: (x: number) => (x + 500) / 50,
    };
  };

  it("moves the outer strands by the hold edge's own displacement", () => {
    // A hold edge that NARROWS as the head turns — 400 at rest, 360 at full
    // turn — which is what a caller with a measured head width and a target
    // silhouette ratio passes. Its boundary stays at 400 throughout.
    const h = handPlate();
    const warp = bakeHairFrontSilhouetteWarp(
      h.mesh,
      0,
      0,
      0,
      h.plateLandingAt,
      h.edgeAt,
      400,
      (deg) => 400 - (40 * Math.abs(deg)) / 30,
      h.plateGuardRows,
    );
    const k = warp.keyforms.find((x) => x.value === 30)!;
    // The hold is direct: a vertex lands at its rest x plus its offset.
    const landing = (x: number) => x + k.offsets[h.col(x) * 2];
    // Continuity: the boundary lands ON the hold edge's destination, where the
    // ramp ends and the outer zone begins.
    expect(landing(400)).toBeCloseTo(360, 6);
    // Beyond it, the boundary's own 40px displacement — slope 1, so the rest
    // spacing survives.
    expect(landing(450)).toBeCloseTo(410, 6);
    expect(landing(500)).toBeCloseTo(460, 6);
    expect(landing(500) - landing(450)).toBeCloseTo(50, 6);
    expect(landing(-450)).toBeCloseTo(-410, 6);
    // The ramp, at the midpoint of the band: half way from the plate's painted
    // edge's RENDERED landing to the hold edge's. The hand plate's grid is
    // also the surface's lattice here, so the carrier's bilinear read at the
    // edge IS the map's own interpolation between the same two columns —
    // exact, where a generated rig's plate grid chords the dense lattice
    // (see "takes its hold edge from the plate's reach").
    const map = h.columnMapAt(30);
    expect(landing(300)).toBeCloseTo((map.mapX(200) + 360) / 2, 6);
    // On the plate: where the plate lands the point, nothing added — on the
    // axis column, nowhere at all.
    expect(k.offsets[h.col(0) * 2]).toBeCloseTo(0, 9);
    // The rest keyform is literal zeros, not the bend's residue at 0.
    for (const o of warp.keyforms.find((x) => x.value === 0)!.offsets) {
      expect(o).toBe(0);
    }
  });

  it("refuses a hold edge that only ONE guard row's painted edge reaches past", () => {
    // A rendered plate whose edge lands where the bare map puts it on every
    // guard row but one of the bangs' own rows, which bulges 250 px further
    // out than the hold edge sits: a guard that read only the face's own rows
    // — or only one row — would pass it, so the fold guard has to iterate
    // every row of `plateGuardRows`.
    const h = handPlate();
    const bulgeRow = h.plateGuardRows[h.plateGuardRows.length - 1];
    const bulging = (deg: number, x: number, y: number) =>
      deg !== 0 && y === bulgeRow
        ? x + Math.sign(x) * 250
        : h.columnMapAt(deg).mapX(x);
    expect(() =>
      bakeHairFrontSilhouetteWarp(
        h.mesh,
        0,
        0,
        0,
        bulging,
        h.edgeAt,
        400,
        () => 400,
        h.plateGuardRows,
      ),
    ).toThrow(
      /at -30° on the -x side the hold edge sits 400 from the face centre but the plate's edge maps to 450/,
    );
    // Without the bulge the same hold builds.
    expect(() =>
      bakeHairFrontSilhouetteWarp(
        h.mesh,
        0,
        0,
        0,
        h.plateLandingAt,
        h.edgeAt,
        400,
        () => 400,
        h.plateGuardRows,
      ),
    ).not.toThrow();
  });
});

describe("bakeHairSwayWarp", () => {
  const mesh = createPixelGridMesh(4, 4, 200, 400);

  it("pins the top row and swings the bottom row by tipShift at ±range", () => {
    const w = bakeHairSwayWarp(mesh, "sway", 36, 20);
    expect(w.keyforms.map((k) => k.value)).toEqual([-20, 20]);
    const [neg, pos] = w.keyforms;
    for (let v = 0; v < mesh.vertices.length / 2; v++) {
      const y = mesh.vertices[v * 2 + 1];
      if (y === 200) {
        expect(pos.offsets[v * 2]).toBe(0);
        expect(neg.offsets[v * 2]).toBe(0);
      }
      if (y === -200) {
        expect(pos.offsets[v * 2]).toBeCloseTo(36, 9);
        expect(neg.offsets[v * 2]).toBeCloseTo(-36, 9);
      }
      expect(pos.offsets[v * 2 + 1]).toBe(0);
    }
  });

  it("bends rather than hinges: the swing grows faster toward the ends", () => {
    const w = bakeHairSwayWarp(mesh, "sway", 36, 20);
    const pos = w.keyforms[1];
    const stride = 5;
    // Walk column 0 top to bottom: successive row-to-row increments grow.
    let prevInc = 0;
    for (let row = 1; row <= 4; row++) {
      const inc =
        pos.offsets[row * stride * 2] - pos.offsets[(row - 1) * stride * 2];
      expect(inc).toBeGreaterThan(prevInc);
      prevInc = inc;
    }
  });
});

describe("hair-sway physics", () => {
  const canvas = { width: 1000, height: 1000 };

  it("emits the turn and tilt hair rigs when a hair_front layer is present", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    expect(model.physics).toBeDefined();
    expect(model.physics).toHaveLength(2);
    const [sway, tilt] = model.physics!;
    expect(sway.input).toEqual({
      parameter: StandardParameter.AngleX,
      weight: 1,
    });
    expect(sway.output).toEqual({
      parameter: StandardParameter.HairSwayX,
      scale: -10,
    });
    expect(tilt.input).toEqual({
      parameter: StandardParameter.AngleZ,
      weight: 1,
    });
    expect(tilt.output).toEqual({
      parameter: StandardParameter.HairSwayZ,
      scale: -10,
    });
    for (const rig of [sway, tilt]) {
      expect(rig.mass).toBe(1);
      expect(rig.stiffness).toBe(80);
      expect(rig.damping).toBe(10);
    }
  });

  const swayWarpsOf = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    id: string,
  ) =>
    (model.parts.find((p) => p.id === id)!.warps ?? []).filter((w) =>
      [StandardParameter.HairSwayX, StandardParameter.HairSwayZ].includes(
        w.parameter as typeof StandardParameter.HairSwayX,
      ),
    );

  it("both hair parts swing on HairSwayX and HairSwayZ through root-pinned warps", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    for (const id of ["hair_front", "hair_back"]) {
      const warps = swayWarpsOf(model, id);
      expect(warps.map((w) => w.parameter).sort()).toEqual(
        [StandardParameter.HairSwayX, StandardParameter.HairSwayZ].sort(),
      );
      const part = model.parts.find((p) => p.id === id)!;
      const topY = Math.max(
        ...part.mesh!.vertices.filter((_, i) => i % 2 === 1),
      );
      for (const w of warps) {
        for (const k of w.keyforms) {
          for (let v = 0; v < part.mesh!.vertices.length / 2; v++) {
            // Roots stay put; nothing moves vertically.
            if (part.mesh!.vertices[v * 2 + 1] === topY) {
              expect(k.offsets[v * 2]).toBe(0);
            }
            expect(k.offsets[v * 2 + 1]).toBe(0);
          }
        }
      }
    }
    // No sway binding survives on either part.
    for (const id of ["hair_front", "hair_back"]) {
      const b = model.parts.find((p) => p.id === id)!.bindings ?? [];
      expect(
        b.some((x) =>
          [StandardParameter.HairSwayX, StandardParameter.HairSwayZ].includes(
            x.parameter as typeof StandardParameter.HairSwayX,
          ),
        ),
      ).toBe(false);
    }
  });

  it("the bangs carry both AngleX part warps — lead and silhouette hold — and the back hair none", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    const turnWarps = (id: string) =>
      (model.parts.find((p) => p.id === id)!.warps ?? []).filter(
        (w) => w.parameter === StandardParameter.AngleX,
      );
    // The back hair holds the head's outline through the turn, so it is the
    // one part with nothing on AngleX at all.
    expect(turnWarps("hair_back")).toHaveLength(0);
    // Two on the bangs, summed: the root-pinned lead across its two ends, and
    // the silhouette hold keyed on all five turn stops.
    expect(
      turnWarps("hair_front")
        .map((w) => w.keyforms.length)
        .sort((a, b) => a - b),
    ).toEqual([2, 5]);
    // Without front hair nothing carries a turn warp: the bangs are the only
    // part that ever had one.
    const bare = generateIkiFromLayerSet(assemblyLayers(), canvas);
    expect(
      (bare.parts.find((p) => p.id === "hair_back")!.warps ?? []).filter(
        (w) => w.parameter === StandardParameter.AngleX,
      ),
    ).toHaveLength(0);
  });

  it("the longer back hair swings further than the bangs, in pixels", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    const tip = (id: string) => {
      const w = swayWarpsOf(model, id).find(
        (x) => x.parameter === StandardParameter.HairSwayX,
      )!;
      const k = w.keyforms.find((x) => x.value > 0)!;
      return Math.max(...k.offsets.filter((_, i) => i % 2 === 0));
    };
    // Fixture heights: hair_front 400, hair_back 700 — same fraction of each.
    expect(tip("hair_front")).toBeCloseTo(0.09 * 400, 6);
    expect(tip("hair_back")).toBeCloseTo(0.09 * 700, 6);
  });

  it("declares the HairSwayX and HairSwayZ parameters when hair is present", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    for (const id of [
      StandardParameter.HairSwayX,
      StandardParameter.HairSwayZ,
    ]) {
      const param = model.parameters.find((p) => p.id === id);
      expect(param).toMatchObject({ min: -20, max: 20, default: 0 });
    }
  });

  it("emits NO physics / param / binding without a hair_front layer", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), canvas);
    expect(model.physics).toBeUndefined();
    const swayIds: string[] = [
      StandardParameter.HairSwayX,
      StandardParameter.HairSwayZ,
    ];
    expect(model.parameters.some((p) => swayIds.includes(p.id))).toBe(false);
    const anySway = model.parts.some(
      (part) =>
        (part.bindings ?? []).some((b) => swayIds.includes(b.parameter)) ||
        (part.warps ?? []).some((w) => swayIds.includes(w.parameter)),
    );
    expect(anySway).toBe(false);
  });
});

// ── Off-center fixture (faceCenterX = -100) ───────────────────────────────────
//
// Canvas 1000×1000. Face bbox x=250,y=100,w=300,h=400:
//   faceTransform = { x: 400-500=-100, y: 500-300=200 }
//   faceCenterX = -100  (non-zero — proves center-relative bake)
//   faceCropH = 400
//
// faceWarp children union (model space, tight then +12% margin):
//   face:   x∈[-250,50],   y∈[0,400]
//   eye_L:  x∈[-350,-250], y∈[220,300]
//   eye_R:  x∈[-200,-100], y∈[220,300]
//   mouth:  x∈[-250,-150], y∈[40,100]
//   tight:  minX=-350, maxX=50, minY=0, maxY=400
//   margin = 12% of span (400 x, 400 y) = 48
//   unionMinX=-398, unionMaxX=98, unionMinY=-48, unionMaxY=448
//
// Symmetric grid about faceCenterX=-100:
//   halfW = max(-100-(-398), 98-(-100)) = max(298, 198) = 298
//   faceGridMinX = -398,  faceGridMaxX = 198
function offCenterLayers(): LayerInput[] {
  return [
    {
      role: "face",
      fileName: "face.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 250, y: 100, w: 300, h: 400 },
      cropW: 300,
      cropH: 400,
    },
    {
      role: "eye_L",
      fileName: "eye_L.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 150, y: 200, w: 100, h: 80 },
      cropW: 100,
      cropH: 80,
    },
    {
      role: "eye_R",
      fileName: "eye_R.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 300, y: 200, w: 100, h: 80 },
      cropW: 100,
      cropH: 80,
    },
    {
      role: "mouth",
      fileName: "mouth.png",
      canvasW: 1000,
      canvasH: 1000,
      bbox: { x: 250, y: 400, w: 100, h: 60 },
      cropW: 100,
      cropH: 60,
    },
  ];
}

// ── describe("warp") ─────────────────────────────────────────────────────────

describe("warp", () => {
  it("faceWarp — the plate's grid — is FACE_PLATE_CELLS per axis", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const faceWarpDef = model.deformers?.find((d) => d.id === "faceWarp");
    const grid = (
      faceWarpDef as { grid: { cols: number; rows: number; points: number[] } }
    ).grid;
    expect(grid.cols).toBe(10);
    expect(grid.rows).toBe(10);
    expect(grid.points).toHaveLength(2 * 121); // (10+1) * (10+1) points
  });

  it("faceWarp grid is the face crop plus 12 % of its span and a pixel, per axis", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const faceWarpDef = model.deformers?.find((d) => d.id === "faceWarp");
    expect(faceWarpDef).toBeDefined();
    const grid = (
      faceWarpDef as { grid: { cols: number; rows: number; points: number[] } }
    ).grid;

    // Read grid min/max from the actual grid points (row 0 is top = maxY; last row is bottom = minY)
    const stride = grid.cols + 1;
    const pointCount = stride * (grid.rows + 1);
    let gridMinX = Infinity,
      gridMaxX = -Infinity;
    let gridMinY = Infinity,
      gridMaxY = -Infinity;
    for (let i = 0; i < pointCount; i++) {
      const x = grid.points[i * 2];
      const y = grid.points[i * 2 + 1];
      if (x < gridMinX) gridMinX = x;
      if (x > gridMaxX) gridMaxX = x;
      if (y < gridMinY) gridMinY = y;
      if (y > gridMaxY) gridMaxY = y;
    }

    // The plate is the grid's only member and carries no binding, no part
    // warp and no turn shift, so its grid is exactly the crop with the
    // margin: the face bbox x=250,y=100,w=300,h=400 → x∈[-250,50], y∈[0,400],
    // grown by 12 % of 300 + 1 = 37 on x and 12 % of 400 + 1 = 49 on y. The
    // features ride grids of their own (see "turn groups").
    expect(gridMinX).toBeCloseTo(-250 - 37, 9);
    expect(gridMaxX).toBeCloseTo(50 + 37, 9);
    expect(gridMinY).toBeCloseTo(0 - 49, 9);
    expect(gridMaxY).toBeCloseTo(400 + 49, 9);
  });

  it("faceWarp grid is symmetric about faceCenterX", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const faceWarpDef = model.deformers?.find((d) => d.id === "faceWarp");
    const grid = (
      faceWarpDef as { grid: { cols: number; rows: number; points: number[] } }
    ).grid;

    // faceCenterX = -100 for offCenterLayers
    const faceCenterX = -100;
    const gridMinX = grid.points[0]; // col 0, row 0
    const gridMaxX = grid.points[grid.cols * 2]; // col cols, row 0

    expect(gridMaxX - faceCenterX).toBeCloseTo(faceCenterX - gridMinX, 10);
  });

  it("headDeformer pivot.x === faceCenterX and pivot.y < faceBottom", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const headDef = model.deformers?.find((d) => d.id === "headDeformer") as
      | { pivot: { x: number; y: number } }
      | undefined;
    expect(headDef).toBeDefined();

    // faceCenterX = -100;  faceBottom = faceTransform.y - faceCropH/2 = 200 - 200 = 0
    const faceCenterX = -100;
    const faceBottom = 0; // 200 - 400/2

    expect(headDef!.pivot.x).toBe(faceCenterX);
    expect(headDef!.pivot.y).toBeLessThan(faceBottom);
  });

  it("faceWarp.warp2d's rest cell (AngleX=0, AngleY=0) has all-zero offsets", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const faceWarpDef = model.deformers?.find((d) => d.id === "faceWarp") as
      | {
          warps?: unknown;
          warp2d?: {
            valuesX: number[];
            valuesY: number[];
            keyforms2d: { offsets: number[] }[];
          };
        }
      | undefined;
    expect(faceWarpDef?.warps).toBeUndefined();
    const warp = faceWarpDef!.warp2d!;
    const i = warp.valuesX.indexOf(0);
    const j = warp.valuesY.indexOf(0);
    const rest = warp.keyforms2d[j * warp.valuesX.length + i];
    for (const offset of rest.offsets) {
      expect(offset).toBeCloseTo(0, 10);
    }
  });

  it("off-center bake: nonzero-angle keyform dx matches center-relative formula", () => {
    // Grid: cols=4, rows=4, faceGridMinX=-398, faceGridMaxX=198, y range -48..448
    const faceGridMinX = -398;
    const faceGridMaxX = 198;
    const unionMinY = -48;
    const unionMaxY = 448;
    const grid = {
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
    const faceCenterX = -100;
    const halfWidth = (grid.points[grid.cols * 2] - grid.points[0]) / 2; // (198-(-398))/2 = 298
    const RADIUS = halfWidth * RADIUS_FACTOR; // 357.6

    const warp = bakeHeadTurnGridWarpCentered(
      grid,
      "ParamAngleX",
      faceCenterX,
      RADIUS,
    );
    const kf30 = warp.keyforms.find((k) => k.value === 30)!;

    // Point i=0: x = faceGridMinX = -398
    const x = grid.points[0]; // -398
    const theta = 30 * (Math.PI / 180);
    const localX = x - faceCenterX; // -298
    const alpha = Math.asin(Math.max(-1, Math.min(1, localX / RADIUS)));
    const xPrime = faceCenterX + RADIUS * Math.sin(alpha + theta);
    // The axis column's own displacement is subtracted from every point.
    const axisShift = RADIUS * Math.sin(theta);
    const expectedDx = xPrime - x - axisShift;

    expect(kf30.offsets[0]).toBeCloseTo(expectedDx, 8);

    // Verify this DIFFERS from the old absolute-x bake (would fail the test
    // if someone reverts to the non-center-relative formula).
    const alphaAbsolute = Math.asin(Math.max(-1, Math.min(1, x / RADIUS)));
    const xPrimeAbsolute = RADIUS * Math.sin(alphaAbsolute + theta);
    const oldDx = xPrimeAbsolute - x;
    expect(kf30.offsets[0]).not.toBeCloseTo(oldDx, 3);
  });

  // A cylinder rotation slides its whole visible surface sideways as well as
  // foreshortening it. That bulk slide is what pushed the head off the
  // shoulders, so the bake subtracts it; these two lock the property in.
  it("the cylinder axis column does not move at any keyform", () => {
    const grid = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -200, 200, -100, 300),
    };
    const warp = bakeHeadTurnGridWarpCentered(
      grid,
      "ParamAngleX",
      0,
      200 * RADIUS_FACTOR,
    );
    for (const kf of warp.keyforms) {
      for (let i = 0; i < grid.points.length / 2; i++) {
        if (Math.abs(grid.points[i * 2] - 0) < 1e-9) {
          expect(kf.offsets[i * 2], `value=${kf.value} point ${i}`).toBeCloseTo(
            0,
            8,
          );
        }
      }
    }
  });

  it("no keyform folds the grid: warped x stays strictly increasing", () => {
    const grid = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -200, 200, -100, 300),
    };
    const warp = bakeHeadTurnGridWarpCentered(
      grid,
      "ParamAngleX",
      0,
      200 * RADIUS_FACTOR,
    );
    const cols = grid.cols + 1;
    for (const kf of warp.keyforms) {
      let previous = -Infinity;
      for (let c = 0; c < cols; c++) {
        const warped = grid.points[c * 2] + kf.offsets[c * 2];
        expect(warped, `value=${kf.value} column ${c}`).toBeGreaterThan(
          previous,
        );
        previous = warped;
      }
    }
  });

  it("face part transform.x is preserved (source placement unshifted)", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const facePart = model.parts.find((p) => p.id === "face");
    // faceCenterX = -100 (bboxToTransform of face layer)
    expect(facePart?.transform.x).toBe(-100);
  });

  it("parseIkiModel passes on the off-center fixture model", () => {
    const canvas = { width: 1000, height: 1000 };
    expect(() =>
      generateIkiFromLayerSet(offCenterLayers(), canvas),
    ).not.toThrow();
  });
});

// ── describe("turn groups") ──────────────────────────────────────────────────

/** assemblyLayers() with a nose, a NARROWER back hair and no bangs: the face
 *  is the widest layer, so the lattice's reach is the plate's own grid plus
 *  the eye family's shift — nothing wider stands in for it. */
function faceWidestLayers(): LayerInput[] {
  return [
    ...assemblyLayers().map((l) =>
      l.role === "hair_back"
        ? { ...l, bbox: { x: 300, y: 50, w: 400, h: 700 }, cropW: 400 }
        : l,
    ),
    noseLayer(),
  ];
}

describe("turn groups", () => {
  /** The three layer sets the group assembly is checked on, each with its
   *  canvas. */
  const fixtures = (): [
    string,
    LayerInput[],
    { width: number; height: number },
  ][] => [
    ["fullFaceLayers", fullFaceLayers(), canvas1000],
    ["heroLikeLayers", heroLikeLayers(), { width: 1100, height: 1100 }],
    ["faceWidestLayers", faceWidestLayers(), canvas1000],
  ];

  /** Mirror of the generator's shift bound for a role's turn family: the
   *  depth solver's own cap in px — the family's landmarks' far edge to the
   *  plate's far edge — when there is a nose to solve against, else 0; the
   *  brows and the blush ride with the eyes, the plate has none. */
  const shiftBoundOf = (layers: LayerInput[], role: string) => {
    if (role === "face" || !layers.some((l) => l.role === "nose")) return 0;
    const family = role.replace(/_[LR]$/, "");
    const marks =
      family === "nose"
        ? ["nose"]
        : family === "mouth" || family === "mouth_open"
          ? ["mouth"]
          : ["eye_L", "eye_R"];
    const [face, ...parts] = ["face", ...marks].map((r) => {
      const l = layers.find((x) => x.role === r)!;
      return {
        x: bboxToTransform(l.bbox, l.canvasW, l.canvasH, r).x,
        w: l.cropW,
      };
    });
    const farEdge = Math.min(...parts.map((p) => p.x - p.w / 2));
    return Math.max(0, farEdge - (face.x - face.w / 2));
  };

  /** A grid's bounding box off its points. */
  const boxOf = (grid: { cols: number; rows: number; points: number[] }) => {
    const xs = grid.points.filter((_, i) => i % 2 === 0);
    const ys = grid.points.filter((_, i) => i % 2 === 1);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  };

  it("emits one warp deformer per group with a member layer, under the head, clear of every part id, and each member rides it", () => {
    for (const [label, layers, canvas] of fixtures()) {
      const model = generateIkiFromLayerSet(layers, canvas);
      const expected = new Set(
        layers
          .map((l) => ROLE_TABLE[l.role].deformer)
          .filter((d) => isTurnGroup(d)),
      );
      const warps = model.deformers!.filter((d) => d.kind === "warp");
      expect(new Set(warps.map((d) => d.id)), label).toEqual(expected);
      const partIds = new Set(model.parts.map((p) => p.id));
      for (const d of warps) {
        expect(d.parent, `${label} ${d.id}`).toBe("headDeformer");
        expect(partIds.has(d.id), `${label} ${d.id}`).toBe(false);
      }
      for (const part of model.parts) {
        const spec = ROLE_TABLE[part.id];
        if (isTurnGroup(spec.deformer)) {
          expect(part.deformer, `${label} ${part.id}`).toBe(spec.deformer);
        }
      }
    }
    // A fixture without brows or blush ships neither group; one with brows
    // but no blush ships the brows' alone.
    const bare = generateIkiFromLayerSet(
      [...hairFrontLayers(), noseLayer()],
      canvas1000,
    );
    expect(
      bare.deformers!.filter((d) => /^(browWarp|blushWarp)_/.test(d.id)),
    ).toHaveLength(0);
    const browed = generateIkiFromLayerSet(fullFaceLayers(), canvas1000);
    expect(
      browed.deformers!.filter((d) => d.id.startsWith("blushWarp_")),
    ).toHaveLength(0);
    expect(
      browed
        .deformers!.filter((d) => d.id.startsWith("browWarp_"))
        .map((d) => d.id),
    ).toEqual(expect.arrayContaining(["browWarp_L", "browWarp_R"]));
  });

  it("every group's rest cell is all zeros, and every node plus its family's shift sits strictly inside the lattice", () => {
    for (const [label, layers, canvas] of fixtures()) {
      const model = generateIkiFromLayerSet(layers, canvas);
      const lattice = latticeOf(layers);
      const latticeMinX = lattice.points[0];
      const latticeMaxX = lattice.points[lattice.cols * 2];
      for (const d of model.deformers!) {
        if (d.kind !== "warp") continue;
        const rest = cell(d.warp2d!, 0, 0);
        for (const o of rest.offsets) expect(o, `${label} ${d.id}`).toBe(0);
        const member = model.parts.find((p) => p.deformer === d.id)!;
        const bound = shiftBoundOf(layers, member.id);
        for (let n = 0; n < d.grid.points.length / 2; n++) {
          const x = d.grid.points[n * 2];
          // The node reads the map at x ± its family's largest shift; both
          // must be inside the lattice or `mapX` would pin them to its edge
          // column and deform the node at rest.
          expect(x - bound, `${label} ${d.id} node ${n}`).toBeGreaterThan(
            latticeMinX,
          );
          expect(x + bound, `${label} ${d.id} node ${n}`).toBeLessThan(
            latticeMaxX,
          );
        }
      }
    }
  });

  it("no part carries an AngleX binding; bodyDeformer's follow is the model's only one", () => {
    const withBody = [
      [heroLikeLayers(), { width: 1100, height: 1100 }],
      [
        [...fullFaceLayers(), bodyLayers().find((l) => l.role === "body")!],
        canvas1000,
      ],
    ] as const;
    for (const [layers, canvas] of withBody) {
      const model = generateIkiFromLayerSet(layers, canvas);
      for (const part of model.parts) {
        expect(
          (part.bindings ?? []).filter(
            (b) => b.parameter === StandardParameter.AngleX,
          ),
          part.id,
        ).toHaveLength(0);
      }
      const turnBindings = model.deformers!.flatMap((d) =>
        d.kind === "warp"
          ? []
          : d.bindings
              .filter((b) => b.parameter === StandardParameter.AngleX)
              .map(() => d.id),
      );
      expect(turnBindings).toEqual(["bodyDeformer"]);
    }
  });

  it("every binding at its extreme, on a full turn and nod, keeps every member's pre-bind vertices strictly inside its group's rest grid", () => {
    const cases: [string, LayerInput[], { width: number; height: number }][] = [
      ["fullFaceLayers", fullFaceLayers(), canvas1000],
      [
        "fullFaceLayers without mouth_open",
        fullFaceLayers().filter((l) => l.role !== "mouth_open"),
        canvas1000,
      ],
      ["heroLikeLayers", heroLikeLayers(), { width: 1100, height: 1100 }],
    ];
    // Every geometric binding driven to an end of its range — the mouth's
    // form and opening (scaleY 4 without an open drawing), the gaze, both
    // brows' raise and tilt, the blink's fold — with the head at a full turn
    // and a full nod either way: 2^7 poses.
    const ends = [-1, 1];
    for (const [label, layers, canvas] of cases) {
      const model = generateIkiFromLayerSet(layers, canvas);
      const boxes = new Map(
        model.deformers!.flatMap((d) =>
          d.kind === "warp" ? [[d.id, boxOf(d.grid)] as const] : [],
        ),
      );
      for (const form of ends)
        for (const gazeX of ends)
          for (const gazeY of ends)
            for (const browY of ends)
              for (const browAngle of ends)
                for (const angleX of [-30, 30])
                  for (const angleY of [-30, 30]) {
                    const params: ParamValues = {
                      [StandardParameter.MouthForm]: form,
                      [StandardParameter.MouthOpen]: 1,
                      [StandardParameter.EyeballX]: gazeX,
                      [StandardParameter.EyeballY]: gazeY,
                      [StandardParameter.BrowLeftY]: browY,
                      [StandardParameter.BrowRightY]: browY,
                      [StandardParameter.BrowLeftAngle]: browAngle,
                      [StandardParameter.BrowRightAngle]: browAngle,
                      [StandardParameter.EyeOpenLeft]: 0,
                      [StandardParameter.EyeOpenRight]: 0,
                      [StandardParameter.AngleX]: angleX,
                      [StandardParameter.AngleY]: angleY,
                    };
                    for (const part of model.parts) {
                      const box = boxes.get(part.deformer!);
                      if (box === undefined) continue;
                      const v = preBindVertices(model, part.id, params);
                      for (let i = 0; i < v.length; i += 2) {
                        const at = `${label} ${part.id} ${JSON.stringify(params)}`;
                        expect(v[i], at).toBeGreaterThan(box.minX);
                        expect(v[i], at).toBeLessThan(box.maxX);
                        expect(v[i + 1], at).toBeGreaterThan(box.minY);
                        expect(v[i + 1], at).toBeLessThan(box.maxY);
                      }
                    }
                  }
    }
  });

  it("no group's deformed grid folds at any stop or between them: rows keep x ascending, columns keep y descending", () => {
    for (const [label, layers, canvas] of fixtures()) {
      const model = generateIkiFromLayerSet(layers, canvas);
      for (const d of model.deformers!) {
        if (d.kind !== "warp") continue;
        const stride = d.grid.cols + 1;
        for (const angleX of [-30, -22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30]) {
          for (const angleY of [-30, -22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30]) {
            const g = deformedGrid(model, d.id, {
              [StandardParameter.AngleX]: angleX,
              [StandardParameter.AngleY]: angleY,
            });
            const at = `${label} ${d.id} (${angleX}, ${angleY})`;
            for (let r = 0; r <= d.grid.rows; r++) {
              for (let c = 1; c <= d.grid.cols; c++) {
                expect(g.points[(r * stride + c) * 2], at).toBeGreaterThan(
                  g.points[(r * stride + c - 1) * 2],
                );
              }
            }
            for (let c = 0; c <= d.grid.cols; c++) {
              for (let r = 1; r <= d.grid.rows; r++) {
                expect(g.points[(r * stride + c) * 2 + 1], at).toBeLessThan(
                  g.points[((r - 1) * stride + c) * 2 + 1],
                );
              }
            }
          }
        }
      }
    }
  });
});

// ── describe("bindings") ─────────────────────────────────────────────────────

describe("bindings", () => {
  it("eye_L white has no bindings and a fold warp on EyeOpenLeft", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const eyeL = model.parts.find((p) => p.id === "eye_L");
    // Blink is a fold WARP, not a binding; the white also has no gaze. (No
    // nose layer here, so no depth parallax either — see its own describe.)
    expect(eyeL?.bindings).toBeUndefined();
    expect(eyeL!.warps!.length).toBe(1);
    expect(eyeL!.warps![0].parameter).toBe(StandardParameter.EyeOpenLeft);
    // open (value 1) = rest (all-zero offsets); closed (value 0) folds.
    const open = eyeL!.warps![0].keyforms.find((k) => k.value === 1);
    expect(open!.offsets.every((o) => o === 0)).toBe(true);
    const closed = eyeL!.warps![0].keyforms.find((k) => k.value === 0);
    expect(closed!.offsets.some((o) => o !== 0)).toBe(true);
  });

  it("eye_R white has a fold warp on EyeOpenRight", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const eyeR = model.parts.find((p) => p.id === "eye_R");
    expect(eyeR?.bindings).toBeUndefined();
    expect(eyeR!.warps![0].parameter).toBe(StandardParameter.EyeOpenRight);
  });

  it("iris_L has gaze only (no blink), stays round, and clips to eye_L", () => {
    const IRIS_CROP_W = 80;
    const IRIS_CROP_H = 80;
    const gx = Math.min(IRIS_CROP_W * 0.18, 22);
    const gy = Math.min(IRIS_CROP_H * 0.18, 16);
    const layers: LayerInput[] = [
      ...assemblyLayers(),
      {
        role: "iris_L",
        fileName: "iris_L.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 310, y: 310, w: IRIS_CROP_W, h: IRIS_CROP_H },
        cropW: IRIS_CROP_W,
        cropH: IRIS_CROP_H,
      },
    ];
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(layers, canvas);
    const irisL = model.parts.find((p) => p.id === "iris_L");
    // gaze only — the iris no longer blinks; it is clipped + cut by the white.
    expect(irisL!.bindings!.length).toBe(2);
    expect(irisL!.bindings!.some((b) => b.channel === "scaleY")).toBe(false);
    // it does NOT fold (stays round), and clips to the eye-white.
    expect(irisL!.warps).toBeUndefined();
    expect(irisL!.clip).toEqual({ masks: ["eye_L"] });
    const gazeX = irisL!.bindings!.find(
      (b) =>
        b.parameter === StandardParameter.EyeballX &&
        b.channel === "translateX",
    );
    expect(gazeX!.from).toBe(-gx);
    expect(gazeX!.to).toBe(gx);
    const gazeY = irisL!.bindings!.find(
      (b) =>
        b.parameter === StandardParameter.EyeballY &&
        b.channel === "translateY",
    );
    expect(gazeY!.from).toBe(-gy);
    expect(gazeY!.to).toBe(gy);
  });

  it("mouth part has MouthOpen scaleY (to:3) + MouthForm scaleX", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const mouthPart = model.parts.find((p) => p.id === "mouth");
    expect(mouthPart?.bindings).toBeDefined();
    const mouthOpen = mouthPart!.bindings!.find(
      (b) => b.parameter === StandardParameter.MouthOpen,
    );
    expect(mouthOpen?.channel).toBe("scaleY");
    expect(mouthOpen?.to).toBe(3);
    const mouthForm = mouthPart!.bindings!.find(
      (b) => b.parameter === StandardParameter.MouthForm,
    );
    expect(mouthForm?.channel).toBe("scaleX");
  });

  it("face part has no bindings key", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const facePart = model.parts.find((p) => p.id === "face");
    expect(facePart?.bindings).toBeUndefined();
  });

  it("bindingsForRole: face spec returns empty array", () => {
    const spec = ROLE_TABLE["face"];
    expect(bindingsForRole(spec, "face", 300, 400)).toHaveLength(0);
  });

  it("bindingsForRole: hair_back without a parallaxUnit returns empty array", () => {
    const spec = ROLE_TABLE["hair_back"];
    expect(bindingsForRole(spec, "hair_back", 800, 700)).toHaveLength(0);
  });

  it("bindingsForRole: hair_front without a parallaxUnit returns no bindings", () => {
    // Its sway is a root-pinned warp, not a binding: a rotate binding would
    // pivot the bangs about their centre and lift the roots off the hairline.
    const spec = ROLE_TABLE["hair_front"];
    expect(bindingsForRole(spec, "hair_front", 700, 400)).toHaveLength(0);
  });

  it("bindingsForRole: brow_L returns 2 bindings with left params, raw-symmetric", () => {
    const spec = ROLE_TABLE["brow_L"];
    const bindings = bindingsForRole(spec, "brow_L", 120, 40);

    expect(bindings).toHaveLength(2);

    const tyBinding = bindings.find(
      (b) => b.parameter === StandardParameter.BrowLeftY,
    );
    expect(tyBinding).toBeDefined();
    expect(tyBinding!.channel).toBe("translateY");
    // from === -to (symmetric)
    expect(tyBinding!.from).toBe(-tyBinding!.to);

    const rotBinding = bindings.find(
      (b) => b.parameter === StandardParameter.BrowLeftAngle,
    );
    expect(rotBinding).toBeDefined();
    expect(rotBinding!.channel).toBe("rotate");
    expect(rotBinding!.from).toBe(-12);
    expect(rotBinding!.to).toBe(12);
  });

  it("bindingsForRole: brow_R returns 2 bindings with right params, same raw-symmetric signs as brow_L", () => {
    const spec = ROLE_TABLE["brow_R"];
    const bindings = bindingsForRole(spec, "brow_R", 120, 40);

    expect(bindings).toHaveLength(2);

    // Must not contain any left-side params
    const hasLeftParam = bindings.some(
      (b) =>
        b.parameter === StandardParameter.BrowLeftY ||
        b.parameter === StandardParameter.BrowLeftAngle,
    );
    expect(hasLeftParam).toBe(false);

    const tyBinding = bindings.find(
      (b) => b.parameter === StandardParameter.BrowRightY,
    );
    expect(tyBinding).toBeDefined();
    expect(tyBinding!.channel).toBe("translateY");
    expect(tyBinding!.from).toBe(-tyBinding!.to);

    // Raw-symmetric: NOT inverted — same from/to signs as brow_L
    const rotBinding = bindings.find(
      (b) => b.parameter === StandardParameter.BrowRightAngle,
    );
    expect(rotBinding).toBeDefined();
    expect(rotBinding!.channel).toBe("rotate");
    expect(rotBinding!.from).toBe(-12);
    expect(rotBinding!.to).toBe(12);
  });

  it("generateIkiFromLayerSet declares all 4 brow param ids even without brow layers", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    const paramIds = new Set(model.parameters.map((p) => p.id));
    expect(paramIds.has(StandardParameter.BrowLeftY)).toBe(true);
    expect(paramIds.has(StandardParameter.BrowRightY)).toBe(true);
    expect(paramIds.has(StandardParameter.BrowLeftAngle)).toBe(true);
    expect(paramIds.has(StandardParameter.BrowRightAngle)).toBe(true);
  });
});

// ── describe("eyelid fold") ──────────────────────────────────────────────────

describe("eyelid fold", () => {
  it("closes the sclera clip completely when that eye has a separate lash", () => {
    const model = generateIkiFromLayerSet(
      [
        ...assemblyLayers(),
        {
          role: "lash_L",
          fileName: "lash_L.png",
          canvasW: 1000,
          canvasH: 1000,
          bbox: { x: 300, y: 290, w: 160, h: 40 },
          cropW: 160,
          cropH: 40,
        },
      ],
      { width: 1000, height: 1000 },
    );
    const closedHeight = (id: string) => {
      const part = model.parts.find((p) => p.id === id)!;
      const closed = part.warps![0].keyforms.find((k) => k.value === 0)!;
      const ys = part
        .mesh!.vertices.map((v, i) => v + closed.offsets[i])
        .filter((_, i) => i % 2 === 1);
      return Math.max(...ys) - Math.min(...ys);
    };
    // A nonzero clip leaves a visible stripe of iris beneath the closed lash.
    expect(closedHeight("eye_L")).toBeCloseTo(0, 10);
    expect(closedHeight("lash_L")).toBeGreaterThan(0);
    // An eye without separate lashes keeps its authored closed-eye line.
    expect(closedHeight("eye_R")).toBeGreaterThan(0);
  });

  it("bakeEyelidFoldWarp: 2 keyforms, open=rest-zeros, closed=non-zero", () => {
    const mesh = createPixelGridMesh(4, 4, 120, 80);
    const w = bakeEyelidFoldWarp(mesh, StandardParameter.EyeOpenLeft, -12, 0.1);
    expect(w.parameter).toBe(StandardParameter.EyeOpenLeft);
    expect(w.keyforms.map((k) => k.value)).toEqual([0, 1]);
    const open = w.keyforms.find((k) => k.value === 1)!;
    const closed = w.keyforms.find((k) => k.value === 0)!;
    // offsets are flat [dx,dy,...] matching the mesh vertices (dx always 0).
    expect(open.offsets.length).toBe(mesh.vertices.length);
    expect(open.offsets.every((o) => o === 0)).toBe(true);
    expect(closed.offsets.some((o) => o !== 0)).toBe(true);
    expect(closed.offsets.every((o, i) => i % 2 === 1 || o === 0)).toBe(true);
  });

  it("a layer set with iris passes the parseIkiModel gate (clip + fold valid)", () => {
    const layers: LayerInput[] = [
      ...assemblyLayers(),
      {
        role: "iris_L",
        fileName: "iris_L.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 310, y: 310, w: 70, h: 70 },
        cropW: 70,
        cropH: 70,
      },
      {
        role: "iris_R",
        fileName: "iris_R.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 560, y: 310, w: 70, h: 70 },
        cropW: 70,
        cropH: 70,
      },
    ];
    expect(() =>
      generateIkiFromLayerSet(layers, { width: 1000, height: 1000 }),
    ).not.toThrow();
  });

  it("lash_L folds (warp on EyeOpen, no clip/bindings) above the iris", () => {
    const layers: LayerInput[] = [
      ...assemblyLayers(),
      {
        role: "iris_L",
        fileName: "iris_L.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 310, y: 320, w: 70, h: 70 },
        cropW: 70,
        cropH: 70,
      },
      {
        role: "lash_L",
        fileName: "lash_L.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 300, y: 290, w: 160, h: 40 },
        cropW: 160,
        cropH: 40,
      },
    ];
    const model = generateIkiFromLayerSet(layers, {
      width: 1000,
      height: 1000,
    });
    const lashL = model.parts.find((p) => p.id === "lash_L")!;
    const irisL = model.parts.find((p) => p.id === "iris_L")!;
    // lash folds, does not gaze or clip, and draws above the iris.
    expect(lashL.bindings).toBeUndefined();
    expect(lashL.clip).toBeUndefined();
    expect(lashL.warps![0].parameter).toBe(StandardParameter.EyeOpenLeft);
    expect(
      lashL.warps![0].keyforms.find((k) => k.value === 0)!.offsets,
    ).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(lashL.order).toBeGreaterThan(irisL.order);
  });
});

describe("meshCellsFor", () => {
  it("clamps to [4,8] per axis, rounds by MESH_CELL_PX, and is monotone", () => {
    expect(meshCellsFor(130, 75)).toEqual({ cols: 4, rows: 4 }); // floors to the minimum
    expect(meshCellsFor(402, 452)).toEqual({ cols: 6, rows: 7 }); // the hero's face
    expect(meshCellsFor(802, 933)).toEqual({ cols: 8, rows: 8 }); // caps at the ceiling
    expect(meshCellsFor(1000, 1)).toEqual({ cols: 8, rows: 4 }); // axes size independently

    const widths = [50, 130, 300, 402, 600, 802, 1200];
    let prevCols = -Infinity;
    for (const w of widths) {
      const { cols } = meshCellsFor(w, 452);
      expect(cols).toBeGreaterThanOrEqual(prevCols);
      prevCols = cols;
    }
    const heights = [50, 130, 300, 452, 600, 933, 1200];
    let prevRows = -Infinity;
    for (const h of heights) {
      const { rows } = meshCellsFor(402, h);
      expect(rows).toBeGreaterThanOrEqual(prevRows);
      prevRows = rows;
    }
  });
});

describe("per-vertex bakes generalize to any grid (not just 4×4/stride-5)", () => {
  it("bakeEyelidFoldWarp / bakeHairSwayWarp / bakeHairFrontSilhouetteWarp / bakeNodWarp all work on an odd-cols mesh", () => {
    // Odd cols/rows deliberately: none of these bakes may assume a stride.
    const mesh = createPixelGridMesh(7, 9, 300, 500);
    const tipShift = 36;

    const fold = bakeEyelidFoldWarp(mesh, "p", -12, 0);
    const sway = bakeHairSwayWarp(mesh, "p", tipShift, 20);
    // Odd face-grid columns too: the silhouette hold reads the plate through
    // the grid, so it must not assume a column on the cylinder's axis.
    const grid = {
      cols: 5,
      rows: 5,
      points: generateGridPoints(5, 5, -260, 260, -300, 300),
    };
    // Travel 0: hand-built grid, no rig behind it — the bend alone; a plate
    // 100 px half-wide about the axis, rendered on that surface.
    const nodRadius = 300 * RADIUS_FACTOR;
    const surface = turnSurface({
      faceCenterX: 0,
      faceCenterY: 0,
      radius: 260 * RADIUS_FACTOR,
      travel: 0,
      nodRadius,
      lattice: grid,
    });
    const plate = facePlate(0, 0, 100, 200);
    const plateLandingAt = plateLandingOn({ grid, part: plate }, surface.mapAt);
    const edgeAt = () => 100;
    const rows = plateGuardRowsFor(plate, {
      centerY: 0,
      cropW: 300,
      cropH: 500,
    });
    const holdBase = plateReach(plateLandingAt, 0, edgeAt, rows) + 1;
    const hold = bakeHairFrontSilhouetteWarp(
      mesh,
      0,
      0,
      0,
      plateLandingAt,
      edgeAt,
      holdBase,
      () => holdBase,
      rows,
    );
    // A part resting 40 px above the nod axis, with a 12 px nod slide of its
    // own.
    const partY = 40;
    const nodTravel = 12;
    const nod = bakeNodWarp(mesh, partY, surface, nodTravel);
    for (const k of [
      ...fold.keyforms,
      ...sway.keyforms,
      ...hold.keyforms,
      ...nod.keyforms,
    ]) {
      expect(k.offsets).toHaveLength(mesh.vertices.length);
    }

    // Sway: root row pinned, tip row swings by exactly tipShift.
    const swayPlus = sway.keyforms.find((k) => k.value === 20)!;
    const swayMinus = sway.keyforms.find((k) => k.value === -20)!;
    const top = Math.max(...mesh.vertices.filter((_, i) => i % 2 === 1));
    const bottom = Math.min(...mesh.vertices.filter((_, i) => i % 2 === 1));
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      const vy = mesh.vertices[i + 1];
      if (vy === top) {
        expect(swayPlus.offsets[i]).toBeCloseTo(0, 10);
        expect(swayMinus.offsets[i]).toBeCloseTo(0, 10);
      }
      if (vy === bottom) {
        expect(swayPlus.offsets[i]).toBeCloseTo(tipShift, 10);
        expect(swayMinus.offsets[i]).toBeCloseTo(-tipShift, 10);
      }
      expect(swayPlus.offsets[i + 1]).toBe(0);
    }

    const stride = 8; // 7 cols → 8 vertex columns

    // Hold: rest keyform all-zero, and every row still lands in x-order — the
    // hold is direct, so a vertex lands at its rest x plus its offset.
    const holdRest = hold.keyforms.find((k) => k.value === 0)!;
    for (const o of holdRest.offsets) expect(o).toBe(0);
    for (const k of hold.keyforms) {
      for (let row = 0; row * stride < mesh.vertices.length / 2; row++) {
        let prev = -Infinity;
        for (let col = 0; col < stride; col++) {
          const v = row * stride + col;
          const x = mesh.vertices[v * 2] + k.offsets[v * 2];
          expect(x).toBeGreaterThan(prev);
          prev = x;
        }
      }
    }

    // Fold with k=0: every vertex's closed y collapses onto the crease line.
    const closed = fold.keyforms.find((k) => k.value === 0)!;
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      const closedY = mesh.vertices[i + 1] + closed.offsets[i + 1];
      expect(closedY).toBeCloseTo(-12, 9);
    }

    // Nod: AngleY on the turn stops, a literal-zero rest keyform, dx 0
    // everywhere, and at +30 every vertex carries its slide `t` plus the
    // surface's pinned bend WHERE THE SLIDE PUT IT — `y + t` — on the nod
    // radius, at NOD_BEND (0.5) of the angle.
    expect(nod.parameter).toBe(StandardParameter.AngleY);
    expect(nod.keyforms.map((k) => k.value)).toEqual([-30, -15, 0, 15, 30]);
    for (const o of nod.keyforms.find((k) => k.value === 0)!.offsets) {
      expect(o).toBe(0);
    }
    const up = nod.keyforms.find((k) => k.value === 30)!;
    const theta = (30 * 0.5 * Math.PI) / 180;
    const pinnedBend = (local: number) =>
      nodRadius * Math.sin(Math.asin(local / nodRadius) + theta) -
      local -
      nodRadius * Math.sin(theta);
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      expect(up.offsets[i]).toBe(0);
      expect(up.offsets[i + 1]).toBeCloseTo(
        nodTravel + pinnedBend(partY + mesh.vertices[i + 1] + nodTravel),
        9,
      );
    }
  });
});

describe("assembly", () => {
  it("does not throw (parseIkiModel gate passes)", () => {
    expect(() =>
      generateIkiFromLayerSet(assemblyLayers(), { width: 1000, height: 1000 }),
    ).not.toThrow();
  });

  it("produces one part per input layer", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    expect(model.parts.length).toBe(assemblyLayers().length);
  });

  it("mesh parts have width===1 and height===1", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    for (const layer of assemblyLayers()) {
      const spec = ROLE_TABLE[layer.role];
      if (spec.mesh) {
        const part = model.parts.find((p) => p.id === layer.role);
        expect(part?.width, `${layer.role}.width`).toBe(1);
        expect(part?.height, `${layer.role}.height`).toBe(1);
      }
    }
  });

  it("mesh parts are sized by meshCellsFor", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    for (const layer of assemblyLayers()) {
      const spec = ROLE_TABLE[layer.role];
      if (spec.mesh) {
        const { cols, rows } = meshCellsFor(layer.cropW, layer.cropH);
        const part = model.parts.find((p) => p.id === layer.role);
        expect(
          part?.mesh?.vertices.length,
          `${layer.role}.mesh.vertices.length`,
        ).toBe(2 * (cols + 1) * (rows + 1));
      }
    }
    // The fixture exercises both ends of the clamp: face (600×600) hits the
    // cap, eye_L (150×100) hits the floor.
    const face = model.parts.find((p) => p.id === "face");
    const eyeL = model.parts.find((p) => p.id === "eye_L");
    expect(face?.mesh?.vertices.length).toBe(2 * 9 * 9);
    expect(eyeL?.mesh?.vertices.length).toBe(2 * 5 * 5);
  });

  it("hair_back is a mesh part on the head deformer, sized like the other meshes", () => {
    // It used to be a static quad; it became a mesh so the sway warps can swing
    // its ends. It still hangs from headDeformer, not faceWarp: it holds the
    // head's outline while the face slides inside that grid.
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    const hair = model.parts.find((p) => p.id === "hair_back")!;
    expect(hair.mesh).toBeDefined();
    expect(hair.width).toBe(1);
    expect(hair.height).toBe(1);
    expect(hair.deformer).toBe("headDeformer");
    const xs = hair.mesh!.vertices.filter((_, i) => i % 2 === 0);
    const ys = hair.mesh!.vertices.filter((_, i) => i % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(800); // cropW
    expect(Math.max(...ys) - Math.min(...ys)).toBe(700); // cropH
  });

  it("body rides bodyDeformer as a static quad", () => {
    const model = generateIkiFromLayerSet(bodyLayers(), {
      width: 1000,
      height: 1000,
    });
    const body = model.parts.find((p) => p.id === "body");
    expect(body).toBeDefined();
    expect(body?.deformer).toBe("bodyDeformer");
    expect(body?.mesh).toBeUndefined();
    expect(body?.width).toBe(960); // cropW
    expect(body?.height).toBe(390); // cropH
  });

  it("every part names a deformer", () => {
    const model = generateIkiFromLayerSet(bodyLayers(), {
      width: 1000,
      height: 1000,
    });
    for (const part of model.parts) {
      expect(part.deformer, `${part.id}.deformer`).toBeDefined();
    }
  });

  it("bodyDeformer follows the turn at 30% of the head's travel and follows the head's breath bob at half amplitude", () => {
    const model = generateIkiFromLayerSet(bodyLayers(), {
      width: 1000,
      height: 1000,
    });
    type MatrixDeformer = {
      id: string;
      parent?: string;
      pivot: { x: number; y: number };
      bindings: {
        parameter: string;
        channel: string;
        from: number;
        to: number;
      }[];
    };
    const head = model.deformers!.find(
      (d) => d.id === "headDeformer",
    ) as MatrixDeformer;
    const bodyDeformer = model.deformers!.find(
      (d) => d.id === "bodyDeformer",
    ) as MatrixDeformer;
    expect(bodyDeformer).toBeDefined();
    expect(bodyDeformer.parent).toBeUndefined();
    expect(bodyDeformer.bindings).toHaveLength(2);

    // The head's own turn travel is no longer a headDeformer binding — it is
    // the uniform slide baked into the face grid, read off its axis column —
    // so the torso's share is measured against THAT.
    expect(
      head.bindings.filter((b) => b.parameter === StandardParameter.AngleX),
    ).toHaveLength(0);
    const headTravel = centreSlideOf(model, 30);
    const bodyTurn = bodyDeformer.bindings.find(
      (b) => b.parameter === StandardParameter.AngleX,
    )!;
    expect(bodyTurn.channel).toBe("translateX");
    expect(bodyTurn.to).toBeCloseTo(0.3 * headTravel, 10);
    expect(bodyTurn.from).toBeCloseTo(-bodyTurn.to, 10);

    const headBreath = head.bindings.find(
      (b) => b.parameter === StandardParameter.Breath,
    )!;
    const bodyBreath = bodyDeformer.bindings.find(
      (b) => b.parameter === StandardParameter.Breath,
    )!;
    expect(bodyBreath.channel).toBe("translateY");
    expect(bodyBreath.from).toBe(0);
    expect(bodyBreath.to).toBeCloseTo(0.5 * headBreath.to, 10);
    // Same sign as the head, smaller magnitude.
    expect(Math.sign(bodyBreath.to)).toBe(Math.sign(headBreath.to));
    expect(Math.abs(bodyBreath.to)).toBeLessThan(Math.abs(headBreath.to));

    expect(bodyDeformer.bindings.some((b) => b.channel === "rotate")).toBe(
      false,
    );

    const bodyLayer = bodyLayers().find((l) => l.role === "body")!;
    const bt = bboxToTransform(
      bodyLayer.bbox,
      bodyLayer.canvasW,
      bodyLayer.canvasH,
    );
    expect(bodyDeformer.pivot.x).toBeCloseTo(bt.x, 10);
    expect(bodyDeformer.pivot.y).toBeCloseTo(bt.y - bodyLayer.cropH / 2, 10);
  });

  it("the head is unchanged by the body", () => {
    const withBody = generateIkiFromLayerSet(bodyLayers(), {
      width: 1000,
      height: 1000,
    });
    const withoutBody = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    const headOf = (model: ReturnType<typeof generateIkiFromLayerSet>) =>
      model.deformers!.find((d) => d.id === "headDeformer");
    expect(JSON.stringify(headOf(withBody))).toBe(
      JSON.stringify(headOf(withoutBody)),
    );
  });

  it("no bodyDeformer without a body layer", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    expect(
      model.deformers!.find((d) => d.id === "bodyDeformer"),
    ).toBeUndefined();
  });

  it("a model with a body passes the validator end to end", () => {
    const model = generateIkiFromLayerSet(bodyLayers(), {
      width: 1000,
      height: 1000,
    });
    expect(() => parseIkiModel(structuredClone(model))).not.toThrow();
  });

  it("body is drawn over hair_back and under face", () => {
    const model = generateIkiFromLayerSet(bodyLayers(), {
      width: 1000,
      height: 1000,
    });
    const orderOf = (id: string) => model.parts.find((p) => p.id === id)!.order;
    expect(orderOf("hair_back")).toBeLessThan(orderOf("body"));
    expect(orderOf("body")).toBeLessThan(orderOf("face"));
  });

  it("a canvas-spanning body leaves the faceWarp grid untouched", () => {
    const gridOf = (layers: LayerInput[]) => {
      const model = generateIkiFromLayerSet(layers, {
        width: 1000,
        height: 1000,
      });
      const faceWarp = model.deformers!.find((d) => d.id === "faceWarp")!;
      return JSON.stringify(faceWarp);
    };
    expect(gridOf(bodyLayers())).toBe(gridOf(assemblyLayers()));
  });

  // A closed-mouth drawing stretched by scaleY 3 is a blurred band, not an open
  // mouth. With a second drawing present the pair cross-fades instead.
  it("bindingsForRole: mouth stretches when there is no open drawing", () => {
    const b = bindingsForRole(ROLE_TABLE["mouth"], "mouth", 150, 15);
    const open = b.find((x) => x.parameter === StandardParameter.MouthOpen)!;
    expect(open.channel).toBe("scaleY");
    expect(open.to).toBe(3);
  });

  it("bindingsForRole: mouth fades out when an open drawing is present", () => {
    const b = bindingsForRole(ROLE_TABLE["mouth"], "mouth", 150, 15, {
      hasMouthOpen: true,
    });
    const open = b.find((x) => x.parameter === StandardParameter.MouthOpen)!;
    expect(open.channel).toBe("opacity");
    expect(open.from).toBe(1);
    expect(open.to).toBe(0);
    // and it must NOT also be stretched
    expect(b.some((x) => x.channel === "scaleY")).toBe(false);
  });

  it("bindingsForRole: mouth_open fades in as the closed mouth fades out", () => {
    const b = bindingsForRole(ROLE_TABLE["mouth_open"], "mouth_open", 150, 60);
    const open = b.find((x) => x.parameter === StandardParameter.MouthOpen)!;
    expect(open.channel).toBe("opacity");
    expect(open.from).toBe(0);
    expect(open.to).toBe(1);
  });

  it("mouth_open draws over the closed mouth", () => {
    expect(ROLE_TABLE["mouth_open"].order).toBeGreaterThan(
      ROLE_TABLE["mouth"].order,
    );
  });

  it("a layer set with mouth_open cross-fades both mouths", () => {
    const layers: LayerInput[] = [
      ...assemblyLayers(),
      {
        role: "mouth_open",
        fileName: "mouth_open.png",
        canvasW: 1000,
        canvasH: 1000,
        bbox: { x: 400, y: 590, w: 200, h: 100 },
        cropW: 200,
        cropH: 100,
      },
    ];
    const model = generateIkiFromLayerSet(layers, {
      width: 1000,
      height: 1000,
    });
    const opacityOf = (id: string) =>
      model.parts
        .find((p) => p.id === id)!
        .bindings!.find(
          (b) =>
            b.parameter === StandardParameter.MouthOpen &&
            b.channel === "opacity",
        )!;
    expect(opacityOf("mouth").to).toBe(0);
    expect(opacityOf("mouth_open").to).toBe(1);
  });

  it("bindingsForRole: body (static) returns empty array", () => {
    expect(bindingsForRole(ROLE_TABLE["body"], "body", 900, 400)).toHaveLength(
      0,
    );
  });

  it("part transforms match bboxToTransform (source-placed, unshifted)", () => {
    const layers = assemblyLayers();
    const model = generateIkiFromLayerSet(layers, {
      width: 1000,
      height: 1000,
    });
    for (const layer of layers) {
      const expected = bboxToTransform(
        layer.bbox,
        layer.canvasW,
        layer.canvasH,
        layer.role,
      );
      const part = model.parts.find((p) => p.id === layer.role);
      expect(part?.transform.x, `${layer.role} transform.x`).toBe(expected.x);
      expect(part?.transform.y, `${layer.role} transform.y`).toBe(expected.y);
    }
  });

  it("returned model is already normalized: parseIkiModel(clone(m)) === m", () => {
    const m = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    expect(m).toEqual(parseIkiModel(structuredClone(m)));
  });

  it("model contains the 8 legacy standard parameter ids (brow ids covered by dedicated test)", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    const paramIds = new Set(model.parameters.map((p) => p.id));
    const expected = [
      StandardParameter.MouthOpen,
      StandardParameter.MouthForm,
      StandardParameter.EyeOpenLeft,
      StandardParameter.EyeOpenRight,
      StandardParameter.EyeballX,
      StandardParameter.EyeballY,
      StandardParameter.AngleX,
      StandardParameter.Breath,
    ];
    for (const id of expected) {
      expect(paramIds.has(id), `parameter ${id} present`).toBe(true);
    }
  });
});

// ── describe("feature depth parallax") ───────────────────────────────────────

describe("feature depth parallax", () => {
  const canvas = { width: 1000, height: 1000 };
  // What a direct bindingsForRole call needs for the nod binding the checks
  // below read: the nod's unit and the nose that gates every feature depth.
  // The turn's depth is solved per rig and read off landings, never bindings.
  const units = { parallaxUnitY: 120, hasNose: true };
  // Mirrors auto-rig.ts's FEATURE_NOD_DEPTH for the eye stack — not exported,
  // so pinned here the way HAIR_FRONT_DEPTH is above.
  const NOD_EYE_DEPTH = 0.04;
  // NOD_BEND (0.5) of a degree of ParamAngleY, in radians — the pitch the nod
  // bends at — mirrored likewise; a full 30° nod is the 15° NOD_THETA.
  const NOD_THETA_PER_DEG = (0.5 * Math.PI) / 180;
  const NOD_THETA = 30 * NOD_THETA_PER_DEG;
  type Binding = {
    parameter: string;
    channel: string;
    from: number;
    to: number;
  };
  const slideOf = (
    bindings: { parameter: string; channel: string }[] | undefined,
    parameter: string,
    channel: string,
  ) =>
    (bindings ?? []).find(
      (b) => b.parameter === parameter && b.channel === channel,
    ) as Binding | undefined;
  const nodOf = (b: { parameter: string; channel: string }[] | undefined) =>
    slideOf(b, StandardParameter.AngleY, "translateY");

  it("every feature on the face slides WITH the head on the turn and the nod", () => {
    const model = generateIkiFromLayerSet(fullFaceLayers(), canvas);
    // Everything on the face but the contour itself and the hair.
    const features = fullFaceLayers()
      .map((l) => l.role)
      .filter((r) => r !== "face" && !r.startsWith("hair_"));
    /** The other side's part; an unsided role is its own mirror. */
    const mirrorOf = (id: string) =>
      id.endsWith("_L")
        ? `${id.slice(0, -2)}_R`
        : id.endsWith("_R")
          ? `${id.slice(0, -2)}_L`
          : id;
    for (const id of features) {
      // A −30° turn foreshortens the −x side, and every feature's centre of
      // mass lands toward it, whichever side of the face it sits on.
      const restX = landedCentroidX(model, id);
      const turnedX = landedCentroidX(model, id, {
        [StandardParameter.AngleX]: -30,
      });
      expect(turnedX - restX, id).toBeLessThan(0);
      // The fixture is symmetric about the canvas centre, so the other side's
      // part at +30 lands exactly there, mirrored.
      expect(
        landedCentroidX(model, mirrorOf(id), {
          [StandardParameter.AngleX]: 30,
        }),
        id,
      ).toBeCloseTo(-turnedX, 4);
      // headDeformer's nod translate runs −30 → 30 with AngleY, so up at +30
      // and down at −30 is WITH the head. The two distances are not each
      // other's mirror — the pinned nod bend pulls toward the axis at either
      // pitch — so it is the direction that flips with the head's.
      const restY = landedCentroidY(model, id);
      expect(
        landedCentroidY(model, id, { [StandardParameter.AngleY]: 30 }) - restY,
        id,
      ).toBeGreaterThan(0);
      expect(
        landedCentroidY(model, id, { [StandardParameter.AngleY]: -30 }) - restY,
        id,
      ).toBeLessThan(0);
    }
  });

  it("the contour, the hair and the body keep their own: the face slides on its axis, hair_back stands, the body follows a share", () => {
    const model = generateIkiFromLayerSet(
      [...fullFaceLayers(), bodyLayers().find((l) => l.role === "body")!],
      canvas,
    );
    const travel = travelOf(model);
    // The face has no depth of its own — it IS the cylinder — and on its axis
    // column the bend is zero, so those vertices land the slide away and
    // nothing more: rest − travel at −30.
    const faceCenterX = model.parts.find((p) => p.id === "face")!.transform.x;
    const faceRest = preBindVertices(model, "face");
    const faceLanded = landVertices(model, "face", turned);
    let axisVertices = 0;
    for (let i = 0; i < faceRest.length; i += 2) {
      if (faceRest[i] !== faceCenterX) continue;
      axisVertices++;
      expect(faceLanded[i]).toBeCloseTo(faceRest[i] - travel, 4);
    }
    expect(axisVertices).toBeGreaterThan(0);
    // The back hair holds the head's outline: at rest at every stop.
    const backRest = Array.from(preBindVertices(model, "hair_back"));
    for (const deg of faceWarpOf(model).warp2d.valuesX) {
      expect(
        Array.from(
          landVertices(model, "hair_back", {
            [StandardParameter.AngleX]: deg,
          }),
        ),
      ).toEqual(backRest);
    }
    // The torso follows the face's slide at BODY_TURN_FOLLOW, the one rigid
    // share of the travel left, and nothing bends it.
    const bodyRest = preBindVertices(model, "body");
    const bodyLanded = landVertices(model, "body", turned);
    for (let i = 0; i < bodyRest.length; i += 2) {
      expect(bodyLanded[i]).toBeCloseTo(
        bodyRest[i] - BODY_TURN_FOLLOW * travel,
        4,
      );
    }
    // The bangs carry no AngleY binding: their nod is a per-vertex warp that
    // bakes the brows' own slide `t` at each stop AND the head's pinned bend
    // where that slide puts the vertex — the composition a grid child gets
    // from its binding and the grid — on the nod cylinder the generator sizes
    // from the head's own half-height about the face centre (the turn
    // family's union with the margin — `headNodRadiusOf` mirrors the rule,
    // and it is the very value the solve is handed).
    const bangs = model.parts.find((p) => p.id === "hair_front")!;
    expect(nodOf(bangs.bindings)).toBeUndefined();
    const browNod = nodOf(
      model.parts.find((p) => p.id === "brow_L")!.bindings,
    )!;
    const faceY = model.parts.find((p) => p.id === "face")!.transform.y;
    const layers = [
      ...fullFaceLayers(),
      bodyLayers().find((l) => l.role === "body")!,
    ];
    const nodRadius = headNodRadiusOf(layers);
    expect(turnSolveInputs(layers)[5]).toBeCloseTo(nodRadius, 9);
    const pinnedBend = (local: number, radius: number, theta: number) =>
      radius * Math.sin(Math.asin(local / radius) + theta) -
      local -
      radius * Math.sin(theta);
    const nodWarp = bangs.warps!.find(
      (w) => w.parameter === StandardParameter.AngleY,
    )!;
    expect(nodWarp.keyforms.map((k) => k.value)).toEqual([-30, -15, 0, 15, 30]);
    for (const k of nodWarp.keyforms) {
      const t = browNod.to * (k.value / 30);
      for (let v = 0; v < bangs.mesh!.vertices.length / 2; v++) {
        const y = bangs.transform.y + bangs.mesh!.vertices[v * 2 + 1];
        expect(k.offsets[v * 2]).toBe(0);
        expect(k.offsets[v * 2 + 1], `${k.value}° vertex ${v}`).toBeCloseTo(
          t + pinnedBend(y + t - faceY, nodRadius, k.value * NOD_THETA_PER_DEG),
          9,
        );
      }
    }
  });

  it("the nose stands off the face; the mouth has its own; the eye stack shares one depth", () => {
    const model = generateIkiFromLayerSet(fullFaceLayers(), canvas);
    // A feature's own slide across the surface at a stop: how far its centre
    // of mass lands from where the face's axis column carries it.
    const ownShift = (id: string, angleX: number) =>
      landedCentroidX(model, id, { [StandardParameter.AngleX]: angleX }) -
      landedCentroidX(model, id) -
      centreSlideOf(model, angleX);
    // The solved targets order the three, not the tabulated depths: the nose
    // carries the most, then the mouth, then the eye pair as a whole. The pair
    // is averaged because nose and mouth sit on the axis, where the bend is
    // zero, so their ownShift is their slide alone; each eye is off-axis and
    // carries the bend too, and only the pair's mean cancels it.
    const eyePair = (ownShift("eye_L", -30) + ownShift("eye_R", -30)) / 2;
    expect(Math.abs(ownShift("nose", -30))).toBeGreaterThan(
      Math.abs(ownShift("mouth", -30)),
    );
    expect(Math.abs(ownShift("mouth", -30))).toBeGreaterThan(Math.abs(eyePair));
    // The two mouth drawings cross-fade, so they land as one.
    expect(ownShift("mouth_open", -30)).toBeCloseTo(ownShift("mouth", -30), 6);
    // iris/pupil/highlight clip to the white and the lash folds onto it: each
    // of their vertices lands where the white lands that same point of itself,
    // or a turn would drag them across the sclera. Under a pixel, not exact:
    // landedXAt reads the white's landing through the white's own coarser
    // mesh triangles, so the grid's bend inside one white cell shows as a
    // sub-pixel gap, while a wrong iris depth would be tens of px (the depth
    // difference × parallaxUnit).
    for (const [role, white] of [
      ["iris_L", "eye_L"],
      ["lash_L", "eye_L"],
      ["iris_R", "eye_R"],
      ["lash_R", "eye_R"],
    ]) {
      const rest = preBindVertices(model, role);
      const landed = landVertices(model, role, turned);
      for (let i = 0; i < rest.length; i += 2) {
        expect(
          Math.abs(
            landed[i] - landedXAt(model, white, rest[i], rest[i + 1], turned),
          ),
          role,
        ).toBeLessThan(1);
      }
    }
    // Both sides slide the same way: the far eye at −30 is the other eye at
    // +30, mirrored.
    expect(ownShift("eye_R", 30)).toBeCloseTo(-ownShift("eye_L", -30), 4);
  });

  it("without the units no parallax is emitted", () => {
    expect(bindingsForRole(ROLE_TABLE["eye_L"], "eye_L", 100, 50)).toHaveLength(
      0,
    );
    // The mouth always carries its own MouthOpen/MouthForm bindings, so it is
    // the nod binding that has to be missing.
    expect(
      nodOf(bindingsForRole(ROLE_TABLE["mouth"], "mouth", 150, 15)),
    ).toBeUndefined();
  });

  it("the generated model's eye nod is the nod depth of the head's own parallax unit", () => {
    const layers = [...hairFrontLayers(), noseLayer()];
    const model = generateIkiFromLayerSet(layers, canvas);
    // The head's half-height about the nod axis — the nod radius without its
    // no-fold margin — sizes the unit, one value for every group.
    const halfH = headNodRadiusOf(layers) / RADIUS_FACTOR;
    const eye = model.parts.find((p) => p.id === "eye_L")!.bindings;
    expect(nodOf(eye)!.to).toBeCloseTo(
      NOD_EYE_DEPTH * headNodParallaxUnit(halfH),
      6,
    );
    // The turn's own depth is solved, not tabulated — it is checked against the
    // cues it was solved from under "turn targets", and where it lands the
    // features under "every feature on the face slides WITH the head".
  });

  it("headNodParallaxUnit is the bulk the 2D bake pins out at full nod", () => {
    // Same derivation as the turn's radius test above, on the vertical axis:
    // recover the radius from the unit and re-derive the top row's pinned dy.
    const halfH = 300;
    const grid = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -400, 400, -halfH, halfH),
    };
    const w = bakeTurnGroupWarp2D(
      grid,
      "ax",
      "ay",
      // turn radius: irrelevant here, the nod is on y; travel 0: no rig behind
      // this bake, the bend alone
      surfaceOn(grid, 400 * RADIUS_FACTOR, 0),
      () => 0,
    );
    const up =
      w.keyforms2d[
        w.valuesY.indexOf(30) * w.valuesX.length + w.valuesX.indexOf(0)
      ];
    const radius = headNodParallaxUnit(halfH) / Math.sin(NOD_THETA);
    const alpha = Math.asin(halfH / radius);
    const expected =
      radius * Math.sin(alpha + NOD_THETA) -
      halfH -
      radius * Math.sin(NOD_THETA);
    // Row 0 is the top row (y = +halfH); its first point's dy is offsets[1].
    expect(up.offsets[1]).toBeCloseTo(expected, 6);
    expect(expected).toBeLessThan(0);
  });

  it("without a nose layer nothing slides: the painted nose pins the face", () => {
    // Units present, no nose: no feature binding at all, and a generated rig
    // without the role has static features and unfollowing bangs — the back
    // hair keeps its own nod tuck either way.
    const noNose = { parallaxUnitY: 120 };
    expect(
      bindingsForRole(ROLE_TABLE["eye_L"], "eye_L", 100, 50, noNose),
    ).toHaveLength(0);
    expect(
      nodOf(bindingsForRole(ROLE_TABLE["mouth"], "mouth", 150, 15, noNose)),
    ).toBeUndefined();
    expect(
      bindingsForRole(ROLE_TABLE["hair_front"], "hair_front", 700, 400, noNose),
    ).toHaveLength(0);
    // A rig with no nose solves no depth, so nothing on the face has a slide
    // of its own: every group's −30° keyform is the surface's own map at its
    // nodes, UNSHIFTED — on the virtual lattice, at the generator's fallback
    // radius and the slide the plate carries; the mouth family's turned about
    // its anchor, the tilt being no slide — and every vertex of every part
    // on the face lands where its group grid's bilinear read of those nodes
    // puts its PRE-BIND position. That position, not the rest x: the mouth
    // family binds at scaleX 1.1 (the MouthForm range −0.2 … 0.4 is not
    // centred on the parameter's default), so its vertices sit at
    // t.x + 1.1·vx when the grid reads them.
    const layers = fullFaceLayers().filter((l) => l.role !== "nose");
    const { model, radius } = solvedRig(layers, canvas);
    const faceCenterX = model.parts.find((p) => p.id === "face")!.transform.x;
    const map = turnColumnMap(
      latticeOf(layers),
      faceCenterX,
      radius,
      -30,
      travelOf(model),
    );
    // The mouth family's anchor: the closed mouth's rest centre.
    const anchor = model.parts.find((p) => p.id === "mouth")!.transform;
    // The hair is not a feature: the bangs carry warps of their own and the
    // back hair rides the head.
    for (const part of model.parts.filter((p) => !p.id.startsWith("hair_"))) {
      const group = groupWarpOf(model, part.deformer!);
      const keyform = cell(group.warp2d, -30, 0);
      const nodeLanding = (nx: number, ny: number) =>
        part.deformer === "mouthWarp"
          ? anchoredLanding(() => map, anchor, -30, 0, nx, ny).x
          : map.mapX(nx);
      for (let n = 0; n < group.grid.points.length / 2; n++) {
        const nx = group.grid.points[n * 2];
        const ny = group.grid.points[n * 2 + 1];
        expect(
          keyform.offsets[n * 2],
          `${part.deformer} node ${n}`,
        ).toBeCloseTo(nodeLanding(nx, ny) - nx, 9);
        if (part.deformer === "mouthWarp") {
          // The tilt turns the mouth's nodes on y too, nose or none.
          expect(
            keyform.offsets[n * 2 + 1],
            `${part.deformer} node ${n}`,
          ).toBeCloseTo(
            anchoredLanding(() => map, anchor, -30, 0, nx, ny).y - ny,
            9,
          );
        }
      }
      const preBind = preBindVertices(model, part.id);
      const landed = landVertices(model, part.id, turned);
      for (let i = 0; i < preBind.length; i += 2) {
        // The engine's grid and landings are float32, an ulp of 3e-5 at
        // |x| < 512: the two agree to that rounding (under two ulps, a
        // deterministic margin), not to 1e-6.
        expect(landed[i], part.id).toBeCloseTo(
          gridBilinearX(group.grid, nodeLanding, preBind[i], preBind[i + 1]),
          4,
        );
      }
    }
    const part = (id: string) => model.parts.find((p) => p.id === id)!;
    expect(nodOf(part("hair_front").bindings)).toBeUndefined();
    expect(Array.from(landVertices(model, "hair_back", turned))).toEqual(
      Array.from(preBindVertices(model, "hair_back")),
    );
    expect(nodOf(part("hair_back").bindings)!.to).toBeLessThan(0);
  });
});

// ── describe("turn targets") ─────────────────────────────────────────────────

describe("bisectTurnRadius", () => {
  // A synthetic radius → far/near ratio, r / 100, whose candidates the caller
  // would ship everywhere but a stretch strictly inside the bracket [2, 4]:
  // the shape a strand bound that fails at mid radii gives the fit, which no
  // layer fixture can be built to guarantee.
  const candidateAt = (radius: number) => ({ radius, ratio: radius / 100 });
  const accepted = (c: { radius: number }) =>
    !(c.radius > 2.9 && c.radius < 3.1);
  const bracket = () => [candidateAt(2), candidateAt(4)] as const;

  it("a rejected mid still steers the bisection, so an accepted target radius past it is reached", () => {
    const evaluated: number[] = [];
    const [lo, hi] = bracket();
    const fitted = bisectTurnRadius(
      lo,
      hi,
      0.033,
      (radius) => {
        evaluated.push(radius);
        return candidateAt(radius);
      },
      accepted,
    );
    // The third mid, √(√8 · √(4√8)) ≈ 3.08, is inside the rejected stretch;
    // the search keeps halving past it instead of stopping on the bracket it
    // held then.
    expect(evaluated.some((r) => r > 3.05 && r < 3.1)).toBe(true);
    expect(accepted(fitted)).toBe(true);
    expect(Math.abs(fitted.ratio - 0.033)).toBeLessThan(1e-6);
  });

  it("a target inside the rejected stretch returns the nearest-ratio accepted candidate, which misses it", () => {
    const [lo, hi] = bracket();
    const fitted = bisectTurnRadius(lo, hi, 0.03, candidateAt, accepted);
    expect(accepted(fitted)).toBe(true);
    // The caller checks the miss against its own tolerance and falls back.
    expect(Math.abs(fitted.ratio - 0.03)).toBeGreaterThan(1e-6);
    // Nothing it evaluated outside the stretch came nearer: the first mid,
    // √8 ≈ 2.83.
    expect(fitted.radius).toBeCloseTo(Math.sqrt(8), 12);
  });

  it("a mid that yields no candidate at all still stops the search and keeps the pair it has", () => {
    const evaluated: number[] = [];
    const [lo, hi] = bracket();
    const fitted = bisectTurnRadius(
      lo,
      hi,
      0.033,
      (radius) => {
        evaluated.push(radius);
        return radius > 2.5 ? undefined : candidateAt(radius);
      },
      accepted,
    );
    expect(evaluated).toHaveLength(1);
    // The nearer end of the pair it held: 4 (0.040) against 2 (0.020).
    expect(fitted.radius).toBe(4);
  });

  it("with every candidate accepted it picks what the plain bisection always picked", () => {
    // The bisection as `fitTurnRadius` ran it before a caller could turn a
    // candidate down: halve on the ratio and return the nearer of the final
    // two ends (no mid is blocked here).
    const plain = (target: number) => {
      let lo = candidateAt(2);
      let hi = candidateAt(4);
      for (let i = 0; i < 40; i++) {
        const mid = candidateAt(Math.sqrt(lo.radius * hi.radius));
        if ((mid.ratio - target) * (lo.ratio - target) <= 0) hi = mid;
        else lo = mid;
      }
      return Math.abs(lo.ratio - target) <= Math.abs(hi.ratio - target)
        ? lo
        : hi;
    };
    for (const target of [0.025, 0.03, 0.033]) {
      const [lo, hi] = bracket();
      expect(
        bisectTurnRadius(lo, hi, target, candidateAt, () => true),
        `${target}`,
      ).toEqual(plain(target));
    }
  });
});

describe("strandPreferredCandidates", () => {
  // Hand-built sweep candidates: two unbroken runs (sweep 0…3 and 5…8, the
  // radius at 4 refused) whose far/near ratios overlap — the first rising,
  // the second turning back — so a ratio inside both is held by either, and
  // only the second keeps the far iris clear of its strand. No layer fixture
  // probed gives two such runs, its ratio rising monotonically with the
  // radius (see the function's doc).
  const run = (from: number, ratios: number[], strandFeasible: boolean) =>
    ratios.map((ratio, i) => ({ sweepIndex: from + i, ratio, strandFeasible }));
  const unheld = run(0, [0.6, 0.65, 0.7, 0.75], false);
  const held = run(5, [0.72, 0.68, 0.64, 0.6], true);
  const candidates = [...unheld, ...held];

  it("a ratio two runs hold is fitted among the strand-feasible one's radii", () => {
    expect(strandPreferredCandidates(candidates, 0.66)).toEqual(held);
  });

  it("a ratio no strand-feasible run holds falls back to every candidate", () => {
    // 0.74 is inside the unheld run only; the held one tops out at 0.72.
    expect(strandPreferredCandidates(candidates, 0.74)).toBe(candidates);
  });

  it("with every candidate feasible — no strands — the sweep is the pool as it stands", () => {
    const all = run(0, [0.6, 0.65, 0.7], true);
    expect(strandPreferredCandidates(all, 0.66)).toBe(all);
  });
});

describe("turn targets", () => {
  const canvas = { width: 1000, height: 1000 };
  /** The assembly fixture, plus the nose that gates the whole turn solve. */
  const withNose = (): LayerInput[] => [...hairFrontLayers(), noseLayer()];
  /** The same character with bangs half the canvas wide — a different faceWarp
   *  grid around the same face. */
  const wideBangs = (): LayerInput[] =>
    withNose().map((l) =>
      l.role === "hair_front"
        ? { ...l, bbox: { ...l.bbox, x: 0, w: 1000 }, cropW: 1000 }
        : l,
    );
  /** The same character with its eyes painted out AT the plate's edge, where
   *  the far one has almost no room to slide before it leaves the face. The
   *  plate spans 200…800 on the canvas and each eye is 150 wide, so 630/220
   *  leaves each one 20px of margin. (It was 600/250 before the face's own
   *  75px slide joined the eye cue: half the default shift now arrives free
   *  with the plate, and eyes 50px off the edge reach it without clamping.) */
  const edgeEyes = (): LayerInput[] =>
    withNose().map((l) =>
      l.role === "eye_L" || l.role === "eye_R"
        ? {
            ...l,
            bbox: { ...l.bbox, x: l.role === "eye_L" ? 630 : 220 },
          }
        : l,
    );
  /** The same character with hair_back's own crop shifted `shift` px off the
   *  canvas centre (same width, so its own rest half-width is unchanged) —
   *  an opaque union whose own centre no longer sits at faceCenterX. */
  const offCentreHairBack = (shift: number): LayerInput[] =>
    withNose().map((l) =>
      l.role === "hair_back"
        ? { ...l, bbox: { ...l.bbox, x: l.bbox.x + shift } }
        : l,
    );
  /** The fixture's face plate half-width: with no measured head, that is what
   *  the shift targets are fractions of. */
  const HH = 300;

  /** `actual` is within 1 % of `target`. */
  const within1Percent = (actual: number, target: number) =>
    expect(Math.abs(actual / target - 1)).toBeLessThan(0.01);

  // ── solveTurnDepth ────────────────────────────────────────────────────────

  const depthGrid = {
    cols: 4,
    rows: 4,
    points: generateGridPoints(4, 4, -400, 400, -300, 300),
  };
  const DEPTH_RADIUS = 400 * RADIUS_FACTOR;
  const DEPTH_UNIT = headTurnParallaxUnit(DEPTH_RADIUS);
  // Travel 0 on both: `depthGrid` is built by hand to exercise the depth
  // solver against a known bend, with no rig behind it to size a slide.
  const restMap = turnColumnMap(depthGrid, 0, DEPTH_RADIUS, 0, 0);
  const turnedMap = turnColumnMap(depthGrid, 0, DEPTH_RADIUS, -30, 0);
  /** A plate edge far enough out that it never bites. */
  const FAR_PLATE = -400;

  it("solveTurnDepth: on a map that deforms nothing, the depth IS the target", () => {
    // The 0° stop is the identity, so mapX(x - d*unit) - x is just -d*unit.
    const s = solveTurnDepth(
      60,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      restMap,
      FAR_PLATE,
    );
    expect(s.reached).toBe(true);
    expect(s.depth).toBeCloseTo(60 / DEPTH_UNIT, 9);
    expect(s.achieved).toBeCloseTo(-60, 9);
  });

  it("solveTurnDepth: where the turn compresses, the same slide costs more depth", () => {
    const flat = solveTurnDepth(
      60,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      restMap,
      FAR_PLATE,
    );
    const bent = solveTurnDepth(
      60,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      FAR_PLATE,
    );
    expect(bent.reached).toBe(true);
    expect(bent.depth).toBeGreaterThan(flat.depth);
    expect(bent.achieved).toBeCloseTo(-60, 6);
  });

  it("solveTurnDepth: the face plate bounds the slide, and a nearer edge cuts it shorter", () => {
    // The landmark's far edge is -120, so a plate edge at -200 leaves it 80px
    // of travel where a far one would have allowed far more.
    const plate = solveTurnDepth(
      100_000,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      -200,
    );
    const far = solveTurnDepth(
      100_000,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      FAR_PLATE,
    );
    expect(plate.depth).toBeCloseTo(80 / DEPTH_UNIT, 9);
    expect(plate.depth).toBeLessThan(far.depth);
    // At that depth the far edge sits exactly ON the plate, never past it.
    expect(-120 - plate.depth * DEPTH_UNIT).toBeCloseTo(-200, 9);
  });

  it("solveTurnDepth: a slide past the plate stops at it, and says what was on offer", () => {
    const s = solveTurnDepth(
      100_000,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      FAR_PLATE,
    );
    expect(s.reached).toBe(false);
    // Cut short by the art's room, not by the face's own drift.
    expect(s.limit).toBe("cap");
    // Ascending, and the far end is as far as the landmark can travel.
    expect(s.attainable[0]).toBeLessThan(s.attainable[1]);
    expect(s.attainable[0]).toBeGreaterThan(-100_000);
    expect(s.achieved).toBeCloseTo(s.attainable[0], 9);
  });

  it("solveTurnDepth: a family with no landmark is an error, not a depth", () => {
    expect(() =>
      solveTurnDepth(60, [], DEPTH_UNIT, restMap, FAR_PLATE),
    ).toThrow(/auto-rig: solveTurnDepth: no landmark to slide/);
  });

  it("solveTurnDepth: a target smaller than the landmark's own drift stops at rest", () => {
    // The near side's inner columns already slide toward the far side at depth
    // 0, so there is no non-negative depth that slides this one LESS than that.
    const drift = turnedMap.mapX(200) - 200;
    expect(drift).toBeLessThan(0);
    const s = solveTurnDepth(
      0,
      [{ x: 200, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      FAR_PLATE,
    );
    expect(s.reached).toBe(false);
    // Cut short by the face's own drift: no depth reaches it.
    expect(s.limit).toBe("floor");
    expect(s.depth).toBe(0);
    expect(s.attainable[1]).toBeCloseTo(drift, 9);
  });

  // ── solveTurnModel ────────────────────────────────────────────────────────

  /** hair_back's own REST geometry, for building a `headEdges` list that
   *  names it. The solve is never handed the back hair itself — it holds the
   *  head's outline and lands where it sits — so this is only where its own
   *  crop edges are. */
  const hairBackOf = (layers: LayerInput[]) => {
    const layer = layers.find((l) => l.role === "hair_back");
    if (!layer) return undefined;
    const x = bboxToTransform(
      layer.bbox,
      layer.canvasW,
      layer.canvasH,
      "hair_back",
    ).x;
    return { x, cropW: layer.cropW };
  };

  /** `solveTurnModel` on a layer set, with exactly the inputs the generator
   *  hands it for THAT layer set (`turnSolveInputs`). */
  const solveFor = (
    layers: LayerInput[],
    targets: TurnTargets = {},
    headEdges?: HeadEdges,
    strandEdges?: StrandEdges,
  ) =>
    solveTurnModel(
      resolveTurnTargets(targets),
      ...turnSolveInputs(layers),
      headEdges,
      strandEdges,
    );

  it("solveTurnModel: a far eye this layer set cannot foreshorten names the range it can", () => {
    const s = solveFor(withNose(), { farEyeRatio: 0.2 });
    expect(s.unreachable).toBe(true);
    if (!s.unreachable) return;
    expect(s.field).toBe("farEyeRatio");
    expect(s.value).toBe(0.2);
    // Every radius the sweep can hold, at the depth each needs for the shift.
    expect(s.attainable[0]).toBeGreaterThan(0.2);
    expect(s.attainable[1]).toBeLessThan(1);
    expect(s.attainable[0]).toBeLessThan(s.attainable[1]);
  });

  it("solveTurnModel: re-submitting the attainable interval's own lower bound is reached, not refused again", () => {
    // A caller that reads `attainable[0]` back off a refusal and resubmits it
    // exactly must not be refused a second time: the boundary round-trips
    // through a cue<->px conversion (`m * hh` here, `/ hh` when it was
    // reported), which can move it by a float ulp.
    const s = solveFor(withNose(), { noseShift: 0.9 });
    expect(s.unreachable).toBe(true);
    if (!s.unreachable) return;
    // noseShift is a MAGNITUDE (the sign is ignored, same as eyeShift), so
    // the lower end of what it offers is never negative.
    expect(s.attainable[0]).toBeGreaterThanOrEqual(0);
    const again = solveFor(withNose(), { noseShift: s.attainable[0] });
    expect(again.unreachable).toBe(false);
  });

  it("solveTurnModel: it reports the cues it reached, and this layer set needs no clamp at all", () => {
    const s = solveFor(withNose());
    if (s.unreachable) throw new Error("expected a reachable turn");
    // Magnitudes, the units the targets are written in.
    within1Percent(s.achieved.eyeShift, DEFAULT_TURN_TARGETS.eyeShift);
    within1Percent(s.achieved.farEyeRatio, DEFAULT_TURN_TARGETS.farEyeRatio);
    // This fixture's eyes stop 100px short of the plate's edge and the default
    // slide needs less than that, so those two are not cut down — and with the
    // head's travel in the grid, the whole deformed grid travels with the
    // turn, so its far-side reach now clears the default hold too: nothing is
    // clamped. (It was the silhouette, back when the plate bent inside a grid
    // that stayed put.)
    expect(s.clamped).toEqual([]);
    // The silhouette lands exactly on the default, because the HOLD is fitted
    // until a render measures it: the bangs' own lead pulling the measured
    // edge in is paid for by a hold a hair wider than the rest silhouette
    // (the cue read 0.9897 back when the ask was carried straight through).
    expect(s.achieved.silhouetteRatio).toBeCloseTo(1, 8);
  });

  it("solveTurnModel: eyes painted out at the plate's edge clamp the DEFAULT shift instead of failing", () => {
    const s = solveFor(edgeEyes());
    if (s.unreachable) throw new Error("a default must never refuse to rig");
    expect(s.clamped).toContain("eyeShift");
    expect(s.achieved.eyeShift).toBeLessThan(DEFAULT_TURN_TARGETS.eyeShift);
    expect(s.achieved.eyeShift).toBeGreaterThan(0);
    // The foreshortening cue is NOT traded away to buy the last few pixels of
    // slide: the radius still fits the ratio.
    within1Percent(s.achieved.farEyeRatio, DEFAULT_TURN_TARGETS.farEyeRatio);
  });

  it("solveTurnModel: a MEASURED shift past what the plate leaves is clamped, and one it leaves room for is met", () => {
    // 0.5 of the head half-width, where the default (0.22) is now reachable on
    // this fixture: the face plate's own slide carries most of the cue, so it
    // takes a bigger ask than the default to run the far eye off the plate.
    // The plate's edge is the art's room, not a fact about the reference, so
    // a measured shift past it is cut to it and says so, exactly as a default
    // is — and the far/near ratio is still fitted.
    const asked = 0.5;
    const s = solveFor(edgeEyes(), { eyeShift: asked });
    if (s.unreachable) throw new Error("a shift past the plate must clamp");
    expect(s.clamped).toContain("eyeShift");
    expect(s.achieved.eyeShift).toBeLessThan(asked);
    within1Percent(s.achieved.farEyeRatio, DEFAULT_TURN_TARGETS.farEyeRatio);
    // A measured shift the plate DOES leave room for is met, not clamped.
    // (The default RATIO may still be, which is its own business: a shallower
    // slide puts the far eye somewhere else on the cylinder.)
    const small = solveFor(edgeEyes(), { eyeShift: s.achieved.eyeShift * 0.8 });
    if (small.unreachable) throw new Error("expected a reachable turn");
    expect(small.clamped).not.toContain("eyeShift");
    within1Percent(small.achieved.eyeShift, s.achieved.eyeShift * 0.8);
  });

  it("solveTurnModel: eyeShift and its negation solve identically", () => {
    // TurnTargets.eyeShift's own contract: "the sign is ignored". A left-turn
    // reference legitimately measures a negative eyeShift, and it must ship
    // the identical rig a positive one of the same magnitude does — the
    // magnitude has to be taken BEFORE the silhouette-centre correction, not
    // after (see evaluateTurnCandidate).
    const layers = withNose();
    const targets = { headHalfWidth: 350 };
    const positive = solveFor(layers, { ...targets, eyeShift: 0.18 });
    const negative = solveFor(layers, { ...targets, eyeShift: -0.18 });
    if (positive.unreachable || negative.unreachable) {
      throw new Error("expected both to reach");
    }
    // toEqual can't diff the `holdEdgeAt` closures; JSON drops functions.
    expect(JSON.stringify(negative)).toBe(JSON.stringify(positive));
  });

  it("solveTurnModel: a CALLER eyeShift past every radius's room solves exactly as the same DEFAULT does", () => {
    // A very wide measured head makes the silhouette hold's own share of the
    // correction large enough that this request — comfortably inside
    // TurnTargets.eyeShift's own |value| <= 1 range — is beyond every
    // radius's own reach once the correction is included.
    const layers = withNose();
    const targets = { headHalfWidth: 2000, eyeShift: 0.1 };
    const measured = solveFor(layers, targets);

    // The identical request, DEFAULTED rather than measured: `solveFor` always
    // resolves eyeShift's absence to DEFAULT_TURN_TARGETS' own 0.22, so the
    // "same request" is built by hand — the resolved-targets shape is a public
    // type, and this is the only way to ask for a DEFAULT that is not 0.22.
    const resolved = resolveTurnTargets({ headHalfWidth: 2000 });
    const defaulted = solveTurnModel(
      {
        ...resolved,
        eyeShift: 0.1,
        defaulted: new Set([...resolved.defaulted, "eyeShift"]),
      },
      ...turnSolveInputs(layers),
    );
    if (measured.unreachable || defaulted.unreachable) {
      throw new Error("a shift past the art's room must clamp, not refuse");
    }
    expect(measured.clamped).toContain("eyeShift");
    // A shift the art's room cuts short no longer excludes the radii where it
    // is cut — only one below the pair's own drift at depth 0 would — so the
    // caller's leaves the far/near ratio fitted across the same radii the
    // default does, at the same radius, cut to the same room. toEqual can't
    // diff the `holdEdgeAt` closures; JSON drops functions.
    expect(JSON.stringify(measured)).toBe(JSON.stringify(defaulted));
  });

  it("solveTurnModel: a CALLER eyeShift below the pair's own drift at depth 0 is still refused", () => {
    // On the hero-like layers the face's own slide carries the eye pair far
    // further toward the far side than 0.01 of the plate's half-width at
    // every radius (≈ 0.13 at the least), and no depth is negative: nothing
    // reaches it, so the measurement is refused naming the shifts on offer,
    // where a default would be clamped. (withNose() is no such fixture: at
    // its flattest radius the silhouette centre drifts with the eyes, and
    // even a shift of 0 is reached there.)
    const layers = heroLikeLayers();
    const s = solveFor(layers, { eyeShift: 0.01 });
    expect(s.unreachable).toBe(true);
    if (!s.unreachable) return;
    expect(s.field).toBe("eyeShift");
    expect(s.value).toBe(0.01);
    expect(s.attainable![0]).toBeGreaterThan(0.01);
    expect(() =>
      generateIkiFromLayerSet(layers, canvas1100, {
        turnTargets: { eyeShift: 0.01 },
      }),
    ).toThrow(
      new TurnTargetError(
        `auto-rig: turnTargets.eyeShift 0.01 is unreachable for this layer set (attainable ${s.attainable![0]}…${s.attainable![1]})`,
      ),
    );
  });

  // ── the generated rig ─────────────────────────────────────────────────────

  it("the default targets solve, and the rig reaches the cues they name", () => {
    const layers = withNose();
    const model = generateIkiFromLayerSet(layers, canvas);
    const cues = cuesOf(model, layers, HH);
    // Positive = toward the far side, the sign the report carries.
    within1Percent(cues.eyeShift, DEFAULT_TURN_TARGETS.eyeShift);
    within1Percent(cues.farEyeRatio, DEFAULT_TURN_TARGETS.farEyeRatio);
  });

  it("the far eye stays on the face plate, which is what the slide is bounded by", () => {
    const layers = withNose();
    let report: TurnSolveReport | undefined;
    const { model, radius } = solvedRig(layers, canvas, {
      onTurnSolved: (r) => (report = r),
    });
    const grid = faceWarpOf(model).grid;
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    // The far eye white — the −x one, whichever character side that is — read
    // where its mesh lands its outer edge on its own centre row, against the
    // plate's own edge landed on that row: past it the white is drawn over
    // the side hair, which bends with the plate and swallows it.
    const [far] = ["eye_L", "eye_R"]
      .map((id) => model.parts.find((p) => p.id === id)!)
      .sort((a, b) => a.transform.x - b.transform.x);
    const w = layers.find((l) => l.role === far.id)!.cropW;
    const { x, y } = far.transform;
    expect(landedXAt(model, far.id, x - w / 2, y, turned)).toBeGreaterThan(
      landedXAt(model, "face", faceCenterX - HH, y, turned),
    );
    // The slide is the eye grid's own keyform geometry now — nothing moves
    // before the bind (the white carries no AngleX binding) — so the bound is
    // on the solved depth itself: its full-turn shift never carries the far
    // edge past the plate's rest edge.
    expect(Array.from(preBindVertices(model, far.id, turned))).toEqual(
      Array.from(preBindVertices(model, far.id)),
    );
    const shift = report!.depths.eye * headTurnParallaxUnit(radius);
    expect(x - w / 2 - shift).toBeGreaterThanOrEqual(faceCenterX - HH);
  });

  it("a bigger eye shift slides the eyes further, and takes the nose and mouth with it", () => {
    const layers = withNose();
    const base = generateIkiFromLayerSet(layers, canvas);
    const more = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: { eyeShift: 0.26 },
    });
    // Where each lands at full turn against rest: further toward the far side
    // (−x) on the bigger ask.
    const shiftOf = (model: typeof base, role: string) =>
      landedCentroidX(model, role, turned) - landedCentroidX(model, role);
    for (const role of ["eye_L", "nose", "mouth"]) {
      expect(shiftOf(more, role), role).toBeLessThan(shiftOf(base, role));
    }
    within1Percent(cuesOf(more, layers, HH).eyeShift, 0.26);
  });

  it("an explicit nose shift wins over the one derived from the eyes", () => {
    const layers = withNose();
    const derived = generateIkiFromLayerSet(layers, canvas);
    // 0.25 against the 0.2992 this fixture derives (NOSE_SHIFT_SHARE 1.36 ×
    // the 0.22 eye cue it reaches): a shallower nose than the eyes imply, and
    // inside what the layer set can carry — the plate's own 75px slide is the
    // floor under every shift cue now, so the 0.1 this asked for before is
    // refused outright (attainable 0.209…0.839 on this fixture).
    const explicit = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: { noseShift: 0.25 },
    });
    // Same eye target, so the eyes land identically — the same rig around
    // them, the same float32 pipeline — and only the nose moves: shallower,
    // so it lands further toward the near side.
    expect(Array.from(landVertices(explicit, "eye_L", turned))).toEqual(
      Array.from(landVertices(derived, "eye_L", turned)),
    );
    expect(landedCentroidX(explicit, "nose", turned)).toBeGreaterThan(
      landedCentroidX(derived, "nose", turned),
    );
  });

  it("a flatter far eye is a rounder head: the radius follows the ratio", () => {
    const layers = withNose();
    const flat = solvedRig(layers, canvas, {
      turnTargets: { farEyeRatio: 0.8 },
    });
    const round = solvedRig(layers, canvas, {
      turnTargets: { farEyeRatio: 0.62 },
    });
    expect(round.radius).toBeLessThan(flat.radius);
    within1Percent(cuesOf(round.model, layers, HH).farEyeRatio, 0.62);
    within1Percent(cuesOf(flat.model, layers, HH).farEyeRatio, 0.8);
  });

  it("the same character at two hair widths reaches the same cues, and rigs its whites identically: the eye grids are the whites' own", () => {
    const wide = wideBangs();
    const narrow = withNose();
    let wideTurn: TurnSolveReport | undefined;
    let narrowTurn: TurnSolveReport | undefined;
    const wideModel = generateIkiFromLayerSet(wide, canvas, {
      onTurnSolved: (r) => (wideTurn = r),
    });
    const narrowModel = generateIkiFromLayerSet(narrow, canvas, {
      onTurnSolved: (r) => (narrowTurn = r),
    });
    for (const [model, layers, turn] of [
      [wideModel, wide, wideTurn!],
      [narrowModel, narrow, narrowTurn!],
    ] as const) {
      const cues = cuesOf(model, layers, HH);
      // Independently re-derived agrees with what the solver reports it
      // reached. Render against report, to the oracle's float32 rounding (the
      // golden suite's own margin): a drift between the two would pass a 1 %
      // check unseen.
      expect(cues.eyeShift).toBeCloseTo(turn.achieved.eyeShift, 6);
      expect(cues.farEyeRatio).toBeCloseTo(turn.achieved.farEyeRatio, 6);
    }
    // Same cues, same eye rig: the eye grids are sized to the whites, not the
    // bangs, and without a measured head the silhouette is read at the bangs'
    // own crop edges — both past the hold base here, where every strand moves
    // by the hold edge's displacement plus the same row's lead, so the
    // silhouette centre drifts by the lead alone on either width and the eyes
    // are solved to the same depth on the same grid. (On the shared union
    // lattice the bangs' extent used to reshape the grid under the eyes.)
    // Only the bangs' own warps differ.
    const landingOf = (model: typeof wideModel) => {
      const { x, y } = model.parts.find((p) => p.id === "eye_L")!.transform;
      return landedXAt(model, "eye_L", x, y, turned);
    };
    expect(groupWarpOf(wideModel, "eyeWarp_L")).toEqual(
      groupWarpOf(narrowModel, "eyeWarp_L"),
    );
    expect(landingOf(wideModel)).toBe(landingOf(narrowModel));
    expect(wideTurn!.depths.eye).toBe(narrowTurn!.depths.eye);
    expect(
      wideModel.parts.find((p) => p.id === "hair_front")!.mesh!.vertices,
    ).not.toEqual(
      narrowModel.parts.find((p) => p.id === "hair_front")!.mesh!.vertices,
    );
  });

  // ── the silhouette ratio ──────────────────────────────────────────────────

  it("a measured head narrows the silhouette by the ratio, and only past the boundary", () => {
    // The wide-bangs variant: the 700 px bangs stop short of the 400 px
    // boundary, so they have no strand past it to measure the narrowing on;
    // the 1000 px ones do.
    const layers = wideBangs();
    const targets = { headHalfWidth: 400, silhouetteRatio: 0.9 };
    const { model, radius } = solvedRig(layers, canvas, {
      turnTargets: targets,
    });
    const grid = faceWarpOf(model).grid;
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    const turn = solveTurnModel(
      resolveTurnTargets(targets),
      ...turnSolveInputs(layers),
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    // The direct solve IS the rig's: same radius, and the same sideways
    // travel the generated grid carries (the solve caps that travel, so the
    // two agreeing is what says the rig was built with what was solved).
    expect(turn.radius).toBeCloseTo(radius, 6);
    expect(turn.travel).toBeCloseTo(travelOf(model), 6);
    // The measured head IS the boundary, and it holds its rest place; only its
    // DESTINATION narrows, and only by |deg|/30 of the hold's own ratio. That
    // ratio is FITTED rather than taken from the ask: 0.9 is what a render has
    // to MEASURE. The measured edge (±400) is read on the bangs' own mesh
    // between the vertex at 375 (in the ramp, off the plate's RENDERED edge)
    // and the one at 500 (past the boundary), so it lands a hair off the
    // hold's own destination and the fitted hold sits a hair off the ask
    // (≈0.9001 here; a hair the other way when the plate's edge was read off
    // the shared grid instead of its own).
    expect(turn.holdBase).toBe(400);
    expect(turn.holdEdgeAt(0)).toBe(400);
    expect(turn.achieved.silhouetteRatio).toBeCloseTo(0.9, 8);
    const fittedHold = turn.holdEdgeAt(30) / turn.holdBase;
    expect(fittedHold).not.toBe(0.9);
    expect(Math.abs(fittedHold - 0.9)).toBeLessThan(0.0005);
    expect(turn.holdEdgeAt(-30)).toBeCloseTo(400 * fittedHold, 9);
    expect(turn.holdEdgeAt(15)).toBeCloseTo(
      400 * (1 + (fittedHold - 1) / 2),
      9,
    );

    // The fixture's own bangs stop short of 400, so the strands that carry the
    // ratio are checked on a mesh wide enough to have some: vertex xs every 50
    // from -500 to 500, about the same face centre, on the plate this solve
    // renders.
    const mesh = createPixelGridMesh(20, 2, 1000, 100);
    const col = (x: number) => (x - faceCenterX + 500) / 50;
    const [, , , , , , carriers, , hairFront] = turnSolveInputs(layers);
    // The plate as the solve read it: its own grid and mesh, the carrier.
    const plate = carriers.get("face")!;
    const plateLandingAt = plateLandingOn(plate, turn.surface.mapAt);
    const warp = bakeHairFrontSilhouetteWarp(
      mesh,
      faceCenterX,
      0,
      faceCenterX,
      plateLandingAt,
      () => HH,
      turn.holdBase,
      turn.holdEdgeAt,
      plateGuardRowsFor(plate.part, hairFront),
    );
    for (const o of warp.keyforms.find((k) => k.value === 0)!.offsets) {
      expect(o).toBe(0);
    }
    for (const deg of [-30, -15, 15, 30]) {
      const k = warp.keyforms.find((x) => x.value === deg)!;
      // The hold is direct: a vertex lands at its rest x plus its offset.
      const landing = (d: number) => {
        const x = faceCenterX + d;
        return x + k.offsets[col(x) * 2] - faceCenterX;
      };
      // The boundary lands on its own destination — the ratio's share of this
      // stop — and the strands outside it take the SAME displacement, slope 1,
      // so the spacing between them survives.
      const side = Math.sign(deg);
      const edge = turn.holdEdgeAt(deg);
      expect(landing(side * 400)).toBeCloseTo(side * edge, 6);
      expect(landing(side * 450)).toBeCloseTo(side * (450 - (400 - edge)), 6);
      expect(landing(side * 500)).toBeCloseTo(side * (500 - (400 - edge)), 6);
      expect(landing(side * 450) - landing(side * 400)).toBeCloseTo(
        side * 50,
        6,
      );
      // And no row folds on the way.
      const stride = 21;
      for (let row = 0; row * stride < mesh.vertices.length / 2; row++) {
        let prev = -Infinity;
        for (let c = 0; c < stride; c++) {
          const v = row * stride + c;
          const x = mesh.vertices[v * 2] + k.offsets[v * 2];
          expect(x).toBeGreaterThan(prev);
          prev = x;
        }
      }
    }
  });

  it("a measured head wider than the bangs that draw it holds the DEFAULT silhouette with a hold wider than the head, its inner strands ramping off the RENDERED plate", () => {
    // 400 is hair_back's own half-width here: the widest part of the head,
    // and so the head a measurement of this character returns — 50 px wider
    // than the bangs (350) that carry the hold. Those outermost strands sit
    // INSIDE the boundary, in the hold's RAMP, so to land them on the
    // boundary at full turn — what the DEFAULT silhouetteRatio (1, held)
    // asks — the hold's own destination has to overshoot the head. No grid
    // edge stops it any more, so it does, and nothing is cut down.
    const layers = withNose();
    const targets = { headHalfWidth: 400 };
    const { model, radius } = solvedRig(layers, canvas, {
      turnTargets: targets,
    });
    const faceCenterX = model.parts.find((p) => p.id === "face")!.transform.x;
    const turn = solveTurnModel(
      resolveTurnTargets(targets),
      ...turnSolveInputs(layers),
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(turn.radius).toBeCloseTo(radius, 6);
    expect(turn.holdBase).toBe(400);
    expect(turn.clamped).not.toContain("silhouetteRatio");
    expect(turn.achieved.silhouetteRatio).toBeCloseTo(1, 8);
    expect(turn.holdEdgeAt(30)).toBeGreaterThan(400);
    // A render measures it: the silhouette points the solve read (the head's
    // own edges, ±400, which the bangs' mesh renders as its nearest column)
    // land at their rest span, to the oracle's float32 rounding.
    const edges = {
      left: [{ role: "hair_front", x: faceCenterX - 400 }],
      right: [{ role: "hair_front", x: faceCenterX + 400 }],
    };
    expect(cuesOf(model, layers, 400, edges).silhouetteRatio).toBeCloseTo(1, 6);

    // The ramp's inner end is the plate as it RENDERS — the face's own landed
    // mesh — not the bare surface: on the root row (no lead) the outermost
    // strand on each side lands on the ramp from the face's painted edge's
    // own landing to the hold edge, at its own fraction of the band.
    const hair = model.parts.find((p) => p.id === "hair_front")!;
    const rootY = hair.transform.y + hair.mesh!.vertices[1];
    const stride = meshCellsFor(700, 400).cols + 1;
    const rootXs = Array.from(
      { length: stride },
      (_, c) => hair.transform.x + hair.mesh!.vertices[c * 2],
    );
    const landed = landVertices(model, "hair_front", turned);
    for (const [v, side] of [
      [0, -1],
      [stride - 1, 1],
    ] as const) {
      const x = rootXs[v];
      expect(Math.abs(x - faceCenterX)).toBeGreaterThan(HH);
      expect(Math.abs(x - faceCenterX)).toBeLessThan(400);
      const inner = landedXAt(
        model,
        "face",
        faceCenterX + side * HH,
        rootY,
        turned,
      );
      const u = (Math.abs(x - faceCenterX) - HH) / (turn.holdBase - HH);
      expect(landed[v * 2]).toBeCloseTo(
        inner + (faceCenterX + side * turn.holdEdgeAt(-30) - inner) * u,
        4,
      );
    }
  });

  it("a CALLER-measured silhouette no hold renders is refused, naming ONE rendered range whatever was asked, both ends of which rig", () => {
    // Same measured head, silhouetteRatio now the CALLER's own number — a
    // measurement, not a style prior, so what no hold renders is refused
    // instead of quietly cut down. Held (1) IS rendered here (see above); a
    // narrowing past the plate's fold floor is not.
    const layers = withNose();
    const messageAt = (silhouetteRatio: number) => {
      try {
        generateIkiFromLayerSet(layers, canvas, {
          turnTargets: { headHalfWidth: 400, silhouetteRatio },
        });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(messageAt(1)).toBe("");
    const narrowMessage = messageAt(0.6);
    expect(narrowMessage).toMatch(
      /turnTargets\.silhouetteRatio 0\.6 is unreachable/,
    );
    const [, lower, upper] = /attainable ([\d.]+)…([\d.]+)/.exec(
      narrowMessage,
    )!;
    // Both bounds are ratios a RENDER of this layer set could show — the
    // measure the caller's own number came from — with the hold at each end
    // of its own bracket: that radius' plate-fold floor below, the widest
    // hold the targets accept above. On withNose() + headHalfWidth 400 the
    // floor is ≈0.656; the ceiling is past the held silhouette, since the
    // bangs are free to hold the outline wherever they are sent.
    expect(Number(lower)).toBeGreaterThan(0.65);
    expect(Number(lower)).toBeLessThan(0.66);
    expect(Number(upper)).toBeGreaterThan(1);
    expect(Number(upper)).toBeLessThan(1.5);
    const narrowerMessage = messageAt(0.5);
    expect(narrowerMessage).toMatch(
      /turnTargets\.silhouetteRatio 0\.5 is unreachable/,
    );
    const [, narrowerLower, narrowerUpper] =
      /attainable ([\d.]+)…([\d.]+)/.exec(narrowerMessage)!;
    // Every refusal names the IDENTICAL interval whatever was asked: the
    // bracket it is read off is the hold's own at REST scale, so it belongs to
    // the layer set and this radius sweep rather than to the number that was
    // refused.
    expect(Number(narrowerLower)).toBe(Number(lower));
    expect(Number(narrowerUpper)).toBe(Number(upper));
    // And what it advertises both rigs and LANDS: a caller resubmitting either
    // end gets a rig whose own rendered silhouette is that number, the hold
    // fitted until it is (see the mixed-owner test below).
    for (const bound of [Number(lower), Number(upper)]) {
      expect(messageAt(bound)).toBe("");
      const again = solveFor(layers, {
        headHalfWidth: 400,
        silhouetteRatio: bound,
      });
      if (again.unreachable) {
        throw new Error("expected the advertised bound to rig");
      }
      expect(again.achieved.silhouetteRatio).toBeCloseTo(bound, 8);
    }
  });

  it("a measured head far wider than the bangs still holds the rest pose exactly, and is cut down honestly at the turned stops", () => {
    // headHalfWidth 500 against bangs 350 half-wide: the strands that carry
    // the silhouette sit deep inside the ramp, and even the widest hold the
    // targets accept (1.5) cannot land them on the boundary at full turn. The
    // cut must never reach back into the rest keyform, only the turned stops.
    const layers = withNose();
    const targets = { headHalfWidth: 500 };
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
    });
    const hair = model.parts.find((p) => p.id === "hair_front")!;
    const warp = hair.warps!.find(
      (w) =>
        w.parameter === StandardParameter.AngleX && w.keyforms.length === 5,
    )!;
    const rest = warp.keyforms.find((k) => k.value === 0)!;
    for (const o of rest.offsets) expect(o).toBe(0);

    const turn = solveTurnModel(
      resolveTurnTargets(targets),
      ...turnSolveInputs(layers),
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(turn.holdBase).toBe(500);
    expect(turn.clamped).toContain("silhouetteRatio");
    expect(turn.achieved.silhouetteRatio).toBeLessThan(1);
  });

  it("the reported and re-derived eye cue agree once the silhouette centre's own drift is included", () => {
    // A measured head (350, which happens to equal this fixture's own
    // hair_front half-width, so the hold's boundary IS the rendered edge)
    // with an explicit eyeShift the plain landmark slide alone would
    // overshoot once the silhouette centre moves.
    const layers = withNose();
    const targets = { headHalfWidth: 350, eyeShift: 0.18 };
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
    });
    const turn = solveTurnModel(
      resolveTurnTargets(targets),
      ...turnSolveInputs(layers),
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    // Not clamped: 0.18 is a MEASURED eyeShift this layer set can reach.
    expect(turn.clamped).not.toContain("eyeShift");

    // Re-derive the cue off where the GENERATED model's parts land at −30 —
    // the eye whites and the bangs' own silhouette edge, rendered (see
    // cuesOf) — rather than by reproducing evaluateTurnCandidate's formula.
    const rederivedCue = cuesOf(model, layers, targets.headHalfWidth).eyeShift;

    within1Percent(rederivedCue, targets.eyeShift);
    within1Percent(turn.achieved.eyeShift, targets.eyeShift);
    // Render against report: float32 rounding, not a fit tolerance.
    expect(rederivedCue).toBeCloseTo(turn.achieved.eyeShift, 6);
  });

  it("the nose and mouth report a head-relative shift too, agreeing with the engine", () => {
    // A MEASURED noseShift alongside eyeShift, on the same headHalfWidth:350
    // fixture.
    const layers = withNose();
    const targets = { headHalfWidth: 350, eyeShift: 0.18, noseShift: 0.2 };
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
    });
    const turn = solveTurnModel(
      resolveTurnTargets(targets),
      ...turnSolveInputs(layers),
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(turn.clamped).not.toContain("noseShift");
    const { silhouetteCenterShift } = cuesOf(
      model,
      layers,
      targets.headHalfWidth,
    );
    // Same silhouette-relative cue as the eye's own: where the part's centre
    // lands at −30 against its rest x, against the silhouette centre landing.
    const cueOf = (role: string) => {
      const { x, y } = model.parts.find((p) => p.id === role)!.transform;
      const landed = landedXAt(model, role, x, y, turned);
      return (-(landed - x) + silhouetteCenterShift) / targets.headHalfWidth;
    };
    // Unclamped, so the solve reached the caller's number itself (the report
    // carries no nose cue of its own to read instead), and the render agrees
    // with it to the oracle's float32 rounding. Exact, unlike the eye sweep's
    // within1Percent above: the family depth is bisected to float64 precision
    // (solveTurnDepth, 40 steps), not fitted to a tolerance. The nose and mouth
    // sit below the eye row and read their own rows' map (TurnLandmark.y);
    // this layer set has no row profile, so every row's map is the eye row's
    // — a profile is what can legitimately move this.
    expect(cueOf("nose")).toBeCloseTo(targets.noseShift, 6);

    // The mouth is DERIVED (no explicit mouthShift): MOUTH_SHIFT_SHARE times
    // the ACHIEVED eye cue, mirroring solveFeatureDepths' own formula — again
    // reached, so the render shows it to the same rounding.
    const MOUTH_SHIFT_SHARE = 1.18;
    expect(turn.clamped).not.toContain("mouthShift");
    expect(cueOf("mouth")).toBeCloseTo(
      MOUTH_SHIFT_SHARE * turn.achieved.eyeShift,
      6,
    );
  });

  it("the reported and re-derived eye cue agree on the defaults too", () => {
    // Same check, un-measured: holdBase falls back to the plate's own reach
    // and the silhouette point falls back to hair_front's own crop edge (see
    // evaluateTurnCandidate's `restAt`), which this fixture's bangs do NOT
    // coincide with the way the measured-head fixture above does.
    const layers = withNose();
    const model = generateIkiFromLayerSet(layers, canvas);
    const turn = solveTurnModel(
      resolveTurnTargets({}),
      ...turnSolveInputs(layers),
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(cuesOf(model, layers, HH).eyeShift).toBeCloseTo(
      turn.achieved.eyeShift,
      6,
    );
  });

  it("a back-hair fixture whose bangs are narrower than it reports the achieved cue accurately", () => {
    // withNose()'s hair_back is 800 wide (half 400) against hair_front's 700
    // (half 350): headHalfWidth:400 is hair_back's own half-width, so it owns
    // BOTH silhouette points, not the bangs.
    const layers = withNose();
    const targets = { headHalfWidth: 400, eyeShift: 0.3 };
    // This fixture's face/hair_back/hair_front are all centred on the canvas
    // (see assemblyLayers()), so faceCenterX is 0 without building the model
    // first — headEdges is an input to that build.
    const headEdges = {
      left: [{ role: "hair_back", x: -400 }],
      right: [{ role: "hair_back", x: 400 }],
    };
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
      headEdges,
    });
    const turn = solveFor(layers, targets, headEdges);
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(turn.clamped).not.toContain("eyeShift");

    // hair_back's own eye-row silhouette vertices land where they sit: it
    // rides headDeformer, which does not move on the turn, and carries
    // nothing of its own, so every vertex lands at rest at full turn. The
    // silhouette centre this fixture is measured against therefore does not
    // move at all, however far the face slides inside it.
    expect(Array.from(landVertices(model, "hair_back", turned))).toEqual(
      Array.from(preBindVertices(model, "hair_back")),
    );
    const centreDelta = 0;

    // Where each eye's centre lands at −30 against its rest x — they DO ride
    // their own eye grids.
    const pairOf = (role: string) => {
      const { x, y } = model.parts.find((p) => p.id === role)!.transform;
      return { x, landed: landedXAt(model, role, x, y, turned) };
    };
    const pairDelta =
      (pairOf("eye_L").landed -
        pairOf("eye_L").x +
        (pairOf("eye_R").landed - pairOf("eye_R").x)) /
      2;

    const rederivedCue = (-pairDelta + centreDelta) / targets.headHalfWidth;
    expect(rederivedCue).toBeCloseTo(turn.achieved.eyeShift, 6);
  });

  it("solveTurnModel: an off-centre union reads restAt from its own extremes, not an assumed centred one", () => {
    // hair_back's crop is shifted 40px off the canvas centre, so the "union"
    // headEdges reports is centred there too, not on faceCenterX (still 0 —
    // the face/eyes did not move).
    const layers = offCentreHairBack(-40);
    const targets = { headHalfWidth: 400, eyeShift: 0.25 };
    const back = hairBackOf(layers)!;
    const headEdges = {
      left: [{ role: "hair_back", x: back.x - back.cropW / 2 }],
      right: [{ role: "hair_back", x: back.x + back.cropW / 2 }],
    };
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
      headEdges,
    });
    const grid = faceWarpOf(model).grid;
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    const turn = solveFor(layers, targets, headEdges);
    if (turn.unreachable) throw new Error("expected a reachable turn");

    // hair_back holds the head's outline — every vertex lands at rest at full
    // turn — so both its crop edges land where they sit and the UNION's own
    // centre — which is what measure_turn_reference reads the eye pair
    // against, and which sits 40px off the face centre here — does not move.
    const backPart = model.parts.find((p) => p.id === "hair_back")!;
    expect(Array.from(landVertices(model, "hair_back", turned))).toEqual(
      Array.from(preBindVertices(model, "hair_back")),
    );
    const centreDelta = 0;
    // A solve that read `restAt` off an assumed faceCenterX-centred head
    // instead of these edges would drift the centre by the crop's own 40px
    // offset, and the cue below would miss by 0.1 of the head half-width.
    expect(backPart.transform!.x).toBeCloseTo(faceCenterX - 40, 9);

    const pairOf = (role: string) => {
      const { x, y } = model.parts.find((p) => p.id === role)!.transform;
      return { x, landed: landedXAt(model, role, x, y, turned) };
    };
    const pairDelta =
      (pairOf("eye_L").landed -
        pairOf("eye_L").x +
        (pairOf("eye_R").landed - pairOf("eye_R").x)) /
      2;

    const rederivedCue = (-pairDelta + centreDelta) / targets.headHalfWidth;
    expect(rederivedCue).toBeCloseTo(turn.achieved.eyeShift, 6);
  });

  it("solveTurnModel: an off-centre union no longer refuses a reachable eyeShift", () => {
    const layers = offCentreHairBack(60);
    const back = hairBackOf(layers)!;
    const headEdges = {
      left: [{ role: "hair_back", x: back.x - back.cropW / 2 }],
      right: [{ role: "hair_back", x: back.x + back.cropW / 2 }],
    };
    const s = solveFor(
      layers,
      { headHalfWidth: 400, eyeShift: 0.25 },
      headEdges,
    );
    expect(s.unreachable).toBe(false);
  });

  it("solveTurnModel: a side with two candidate roles takes the outermost LANDING, not the outermost rest x", () => {
    // Both candidates sit at each role's own crop edge (hair_front narrower at
    // rest, -350, than hair_back's -400), so the rest-time owner is hair_back
    // — the point of this test is that the LANDING ordering, not the rest
    // one, decides, and it can go either way depending on each role's own
    // deformation, not just which one started further out.
    const layers = withNose();
    const targets = { headHalfWidth: 400, eyeShift: 0.3 };
    const right = [{ role: "hair_back", x: 400 }];
    const frontOnly = solveFor(layers, targets, {
      left: [{ role: "hair_front", x: -350 }],
      right,
    });
    const backOnly = solveFor(layers, targets, {
      left: [{ role: "hair_back", x: -400 }],
      right,
    });
    const both = solveFor(layers, targets, {
      left: [
        { role: "hair_front", x: -350 },
        { role: "hair_back", x: -400 },
      ],
      right,
    });
    // Neither single-candidate answer is degenerate, and they differ (else
    // this would not be exercising a real choice between them).
    if (frontOnly.unreachable || backOnly.unreachable || both.unreachable) {
      throw new Error("expected all three to be reachable");
    }
    expect(frontOnly.achieved.silhouetteRatio).not.toBe(
      backOnly.achieved.silhouetteRatio,
    );
    // `both` matches whichever single-candidate answer its own outermost pick
    // agrees with — toEqual can't diff the `holdEdgeAt` closure, so compare
    // through JSON, which drops it from both sides identically.
    expect(JSON.stringify(both)).toBe(JSON.stringify(backOnly));
  });

  it("solveTurnModel: a headEdges candidate on the face plate lands where the RENDERED plate puts it, not rigidly", () => {
    const layers = withNose();
    const targets = { headHalfWidth: 400, eyeShift: 0.4 };
    const right = [{ role: "hair_back", x: 400 }];
    const faceX = -targets.headHalfWidth;
    const withFace = solveFor(layers, targets, {
      left: [{ role: "face", x: faceX }],
      right,
    });
    if (withFace.unreachable) throw new Error("expected a reachable turn");
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
      headEdges: { left: [{ role: "face", x: faceX }], right },
    });
    // face has no depth parallax of its own (see roleOwnBindings): its
    // landing is where its own mesh over its own plate grid puts that point
    // on the eye row — read off the generated model with the oracle, as the
    // solve reads it through the plate's carrier. The candidate sits 100 px
    // past the plate's crop, so both read the plate's edge column, the
    // nearest point the face draws — which the turn moves, or the check below
    // would pass for "rigid" too.
    const eyeRowY =
      (model.parts.find((p) => p.id === "eye_L")!.transform.y +
        model.parts.find((p) => p.id === "eye_R")!.transform.y) /
      2;
    const landingFace = landedXAt(model, "face", faceX, eyeRowY, turned);
    expect(landingFace).not.toBeCloseTo(faceX, 1);

    // The right-hand edge is hair_back's, which holds: it lands on its own
    // rest x — same recipe as "a back-hair fixture..." above.
    const restNear = right[0].x;
    expect(Array.from(landVertices(model, "hair_back", turned))).toEqual(
      Array.from(preBindVertices(model, "hair_back")),
    );
    const landingNear = restNear;

    const centreDelta =
      (landingFace + landingNear) / 2 - (faceX + restNear) / 2;
    // Where each eye's centre lands at −30 against its rest x.
    const pairOf = (role: string) => {
      const { x, y } = model.parts.find((p) => p.id === role)!.transform;
      return { x, landed: landedXAt(model, role, x, y, turned) };
    };
    const pairDelta =
      (pairOf("eye_L").landed -
        pairOf("eye_L").x +
        (pairOf("eye_R").landed - pairOf("eye_R").x)) /
      2;
    // Render against report, to the oracle's float32 rounding.
    const rederivedCue = (-pairDelta + centreDelta) / targets.headHalfWidth;
    expect(rederivedCue).toBeCloseTo(withFace.achieved.eyeShift, 6);
  });

  it("solveTurnModel: a headEdges candidate naming hair_back lands at its own rest x", () => {
    const layers = withNose();
    const targets = { headHalfWidth: 400, eyeShift: 0.3 };
    // Called directly rather than through `solveFor`: the point is that the
    // solve is handed the bangs' geometry and nothing of hair_back's, and
    // still places a hair_back edge.
    const solved = solveTurnModel(
      resolveTurnTargets(targets),
      ...turnSolveInputs(layers),
      {
        left: [{ role: "hair_back", x: -400 }],
        right: [{ role: "hair_back", x: 400 }],
      },
    );
    if (solved.unreachable) throw new Error("expected a reachable turn");
    // Both silhouette edges belong to the held shell, so the span a render
    // measures at full turn IS the rest span — exactly, not within a
    // tolerance: the solve sends each edge back to the x it already sits at.
    expect(solved.achieved.silhouetteRatio).toBe(1);
  });

  it("solveTurnModel: a CALLER's narrowing is refused where a STATIC shell owns both edges", () => {
    // Same held shell as above, now against a caller-measured ratio. hair_back
    // keeps its rest place through the turn, so the span a render measures IS
    // the rest span whatever destination the bangs' hold is sent to: 0.8 is
    // not something this layer set can show, and it is refused rather than
    // rigged as a 1 and reported as achieved.
    const layers = withNose();
    const targets = { headHalfWidth: 400 };
    const headEdges = {
      left: [{ role: "hair_back", x: -400 }],
      right: [{ role: "hair_back", x: 400 }],
    };
    const narrow = solveFor(
      layers,
      { ...targets, silhouetteRatio: 0.8 },
      headEdges,
    );
    expect(narrow.unreachable).toBe(true);
    if (!narrow.unreachable) return;
    expect(narrow.field).toBe("silhouetteRatio");
    expect(narrow.value).toBe(0.8);
    // A static shell renders its own rest span at every hold, so the interval
    // is that one ratio twice — not a range the hold can be walked along.
    expect(narrow.attainable).toEqual([1, 1]);
    // What it advertises rigs, renders exactly that, and is NOT reported as
    // cut down: where the bangs' own strands land inside that shell is the
    // hold's business and never the silhouette's.
    const held = solveFor(
      layers,
      { ...targets, silhouetteRatio: 1 },
      headEdges,
    );
    if (held.unreachable) {
      throw new Error("expected the attainable ratio to rig");
    }
    expect(held.achieved.silhouetteRatio).toBe(1);
    expect(held.clamped).not.toContain("silhouetteRatio");
    // The DEFAULTED ratio rigs too, and needs no clamp either: the shell
    // renders its own rest span, which IS the default, so the hold the
    // default names is shipped untouched.
    const defaulted = solveFor(layers, targets, headEdges);
    if (defaulted.unreachable) {
      throw new Error("a default must never refuse to rig");
    }
    expect(defaulted.achieved.silhouetteRatio).toBe(1);
    expect(defaulted.clamped).not.toContain("silhouetteRatio");
    expect(defaulted.holdEdgeAt(30) / defaulted.holdBase).toBe(1);
  });

  it("solveTurnModel: a CALLER-measured silhouette on a mixed-owner shell leaves the far/near ratio fit intact", () => {
    // A caller-measured silhouette narrows the feasible radii to the ones
    // whose own rendered range covers it. With the bangs free to hold the
    // outline wherever they are sent, that range covers this ask at every
    // radius of the sweep, so the far/near fit runs on the whole sweep: both
    // ratios are met exactly and nothing is reported cut — where a fit that
    // bisected across a refused radius used to ship the wrong run's edge.
    // The asks span the sweep's own range: its tightest radius — the plate's
    // half-width with the no-fold margin — foreshortens this fixture's far
    // white to ≈0.613 once the white is read through its own 4-cell grid
    // (the shared 145 px lattice cells used to chord the bend past that, to
    // 0.589), so 0.62 is the tight end of what a caller can ask.
    const layers = withNose();
    const base = { headHalfWidth: 400, silhouetteRatio: 0.977997 };
    const headEdges = {
      left: [{ role: "hair_front", x: -350 }],
      right: [{ role: "hair_back", x: 400 }],
    };
    for (const asked of [0.62, 0.67, 0.72, 0.8]) {
      const fitted = solveFor(
        layers,
        { ...base, farEyeRatio: asked },
        headEdges,
      );
      if (fitted.unreachable) throw new Error(`expected ${asked} to rig`);
      expect(fitted.achieved.farEyeRatio).toBeCloseTo(asked, 8);
      expect(fitted.achieved.silhouetteRatio).toBeCloseTo(
        base.silhouetteRatio,
        8,
      );
      expect(fitted.clamped).toEqual([]);
    }
    // A far/near ratio no radius produces still names the run that exists.
    const refused = solveFor(layers, { ...base, farEyeRatio: 0.2 }, headEdges);
    expect(refused.unreachable).toBe(true);
    if (!refused.unreachable) return;
    expect(refused.field).toBe("farEyeRatio");
    const [lo, hi] = refused.attainable!;
    expect(lo).toBeLessThan(0.62);
    expect(hi).toBeGreaterThan(0.8);
  });

  it("solveTurnModel: a far/near ratio in a GAP between feasible radii is refused, not rigged at the nearest run's edge", () => {
    // A caller-measured eyeShift refuses the radii that cannot land it, and
    // it does that in the MIDDLE of the sweep: 0.16 of this head (64 px) sits
    // just under the eye pair's own drift at depth 0 — the plate's slide plus
    // the bend — which GROWS with the radius through the middle of the sweep
    // and falls back under the ask only at the flat end, where
    // `shellTravelCap` cuts the slide the shell has no room for (75 → 42 px).
    // The radii that survive therefore come in two runs: the tight one — the
    // sweep's floor radius alone, far/near ≈0.628, the whites read through
    // their own grids drifting past the ask one sample later — and the flat
    // ones, ≈[0.849, 0.941], with nothing in between. A target in that gap
    // used to be bisected across it and shipped at a run's edge with
    // `clamped: []`.
    const layers = withNose();
    const base = { headHalfWidth: 400, eyeShift: 0.16 };
    const headEdges = {
      left: [{ role: "hair_front", x: -350 }],
      right: [{ role: "hair_back", x: 400 }],
    };
    const refused = solveFor(layers, { ...base, farEyeRatio: 0.67 }, headEdges);
    expect(refused.unreachable).toBe(true);
    if (!refused.unreachable) return;
    expect(refused.field).toBe("farEyeRatio");
    expect(refused.value).toBe(0.67);
    // The nearest RUN's own range, not the span across the gap.
    const [lo, hi] = refused.attainable!;
    expect(lo).toBeGreaterThan(0.6);
    expect(hi).toBeLessThan(0.66);
    // A target on the far side of the gap names the run on ITS side.
    const above = solveFor(layers, { ...base, farEyeRatio: 0.8 }, headEdges);
    expect(above.unreachable).toBe(true);
    if (!above.unreachable) return;
    expect(above.attainable![0]).toBeGreaterThan(0.84);
    expect(above.attainable![0]).toBeLessThan(0.86);
    expect(above.attainable![1]).toBeLessThan(0.95);
    // The generator's own message names that same range.
    expect(() =>
      generateIkiFromLayerSet(layers, canvas, {
        turnTargets: { ...base, farEyeRatio: 0.67 },
        headEdges,
      }),
    ).toThrow(
      new RegExp(
        `turnTargets\\.farEyeRatio 0\\.67 is unreachable for this layer set \\(attainable ${lo}…${hi}\\)`,
      ),
    );
    // Inside either run — the tight run's own end, and a flat radius — the
    // target is met exactly and nothing is reported cut.
    for (const asked of [lo, 0.9]) {
      const fitted = solveFor(
        layers,
        { ...base, farEyeRatio: asked },
        headEdges,
      );
      if (fitted.unreachable) throw new Error(`expected ${asked} to rig`);
      expect(fitted.achieved.farEyeRatio).toBeCloseTo(asked, 8);
      expect(fitted.achieved.eyeShift).toBeCloseTo(base.eyeShift, 8);
      expect(fitted.clamped).toEqual([]);
    }
    // The DEFAULT (0.67) falls in the same gap: it rigs on the nearest run's
    // edge and SAYS so, where it used to report the miss as a cue it had met.
    const defaulted = solveFor(layers, base, headEdges);
    if (defaulted.unreachable) {
      throw new Error("a default must never refuse to rig");
    }
    expect(defaulted.clamped).toContain("farEyeRatio");
    expect(defaulted.achieved.farEyeRatio).toBeCloseTo(hi, 8);
    expect(defaulted.achieved.farEyeRatio).toBeLessThan(
      DEFAULT_TURN_TARGETS.farEyeRatio,
    );
  });

  it("solveTurnModel: a mixed-owner shell names the range its ONE moving side can render, and fits inside it", () => {
    // The static edge on the -x side and the moving one on the +x: the bangs'
    // side carries the whole change on its own, so what a render can show is
    // narrower than the hold's own ratio range — a widening past what the
    // moving strand reaches, even under the widest hold the targets accept,
    // is refused in the RENDERED range's own terms.
    const layers = withNose();
    const base = { headHalfWidth: 400 };
    const headEdges = {
      left: [{ role: "hair_back", x: -400 }],
      right: [{ role: "hair_front", x: 350 }],
    };
    const refused = solveFor(
      layers,
      { ...base, silhouetteRatio: 1.2 },
      headEdges,
    );
    expect(refused.unreachable).toBe(true);
    if (!refused.unreachable) return;
    expect(refused.field).toBe("silhouetteRatio");
    const offered = refused.attainable!;
    // Ordered, a real interval rather than a point, and short of the ask.
    expect(offered[0]).toBeLessThan(1);
    expect(offered[1]).toBeGreaterThan(1);
    expect(offered[1]).toBeLessThan(1.2);
    // Both ends rig, and a render of each measures the end it advertised.
    for (const bound of offered) {
      const again = solveFor(
        layers,
        { ...base, silhouetteRatio: bound },
        headEdges,
      );
      if (again.unreachable) {
        throw new Error(`expected ${bound} to rig`);
      }
      expect(again.achieved.silhouetteRatio).toBeCloseTo(bound, 8);
    }
    // And so does an ask inside it, which is the fit working in whichever
    // sampled interval straddles it rather than in an assumed direction.
    const inside = (offered[0] + offered[1]) / 2;
    const fitted = solveFor(
      layers,
      { ...base, silhouetteRatio: inside },
      headEdges,
    );
    if (fitted.unreachable) throw new Error("expected the midpoint to rig");
    expect(fitted.achieved.silhouetteRatio).toBeCloseTo(inside, 8);
    expect(fitted.clamped).not.toContain("silhouetteRatio");
    // The held DEFAULT is inside it too, and needs a hold WIDER than the head
    // to render: the static side takes no share, so the moving strand — in
    // the ramp, inside the boundary — has to be sent past it.
    const defaulted = solveFor(layers, base, headEdges);
    if (defaulted.unreachable) {
      throw new Error("a default must never refuse to rig");
    }
    expect(defaulted.achieved.silhouetteRatio).toBeCloseTo(1, 8);
    expect(defaulted.clamped).not.toContain("silhouetteRatio");
    expect(defaulted.holdEdgeAt(30)).toBeGreaterThan(defaulted.holdBase);
  });

  it("solveTurnModel: a silhouette edge between mesh columns lands where the shipped mesh puts it", () => {
    // The measured edge sits mid-cell — 0.43 of a column across, and on the
    // eye row, which falls between two mesh rows because the bangs' own turn
    // lead is baked per row. Interpolating anything but the FINAL, already
    // mapped vertex positions (the pre-bind xs, or an analytic lead at the
    // measured row) drifts from what the renderer draws there, and the fit
    // would then hit a number the shipped mesh does not.
    const layers = withNose();
    const hairLayer = layers.find((l) => l.role === "hair_front")!;
    const { cols, rows } = meshCellsFor(hairLayer.cropW, hairLayer.cropH);
    const hf = hairFrontOf(layers);
    const cellW = hf.cropW / cols;
    // The eye row's own fraction of the crop, the row measure_turn_reference
    // reads the silhouette on — solveTurnModel's own formula.
    const eyeRowY =
      (turnLandmarks(layers).eye[0].y! + turnLandmarks(layers).eye[1].y!) / 2;
    const rowFrac = (hf.centerY + hf.cropH / 2 - eyeRowY) / hf.cropH;
    expect(rowFrac).toBeGreaterThan(0);
    expect(rowFrac).toBeLessThan(1);
    const r = rowFrac * rows;
    // A real fraction: the row sits between two mesh rows, which is the case
    // this is about.
    expect(r - Math.floor(r)).toBeGreaterThan(0);
    // Two candidates: one 0.43 of a column across — inside a cell, not on a
    // corner — and one ON the crop's own edge column, the point the solve
    // falls back to when nothing measured the head. Both inside the hold's
    // RAMP (past the plate's own half-width, inside the measured head), so
    // the hold and the lead both move them.
    for (const colFraction of [0.43, 0]) {
      const edgeX = hf.x - hf.cropW / 2 + colFraction * cellW;
      expect(Math.abs(edgeX)).toBeGreaterThan(HH);
      const staticEdgeX = 400;
      const targets = { headHalfWidth: 400 };
      const headEdges = {
        left: [{ role: "hair_front", x: edgeX }],
        right: [{ role: "hair_back", x: staticEdgeX }],
      };
      let report: TurnSolveReport | undefined;
      const model = generateIkiFromLayerSet(layers, canvas, {
        turnTargets: targets,
        headEdges,
        onTurnSolved: (r) => (report = r),
      });
      // hair_back holds its rest x, so the solve's own landing for the bangs'
      // edge falls out of the ratio it reports.
      const solverLanding =
        staticEdgeX - report!.achieved.silhouetteRatio * (staticEdgeX - edgeX);
      // The same point where the SHIPPED mesh renders it: the oracle lands the
      // surrounding vertices as the engine does and interpolates over the
      // TRIANGLE the point falls in ([BL, BR, TL] below the TL→BR diagonal,
      // [TL, BR, TR] above it), never bilinearly — a bilinear patch would
      // differ by its own cross term, 0.085 px on this fixture. The landing is
      // float32 (an ulp of 3e-5 at |x| < 512), so the solver's float64 agrees
      // to that rounding.
      expect(
        landedXAt(model, "hair_front", edgeX, eyeRowY, turned),
        `column fraction ${colFraction}`,
      ).toBeCloseTo(solverLanding, 4);
    }
  });

  it("solveTurnModel: what a refusal offers stays inside the ratios turnTargets accepts, and says so when nothing does", () => {
    // A silhouette the face plate's own slide all but closes: the -x edge is
    // the plate's own corner, which slides and bends, and the +x edge a static
    // hair_back 110px away, so what a render measures is a small fraction of
    // a small rest span. Some radii render it below the 0.5 the targets accept
    // at all — those have nothing to offer a caller and say nothing, rather
    // than advertising a floor `resolveTurnTargets` would throw on.
    const layers = withNose();
    const targets = { headHalfWidth: 400, silhouetteRatio: 1 };
    const headEdges = {
      left: [{ role: "face", x: -300 }],
      right: [{ role: "hair_back", x: -190 }],
    };
    const refused = solveFor(layers, targets, headEdges);
    expect(refused.unreachable).toBe(true);
    if (!refused.unreachable) return;
    const offered = refused.attainable!;
    expect(offered[0]).toBeGreaterThan(0.5);
    expect(offered[1]).toBeLessThan(1.5);
    // Everything it offers rigs and lands...
    for (const bound of offered) {
      const again = solveFor(
        layers,
        { ...targets, silhouetteRatio: bound },
        headEdges,
      );
      if (again.unreachable) throw new Error(`expected ${bound} to rig`);
      expect(again.achieved.silhouetteRatio).toBeCloseTo(bound, 8);
    }
    // ...and the domain's own floor, which it stops short of, does not: the
    // interval is the reachable intersection, not the domain clipped onto an
    // unreachable range.
    const atDomainFloor = solveFor(
      layers,
      { ...targets, silhouetteRatio: 0.5 },
      headEdges,
    );
    expect(atDomainFloor.unreachable).toBe(true);

    // Pull the static edge further in and nothing inside the accepted range
    // renders at all, which the refusal says outright instead of naming an
    // interval it cannot honour.
    expect(() =>
      generateIkiFromLayerSet(layers, canvas, {
        turnTargets: targets,
        headEdges: {
          left: [{ role: "face", x: -300 }],
          right: [{ role: "hair_back", x: -230 }],
        },
      }),
    ).toThrow(
      /turnTargets\.silhouetteRatio 1 is unreachable for this layer set, and so is every silhouetteRatio in \[0\.5, 1\.5\]/,
    );
    const nothing = solveFor(layers, targets, {
      left: [{ role: "face", x: -300 }],
      right: [{ role: "hair_back", x: -230 }],
    });
    expect(nothing.unreachable).toBe(true);
    if (!nothing.unreachable) return;
    expect(nothing.attainable).toBeUndefined();
  });

  it("solveTurnModel: a CALLER's silhouette is FITTED, so a mixed-owner shell renders exactly the ask", () => {
    // hair_front owns the -x edge — it moves with the hold — and a static
    // hair_back owns the +x one, which does not, so the hold's own ratio and
    // what a render measures are two different numbers. The caller's number is
    // the render's, so the solve fits the hold until the rendered span IS the
    // ask instead of carrying the ask through as the hold and landing short.
    const layers = withNose();
    const base = { headHalfWidth: 400 };
    const headEdges = {
      left: [{ role: "hair_front", x: -350 }],
      right: [{ role: "hair_back", x: 400 }],
    };
    for (const asked of [0.9, 0.95]) {
      const s = solveFor(
        layers,
        { ...base, silhouetteRatio: asked },
        headEdges,
      );
      if (s.unreachable) throw new Error(`expected ${asked} to rig`);
      expect(s.achieved.silhouetteRatio).toBeCloseTo(asked, 8);
      expect(s.clamped).not.toContain("silhouetteRatio");
      // The hold it ships is NOT the ask: the static edge takes no share of
      // the narrowing, so the moving one has to carry all of it and its own
      // destination goes further in than the ask does.
      expect(s.holdEdgeAt(30) / s.holdBase).toBeLessThan(asked);
    }
    // Narrower than that half-static silhouette can render, it is refused
    // rather than rigged short — and the refusal names the rendered range.
    const tooNarrow = solveFor(
      layers,
      { ...base, silhouetteRatio: 0.85 },
      headEdges,
    );
    expect(tooNarrow.unreachable).toBe(true);
    if (!tooNarrow.unreachable) return;
    expect(tooNarrow.field).toBe("silhouetteRatio");
    expect(tooNarrow.attainable[0]).toBeGreaterThan(0.85);
    expect(tooNarrow.attainable[0]).toBeLessThan(0.9);
    // The floor it names is itself reachable, and lands.
    const atFloor = solveFor(
      layers,
      { ...base, silhouetteRatio: tooNarrow.attainable![0] },
      headEdges,
    );
    if (atFloor.unreachable) {
      throw new Error("expected the advertised floor to rig");
    }
    expect(atFloor.achieved.silhouetteRatio).toBeCloseTo(
      tooNarrow.attainable![0],
      8,
    );
    // The DEFAULT (held) is fitted the same way: the moving edge sits in the
    // hold's ramp, where two pulls compete — the plate's rendered edge, the
    // ramp's inner end, slides and bends IN at full turn while the bangs' own
    // lead carries the strand OUT — so the hold that renders the rest span
    // sits a little off the head, whichever pull wins by a hair on this
    // radius (just outside it here, at ≈1.004; just inside when the plate's
    // edge was read off the shared grid), and is not reported as cut down.
    const defaulted = solveFor(layers, base, headEdges);
    if (defaulted.unreachable) {
      throw new Error("a default must never refuse to rig");
    }
    expect(defaulted.clamped).not.toContain("silhouetteRatio");
    expect(defaulted.achieved.silhouetteRatio).toBeCloseTo(1, 8);
    const heldRatio = defaulted.holdEdgeAt(30) / defaulted.holdBase;
    expect(heldRatio).not.toBe(1);
    expect(Math.abs(heldRatio - 1)).toBeLessThan(0.02);
  });

  it("solveTurnModel: an off-centre shell contains the sliding plate on its NARROW side too", () => {
    // A measured shell spanning -300…500, which `headEdges` records as each
    // side's own extreme: the head is 400px half-wide, but only 300 of that
    // sits on the -x side. The slide has to fit inside 300 where it moves
    // that way (the -30 stops) and inside 500 the other way; a cap reading
    // the union's own 400px half-width for both directions sends the -30
    // plate out through the narrow side and makes the FACE the silhouette
    // there. A flat head (farEyeRatio 0.9) is what exposes it — the tighter
    // the bend, the more of the slide it pulls back inside on its own.
    const layers = withNose();
    const targets = { headHalfWidth: 400, farEyeRatio: 0.9 };
    const faceCenterX = turnSolveInputs(layers)[2];
    const shell = { left: faceCenterX - 300, right: faceCenterX + 500 };
    const headEdges = {
      left: [{ role: "hair_back", x: shell.left }],
      right: [{ role: "hair_back", x: shell.right }],
    };
    const turn = solveFor(layers, targets, headEdges);
    if (turn.unreachable) throw new Error("expected a reachable turn");
    // The narrow side is what sized the slide: well under the plate's own ask
    // (headTurnTravel — a quarter of its half-width).
    expect(turn.travel).toBeLessThan(0.25 * HH);
    // That ask is exactly what breaches: the same surface carrying the whole
    // 75px puts the plate's own edge near -318, outside the static shell.
    const asked = turnColumnMap(
      latticeOf(layers),
      faceCenterX,
      turn.radius,
      -30,
      0.25 * HH,
    );
    expect(asked.mapX(faceCenterX - HH)).toBeLessThan(shell.left);
    // The plate's edges as the generated rig RENDERS them — its own mesh over
    // its own grid, the very read the cap was sized on; the map is the same
    // on every row, so one row of the face stands for the guard rows.
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
      headEdges,
    });
    const faceY = model.parts.find((p) => p.id === "face")!.transform.y;
    let tightest = Infinity;
    for (const deg of [-30, -15, 15, 30]) {
      for (const side of [-1, 1] as const) {
        const landing = landedXAt(
          model,
          "face",
          faceCenterX + side * HH,
          faceY,
          {
            [StandardParameter.AngleX]: deg,
          },
        );
        // Inside the shell's own boundary on that side, at every stop and in
        // both directions.
        expect(landing).toBeGreaterThan(shell.left);
        expect(landing).toBeLessThan(shell.right);
        tightest = Math.min(
          tightest,
          side < 0 ? landing - shell.left : shell.right - landing,
        );
      }
    }
    // And the cap is TIGHT, not merely safe: at the stop that binds, the
    // plate's own edge sits exactly HOLD_CLEARANCE inside the boundary — to
    // the oracle's float32 rounding.
    expect(tightest).toBeCloseTo(HOLD_CLEARANCE, 4);
  });

  it("solveTurnModel: a headEdges candidate on the body follows bodyDeformer, not the face grid", () => {
    const layers = withNose();
    const targets = { headHalfWidth: 400, eyeShift: 0.3 };
    const right = [{ role: "hair_back", x: 400 }];
    const withBody = solveFor(layers, targets, {
      left: [{ role: "body", x: -450 }],
      right,
    });
    const withHairBack = solveFor(layers, targets, {
      left: [{ role: "hair_back", x: -450 }],
      right,
    });
    if (withBody.unreachable || withHairBack.unreachable) {
      throw new Error("expected both to be reachable");
    }
    // Both reach the SAME requested eyeShift exactly (that is what "reached"
    // means), so it cannot tell the two paths apart — the depth the eyes
    // needed to GET there can, since it is solved against a silhouette-centre
    // correction that differs: the body carries its own share of the head's
    // travel (BODY_TURN_FOLLOW), while a hair_back edge at the same rest x
    // does not move at all.
    expect(withBody.depths.eye).not.toBeCloseTo(withHairBack.depths.eye, 6);
  });

  it("solveTurnModel: a headEdges candidate naming a role outside ROLE_TABLE throws rather than treating it as rigid", () => {
    const layers = withNose();
    const targets = { headHalfWidth: 400, eyeShift: 0.3 };
    expect(() =>
      solveFor(layers, targets, {
        left: [{ role: "accessory_hat", x: -450 }],
        right: [{ role: "hair_back", x: 400 }],
      }),
    ).toThrow(/auto-rig:.*unrecognised role "accessory_hat"/);
  });

  it("solveTurnModel: a headEdges candidate naming a face-family role this layer set has no layer for throws", () => {
    // The mcp measures edges off the layers it rigs, so a face-family role it
    // names always has a carrier to land through; a caller's list naming one
    // these layers do not include is refused rather than landed as a part
    // that does not exist.
    const layers = withNose();
    expect(layers.some((l) => l.role === "blush_L")).toBe(false);
    const targets = { headHalfWidth: 400, eyeShift: 0.3 };
    expect(() =>
      solveFor(layers, targets, {
        left: [{ role: "blush_L", x: -250 }],
        right: [{ role: "hair_back", x: 400 }],
      }),
    ).toThrow(
      /auto-rig: evaluateTurnCandidate: headEdges names "blush_L", which this layer set has no layer for/,
    );
  });

  it("a silhouette this layer set cannot hold names ratios it CAN hold — a safe floor, not the narrowest", () => {
    const complaintAt = (silhouetteRatio: number) => {
      try {
        generateIkiFromLayerSet(withNose(), canvas, {
          turnTargets: { headHalfWidth: 400, silhouetteRatio },
        });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    const tooNarrow = complaintAt(0.6);
    expect(tooNarrow).toMatch(
      /turnTargets\.silhouetteRatio 0\.6 is unreachable/,
    );
    // A silhouette narrower than the plate's own reach through the turn would
    // run the ramp onto the strands backwards, whatever the radius.
    const [, lower, upper] = /attainable ([\d.]+)…([\d.]+)/.exec(tooNarrow)!;
    const [min, max] = [Number(lower), Number(upper)];
    expect(min).toBeGreaterThan(0.6);
    // The ceiling is the widest hold the targets accept, rendered: past the
    // held silhouette, short of the domain's own 1.5.
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThan(1.5);
    // The bound this names is SAFE, not TIGHT — the ratio sizes the head's
    // slide as well (`shellTravelCap`), so a narrower request arrives with a
    // smaller slide that pulls the plate's own reach in with it, and some
    // ratios below the advertised floor may still hold (on this fixture it
    // names ≈0.656). What the refusal promises is that everything it offers
    // rigs...
    expect(complaintAt(min)).toBe("");
    expect(complaintAt((min + max) / 2)).toBe("");
    expect(complaintAt(max)).toBe("");
    // ...and that what it refused stays refused: the floor never over-states
    // what the layer set can do, only under-states it.
    expect(complaintAt(0.6)).toMatch(/silhouetteRatio/);
  });

  // ── bad targets ───────────────────────────────────────────────────────────

  it("a target outside its own range throws, naming the field", () => {
    const bad = (turnTargets: TurnTargets) => () =>
      generateIkiFromLayerSet(withNose(), canvas, { turnTargets });
    expect(bad({ eyeShift: 2 })).toThrow(/turnTargets\.eyeShift \(2\)/);
    expect(bad({ farEyeRatio: 0 })).toThrow(/turnTargets\.farEyeRatio \(0\)/);
    expect(bad({ silhouetteRatio: 0.1 })).toThrow(
      /turnTargets\.silhouetteRatio \(0\.1\)/,
    );
    expect(bad({ headHalfWidth: 0 })).toThrow(
      /turnTargets\.headHalfWidth \(0\)/,
    );
    expect(bad({ eyeShift: Number.NaN })).toThrow(/turnTargets\.eyeShift/);
    // Derived targets are checked like given ones — and say where they came
    // from, the caller having never written a noseShift at all.
    expect(bad({ eyeShift: 0.9 })).toThrow(
      /turnTargets\.noseShift \(1\.224\d*\), derived from turnTargets\.eyeShift \(0\.9\), must be/,
    );
  });

  it("an unreachable target throws, naming the field and what was on offer", () => {
    expect(() =>
      generateIkiFromLayerSet(withNose(), canvas, {
        turnTargets: { farEyeRatio: 0.2 },
      }),
    ).toThrow(
      /auto-rig: turnTargets\.farEyeRatio 0\.2 is unreachable for this layer set \(attainable [\d.]+…[\d.]+\)/,
    );
  });

  it("a measured head narrower than the face it is drawn around is refused", () => {
    // The hold's whole zone lives outside the plate's edge, so such a head
    // would have the plate sticking out of its own silhouette at rest.
    expect(() =>
      generateIkiFromLayerSet(withNose(), canvas, {
        turnTargets: { headHalfWidth: 250 },
      }),
    ).toThrow(
      /auto-rig: turnTargets\.headHalfWidth \(250\) must be wider than the face plate's own half-width \(300\)/,
    );
  });

  it("every refused target throws TurnTargetError, not a bare Error", () => {
    // The class is the seam a host reports on: it tells a caller's bad number
    // from the invariant breaks the rest of the generator throws.
    const refused: TurnTargets[] = [
      { eyeShift: 2 },
      { farEyeRatio: 0.2 },
      { headHalfWidth: 250 },
    ];
    for (const turnTargets of refused) {
      expect(() =>
        generateIkiFromLayerSet(withNose(), canvas, { turnTargets }),
      ).toThrow(TurnTargetError);
    }
  });

  it("the solve reports itself to onTurnSolved, once, and only when there is a turn", () => {
    const reports: TurnSolveReport[] = [];
    const onTurnSolved = (r: TurnSolveReport) => reports.push(r);

    const rig = generateIkiFromLayerSet(withNose(), canvas, { onTurnSolved });
    expect(reports).toHaveLength(1);
    // This layer set reaches every default — see "this layer set needs no
    // clamp at all" above.
    expect(reports[0].clamped).toEqual([]);
    within1Percent(
      reports[0].achieved.farEyeRatio,
      DEFAULT_TURN_TARGETS.farEyeRatio,
    );
    // The report is about the rig that was built: its radius, fed back
    // through the surface's map on the lattice with the travel the shipped
    // plate grid carries, reproduces that grid's own −30° keyform at every
    // node (the plate has no shift of its own).
    const grid = faceWarpOf(rig).grid;
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    const map = turnColumnMap(
      latticeOf(withNose()),
      faceCenterX,
      reports[0].radius,
      -30,
      travelOf(rig),
    );
    const baked = cell(faceWarpOf(rig).warp2d, -30, 0);
    for (let n = 0; n < grid.points.length / 2; n++) {
      const nx = grid.points[n * 2];
      expect(baked.offsets[n * 2], `node ${n}`).toBeCloseTo(
        map.mapX(nx) - nx,
        9,
      );
    }
    expect(reports[0].depths.eye).toBeGreaterThan(0);
    expect(reports[0].holdBase).toBeGreaterThan(HH);

    // A layer set the defaults have to be cut down for says which field.
    generateIkiFromLayerSet(edgeEyes(), canvas, { onTurnSolved });
    expect(reports).toHaveLength(2);
    expect(reports[1].clamped).toEqual(["eyeShift"]);
    expect(reports[1].achieved.eyeShift).toBeLessThan(
      DEFAULT_TURN_TARGETS.eyeShift,
    );

    // No nose, no turn solve, nothing to report.
    generateIkiFromLayerSet(hairFrontLayers(), canvas, { onTurnSolved });
    expect(reports).toHaveLength(2);
  });

  it("without a nose there is no slide to fit, so the targets are inert", () => {
    const plain = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    const targeted = generateIkiFromLayerSet(hairFrontLayers(), canvas, {
      turnTargets: { eyeShift: 0.4, farEyeRatio: 0.5, silhouetteRatio: 0.8 },
    });
    // Not even an unreachable one throws: nothing is solved at all — the eye
    // binds to the grid at its rest position, unslid.
    expect(targeted).toEqual(plain);
    expect(Array.from(preBindVertices(targeted, "eye_L", turned))).toEqual(
      Array.from(preBindVertices(targeted, "eye_L")),
    );
  });
});

// ── Hero-like fixture ────────────────────────────────────────────────────────

/** The 1100×1100 canvas the playground hero's layers are painted on. */
const canvas1100 = { width: 1100, height: 1100 };

/**
 * The playground hero's own layer geometry — examples/playground/public/hero.iki
 * (rigged 2026-09-19 from iki-char/layers-nose), read back off
 * iki-char/rewrite/baseline.iki, which reproduces it byte for byte: each mesh
 * part's bbox from its transform and mesh half-extents (createPixelGridMesh
 * spans ±w/2, ±h/2), the body's from its width/height.
 */
function heroLikeLayers(): LayerInput[] {
  return [
    layer(canvas1100, "body", 136, 809, 829, 291),
    layer(canvas1100, "brow_L", 577, 394, 137, 23),
    layer(canvas1100, "brow_R", 387, 394, 137, 23),
    layer(canvas1100, "eye_L", 592, 442, 130, 66),
    layer(canvas1100, "eye_R", 378, 442, 130, 66),
    layer(canvas1100, "face", 349, 234, 402, 592),
    layer(canvas1100, "hair_back", 149, 56, 802, 1028),
    layer(canvas1100, "hair_front", 219, 45, 662, 991),
    layer(canvas1100, "iris_L", 625, 438, 74, 74),
    layer(canvas1100, "iris_R", 401, 438, 74, 74),
    layer(canvas1100, "lash_L", 592, 442, 129, 35),
    layer(canvas1100, "lash_R", 379, 442, 129, 35),
    layer(canvas1100, "mouth", 515, 623, 70, 21),
    layer(canvas1100, "mouth_open", 515, 621, 70, 29),
    layer(canvas1100, "nose", 533, 561, 35, 50),
  ];
}

/** The head `auto_rig_from_layers` measured off those layers' opaque union at
 *  the eye row (`headHalfWidth`, canvas px) and every role's own extent in
 *  that band, per side (`headEdges`, model x) — copied from
 *  iki-char/rewrite/baseline-report.json. */
const HERO_HEAD = {
  headHalfWidth: 262,
  headEdges: {
    left: [
      { role: "eye_L", x: 45 },
      { role: "eye_R", x: -170 },
      { role: "face", x: -180 },
      { role: "hair_back", x: -214 },
      { role: "hair_front", x: -263 },
      { role: "iris_L", x: 76 },
      { role: "iris_R", x: -148 },
      { role: "lash_L", x: 45 },
      { role: "lash_R", x: -167 },
    ],
    right: [
      { role: "eye_L", x: 169 },
      { role: "eye_R", x: -46 },
      { role: "face", x: 180 },
      { role: "hair_back", x: 224 },
      { role: "hair_front", x: 260 },
      { role: "iris_L", x: 147 },
      { role: "iris_R", x: -77 },
      { role: "lash_L", x: 166 },
      { role: "lash_R", x: -46 },
    ],
  },
};

/** What the shipped hero's turn solve reached (`turn.achieved`, to 4 decimals)
 *  and which defaulted target it had to cut down (`turn.clamped`) — copied
 *  from iki-char/rewrite/baseline-report.json, except `eyeShift`, a clamp at
 *  the plate's edge that moves as the clamp is re-evaluated: the baseline's
 *  0.2197 became 0.2167 when the bangs left the face grid (the lead sums
 *  unscaled now, where the grid's local slope used to scale it, so the
 *  silhouette centre the eye cue is read against moved by 0.8 px), then
 *  0.2195 when the whites moved onto their own 4-cell grids (the eye cue read
 *  through the white's own carrier instead of the shared lattice's 145 px
 *  chord; the radius re-fitted 375.4 → 361.1 to keep the far/near ratio, the
 *  travel and hold base unchanged). Both within 0.01 of the baseline. */
const HERO_CUES = { eyeShift: 0.2195, farEyeRatio: 0.67, silhouetteRatio: 1 };
const HERO_CLAMPED = ["eyeShift"];

describe("hero golden cues", () => {
  const layers = heroLikeLayers();
  /** The hero-like rig and its report, solved once on first use — from inside
   *  an `it`, so a solve that throws fails these three tests rather than the
   *  whole file's collection (vitest collects no test from a `describe` body
   *  that throws). */
  let solved:
    | {
        model: ReturnType<typeof generateIkiFromLayerSet>;
        report: TurnSolveReport;
      }
    | undefined;
  const heroRig = () => {
    if (solved) return solved;
    let report: TurnSolveReport | undefined;
    const model = generateIkiFromLayerSet(layers, canvas1100, {
      turnTargets: { headHalfWidth: HERO_HEAD.headHalfWidth },
      headEdges: HERO_HEAD.headEdges,
      onTurnSolved: (r) => {
        report = r;
      },
    });
    if (!report) throw new Error("the hero-like layer set must solve a turn");
    solved = { model, report };
    return solved;
  };

  it("reaches the shipped hero's cues and cuts down the same target", () => {
    const { report } = heroRig();
    expect(report.achieved.eyeShift).toBeCloseTo(HERO_CUES.eyeShift, 3);
    expect(report.achieved.farEyeRatio).toBeCloseTo(HERO_CUES.farEyeRatio, 3);
    expect(report.achieved.silhouetteRatio).toBeCloseTo(
      HERO_CUES.silhouetteRatio,
      3,
    );
    expect(report.clamped).toEqual(HERO_CLAMPED);
  });

  it("reports the cues the engine renders at −30, equal to the landed geometry's float32 rounding", () => {
    const { model, report } = heroRig();
    // The render's own cues (see cuesOf): the eye whites where their meshes
    // land them, the silhouette from the roles the mcp saw in the eye-row
    // band, each read at its own rest x.
    const cues = cuesOf(
      model,
      layers,
      HERO_HEAD.headHalfWidth,
      HERO_HEAD.headEdges,
    );

    // The report is float64; the oracle lands in float32 as the engine does,
    // so the two differ by that rounding alone (≈3e-5 px on x ≈ 300, ≈1e-7
    // in cue units) — 1e-6 is deterministic agreement, not a flake margin.
    expect(cues.farEyeRatio).toBeCloseTo(report.achieved.farEyeRatio, 6);
    expect(cues.eyeShift).toBeCloseTo(report.achieved.eyeShift, 6);
    expect(cues.silhouetteRatio).toBeCloseTo(
      report.achieved.silhouetteRatio,
      6,
    );
  });

  it("hair_back holds the outline: its vertices land at rest at every stop", () => {
    const { model } = heroRig();
    // headDeformer is the identity at rest, so the pre-bind positions ARE the
    // rest placement — and the landing at every AngleX stop is the same
    // float32 pipeline with nothing moving in it, so it equals them exactly.
    const rest = Array.from(preBindVertices(model, "hair_back"));
    for (const deg of faceWarpOf(model).warp2d.valuesX) {
      const landed = landVertices(model, "hair_back", {
        [StandardParameter.AngleX]: deg,
      });
      expect(Array.from(landed)).toEqual(rest);
    }
  });

  /** Mirror of auto-rig's private NOD_TRAVEL: headDeformer's rigid vertical
   *  translate at a full nod, which every child of the head carries on top of
   *  its own bend. */
  const NOD_TRAVEL = 30;
  /** NOD_BEND (0.5) of a degree of ParamAngleY, in radians. */
  const NOD_THETA_PER_DEG = (0.5 * Math.PI) / 180;
  const pinnedBend = (local: number, radius: number, theta: number) =>
    radius * Math.sin(Math.asin(local / radius) + theta) -
    local -
    radius * Math.sin(theta);

  it("every group's −30 keyform is one surface: the lattice map of each node's rest x plus its family's solved shift, the mouth's turned about its anchor", () => {
    const { model, report } = heroRig();
    const faceCenterX = model.parts.find((p) => p.id === "face")!.transform.x;
    // The mouth family's anchor: the closed mouth's rest centre.
    const anchor = model.parts.find((p) => p.id === "mouth")!.transform;
    const travel = travelOf(model);
    const unit = headTurnParallaxUnit(report.radius);
    // A dense lattice of the test's own: 16 px columns anchored on the face
    // centre, wide enough to hold every node plus the largest shift.
    const half = 48 * 16;
    const dense = {
      cols: 96,
      rows: 1,
      points: generateGridPoints(
        96,
        1,
        faceCenterX - half,
        faceCenterX + half,
        -1,
        1,
      ),
    };
    const map = turnColumnMap(dense, faceCenterX, report.radius, -30, travel);
    const depthOf = (group: string) =>
      group === "faceWarp"
        ? 0
        : group === "noseWarp"
          ? report.depths.nose
          : group === "mouthWarp"
            ? report.depths.mouth
            : report.depths.eye;
    let groups = 0;
    for (const d of model.deformers!) {
      if (d.kind !== "warp") continue;
      groups++;
      const shift = -depthOf(d.id) * unit;
      const k = cell(d.warp2d!, -30, 0);
      for (let n = 0; n < d.grid.points.length / 2; n++) {
        const x = d.grid.points[n * 2];
        const y = d.grid.points[n * 2 + 1];
        if (d.id === "mouthWarp") {
          // The mouth turns as one feature about its anchor, tilted: its dy
          // on this row is the turn's own.
          const landed = anchoredLanding(() => map, anchor, -30, shift, x, y);
          expect(
            Math.abs(k.offsets[n * 2] - (landed.x - x)),
            `${d.id} node ${n}`,
          ).toBeLessThan(0.1);
          expect(
            Math.abs(k.offsets[n * 2 + 1] - (landed.y - y)),
            `${d.id} node ${n}`,
          ).toBeLessThan(0.1);
          continue;
        }
        expect(
          Math.abs(k.offsets[n * 2] - (map.mapX(x + shift) - x)),
          `${d.id} node ${n}`,
        ).toBeLessThan(0.1);
        // dy is the nod's alone: none on this row.
        expect(k.offsets[n * 2 + 1]).toBe(0);
      }
    }
    expect(groups).toBe(7);
    // The plate grid the slide is read off has an even column count, symmetric
    // about the face centre (asserted inside centreSlideOf), and carries the
    // rig's travel on its axis.
    expect(travel).toBeGreaterThan(0);
    expect(travel).toBeCloseTo(0.25 * 201, 9);
  });

  it("every group nods on one radius, the head's: dy at AngleY −30 is the pinned bend of each node's rest y", () => {
    const { model } = heroRig();
    const faceCenterY = model.parts.find((p) => p.id === "face")!.transform.y;
    const nodRadius = headNodRadiusOf(layers);
    const theta = -30 * NOD_THETA_PER_DEG;
    for (const d of model.deformers!) {
      if (d.kind !== "warp") continue;
      const k = cell(d.warp2d!, 0, -30);
      for (let n = 0; n < d.grid.points.length / 2; n++) {
        const y = d.grid.points[n * 2 + 1];
        expect(k.offsets[n * 2], `${d.id} node ${n}`).toBe(0);
        expect(k.offsets[n * 2 + 1], `${d.id} node ${n}`).toBeCloseTo(
          pinnedBend(y - faceCenterY, nodRadius, theta),
          9,
        );
      }
    }
  });

  it("the plate's vertices nod on the analytic surface to the 10-row grid's chord, once the head's own rigid nod is taken back out", () => {
    const { model } = heroRig();
    const faceCenterY = model.parts.find((p) => p.id === "face")!.transform.y;
    const nodRadius = headNodRadiusOf(layers);
    const rest = preBindVertices(model, "face");
    for (const deg of [-30, 30]) {
      const landed = landVertices(model, "face", {
        [StandardParameter.AngleY]: deg,
      });
      for (let i = 0; i < rest.length; i += 2) {
        // resolveWarpGrids folds headDeformer's affine — its NOD_TRAVEL
        // translate — into every plate vertex; what is left is the grid's
        // bilinear chord of the surface's bend at the vertex's rest y.
        const own = landed[i + 1] - rest[i + 1] - (NOD_TRAVEL * deg) / 30;
        expect(
          Math.abs(
            own -
              pinnedBend(
                rest[i + 1] - faceCenterY,
                nodRadius,
                deg * NOD_THETA_PER_DEG,
              ),
          ),
          `${deg}° vertex ${i / 2}`,
        ).toBeLessThan(0.5);
      }
    }
  });

  it("the far eye white foreshortens asymmetrically: its outer half lands narrower than its inner half", () => {
    const { model } = heroRig();
    const [far] = ["eye_L", "eye_R"]
      .map((id) => model.parts.find((p) => p.id === id)!)
      .sort((a, b) => a.transform.x - b.transform.x);
    const w = layers.find((l) => l.role === far.id)!.cropW;
    const { x, y } = far.transform;
    const at = (px: number) => landedXAt(model, far.id, px, y, turned);
    const outerHalf = at(x) - at(x - w / 2);
    const innerHalf = at(x + w / 2) - at(x);
    expect(outerHalf).toBeGreaterThan(0);
    expect(outerHalf).toBeLessThan(innerHalf);
  });
});

// ── Mouth turn ───────────────────────────────────────────────────────────────

describe("mouth turn", () => {
  const layers = heroLikeLayers();
  /** The hero-like rig, solved once on first use — from inside an `it`, as
   *  "hero golden cues" does, so a solve that throws fails these tests rather
   *  than the file's collection. */
  let solved: ReturnType<typeof generateIkiFromLayerSet> | undefined;
  const heroRig = () => {
    solved ??= generateIkiFromLayerSet(layers, canvas1100, {
      turnTargets: { headHalfWidth: HERO_HEAD.headHalfWidth },
      headEdges: HERO_HEAD.headEdges,
    });
    return solved;
  };
  const drawings = ["mouth", "mouth_open"] as const;
  /** Both drawings rest at MouthForm's default, scaleX 1.1 about their own
   *  centre. */
  const REST_SCALE_X = 1.1;

  /** Where a drawing's two rest ends `(x ∓ w/2, y)` on its own centre row
   *  land at AngleX `deg` and AngleY `nod`, as vectors from the first to the
   *  second. */
  const chordOf = (id: (typeof drawings)[number], deg: number, nod = 0) => {
    const model = heroRig();
    const { x, y } = model.parts.find((p) => p.id === id)!.transform;
    const w = layers.find((l) => l.role === id)!.cropW;
    const params = {
      [StandardParameter.AngleX]: deg,
      [StandardParameter.AngleY]: nod,
    };
    const end = (px: number) => ({
      x: landedXAt(model, id, px, y, params),
      y: landedYAt(model, id, px, y, params),
    });
    const a = end(x - w / 2);
    const b = end(x + w / 2);
    return { dx: b.x - a.x, dy: b.y - a.y, w };
  };

  it("tilts each drawing's centre-row chord by the tilt at full turn, near end down: −5° at −30, +5° at +30", () => {
    for (const id of drawings) {
      for (const deg of [-30, 30]) {
        const { dx, dy } = chordOf(id, deg);
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        expect(
          Math.abs(angle - (MOUTH_TURN_TILT_DEG * deg) / 30),
          `${id} ${deg}°`,
        ).toBeLessThan(1e-4);
      }
    }
  });

  it("keeps that tilt under a full nod: the cells that turn and nod at once carry the turn's dy as well as the nod's", () => {
    // The nod moves every node on y by an amount set by its rest y alone, so
    // it lands both ends of a horizontal rest chord by the same dy and leaves
    // the chord's angle to the turn's own tilt.
    for (const id of drawings) {
      for (const deg of [-30, 30]) {
        for (const nod of [-30, 30]) {
          const { dx, dy } = chordOf(id, deg, nod);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          expect(
            Math.abs(angle - (MOUTH_TURN_TILT_DEG * deg) / 30),
            `${id} (${deg}°, ${nod}°)`,
          ).toBeLessThan(1e-4);
        }
      }
    }
  });

  it("foreshortens that chord as the face under it: its length over its pre-bind length is cos 30° at either full turn", () => {
    // The mouth is centred on the face axis, where the surface's own slope at
    // a full turn is cos 30°; the tilt is a rotation and keeps the length.
    const faceCenterX = heroRig().parts.find((p) => p.id === "face")!.transform
      .x;
    for (const id of drawings) {
      expect(heroRig().parts.find((p) => p.id === id)!.transform.x).toBe(
        faceCenterX,
      );
      for (const deg of [-30, 30]) {
        const { dx, dy, w } = chordOf(id, deg);
        expect(
          Math.abs(
            Math.hypot(dx, dy) / (REST_SCALE_X * w) - Math.cos(Math.PI / 6),
          ),
          `${id} ${deg}°`,
        ).toBeLessThan(0.01);
      }
    }
  });

  it("lands the closed and the open mouth as one: a rest point inside both meshes lands at the same (x, y) at every turn stop", () => {
    const model = heroRig();
    const [closed, open] = drawings.map(
      (id) => model.parts.find((p) => p.id === id)!.transform,
    );
    // Both rest about one centre x at the same scale, so one rest point is
    // one pre-bind point on the grid they share.
    expect(open.x).toBe(closed.x);
    // Inside both crops (70 × 21 about the closed mouth's centre, 70 × 29
    // about the open one's, 2 px lower) and off every vertex of either mesh,
    // so each drawing reads it inside a triangle of its own.
    const px = closed.x + 13;
    const py = closed.y + 4;
    for (const deg of [-30, -15, 15, 30]) {
      const params = { [StandardParameter.AngleX]: deg };
      const [a, b] = drawings.map((id) => ({
        x: landedXAt(model, id, px, py, params),
        y: landedYAt(model, id, px, py, params),
      }));
      expect(Math.abs(a.x - b.x), `${deg}° x`).toBeLessThan(1e-4);
      expect(Math.abs(a.y - b.y), `${deg}° y`).toBeLessThan(1e-4);
    }
  });
});

// ── Iris strand bound ────────────────────────────────────────────────────────

/** Each far iris against the bangs' side strand it slides under, as the
 *  shipped hero's strand diagnosis (iki-char/diag5/strand.mjs) found them,
 *  placed on heroLikeLayers(): the iris's opaque span on its centre row
 *  (image row 475, model y 74.5) and the run outward of it, whose face-side
 *  edge sits 12 px outside the iris's outer edge at rest. A stand-in until
 *  the hero's own measured `strandEdges` replace it. */
const HERO_STRAND: { left: IrisStrand; right: IrisStrand } = {
  left: {
    y: 74.5,
    irisOuter: -148,
    irisInner: -76,
    runOuter: -200,
    runFace: -160,
  },
  right: {
    y: 74.5,
    irisOuter: 148,
    irisInner: 76,
    runOuter: 200,
    runFace: 160,
  },
};

describe("iris strand bound", () => {
  const layers = heroLikeLayers();
  const HH = HERO_HEAD.headHalfWidth;
  type Model = ReturnType<typeof generateIkiFromLayerSet>;

  /** A rig and its report — solved from inside an `it`, as "hero golden
   *  cues" does, so a solve that throws fails that test rather than the
   *  file's collection. The hero-like head by default. */
  const rigOf = (
    options: Parameters<typeof generateIkiFromLayerSet>[2],
    rigLayers = layers,
  ) => {
    let report: TurnSolveReport | undefined;
    const model = generateIkiFromLayerSet(rigLayers, canvas1100, {
      ...options,
      onTurnSolved: (r) => (report = r),
    });
    if (!report) throw new Error("the layer set must solve a turn");
    return { model, report };
  };
  const heroRig = (strandEdges?: StrandEdges) =>
    rigOf({
      turnTargets: { headHalfWidth: HH },
      headEdges: HERO_HEAD.headEdges,
      ...(strandEdges === undefined ? {} : { strandEdges }),
    });
  let plain: ReturnType<typeof heroRig> | undefined;
  let bounded: ReturnType<typeof heroRig> | undefined;
  const plainRig = () => (plain ??= heroRig());
  const boundedRig = () => (bounded ??= heroRig(HERO_STRAND));

  const at = (deg: number) => ({ [StandardParameter.AngleX]: deg });
  /** The far stops of a side: −15 and −30 for the −x side. */
  const farStops = (side: -1 | 1) => [15 * side, 30 * side];
  /** The part id of the iris resting on `side` (−1 the −x side). */
  const irisOn = (model: Model, side: -1 | 1) =>
    ["iris_L", "iris_R"]
      .map((id) => model.parts.find((p) => p.id === id)!)
      .sort((a, b) => a.transform.x - b.transform.x)[side < 0 ? 0 : 1].id;
  /** σ·(run's face-side edge − iris's outer edge), each landed where the
   *  engine renders it at AngleX `deg`: positive while the iris stays clear
   *  of the run. */
  const clearanceAt = (
    model: Model,
    strand: IrisStrand,
    side: -1 | 1,
    deg: number,
  ) =>
    side *
    (landedXAt(model, "hair_front", strand.runFace!, strand.y, at(deg)) -
      landedXAt(
        model,
        irisOn(model, side),
        strand.irisOuter,
        strand.y,
        at(deg),
      ));
  /** The rest clearance capped at 0: how far under its run an iris may sit. */
  const allowanceOf = (strand: IrisStrand, side: -1 | 1) =>
    Math.min(0, side * (strand.runFace! - strand.irisOuter));
  /** The landed iris span's length inside the landed run at AngleX `deg`,
   *  every end read through the oracle — face-ward without end for a run
   *  with no face-side edge. */
  const coveredAt = (
    model: Model,
    strand: IrisStrand,
    side: -1 | 1,
    deg: number,
  ) => {
    // Outward-positive x on this side.
    const land = (id: string, x: number) =>
      side * landedXAt(model, id, x, strand.y, at(deg));
    const iris = irisOn(model, side);
    const runFace =
      strand.runFace === null ? -Infinity : land("hair_front", strand.runFace);
    return Math.max(
      0,
      Math.min(
        land(iris, strand.irisOuter),
        land("hair_front", strand.runOuter),
      ) - Math.max(land(iris, strand.irisInner), runFace),
    );
  };
  /** A reported entry against the render: its covered width at its stop,
   *  over the head half-width, is its `hh` to 1e-6 and, in px, its `px` to
   *  float32 at x ≈ 150 — and no other far stop covers more. */
  const expectEntryIsRender = (
    model: Model,
    strand: IrisStrand,
    side: -1 | 1,
    entry: StrandOverlap | undefined,
  ) => {
    if (entry === undefined) throw new Error("expected a strandOverlap entry");
    expect(farStops(side)).toContain(entry.deg);
    const covered = coveredAt(model, strand, side, entry.deg);
    expect(Math.abs(covered / HH - entry.hh)).toBeLessThan(1e-6);
    expect(Math.abs(covered - entry.px)).toBeLessThan(1e-4);
    for (const deg of farStops(side)) {
      expect(coveredAt(model, strand, side, deg), `${deg}°`).toBeLessThan(
        entry.px + 1e-4,
      );
    }
  };
  const mirrored = (s: IrisStrand): IrisStrand => ({
    y: s.y,
    irisOuter: -s.irisOuter,
    irisInner: -s.irisInner,
    runOuter: -s.runOuter,
    runFace: s.runFace === null ? null : -s.runFace,
  });

  it("an empty option, and a run too far out for the iris to reach, rig exactly the model without it", () => {
    const farOut: IrisStrand = {
      y: 74.5,
      irisOuter: -148,
      irisInner: -76,
      runOuter: -320,
      runFace: -300,
    };
    for (const strandEdges of [{}, { left: farOut, right: mirrored(farOut) }]) {
      const { model, report } = heroRig(strandEdges);
      expect(report.strandOverlap).toBeUndefined();
      expect(report).toEqual(plainRig().report);
      expect(model).toEqual(plainRig().model);
    }
  });

  it("premise: without the option, the far iris slides under the strand at full turn", () => {
    const { model } = plainRig();
    const under = ([-1, 1] as const).filter((side) => {
      const strand = side < 0 ? HERO_STRAND.left : HERO_STRAND.right;
      return (
        clearanceAt(model, strand, side, 30 * side) < allowanceOf(strand, side)
      );
    });
    expect(under.length).toBeGreaterThan(0);
  });

  it("keeps each far iris clear of its strand on the render, at every far stop and between them, and touches it where the bound binds", () => {
    const { model, report } = boundedRig();
    expect(report.strandOverlap).toBeUndefined();
    let tightest = Infinity;
    for (const side of [-1, 1] as const) {
      const strand = side < 0 ? HERO_STRAND.left : HERO_STRAND.right;
      for (const deg of [7.5, 15, 22.5, 30].map((d) => d * side)) {
        const margin =
          clearanceAt(model, strand, side, deg) - allowanceOf(strand, side);
        expect(margin, `${deg}°`).toBeGreaterThanOrEqual(-1e-3);
        tightest = Math.min(tightest, margin);
      }
    }
    expect(tightest).toBeLessThan(1e-3);
  });

  it("an iris painted 4 px under its run goes no deeper, and says how much of it is covered", () => {
    const left = { ...HERO_STRAND.left, runFace: -144 };
    const strandEdges = { left, right: mirrored(left) };
    const { model, report } = heroRig(strandEdges);
    for (const side of [-1, 1] as const) {
      const strand = side < 0 ? strandEdges.left : strandEdges.right;
      for (const deg of farStops(side)) {
        expect(
          clearanceAt(model, strand, side, deg),
          `${deg}°`,
        ).toBeGreaterThanOrEqual(-4 - 1e-3);
      }
      const entry = report.strandOverlap?.[side < 0 ? "left" : "right"];
      expect(entry?.held).toBe(true);
      expect(entry?.restPx).toBe(4);
      expect(entry!.px).toBeLessThanOrEqual(4 + 1e-3);
      expectEntryIsRender(model, strand, side, entry);
    }
  });

  it("a run over the iris centre that clears on the face side keeps the iris no deeper under it than painted", () => {
    // The run's face edge at −100 is inside the iris centre (−112), 48 px
    // face-ward of the iris's outer edge.
    const strandEdges = {
      ...HERO_STRAND,
      left: { ...HERO_STRAND.left, runFace: -100 },
    };
    const { model, report } = heroRig(strandEdges);
    for (const deg of farStops(-1)) {
      expect(
        clearanceAt(model, strandEdges.left, -1, deg),
        `${deg}°`,
      ).toBeGreaterThanOrEqual(-48 - 1e-3);
    }
    const entry = report.strandOverlap?.left;
    expect(entry?.held).toBe(true);
    expect(entry?.restPx).toBe(48);
    expect(entry!.px).toBeLessThanOrEqual(48 + 1e-3);
    expectEntryIsRender(model, strandEdges.left, -1, entry);
  });

  it("a fringe spanning the face has no face-side edge to keep clear of: the rig is built with the eyes' depth at 0, and says how much is covered", () => {
    const strandEdges = {
      ...HERO_STRAND,
      left: { ...HERO_STRAND.left, runFace: null },
    };
    const { model, report } = heroRig(strandEdges);
    expect(report.depths.eye).toBe(0);
    expect(report.clamped).toContain("eyeShift");
    const entry = report.strandOverlap?.left;
    expect(entry?.held).toBe(false);
    // The whole painted iris row, −148…−76.
    expect(entry?.restPx).toBe(72);
    expectEntryIsRender(model, strandEdges.left, -1, entry);
  });

  it("the bound costs the eye shift, not the far/near ratio or the silhouette, and the report is still the render", () => {
    const { model, report } = boundedRig();
    expect(report.clamped).toEqual(["eyeShift"]);
    expect(report.achieved.eyeShift).toBeLessThan(HERO_CUES.eyeShift);
    expect(report.achieved.farEyeRatio).toBeCloseTo(HERO_CUES.farEyeRatio, 3);
    expect(report.achieved.silhouetteRatio).toBeCloseTo(
      HERO_CUES.silhouetteRatio,
      3,
    );
    const cues = cuesOf(model, layers, HH, HERO_HEAD.headEdges);
    expect(cues.farEyeRatio).toBeCloseTo(report.achieved.farEyeRatio, 6);
    expect(cues.eyeShift).toBeCloseTo(report.achieved.eyeShift, 6);
    expect(cues.silhouetteRatio).toBeCloseTo(
      report.achieved.silhouetteRatio,
      6,
    );
  });

  it("a CALLER eyeShift the strand cuts short solves exactly as the same DEFAULT does", () => {
    const measured = solveTurnModel(
      resolveTurnTargets({ headHalfWidth: HH, eyeShift: 0.5 }),
      ...turnSolveInputs(layers),
      HERO_HEAD.headEdges,
      HERO_STRAND,
    );
    // The same 0.5 as a default, built by hand as "turn targets" does.
    const resolved = resolveTurnTargets({ headHalfWidth: HH });
    const defaulted = solveTurnModel(
      {
        ...resolved,
        eyeShift: 0.5,
        defaulted: new Set([...resolved.defaulted, "eyeShift"]),
      },
      ...turnSolveInputs(layers),
      HERO_HEAD.headEdges,
      HERO_STRAND,
    );
    if (measured.unreachable) throw new Error("a cut-short shift must clamp");
    expect(measured.clamped).toEqual(["eyeShift"]);
    // JSON drops the `holdEdgeAt` closure toEqual cannot diff.
    expect(JSON.stringify(measured)).toBe(JSON.stringify(defaulted));
  });

  // ── A narrowed profile ────────────────────────────────────────────────────
  // Every face row painted at half-width 100 under a measured head of 262
  // asked to narrow to 0.7: the −x run at −200…F sits in the hold's ramp,
  // which the narrowing pulls inward while the face's own slide carries the
  // iris outward, so whether any eye depth keeps the iris clear depends on
  // the radius. Only the −x side is given.
  const narrowedRig = (runFace: number, farEyeRatio?: number) =>
    rigOf(
      {
        turnTargets: {
          headHalfWidth: HH,
          silhouetteRatio: 0.7,
          ...(farEyeRatio === undefined ? {} : { farEyeRatio }),
        },
        strandEdges: { left: { ...HERO_STRAND.left, runFace } },
      },
      withProfile(
        layers,
        Array.from(
          { length: layers.find((l) => l.role === "face")!.cropH },
          () => 100,
        ),
      ),
    );

  it("a run no radius keeps the iris clear of is still rigged, with the eyes' depth at 0 and the coverage it leaves", () => {
    // 2 px clear at rest: at every radius the sweep fits, the face's own
    // slide alone carries the iris under the inward-pulled run.
    const strand = { ...HERO_STRAND.left, runFace: -150 };
    const { model, report } = narrowedRig(-150);
    expect(report.depths.eye).toBe(0);
    expect(report.clamped).toContain("eyeShift");
    expect(report.strandOverlap?.right).toBeUndefined();
    const entry = report.strandOverlap?.left;
    expect(entry?.held).toBe(false);
    expect(entry?.restPx).toBe(0);
    expect(entry!.px).toBeGreaterThan(0);
    expectEntryIsRender(model, strand, -1, entry);
  });

  it("at a strand-feasible fitted radius the cap keeps the far iris clear and nothing is reported; at an infeasible one the rig is still built and reports the bound unheld", () => {
    // Found by probing caller far/near ratios 0.55…0.9 at runFace −170…−190:
    // at −190 the tighter radii keep the iris clear (0.55–0.67, radius ≤ 341
    // px) and so does the flattest (0.9), while the radii in between cannot
    // (0.7–0.85, radius 375–774 px: the eyes' depth is 0 and the run still
    // covers 0.8–2.4 px of the far iris). A = 0.6 (radius ≈ 284.6) and
    // B = 0.75 (≈ 452.8) sit well inside each.
    const F = -190;
    const A = 0.6;
    const B = 0.75;
    const feasible = narrowedRig(F, A).report;
    expect(feasible.achieved.farEyeRatio).toBeCloseTo(A, 3);
    expect(feasible.strandOverlap).toBeUndefined();
    const infeasible = narrowedRig(F, B).report;
    expect(infeasible.achieved.farEyeRatio).toBeCloseTo(B, 3);
    expect(infeasible.strandOverlap?.left?.held).toBe(false);
  });
});

// ── Odd-column golden ────────────────────────────────────────────────────────

/** A face whose eye whites are 320 px wide — `meshCellsFor` gives them FIVE
 *  columns, so neither white has a vertex at its centre and every cue on it
 *  is read inside a mesh triangle: the case the two-stage sampler exists for.
 *  An 800 px plate to hold them, and a nose to solve against. */
function oddColumnLayers(): LayerInput[] {
  return [
    layer(canvas1000, "face", 100, 200, 800, 600),
    layer(canvas1000, "eye_R", 110, 380, 320, 100),
    layer(canvas1000, "eye_L", 470, 380, 320, 100),
    layer(canvas1000, "mouth", 400, 650, 200, 60),
    layer(canvas1000, "nose", 480, 480, 40, 60),
    layer(canvas1000, "hair_back", 20, 50, 960, 800),
    layer(canvas1000, "hair_front", 50, 60, 900, 500),
  ];
}

describe("odd-column golden cues", () => {
  it("reports the cues the engine renders at −30 on whites with no centre vertex, to float32 rounding", () => {
    const layers = oddColumnLayers();
    expect(meshCellsFor(320, 100).cols).toBe(5);
    let report: TurnSolveReport | undefined;
    const model = generateIkiFromLayerSet(layers, canvas1000, {
      onTurnSolved: (r) => (report = r),
    });
    if (!report) throw new Error("the odd-column layer set must solve a turn");
    // No measured head: the shifts are fractions of the plate's half-width
    // and the silhouette is the bangs' own crop edges, as the solve falls
    // back to — the same points cuesOf reads without a headEdges list.
    const cues = cuesOf(model, layers, 400);
    expect(cues.farEyeRatio).toBeCloseTo(report.achieved.farEyeRatio, 6);
    expect(cues.eyeShift).toBeCloseTo(report.achieved.eyeShift, 6);
    expect(cues.silhouetteRatio).toBeCloseTo(
      report.achieved.silhouetteRatio,
      6,
    );
  });
});

// ── Brow-owned edge golden ───────────────────────────────────────────────────

/** hairFrontLayers() + a nose, and a brow painted out past the bangs and the
 *  back hair on the −x side of the eye row: the outermost opaque pixel there
 *  is a part that rides the eye family's solved turn depth, not a held
 *  shell. The plate spans model x ±300, the bangs ±350, the back hair ±400;
 *  the brow runs −500…−100 on canvas rows 340…360, inside the mcp's ±10 px
 *  band about the eye row (canvas 350). */
function browEdgeLayers(): LayerInput[] {
  return [
    ...hairFrontLayers(),
    noseLayer(),
    layer(canvas1000, "brow_R", 0, 340, 400, 20),
  ];
}

describe("brow-owned edge golden cues", () => {
  /** Every role with an opaque pixel in the eye-row band at its own rest
   *  extent, per side, as the mcp would list it for `browEdgeLayers()`. */
  const browEdges = {
    left: [
      { role: "brow_R", x: -500 },
      { role: "hair_back", x: -400 },
      { role: "hair_front", x: -350 },
      { role: "face", x: -300 },
      { role: "eye_L", x: -200 },
    ],
    right: [
      { role: "brow_R", x: -100 },
      { role: "hair_back", x: 400 },
      { role: "hair_front", x: 350 },
      { role: "face", x: 300 },
      { role: "eye_R", x: 200 },
    ],
  };
  /** The rig for `browEdgeLayers()` at a measured head half-width, with its
   *  report and the cues the engine renders (`cuesOf`). */
  const rigAt = (HH: number) => {
    const layers = browEdgeLayers();
    let report: TurnSolveReport | undefined;
    const model = generateIkiFromLayerSet(layers, canvas1000, {
      turnTargets: { headHalfWidth: HH },
      headEdges: browEdges,
      onTurnSolved: (r) => (report = r),
    });
    if (!report) throw new Error("the brow-edge layer set must solve a turn");
    return { model, report, cues: cuesOf(model, layers, HH, browEdges) };
  };
  /** Report against render, to the oracle's float32 rounding (see the hero
   *  golden). */
  const expectReportEqualsRender = ({
    report,
    cues,
  }: ReturnType<typeof rigAt>) => {
    expect(cues.farEyeRatio).toBeCloseTo(report.achieved.farEyeRatio, 6);
    expect(cues.eyeShift).toBeCloseTo(report.achieved.eyeShift, 6);
    expect(cues.silhouetteRatio).toBeCloseTo(
      report.achieved.silhouetteRatio,
      6,
    );
  };

  it("reports the cues the engine renders at −30 when a brow owns the far silhouette edge, to float32 rounding", () => {
    // The union's half-width at the eye row, as the mcp would measure it.
    const rig = rigAt(450);

    // The brow really owns the rendered far edge: its own grid carries it
    // further out than every other candidate on that side lands.
    const { model } = rig;
    const eyeRowY =
      (model.parts.find((p) => p.id === "eye_L")!.transform.y +
        model.parts.find((p) => p.id === "eye_R")!.transform.y) /
      2;
    const landingOf = (c: { role: string; x: number }) =>
      landedXAt(model, c.role, c.x, eyeRowY, turned);
    const [brow, ...others] = browEdges.left;
    expect(landingOf(brow)).toBeLessThan(Math.min(...others.map(landingOf)));

    // The brow's landing is read through the depth its group grid ships
    // with, the one the same solve settled on.
    expectReportEqualsRender(rig);
  });

  it("a sampled radius the fixed point never settles is skipped, and the rig fitted among the rest still reports its render", () => {
    // The same brow under a head measured 50 px wider: the sweep's second
    // sampled radius (≈ 382.7 px) does not settle the silhouette and the
    // depths its owners ride on within TURN_SETTLE_PASSES — found by probing
    // the sweep — while every other one does. It is a `settle` miss the
    // sweep skips like any refused radius, not an error that aborts the
    // layer set, and the rig fitted among the radii that settled keeps the
    // report a promise about the render.
    expectReportEqualsRender(rigAt(500));
  });

  it("a layer set no sampled radius carries — unsettled at some, the targets refusing the rest — is refused as such, not as an internal failure", () => {
    // Brows owning BOTH sides' extremes ride the eye family's depth on both,
    // which leaves the eye cue nearly independent of that depth: the tighter
    // radii never settle. The flatter ones still do and would carry the rig
    // on their own; a caller-measured silhouette they cannot render refuses
    // them, and the sweep is left with nothing — refused by solveTurnModel
    // naming both causes, as the TurnTargetError the mcp reports to its
    // caller, never a bare Error out of the sweep.
    const layers = [
      ...hairFrontLayers(),
      noseLayer(),
      layer(canvas1000, "brow_R", 0, 340, 400, 20),
      layer(canvas1000, "brow_L", 600, 340, 400, 20),
    ];
    const headEdges = {
      left: [
        { role: "brow_R", x: -500 },
        { role: "brow_L", x: 100 },
        { role: "hair_back", x: -400 },
        { role: "hair_front", x: -350 },
        { role: "face", x: -300 },
        { role: "eye_L", x: -200 },
      ],
      right: [
        { role: "brow_L", x: 500 },
        { role: "brow_R", x: -100 },
        { role: "hair_back", x: 400 },
        { role: "hair_front", x: 350 },
        { role: "face", x: 300 },
        { role: "eye_R", x: 200 },
      ],
    };
    let thrown: unknown;
    try {
      generateIkiFromLayerSet(layers, canvas1000, {
        turnTargets: { headHalfWidth: 500, silhouetteRatio: 0.7 },
        headEdges,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TurnTargetError);
    expect((thrown as Error).message).toMatch(
      /^auto-rig: headEdges: no sampled radius carries the turn — the silhouette and the depths its headEdges owners ride on did not settle within \d+ passes at \d+ of the \d+ radii, and the targets refused the other \d+$/,
    );
  });
});

// ── Face row profile (④) ─────────────────────────────────────────────────────

/** Mirror of auto-rig's private CHIN_SWING: the chin's swing toward the near
 *  side at full turn, as a fraction of the plate's half-width, scaled by how
 *  much narrower than the widest row a row is. */
const CHIN_SWING = 0.08;

/** Mirror of auto-rig's private FACE_ROW_MIN_FRACTION: the floor under a
 *  row's half-width, as a fraction of the widest row's. */
const FACE_ROW_MIN_FRACTION = 0.15;

/** The bounded bend's own fraction: where a point at signed distance `l` from
 *  the axis lands, as a fraction of `l`, on a cylinder of radius `R` turned
 *  by `theta` with the axis pinned — `R·sin(asin(l/R) + θ) − R·sinθ` over
 *  `l`, the analytic branch of boundedCylinderBend (|l| ≤ R / RADIUS_FACTOR).
 *  Scale-free: the same for (l, R) and (l/2, R/2). */
const bendFraction = (l: number, R: number, theta: number) =>
  (R * Math.sin(Math.asin(l / R) + theta) - R * Math.sin(theta)) / l;

/** Mirror of auto-rig's private `turnSlide`: the whole travel at ±30°, linear
 *  between. */
const slideAt = (travel: number, deg: number) => (travel * deg) / 30;

describe("face row profile", () => {
  const layers = heroLikeLayers();
  const faceLayer = layers.find((l) => l.role === "face")!;
  /** 592 crop rows, 201 px half-wide, the face centre at (0, 20): its crop
   *  spans model y 316 (row 0) down to −276 (row 591). */
  const cropH = faceLayer.cropH;
  const faceHalfWidth = faceLayer.cropW / 2;
  const heroTargets = {
    turnTargets: { headHalfWidth: HERO_HEAD.headHalfWidth },
    headEdges: HERO_HEAD.headEdges,
  };
  const stops = [-30, -15, 15, 30];
  const theta30 = (-30 * Math.PI) / 180;

  /** A hero-like rig on `rows` as the face's profile (none when undefined),
   *  its report, and the solve's own `holdEdgeAt` — re-solved on the identical
   *  inputs the generator used (`turnSolveInputs`), checked by radius to be
   *  this rig's, as `rigOf` does — plus the profile as the generator read it.
   *  Solved once per fixture on first use. */
  type Profiled = {
    layers: LayerInput[];
    model: ReturnType<typeof generateIkiFromLayerSet>;
    report: TurnSolveReport;
    holdEdgeAt: (deg: number) => number;
    faceCenterX: number;
    faceCenterY: number;
    eyeRowY: number;
    profile: ReturnType<typeof faceRowProfile>;
  };
  const solved = new Map<string, Profiled>();
  const profiled = (
    key: string,
    rows: number[] | undefined,
    opts: { turnTargets: TurnTargets; headEdges?: HeadEdges } = heroTargets,
  ): Profiled => {
    const cached = solved.get(key);
    if (cached) return cached;
    const own = rows === undefined ? layers : withProfile(layers, rows);
    let report: TurnSolveReport | undefined;
    const model = generateIkiFromLayerSet(own, canvas1100, {
      ...opts,
      onTurnSolved: (r) => (report = r),
    });
    if (!report) throw new Error("the hero-like layer set must solve a turn");
    const turn = solveTurnModel(
      resolveTurnTargets(opts.turnTargets),
      ...turnSolveInputs(own),
      opts.headEdges,
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(turn.radius).toBe(report.radius);
    const face = model.parts.find((p) => p.id === "face")!.transform;
    const eyes = ["eye_L", "eye_R"].map(
      (id) => model.parts.find((p) => p.id === id)!.transform.y,
    );
    const result: Profiled = {
      layers: own,
      model,
      report,
      holdEdgeAt: turn.holdEdgeAt,
      faceCenterX: face.x,
      faceCenterY: face.y,
      eyeRowY: (eyes[0] + eyes[1]) / 2,
      profile: faceRowProfile(own.find((l) => l.role === "face")!, face.y),
    };
    solved.set(key, result);
    return result;
  };

  /** A dense lattice of the test's own: 16 px columns anchored on the face
   *  centre, wide enough to hold every node plus the largest shift — so a
   *  painted edge at a multiple of 16 from the centre IS a column. */
  const denseLattice = (faceCenterX: number) => {
    const half = 48 * 16;
    return {
      cols: 96,
      rows: 1,
      points: generateGridPoints(
        96,
        1,
        faceCenterX - half,
        faceCenterX + half,
        -1,
        1,
      ),
    };
  };

  /** The surface's per-row numbers, mirrored off a profile: the radius scaled
   *  by the row's half-width over the eye row's, and the chin's swing below
   *  the widest row. */
  const rowTerms = (r: Profiled, y: number) => {
    const p = r.profile!;
    const a = p.at(y);
    return {
      a,
      radius: (r.report.radius * a) / p.at(r.eyeRowY),
      swing:
        y < p.widestY
          ? -CHIN_SWING * faceHalfWidth * Math.max(0, 1 - a / p.aMax)
          : 0,
    };
  };

  it("builds the profile by the rule: aMax above the widest row, the measurement filled, smoothed and floored at and below it, linear between rows, the end rows beyond", () => {
    // Ten rows on a 20 px-wide face centred at y = 0: rows rest at 4.5, 3.5,
    // … −4.5. The widest is row 2 (10); rows 0–1 read it however little they
    // paint; below it the empty rows 5–6 take row 4's 6 and row 9 takes row
    // 8's 1; the window is three rows (5 % of ten, at least three), the end
    // row repeated past the crop; the floor is 1.5.
    const face = layer({ width: 100, height: 100 }, "face", 40, 45, 20, 10);
    const p = faceRowProfile(
      { ...face, rowHalfWidths: [0, 4, 10, 8, 6, 0, 0, 2, 1, 0] },
      0,
    )!;
    expect(p.aMax).toBe(10);
    expect(p.widestY).toBe(2.5);
    expect(p.faceHalfWidth).toBe(10);
    const smoothed = [10, 10, 28 / 3, 8, 20 / 3, 6, 14 / 3, 3, 1.5, 1.5];
    smoothed.forEach((a, i) => {
      expect(p.at(4.5 - i), `row ${i}`).toBeCloseTo(a, 12);
    });
    // Linear between two rows' centres; the end rows past the crop.
    expect(p.at(1.5 + 0.25)).toBeCloseTo(8 + (28 / 3 - 8) * 0.25, 12);
    expect(p.at(50)).toBe(10);
    expect(p.at(-50)).toBe(1.5);
    // The widest of several equal rows is the lowest of them.
    expect(
      faceRowProfile(
        { ...face, rowHalfWidths: [3, 5, 5, 5, 2, 0, 0, 0, 0, 0] },
        0,
      )!.widestY,
    ).toBe(1.5);
    // No painted row at all — or no profile — is no profile.
    expect(
      faceRowProfile({ ...face, rowHalfWidths: new Array(10).fill(0) }, 0),
    ).toBeUndefined();
    expect(faceRowProfile(face, 0)).toBeUndefined();
  });

  describe("two bands", () => {
    /** Rows 0–349 (model y down to −33.5) at 192, the rest at 96: both
     *  multiples of TURN_LATTICE_CELL_PX, so `faceCenterX ∓ a(y)` is a lattice
     *  node on both bands; each band far wider than the 31-row smoothing
     *  window, so its interior rows read exactly 192 / 96. The boundary sits
     *  below every eye-family grid node (the lowest rests at y ≈ 2) and
     *  between the plate grid's node rows at 20 and −53.6, so the eye row
     *  (75) and everything the cues read is in the upper band. */
    const BOUNDARY_ROW = 350;
    const twoBand = Array.from({ length: cropH }, (_, i) =>
      i < BOUNDARY_ROW ? 192 : 96,
    );
    const rig = () => profiled("twoBand", twoBand);
    /** An interior row of each band: 200 sits between the plate's node rows
     *  240.8 and 167.2 and the face mesh's 242 and 168; −200 between −127.2
     *  and −200.8 and the mesh's −128 and −202 — nothing a render reads there
     *  touches the smoothing ramp (y −19.5 … −49). */
    const UPPER_Y = 200;
    const LOWER_Y = -200;

    it("a constant profile — the crop's half-width on every row — rigs the no-profile model, byte for byte", () => {
      const bare = profiled("none", undefined);
      const flat = profiled("constant", new Array(cropH).fill(faceHalfWidth));
      expect(flat.model).toEqual(bare.model);
      expect(flat.report).toEqual(bare.report);
    });

    it("reads each band exactly: the eye row, an interior row of each band, and the widest row", () => {
      const r = rig();
      const p = r.profile!;
      expect(p.aMax).toBe(192);
      expect(p.at(r.eyeRowY)).toBe(192);
      expect(p.at(UPPER_Y)).toBe(192);
      expect(p.at(LOWER_Y)).toBe(96);
      // The widest row is the last 192 row, row 349, resting at 316 − 349.5.
      expect(p.widestY).toBe(-33.5);
      expect(192 % 16).toBe(0);
      expect(96 % 16).toBe(0);
    });

    it("bends each row on its own radius: an interior row of each band lands its painted edges at the SAME fraction of its half-width, the bounded bend's own, to 1e-9", () => {
      const r = rig();
      const travel = travelOf(r.model);
      const dense = denseLattice(r.faceCenterX);
      const fractions = (y: number) => {
        const { a, radius, swing } = rowTerms(r, y);
        const map = turnColumnMap(
          dense,
          r.faceCenterX,
          radius,
          -30,
          travel + swing,
        );
        const slide = slideAt(travel + swing, -30);
        // Both painted edges are lattice nodes here, so `mapX` returns the
        // node's own bend + slide — the analytic value, no chord.
        return [-1, 1].map(
          (side) =>
            (map.mapX(r.faceCenterX + side * a) - r.faceCenterX - slide) /
            (side * a),
        );
      };
      const upper = fractions(UPPER_Y);
      const lower = fractions(LOWER_Y);
      for (const side of [0, 1]) {
        expect(lower[side]).toBeCloseTo(upper[side], 9);
      }
      // And that fraction is the bend's own at the eye row's radius: far
      // side foreshortened, near side stretched.
      expect(upper[0]).toBeCloseTo(
        bendFraction(-192, r.report.radius, theta30),
        9,
      );
      expect(upper[1]).toBeCloseTo(
        bendFraction(192, r.report.radius, theta30),
        9,
      );
      expect(upper[0]).toBeLessThan(1);
      expect(upper[1]).toBeGreaterThan(1);
      // The lower band's radius is half the eye row's — the rule that keeps
      // the fraction — and its edge stays on the analytic branch.
      expect(rowTerms(r, LOWER_Y).radius).toBeCloseTo(r.report.radius / 2, 9);
      expect(96 / (r.report.radius / 2)).toBeLessThan(1 / RADIUS_FACTOR);
    });

    it("renders those painted edges within the plate grid's and the face mesh's chord of the analytic map", () => {
      const r = rig();
      const travel = travelOf(r.model);
      const dense = denseLattice(r.faceCenterX);
      const analytic = (y: number, side: -1 | 1) => {
        const { a, radius, swing } = rowTerms(r, y);
        return turnColumnMap(
          dense,
          r.faceCenterX,
          radius,
          -30,
          travel + swing,
        ).mapX(r.faceCenterX + side * a);
      };
      const rendered = (y: number, side: -1 | 1) =>
        landedXAt(
          r.model,
          "face",
          r.faceCenterX + side * rowTerms(r, y).a,
          y,
          turned,
        );
      // The render never samples the plate at the painted edge itself: it
      // lands the face mesh's vertices bracketing it — each bilinear over the
      // 50.05 px plate cells — and interpolates linearly between them, so the
      // error is the mesh's chord of the bend over that 67 px cell plus the
      // plate chord the two vertices carry. On the upper band (the eye row's
      // radius, ≈ 361) −192 sits 9 px from the mesh column at −201 and the
      // two together stay under 1.1 px. The lower band's radius is HALF that,
      // doubling the curvature, and ∓96 falls mid-cell between the mesh's
      // ∓134 and ∓67: measured at −30, the mesh chord is 2.89 px and the
      // plate chord the −67 vertex carries 1.03 px (0.63 at +134; ≈ 0 at
      // −134, where the lattice's kink at the bound R/1.2 ≈ 150 cancels it)
      // — 3.46 px far, 3.75 near, against the 4 px bound. The bound is TIGHT,
      // 0.25 px of margin: FACE_PLATE_CELLS at 8, Decision 6's byte fallback,
      // gives 62.6 px plate cells and would exceed it.
      for (const side of [-1, 1] as const) {
        expect(
          Math.abs(rendered(UPPER_Y, side) - analytic(UPPER_Y, side)),
          `upper ${side}`,
        ).toBeLessThan(2);
        expect(
          Math.abs(rendered(LOWER_Y, side) - analytic(LOWER_Y, side)),
          `lower ${side}`,
        ).toBeLessThan(4);
      }
    });

    it("swings the chin toward the near side: the plate's axis column carries the slide alone above the widest row and the slide less the swing below it", () => {
      const r = rig();
      const travel = travelOf(r.model);
      const faceWarp = faceWarpOf(r.model);
      const { grid } = faceWarp;
      const stride = grid.cols + 1;
      const col = grid.cols / 2; // the axis column (asserted in centreSlideOf)
      let lower = 0;
      let upper = 0;
      for (const deg of stops) {
        const k = cell(faceWarp.warp2d, deg, 0);
        for (let row = 0; row <= grid.rows; row++) {
          const y = grid.points[(row * stride + col) * 2 + 1];
          const dx = k.offsets[(row * stride + col) * 2];
          if (y < r.profile!.widestY) {
            // Every node row below the widest rests on the 96 band, so
            // 1 − a/aMax is ½ on each: the slide less CHIN_SWING · ½ of the
            // plate's half-width, scaled to the stop — at −30 that is
            // −travel + 0.025 · faceHalfWidth, toward the near side.
            expect(rowTerms(r, y).a).toBe(96);
            expect(dx, `${deg}° row ${row}`).toBeCloseTo(
              slideAt(travel, deg) -
                (CHIN_SWING * faceHalfWidth * 0.5 * deg) / 30,
              1,
            );
            expect(Math.abs(dx)).toBeLessThan(Math.abs(slideAt(travel, deg)));
            lower++;
          } else {
            expect(dx, `${deg}° row ${row}`).toBeCloseTo(
              slideAt(travel, deg),
              1,
            );
            upper++;
          }
        }
      }
      expect(lower).toBe(5 * stops.length);
      expect(upper).toBe(6 * stops.length);
      expect(travel).toBeCloseTo(0.25 * faceHalfWidth, 9);
    });

    it("keeps the bangs' join on the rendered plate and puts the strands between a row's painted edge and the plate's crop on the ramp", () => {
      const r = rig();
      const hair = r.model.parts.find((p) => p.id === "hair_front")!;
      const hairLayer = r.layers.find((l) => l.role === "hair_front")!;
      const { cols, rows } = meshCellsFor(hairLayer.cropW, hairLayer.cropH);
      const stride = cols + 1;
      const restX = (v: number) =>
        hair.transform.x + hair.mesh!.vertices[v * 2];
      const restY = (v: number) =>
        hair.transform.y + hair.mesh!.vertices[v * 2 + 1];
      const unit = headTurnParallaxUnit(r.report.radius);
      for (const deg of stops) {
        const params = { [StandardParameter.AngleX]: deg };
        const landed = landVertices(r.model, "hair_front", params);
        let onPlate = 0;
        let onRamp = 0;
        for (let v = 0; v < (cols + 1) * (rows + 1); v++) {
          const x = restX(v);
          const y = restY(v);
          const dist = Math.abs(x - r.faceCenterX);
          const a = r.profile!.at(y);
          const row = Math.floor(v / stride);
          // The root row (lead 0) over the painted plate lands where the
          // RENDERED plate lands that point — float32, 3e-5 at |x| < 512.
          if (row === 0 && dist <= a) {
            expect(landed[v * 2], `${deg}° vertex ${v}`).toBeCloseTo(
              landedXAt(r.model, "face", x, y, params),
              4,
            );
            onPlate++;
          }
          // On the 96 band a strand drawn over the plate's crop but past its
          // painted edge is on the ramp: its hold target (the landing less
          // the row's own lead) lies strictly between the painted edge's
          // rendered landing and the hold edge.
          if (a === 96 && dist > a && dist <= faceHalfWidth) {
            const side = Math.sign(x - r.faceCenterX);
            const lead =
              (deg / 30) *
              HAIR_FRONT_DEPTH *
              unit *
              Math.pow(row / rows, HAIR_SWAY_CURL);
            const hold = landed[v * 2] - lead;
            const inner = landedXAt(
              r.model,
              "face",
              r.faceCenterX + side * a,
              y,
              params,
            );
            const outer = r.faceCenterX + side * r.holdEdgeAt(deg);
            expect(
              (hold - inner) * (outer - hold),
              `${deg}° vertex ${v}`,
            ).toBeGreaterThan(0);
            onRamp++;
          }
        }
        expect(onPlate).toBe(5);
        expect(onRamp).toBeGreaterThan(0);
      }
    });

    it("the mouth's grid reads the same surface as the plate: each node the map at its own row, swing and radius included, turned about its anchor", () => {
      const r = rig();
      const unit = headTurnParallaxUnit(r.report.radius);
      const surface = turnSurface({
        faceCenterX: r.faceCenterX,
        faceCenterY: r.faceCenterY,
        radius: r.report.radius,
        travel: travelOf(r.model),
        nodRadius: headNodRadiusOf(r.layers),
        lattice: denseLattice(r.faceCenterX),
        profile: r.profile,
        eyeRowY: r.eyeRowY,
      });
      const mouth = groupWarpOf(r.model, "mouthWarp");
      // The mouth family's anchor: the closed mouth's rest centre.
      const anchor = r.model.parts.find((p) => p.id === "mouth")!.transform;
      const shift = -r.report.depths.mouth * unit;
      const k = cell(mouth.warp2d, -30, 0);
      let nodes = 0;
      for (let n = 0; n < mouth.grid.points.length / 2; n++) {
        const x = mouth.grid.points[n * 2];
        const y = mouth.grid.points[n * 2 + 1];
        // Every mouth node rests on the 96 band, where the swing is live.
        expect(surface.swingAt(y)).toBeCloseTo(
          -CHIN_SWING * faceHalfWidth * 0.5,
          9,
        );
        const landed = anchoredLanding(
          (row) => surface.mapAt(-30, row),
          anchor,
          -30,
          shift,
          x,
          y,
        );
        expect(k.offsets[n * 2], `node ${n}`).toBeCloseTo(landed.x - x, 6);
        expect(k.offsets[n * 2 + 1], `node ${n}`).toBeCloseTo(landed.y - y, 6);
        nodes++;
      }
      expect(nodes).toBe(25);
    });

    it("reports the cues the engine renders at −30 with the profile in play, to float32 rounding", () => {
      const r = rig();
      const cues = cuesOf(
        r.model,
        r.layers,
        HERO_HEAD.headHalfWidth,
        HERO_HEAD.headEdges,
      );
      expect(cues.farEyeRatio).toBeCloseTo(r.report.achieved.farEyeRatio, 6);
      expect(cues.eyeShift).toBeCloseTo(r.report.achieved.eyeShift, 6);
      expect(cues.silhouetteRatio).toBeCloseTo(
        r.report.achieved.silhouetteRatio,
        6,
      );
    });

    it("folds nowhere: every faceWarp row keeps x ascending and every bangs row lands in order, at the stops and between them", () => {
      const r = rig();
      const { grid } = faceWarpOf(r.model);
      const stride = grid.cols + 1;
      const hair = r.model.parts.find((p) => p.id === "hair_front")!;
      const hairLayer = r.layers.find((l) => l.role === "hair_front")!;
      const hairStride =
        meshCellsFor(hairLayer.cropW, hairLayer.cropH).cols + 1;
      for (const deg of [-30, -22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30]) {
        const params = { [StandardParameter.AngleX]: deg };
        const g = deformedGrid(r.model, "faceWarp", params);
        for (let row = 0; row <= grid.rows; row++) {
          for (let c = 1; c <= grid.cols; c++) {
            expect(g.points[(row * stride + c) * 2], `${deg}°`).toBeGreaterThan(
              g.points[(row * stride + c - 1) * 2],
            );
          }
        }
        const landed = landVertices(r.model, "hair_front", params);
        for (let v = 1; v < hair.mesh!.vertices.length / 2; v++) {
          if (v % hairStride === 0) continue;
          expect(landed[v * 2], `${deg}° vertex ${v}`).toBeGreaterThan(
            landed[(v - 1) * 2],
          );
        }
      }
    });

    it("without a nose the fallback surface still reads the profile: it rigs, the plate folds nowhere, and the lower band's axis carries the slide less the swing", () => {
      // No nose, so nothing is solved and the generator builds its own
      // surface — the profile and the eye row have to reach it the same way.
      const noNose = withProfile(
        layers.filter((l) => l.role !== "nose"),
        twoBand,
      );
      const model = generateIkiFromLayerSet(noNose, canvas1100);
      const face = model.parts.find((p) => p.id === "face")!.transform;
      const profile = faceRowProfile(
        noNose.find((l) => l.role === "face")!,
        face.y,
      )!;
      const faceWarp = faceWarpOf(model);
      const { grid } = faceWarp;
      const stride = grid.cols + 1;
      for (const deg of [-30, -22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30]) {
        const g = deformedGrid(model, "faceWarp", {
          [StandardParameter.AngleX]: deg,
        });
        for (let row = 0; row <= grid.rows; row++) {
          for (let c = 1; c <= grid.cols; c++) {
            expect(g.points[(row * stride + c) * 2], `${deg}°`).toBeGreaterThan(
              g.points[(row * stride + c - 1) * 2],
            );
          }
        }
      }
      // The fallback travel is the plate's own ask; the top row reads the
      // upper band, so `travelOf` still reads the slide alone.
      const travel = travelOf(model);
      expect(travel).toBeCloseTo(0.25 * faceHalfWidth, 9);
      const col = grid.cols / 2;
      let lower = 0;
      for (const deg of stops) {
        const k = cell(faceWarp.warp2d, deg, 0);
        for (let row = 0; row <= grid.rows; row++) {
          const y = grid.points[(row * stride + col) * 2 + 1];
          if (y >= profile.widestY) continue;
          expect(
            k.offsets[(row * stride + col) * 2],
            `${deg}° row ${row}`,
          ).toBeCloseTo(
            slideAt(travel, deg) -
              (CHIN_SWING * faceHalfWidth * 0.5 * deg) / 30,
            1,
          );
          lower++;
        }
      }
      expect(lower).toBe(5 * stops.length);
    });
  });

  describe("guards agree", () => {
    /** The widest rows ABOVE the eyes: every row down to 40 above the eye row
     *  (crop row 200) at the full half-width, the eye row's band and everything
     *  below at 0.8 of it. The eye row then reads 160.8 and rows above it
     *  201 — on a radius 1.25× the eye row's, so their painted edge lands
     *  f · 0.2 · aMax further out than the eye row's. */
    const eyeRow = Math.round(cropH / 2 - (75 - 20) - 0.5);
    const widestAbove = Array.from({ length: cropH }, (_, i) =>
      i < eyeRow - 40 ? faceHalfWidth : 0.8 * faceHalfWidth,
    );
    /** A shell four px wider than the plate's half-width — wider than the
     *  plate itself, as the solve requires, and tight enough that the slide
     *  has to be cut to fit inside it. */
    const SHELL = faceHalfWidth + 4;
    const rig = () =>
      profiled("widestAbove", widestAbove, {
        turnTargets: { headHalfWidth: SHELL },
      });

    it("holds the widest rows where they land, not the eye row: the shell cap binds on them and every guard row's painted edge stays inside the hold edge at every stop", () => {
      const r = rig();
      const p = r.profile!;
      expect(p.widestY).toBeGreaterThan(r.eyeRowY);
      expect(p.at(r.eyeRowY)).toBeCloseTo(0.8 * faceHalfWidth, 9);
      expect(p.at(300)).toBe(faceHalfWidth);
      // The cap bit: the rig slides, but less than the plate's own ask.
      const travel = travelOf(r.model);
      expect(travel).toBeGreaterThan(0);
      expect(travel).toBeLessThan(0.25 * faceHalfWidth);
      // Every row the bake's guard iterates, both sides, every stop: inside
      // the hold edge by the clearance. Float32 landings: 3e-5 at |x| < 512.
      const [, , , , , , carriers, , hairFront] = turnSolveInputs(r.layers);
      const guardRows = plateGuardRowsFor(
        carriers.get("face")!.part,
        hairFront,
      );
      let furthest = 0;
      for (const deg of stops) {
        const params = { [StandardParameter.AngleX]: deg };
        for (const y of guardRows) {
          for (const side of [-1, 1]) {
            const reach = Math.abs(
              landedXAt(
                r.model,
                "face",
                r.faceCenterX + side * p.at(y),
                y,
                params,
              ) - r.faceCenterX,
            );
            expect(reach, `${deg}° y ${y} side ${side}`).toBeLessThanOrEqual(
              r.holdEdgeAt(deg) - HOLD_CLEARANCE + 1e-4,
            );
            furthest = Math.max(furthest, reach);
          }
        }
      }
      // And the row that set the cap lands ON the shell's line: the slide was
      // cut to what the WIDEST rows leave, not to the eye row's own room.
      expect(furthest).toBeCloseTo(SHELL - HOLD_CLEARANCE, 4);
      // The case an eye-row-only cap gets wrong: at −30 the widest row's
      // painted far edge lands f · 0.2 · aMax further out than the eye row's
      // — ≈ 30 px here — which the bake's row guard would have refused.
      const farReach = (y: number) =>
        Math.abs(
          landedXAt(r.model, "face", r.faceCenterX - p.at(y), y, turned) -
            r.faceCenterX,
        );
      expect(farReach(300) - farReach(r.eyeRowY)).toBeGreaterThan(20);
    });
  });

  describe("occlusion", () => {
    /** A hero-like profile: the top 30 crop rows at 0.06 of the max (the
     *  hairline under the bangs), ramping to the max by row 60, the max down
     *  to row 340, a taper to 0.06 of it by row 471, and the last 120 rows
     *  empty (sub-threshold neck shading). */
    const heroLike = Array.from({ length: cropH }, (_, i) => {
      if (i < 30) return 0.06 * faceHalfWidth;
      if (i < 60) return faceHalfWidth * (0.06 + (0.94 * (i - 30)) / 30);
      if (i <= 340) return faceHalfWidth;
      if (i < cropH - 120)
        return faceHalfWidth * (1 - (0.94 * (i - 340)) / (cropH - 120 - 341));
      return 0;
    });
    const rig = () => profiled("heroLike", heroLike);
    /** Model y of crop row `i`'s centre. */
    const rowY = (i: number) => 20 + cropH / 2 - i - 0.5;
    const lastPainted = cropH - 120 - 1;

    it("reads the cranium as wide as the cheeks: rows above the widest row land their far edge where the eye row does, though the layer paints little there", () => {
      const r = rig();
      const p = r.profile!;
      expect(p.aMax).toBe(faceHalfWidth);
      expect(heroLike[0]).toBeCloseTo(0.06 * faceHalfWidth, 9);
      expect(p.at(rowY(0))).toBe(faceHalfWidth);
      expect(p.at(r.eyeRowY)).toBe(faceHalfWidth);
      expect(p.widestY).toBe(rowY(340));
      const farLanding = (y: number) =>
        landedXAt(r.model, "face", r.faceCenterX - p.at(y), y, turned);
      const eye = farLanding(r.eyeRowY);
      // Same half-width, same radius, no swing: the same map on every node
      // row above the widest, so the same landing — to float32.
      for (const y of [rowY(0), 280, 200, 120, 30]) {
        expect(farLanding(y), `y ${y}`).toBeCloseTo(eye, 4);
      }
    });

    it("tapers the jaw: the chin's painted far edge, and the bangs over it, land inside the eye row's reach", () => {
      const r = rig();
      const p = r.profile!;
      const chinY = rowY(lastPainted);
      // The last painted row is 6 % of the max — floored to 15 %.
      expect(p.at(chinY)).toBeCloseTo(FACE_ROW_MIN_FRACTION * faceHalfWidth, 9);
      const reachOf = (partId: string, x: number, y: number) =>
        Math.abs(landedXAt(r.model, partId, x, y, turned) - r.faceCenterX);
      const eyeReach = reachOf(
        "face",
        r.faceCenterX - p.at(r.eyeRowY),
        r.eyeRowY,
      );
      expect(reachOf("face", r.faceCenterX - p.at(chinY), chinY)).toBeLessThan(
        eyeReach,
      );
      // The bangs over the painted chin — its two edges and the axis, read
      // where the bangs' mesh renders them — sit inside it too. Strands
      // further out ride the ramp onto the held outline, which is wider than
      // the plate on every row by design.
      const hairLayer = r.layers.find((l) => l.role === "hair_front")!;
      const hair = r.model.parts.find((p) => p.id === "hair_front")!;
      const { rows } = meshCellsFor(hairLayer.cropW, hairLayer.cropH);
      const hairRows = Array.from(
        { length: rows + 1 },
        (_, k) =>
          hair.transform.y + hairLayer.cropH / 2 - (k / rows) * hairLayer.cropH,
      );
      // The bangs' mesh row nearest the chin inside the face's crop.
      const chinRow = hairRows
        .filter((y) => y >= r.faceCenterY - cropH / 2)
        .reduce((a, b) => (Math.abs(b - chinY) < Math.abs(a - chinY) ? b : a));
      for (const x of [-p.at(chinRow), 0, p.at(chinRow)]) {
        expect(
          reachOf("hair_front", r.faceCenterX + x, chinRow),
          `x ${x}`,
        ).toBeLessThan(eyeReach);
      }
    });

    it("treats the empty rows under the chin as the last painted row", () => {
      const r = rig();
      const p = r.profile!;
      const last = p.at(rowY(lastPainted));
      for (const i of [lastPainted + 1, lastPainted + 40, cropH - 1]) {
        expect(p.at(rowY(i)), `row ${i}`).toBe(last);
      }
      expect(p.at(rowY(cropH) - 100)).toBe(last);
      // Rendered alike where the whole cell rests on those rows — float32.
      const farLanding = (y: number) =>
        landedXAt(r.model, "face", r.faceCenterX - p.at(y), y, turned);
      expect(farLanding(rowY(cropH - 1))).toBeCloseTo(farLanding(-250), 4);
    });

    it("an all-zero profile counts as absent", () => {
      const bare = profiled("none", undefined);
      const zero = profiled("allZero", new Array(cropH).fill(0));
      expect(zero.profile).toBeUndefined();
      expect(zero.model).toEqual(bare.model);
    });
  });
});
