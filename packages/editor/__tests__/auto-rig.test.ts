import { StandardParameter, parseIkiModel } from "@ikijs/format";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_TARGETS,
  ROLE_TABLE,
  TurnTargetError,
  bakeEyelidFoldWarp,
  bakeHairBackTurnWarp,
  bakeHairFrontSilhouetteWarp,
  bakeHairSwayWarp,
  bakeHeadTurnGridWarp2DCentered,
  bakeHeadTurnGridWarpCentered,
  bboxToTransform,
  bindingsForRole,
  createPixelGridMesh,
  generateGridPoints,
  generateIkiFromLayerSet,
  headNodParallaxUnit,
  headTurnParallaxUnit,
  meshCellsFor,
  parseLayerRoles,
  plateReach,
  resolveTurnTargets,
  solveTurnDepth,
  solveTurnModel,
  turnColumnMap,
  turnLandmarks,
  validateLayerInputs,
  type LayerInput,
  type TurnSolveReport,
  type TurnTargets,
} from "../src/auto-rig";

/** Mirror of auto-rig's private HEAD_CYLINDER_RADIUS_FACTOR: the margin
 *  between a cylinder's radius and the reach it covers. Tests pick the turn
 *  radius the generator picks by scaling a half-width by it. */
const RADIUS_FACTOR = 0.6 / 0.5;

/** Mirror of auto-rig's private HAIR_BACK_DEPTH: the back hair's signed share
 *  of the parallax unit. That share is the only binding a generated model
 *  carries the turn radius in, so it is how these tests read back a radius the
 *  generator SOLVED instead of scaling off the grid. */
const HAIR_BACK_DEPTH = -0.08;

/** The turn radius behind a generated model's parallax unit. */
const solvedRadiusOf = (model: ReturnType<typeof generateIkiFromLayerSet>) => {
  const back = (
    model.parts.find((p) => p.id === "hair_back")!.bindings ?? []
  ).find(
    (b) =>
      b.parameter === StandardParameter.AngleX && b.channel === "translateX",
  ) as { to: number };
  return back.to / (HAIR_BACK_DEPTH * Math.sin((30 * Math.PI) / 180));
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
});

// ── describe("assembly") ─────────────────────────────────────────────────────

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
 * canvas — the shape most likely to contaminate the faceWarp grid union.
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

// ── describe("head nod (AngleY)") ────────────────────────────────────────────

describe("head nod (AngleY)", () => {
  const canvas = { width: 1000, height: 1000 };
  // A grid whose middle row sits exactly on centerY = 0, so the pinned axis
  // row is a real row of control points.
  const grid = {
    cols: 4,
    rows: 4,
    points: generateGridPoints(4, 4, -400, 400, -300, 300),
  };
  // The turn radius is the bake's caller's now: this is the grid's own x-reach
  // about centerX = 0 with the no-fold margin, i.e. what the rig picks.
  const radiusX = 400 * RADIUS_FACTOR;
  // Takes angle VALUES (degrees), not lattice indices.
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

  it("bakes a 5×5 lattice at 15° stops in the format's row-major layout", () => {
    const w = bakeHeadTurnGridWarp2DCentered(grid, "ax", "ay", 0, 0, radiusX);
    expect(w.valuesX).toEqual([-30, -15, 0, 15, 30]);
    expect(w.valuesY).toEqual([-30, -15, 0, 15, 30]);
    expect(w.keyforms2d).toHaveLength(25);
    for (const k of w.keyforms2d) {
      expect(k.offsets).toHaveLength(grid.points.length);
    }
  });

  it("the AngleY=0 row IS the 1D turn bake, so the turn did not change", () => {
    const w = bakeHeadTurnGridWarp2DCentered(grid, "ax", "ay", 0, 0, radiusX);
    const turn = bakeHeadTurnGridWarpCentered(grid, "ax", 0, radiusX);
    for (const angle of w.valuesX) {
      const k1d = turn.keyforms.find((k) => k.value === angle)!;
      const k2d = cell(w, angle, 0);
      for (let n = 0; n < k1d.offsets.length; n++) {
        expect(k2d.offsets[n]).toBeCloseTo(k1d.offsets[n], 9);
      }
    }
  });

  it("mid stops are the analytic bend, not the chord between ±30 and 0", () => {
    const w = bakeHeadTurnGridWarp2DCentered(grid, "ax", "ay", 0, 0, radiusX);
    const R = radiusX;
    const theta15 = 15 * (Math.PI / 180);
    const mid = cell(w, 15, 0);
    for (let i = 0; i < grid.points.length / 2; i++) {
      const x = grid.points[i * 2];
      const alpha = Math.asin(Math.max(-1, Math.min(1, x / R)));
      const expectedDx =
        R * Math.sin(alpha + theta15) - x - R * Math.sin(theta15);
      expect(mid.offsets[i * 2]).toBeCloseTo(expectedDx, 8);
    }
    // Guard against a lattice built by linear interpolation between ±30 and 0:
    // the analytic bend at the outer column differs from the chord's midpoint.
    const full = cell(w, 30, 0);
    let maxDiff = 0;
    for (let i = 0; i < grid.points.length / 2; i++) {
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
    const w2 = bakeHeadTurnGridWarp2DCentered(
      lopsided,
      "ax",
      "ay",
      0,
      0,
      lopsidedRadius,
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
    for (const k of bakeHeadTurnGridWarp2DCentered(
      wide,
      "ax",
      "ay",
      0,
      0,
      tight,
    ).keyforms2d) {
      ordered(k.offsets);
    }
    for (const k of bakeHeadTurnGridWarpCentered(wide, "ax", 0, tight)
      .keyforms) {
      ordered(k.offsets);
    }
  });

  it("pins the axis row: points on centerY never move vertically", () => {
    const w = bakeHeadTurnGridWarp2DCentered(grid, "ax", "ay", 0, 0, radiusX);
    for (const k of w.keyforms2d) {
      for (let p = 0; p < grid.points.length / 2; p++) {
        if (grid.points[p * 2 + 1] === 0) {
          expect(k.offsets[p * 2 + 1]).toBeCloseTo(0, 10);
        }
      }
    }
  });

  it("a full nod foreshortens without folding, the far side most", () => {
    const w = bakeHeadTurnGridWarp2DCentered(grid, "ax", "ay", 0, 0, radiusX);
    const up = cell(w, 0, 30); // AngleX=0, AngleY=+30
    const stride = grid.cols + 1;
    for (let col = 0; col <= grid.cols; col++) {
      const column = [];
      for (let row = 0; row <= grid.rows; row++) {
        const p = row * stride + col;
        const restY = grid.points[p * 2 + 1];
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
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
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
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
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
    const model = generateIkiFromLayerSet(layers, canvas);
    const nodOf = (id: string) =>
      (model.parts.find((p) => p.id === id)!.bindings ?? []).find(
        (b) =>
          b.parameter === StandardParameter.AngleY &&
          b.channel === "translateY",
      ) as { from: number; to: number } | undefined;
    // The bangs hang from the hairline, on the same surface as the brows: they
    // slide with them, WITH the head, or the fringe closes onto the brows
    // looking up and leaves a bare forehead looking down.
    const front = nodOf("hair_front")!;
    expect(front.to).toBeGreaterThan(0);
    expect(front.to).toBe(nodOf("brow_L")!.to);
    expect(front.from).toBeCloseTo(-front.to, 10);
    // Looking up (+AngleY) bends the front crown down; the rigid back hair has
    // to follow or it shows above it as a second crown.
    const back = nodOf("hair_back")!;
    expect(back.to).toBeLessThan(0);
    expect(back.from).toBeCloseTo(-back.to, 10);
  });

  it("the nod bends the face gentler than the turn does", () => {
    // Same square grid, same radius on both axes: only NOD_BEND separates the
    // top edge's vertical travel from the right edge's horizontal travel.
    const w = bakeHeadTurnGridWarp2DCentered(
      {
        cols: 4,
        rows: 4,
        points: generateGridPoints(4, 4, -400, 400, -400, 400),
      },
      "ax",
      "ay",
      0,
      0,
      radiusX, // 400 reach × the margin — the same radius the nod axis derives
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

  it("its warped columns are the bake's own, at every stop", () => {
    // The map has to describe the SAME turn the model ships, or anything
    // measured through it is measuring a different head.
    const w = bakeHeadTurnGridWarp2DCentered(
      grid,
      "ax",
      "ay",
      faceCenterX,
      200,
      radiusX,
    );
    for (const angleX of w.valuesX) {
      const k =
        w.keyforms2d[
          w.valuesY.indexOf(0) * w.valuesX.length + w.valuesX.indexOf(angleX)
        ];
      const map = turnColumnMap(grid, faceCenterX, radiusX, angleX);
      for (let col = 0; col <= grid.cols; col++) {
        expect(map.restX[col]).toBe(grid.points[col * 2]);
        // Row 0 of the grid: point index === column index.
        expect(map.warpedX[col]).toBeCloseTo(
          grid.points[col * 2] + k.offsets[col * 2],
          9,
        );
      }
    }
  });

  it("mapX matches how the engine samples the grid, edge clamp included", () => {
    const map = turnColumnMap(grid, faceCenterX, radiusX, 30);
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
    const map = turnColumnMap(grid, faceCenterX, radiusX, -30);
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
    expect(() => turnColumnMap(grid, faceCenterX, radiusX, 45)).toThrow(
      /auto-rig: turnColumnMap/,
    );
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

  // Mirrors auto-rig.ts's HAIR_FRONT_DEPTH, matching the impl, not imported —
  // it isn't exported: pinned here so the lead's exact numeric value can be
  // checked against the parallaxUnit recovered from the model's own faceWarp
  // grid.
  const HAIR_FRONT_DEPTH = 0.1;

  it("bindingsForRole: a parallaxUnit adds one AngleX translateX to hair_back, none to hair_front", () => {
    const unit = 250;
    const front = bindingsForRole(
      ROLE_TABLE["hair_front"],
      "hair_front",
      700,
      400,
      { parallaxUnit: unit },
    );
    const back = bindingsForRole(
      ROLE_TABLE["hair_back"],
      "hair_back",
      800,
      700,
      { parallaxUnit: unit },
    );
    // The bangs' lead is a warp (attached in generateIkiFromLayerSet), not a
    // binding — hair_front carries none here.
    expect(front).toHaveLength(0);
    expect(back).toHaveLength(1);
    expect(parallaxOf(back)).toBeDefined();
  });

  it("the bangs lead the head and the back hair swings against it", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    const back = parallaxOf(
      model.parts.find((p) => p.id === "hair_back")!.bindings ?? [],
    )!;
    // headDeformer's own AngleX translateX runs -50 -> 50, so a negative `to`
    // means hair_back travels AGAINST the head.
    expect(back.to).toBeLessThan(0);

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
    // The shared parallaxUnit, recovered from the cylinder radius the faceWarp
    // grid's own half-width gives (hairHeadroomAt below reads the same edges).
    const grid = model.deformers!.find((d) => d.id === "faceWarp")!.grid;
    const parallaxUnit = headTurnParallaxUnit(
      ((grid.points[grid.cols * 2] - grid.points[0]) / 2) * RADIUS_FACTOR,
    );
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

  it("rest is untouched: the back-hair parallax binding is symmetric about zero", () => {
    // ParamAngleX defaults to 0, mid-range, so an asymmetric binding would
    // shift the hair in the rest pose — the pose every proportion is judged on.
    // (hair_front carries no binding; its rest is its warp's mid-point between
    // symmetric keyforms, asserted above.)
    const b = parallaxOf(
      bindingsForRole(ROLE_TABLE["hair_back"], "hair_back", 800, 700, {
        parallaxUnit: 250,
      }),
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

  it("the generated model shifts hair_back via a binding and hair_front via a warp", () => {
    const layers = hairFrontLayers();
    const model = generateIkiFromLayerSet(layers, canvas);
    const front = model.parts.find((p) => p.id === "hair_front")!;
    const back = model.parts.find((p) => p.id === "hair_back")!;
    // hair_front has NO translateX binding: its lead is the warp checked above.
    expect(parallaxOf(front.bindings ?? [])).toBeUndefined();
    expect(
      front.warps!.some((w) => w.parameter === StandardParameter.AngleX),
    ).toBe(true);
    const backParallax = parallaxOf(back.bindings ?? []);
    expect(backParallax).toBeDefined();
    expect(backParallax!.to).toBeLessThan(0);
  });

  // One hair spring peaks near 11.2 of its ±20 range (ζ ≈ 0.56 on a ±10
  // steady state) — the parameter value the sway cap is sized for.
  const SPRING_PEAK = 11.2;

  /** Worst-case x reach of hair_front's tips at parameter `v` on ONE sway warp,
   *  plus the turn lead's own warp (both root-pinned, so both peak at the same
   *  tip row), against the faceWarp grid's x-edges. */
  const hairHeadroomAt = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    v: number,
  ) => {
    const grid = model.deformers!.find((d) => d.id === "faceWarp")!.grid;
    const gridMaxX = grid.points[grid.cols * 2];
    const gridMinX = grid.points[0];
    const hair = model.parts.find((p) => p.id === "hair_front")!;
    const xs = hair.mesh!.vertices.filter((_, i) => i % 2 === 0);
    const lead = (hair.warps ?? []).find(
      (w) => w.parameter === StandardParameter.AngleX,
    )!;
    const shift = Math.max(
      ...lead.keyforms[1].offsets.filter((_, i) => i % 2 === 0),
    );
    const sway = (hair.warps ?? []).find(
      (w) => w.parameter === StandardParameter.HairSwayX,
    )!;
    const tip = Math.max(
      ...sway.keyforms[1].offsets.filter((_, i) => i % 2 === 0),
    );
    const swing = (tip * v) / 20;
    return {
      right: gridMaxX - (hair.transform!.x + Math.max(...xs) + shift + swing),
      left: hair.transform!.x + Math.min(...xs) - shift - swing - gridMinX,
      tip,
    };
  };

  it("the swayed, shifted hair_front tips stay inside the faceWarp grid at a spring's peak", () => {
    // applyWarpToChild sways and shifts a vertex BEFORE binding it to the rest
    // grid; past the edge the binding clamps and the tips flatten into a line.
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    const h = hairHeadroomAt(model, SPRING_PEAK);
    expect(h.right).toBeGreaterThan(0);
    expect(h.left).toBeGreaterThan(0);
    // On this fixture the cap does not bite: the swing is the full 9%.
    expect(h.tip).toBeCloseTo(0.09 * 400, 6);
  });

  it("tall bangs on a narrow face get their swing capped to the grid, not clamped by it", () => {
    // The grid's margin is 12% of the union's WIDTH, but the swing is 9% of the
    // hair's HEIGHT; hair that sets the union's width and is much taller than
    // it is wide puts its tips past the edge at a spring's peak. Uncapped, this
    // layout swings 90px against ~33px of headroom after the parallax shift.
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
    const h = hairHeadroomAt(model, SPRING_PEAK);
    expect(h.tip).toBeLessThan(0.09 * 1000);
    expect(h.tip).toBeGreaterThan(0);
    expect(h.right).toBeGreaterThanOrEqual(-1e-6);
    expect(h.left).toBeGreaterThanOrEqual(-1e-6);
    // The back hair, a matrix child with no grid, keeps the full swing.
    const back = model.parts.find((p) => p.id === "hair_back")!;
    const backSway = (back.warps ?? []).find(
      (w) => w.parameter === StandardParameter.HairSwayX,
    )!;
    expect(
      Math.max(...backSway.keyforms[1].offsets.filter((_, i) => i % 2 === 0)),
    ).toBeCloseTo(0.09 * 800, 6);
  });
});

describe("bakeHairBackTurnWarp", () => {
  const mesh = createPixelGridMesh(4, 4, 800, 700);
  const w = bakeHairBackTurnWarp(mesh, "ax");
  const stride = 5;
  // The mesh's half-width is 400, so the bake derives these from it.
  const RADIUS = 400 * 2.5; // HAIR_BACK_BEND_RADIUS_FACTOR
  const BULGE = 0.22 * 400; // HAIR_BACK_FAR_BULGE
  /** Keyform at a turn stop, by value: the stops are not fixed by position. */
  const kf = (deg: number) => {
    const found = w.keyforms.find((k) => k.value === deg);
    if (!found) throw new Error(`kf: turn stop ${deg} not found`);
    return found;
  };
  const bendAt = (x: number, deg: number) => {
    const theta = deg * (Math.PI / 180);
    const alpha = Math.asin(x / RADIUS);
    return RADIUS * Math.sin(alpha + theta) - x - RADIUS * Math.sin(theta);
  };
  /** How far this column counts as the far side at this stop: 0 on the near
   *  side and at the centre column, 1 at the far edge. */
  const farOf = (x: number, deg: number) =>
    Math.max(0, (-Math.sign(deg) * x) / 400);
  /** The bend the bake applies: the analytic bend on the near side, the chord
   *  of the column's own ±30 keyform on the far side. */
  const turnBendAt = (x: number, deg: number) =>
    farOf(x, deg) > 0
      ? (Math.abs(deg) / 30) * bendAt(x, Math.sign(deg) * 30)
      : bendAt(x, deg);

  it("keys the turn at -30/-15/0/15/30 with a zero rest keyform", () => {
    expect(w.keyforms.map((k) => k.value)).toEqual([-30, -15, 0, 15, 30]);
    for (const o of kf(0).offsets) expect(o).toBeCloseTo(0, 10);
  });

  it("mid stops: the near side is the analytic bend, the far side the chord of its ±30 keyform", () => {
    for (const deg of [15, -15]) {
      const mid = kf(deg);
      for (let v = 0; v < mesh.vertices.length / 2; v++) {
        const x = mesh.vertices[v * 2];
        // The bulge ramps with the angle, on the far side only.
        expect(mid.offsets[v * 2]).toBeCloseTo(
          turnBendAt(x, deg) - ((BULGE * deg) / 30) * farOf(x, deg),
          8,
        );
      }
    }
    const mid = kf(15);
    const full = kf(30);
    // The NEAR side is a lattice the engine could not have interpolated from
    // ±30 and 0: the sin-based bend there is nowhere near the chord.
    const nearCol = 2 * stride + 4; // middle row, x = +400
    expect(
      Math.abs(mid.offsets[nearCol * 2] - 0.5 * full.offsets[nearCol * 2]),
    ).toBeGreaterThan(5);
    // The FAR side IS that chord, exactly — it is keyed as one.
    const farCol = 2 * stride; // middle row, x = -400
    expect(
      Math.abs(mid.offsets[farCol * 2] - 0.5 * full.offsets[farCol * 2]),
    ).toBeLessThan(1e-8);
  });

  it("the bulge is exactly half strength at half turn, so the extra stops did not step it", () => {
    const mid = kf(15);
    const full = kf(30);
    for (let v = 0; v < mesh.vertices.length / 2; v++) {
      const x = mesh.vertices[v * 2];
      // Isolate the bulge: it is whatever the offset is on top of the bend the
      // bake applies at that stop — on the far side the chord, not the analytic
      // bend, or the gap between the two would count as bulge.
      const midBulge = turnBendAt(x, 15) - mid.offsets[v * 2];
      const fullBulge = turnBendAt(x, 30) - full.offsets[v * 2];
      expect(midBulge).toBeCloseTo(0.5 * fullBulge, 8);
    }
  });

  it("pins the centre column and moves nothing vertically", () => {
    for (const k of w.keyforms) {
      for (let v = 0; v < mesh.vertices.length / 2; v++) {
        if (mesh.vertices[v * 2] === 0)
          expect(k.offsets[v * 2]).toBeCloseTo(0, 10);
        expect(k.offsets[v * 2 + 1]).toBe(0);
      }
    }
  });

  it("turning right tucks the near edge in and bulges the far edge out, without folding", () => {
    const right = kf(30).offsets;
    const row = 2 * stride; // middle row
    const nearEdge = right[(row + 4) * 2]; // x = +400, toward the turn
    const farEdge = right[row * 2]; // x = -400, away from it
    // Both move left: the near edge toward the centre (tucks behind the face),
    // the far edge away from it (the hidden volume swings into view).
    expect(nearEdge).toBeLessThan(0);
    expect(farEdge).toBeLessThan(0);
    // The bulge is the far edge's motion; a bare cylinder bend would leave it
    // slightly INSIDE its rest position (+12px on this mesh).
    expect(Math.abs(farEdge)).toBeGreaterThan(0.12 * 400);
    // Order preserved along the row: no cell folds.
    let prev = -Infinity;
    for (let col = 0; col <= 4; col++) {
      const x = mesh.vertices[(row + col) * 2] + right[(row + col) * 2];
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
  });

  it("the bulge is one-sided: a column is pushed out only when it is the far side", () => {
    // Column x = +200. On a right turn it is the near side and only the bend
    // acts on it, tucking it toward the centre. On a left turn it is the far
    // side: a bare bend would still leave it slightly inside its rest
    // position (-17px on this mesh), so an OUTWARD move can only be the bulge.
    const col = 2 * stride + 3; // middle row, x = +200
    expect(kf(30).offsets[col * 2]).toBeLessThan(0); // right turn
    expect(kf(-30).offsets[col * 2]).toBeGreaterThan(0); // left turn
  });

  it("bends far flatter than the face: the near edge folds in by well under its half-width", () => {
    const right = kf(30).offsets;
    const nearEdge = Math.abs(right[(2 * stride + 4) * 2]);
    expect(nearEdge).toBeLessThan(0.3 * 400);
  });

  it("the far side swings out at one speed: every 7.5° step outward and within 25% of the widest", () => {
    for (const deg of [15, -15]) {
      const s = Math.sign(deg);
      const mid = kf(deg);
      const full = kf(30 * s);
      for (let v = 0; v < mesh.vertices.length / 2; v++) {
        const x = mesh.vertices[v * 2];
        if (farOf(x, deg) <= 0) continue;
        const o15 = mid.offsets[v * 2];
        const o30 = full.offsets[v * 2];
        // What the viewer actually sees: the engine blends parameter-linearly
        // between stops, so 7.5° and 22.5° are the midpoints of their cells.
        const shown = [0, o15 / 2, o15, (o15 + o30) / 2, o30];
        const steps = shown.slice(1).map((o, i) => o - shown[i]);
        const widest = Math.max(...steps.map(Math.abs));
        for (const step of steps) {
          // Outward first, as a floor — even the stalling bake never reversed at
          // these stops, so it is the envelope below that does the work.
          expect(step * s).toBeLessThan(0);
          // And at the same speed. The chord makes them exactly equal; 25% is
          // the envelope the cue tolerates before it reads as a stall. At
          // 11879aa the far edge (x = -400) moved 52.0 units through the first
          // 15° and 24.2 through the second — two steps each — a ratio of 0.46
          // this bound rejects.
          expect(Math.abs(step)).toBeGreaterThan(0.75 * widest);
        }
      }
    }
  });

  it("the ±30 keyforms are the bare bend minus the full bulge, untouched by the far-side chord", () => {
    for (const deg of [30, -30]) {
      for (let v = 0; v < mesh.vertices.length / 2; v++) {
        const x = mesh.vertices[v * 2];
        // Stated in bendAt alone — no chord in it — so it holds independently of
        // how the mid stops are derived. At full turn the two branches coincide,
        // which is why the hero's full-turn silhouette is the one already shipped.
        expect(kf(deg).offsets[v * 2]).toBeCloseTo(
          bendAt(x, deg) - ((BULGE * deg) / 30) * farOf(x, deg),
          8,
        );
      }
    }
  });
});

describe("hair_front silhouette hold", () => {
  const canvas = { width: 1000, height: 1000 };

  /** Every layer's bbox pushed `dx` across the canvas, so the face centre — and
   *  with it the whole hold — sits off the model origin. */
  const shiftedBy = (layers: LayerInput[], dx: number): LayerInput[] =>
    layers.map((l) => ({ ...l, bbox: { ...l.bbox, x: l.bbox.x + dx } }));

  /** A generated rig, plus the pieces a silhouette assertion needs: the face
   *  grid's own turn map, the hold zone the generator picks from it, and the
   *  hair_front warp that does the holding. */
  const rigOf = (layers: LayerInput[]) => {
    const model = generateIkiFromLayerSet(layers, canvas);
    const grid = model.deformers!.find((d) => d.id === "faceWarp")!.grid;
    // The grid is built symmetric about the face centre, so its own mid-x IS
    // the cylinder axis and its half-width the radius the generator scaled.
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    // These fixtures carry a nose, so the generator solved the radius from the
    // turn targets — take it from the model, not from the grid's half-width.
    const radius = solvedRadiusOf(model);
    const columnMapAt = (deg: number) =>
      turnColumnMap(grid, faceCenterX, radius, deg);
    const faceHalfWidth = layers.find((l) => l.role === "face")!.cropW / 2;
    const holdBase = plateReach(faceCenterX, faceHalfWidth, columnMapAt) + 1;
    const hair = model.parts.find((p) => p.id === "hair_front")!;
    // Two AngleX warps ride the bangs; the hold is the one keyed on all five
    // turn stops (the root-pinned lead has only its two ends).
    const warp = hair.warps!.find(
      (w) =>
        w.parameter === StandardParameter.AngleX && w.keyforms.length === 5,
    )!;
    const partX = hair.transform!.x;
    /** Absolute rest x of mesh vertex `v`. */
    const restX = (v: number) => partX + hair.mesh!.vertices[v * 2];
    return {
      model,
      grid,
      faceCenterX,
      faceHalfWidth,
      holdBase,
      columnMapAt,
      hair,
      warp,
      partX,
      restX,
      vertexCount: hair.mesh!.vertices.length / 2,
    };
  };

  const fixtures: [string, LayerInput[]][] = [
    ["face centred on the canvas", [...hairFrontLayers(), noseLayer()]],
    ["face off-centre", shiftedBy([...hairFrontLayers(), noseLayer()], 60)],
  ];

  for (const [label, layers] of fixtures) {
    it(`holds the strands past the hold edge at their rest x, at every stop (${label})`, () => {
      const r = rigOf(layers);
      // The fixture's bangs put one mesh column past the hold edge each side,
      // seven rows deep.
      const outer: number[] = [];
      for (let v = 0; v < r.vertexCount; v++) {
        if (Math.abs(r.restX(v) - r.faceCenterX) > r.holdBase) outer.push(v);
      }
      expect(outer).toHaveLength(14);
      for (const k of r.warp.keyforms) {
        const map = r.columnMapAt(k.value);
        let held = 0;
        for (const v of outer) {
          const x = r.restX(v);
          // Nothing can land outside the DEFORMED edge columns: the engine
          // pins a vertex past the rest grid's edge onto the edge column, so
          // at full turn the near side's outermost column is unreachable.
          if (x < map.warpedX[0] || x > map.warpedX[r.grid.cols]) continue;
          // Offset first (part warps apply before the bind), then the grid.
          expect(map.mapX(x + k.offsets[v * 2])).toBeCloseTo(x, 6);
          held++;
        }
        // Every one of them out to half turn; at full turn the near side's
        // column is out of the grid's reach and only the far side's is held.
        expect(held).toBe(
          Math.abs(k.value) === 30 ? outer.length / 2 : outer.length,
        );
      }
    });

    it(`leaves the vertices on the face plate to the grid's own bend (${label})`, () => {
      const r = rigOf(layers);
      let onPlate = 0;
      for (const k of r.warp.keyforms) {
        for (let v = 0; v < r.vertexCount; v++) {
          if (Math.abs(r.restX(v) - r.faceCenterX) > r.faceHalfWidth) continue;
          expect(k.offsets[v * 2]).toBeCloseTo(0, 6);
          expect(k.offsets[v * 2 + 1]).toBe(0);
          onPlate++;
        }
      }
      expect(onPlate).toBeGreaterThan(0);
    });

    it(`keeps every row's landing order at every stop — no folded cell (${label})`, () => {
      const r = rigOf(layers);
      const hairLayer = layers.find((l) => l.role === "hair_front")!;
      const stride = meshCellsFor(hairLayer.cropW, hairLayer.cropH).cols + 1;
      for (const k of r.warp.keyforms) {
        const map = r.columnMapAt(k.value);
        const landing = (v: number) => map.mapX(r.restX(v) + k.offsets[v * 2]);
        for (let v = 1; v < r.vertexCount; v++) {
          if (v % stride === 0) continue; // first vertex of a row
          const prev = landing(v - 1);
          const cur = landing(v);
          expect(cur).toBeGreaterThanOrEqual(prev);
          // Strictly, wherever neither sits on a clamped edge column — there
          // the engine stacks vertices on the same x, which is the clamp, not
          // a fold.
          const EPS = 1e-9;
          if (
            prev > map.warpedX[0] + EPS &&
            cur < map.warpedX[r.grid.cols] - EPS
          ) {
            expect(cur).toBeGreaterThan(prev);
          }
        }
      }
    });

    it(`is inert at rest: the 0 keyform is all zeros (${label})`, () => {
      const rest = rigOf(layers).warp.keyforms.find((k) => k.value === 0)!;
      for (const o of rest.offsets) expect(o).toBeCloseTo(0, 9);
    });
  }

  it("takes its hold edge from the plate's reach over ALL the stops, mid ones included", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    const edgeAt = (deg: number) =>
      Math.abs(
        r.columnMapAt(deg).mapX(r.faceCenterX - r.faceHalfWidth) -
          r.faceCenterX,
      );
    const reach = plateReach(r.faceCenterX, r.faceHalfWidth, r.columnMapAt);
    // The cylinder pushes the near edge PAST its rest half-width, and furthest
    // at the mid stop — not at rest (300) and not at full turn.
    expect(reach).toBeGreaterThan(r.faceHalfWidth);
    expect(reach).toBeGreaterThan(edgeAt(30));
    expect(reach).toBeCloseTo(edgeAt(15), 9);
    expect(r.holdBase).toBeCloseTo(reach + 1, 9);
  });

  /** How far the plate's +x edge lands from the face centre at `deg` — the
   *  reach a hold edge has to clear. */
  const plateEdgeAt = (r: ReturnType<typeof rigOf>, deg: number) =>
    Math.abs(
      r.columnMapAt(deg).mapX(r.faceCenterX + r.faceHalfWidth) - r.faceCenterX,
    );

  it("refuses a hold edge inside the plate's mapped edge, naming the stop and both numbers", () => {
    const r = rigOf([...hairFrontLayers(), noseLayer()]);
    // The bare plate half-width, which the fixture's plate edge overshoots at
    // every turned stop: the ramp between them would run backwards.
    expect(() =>
      bakeHairFrontSilhouetteWarp(
        r.hair.mesh!,
        r.partX,
        r.faceCenterX,
        r.faceHalfWidth,
        r.faceHalfWidth,
        () => r.faceHalfWidth,
        r.columnMapAt,
      ),
    ).toThrow(
      `auto-rig: bakeHairFrontSilhouetteWarp: at -30° on the +x side the hold edge sits 300 from the face centre but the plate's edge maps to ${plateEdgeAt(r, -30)}`,
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
        r.faceCenterX,
        r.faceHalfWidth,
        holdBase,
        () => holdBase,
        r.columnMapAt,
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
        r.faceCenterX,
        r.faceHalfWidth,
        r.holdBase,
        () => r.holdBase - 1,
        r.columnMapAt,
      ),
    ).toThrow(/auto-rig: bakeHairFrontSilhouetteWarp: holdEdgeAt\(0\)/);
  });

  it("moves the outer strands by the hold edge's own displacement", () => {
    // A hold edge that NARROWS as the head turns — 400 at rest, 360 at full
    // turn — which is what a caller with a measured head width and a target
    // silhouette ratio passes. Its boundary stays at 400 throughout.
    const grid = {
      cols: 4,
      rows: 4,
      points: generateGridPoints(4, 4, -800, 800, -400, 400),
    };
    const columnMapAt = (deg: number) =>
      turnColumnMap(grid, 0, 800 * RADIUS_FACTOR, deg);
    // Vertex xs every 50 from -500 to 500: the plate (0, 200), the ramp (300),
    // the boundary (400) and two strands beyond it (450, 500).
    const mesh = createPixelGridMesh(20, 2, 1000, 100);
    const col = (x: number) => (x + 500) / 50;
    const warp = bakeHairFrontSilhouetteWarp(
      mesh,
      0,
      0,
      200,
      400,
      (deg) => 400 - (40 * Math.abs(deg)) / 30,
      columnMapAt,
    );
    const k = warp.keyforms.find((x) => x.value === 30)!;
    const map = columnMapAt(30);
    const landing = (x: number) => map.mapX(x + k.offsets[col(x) * 2]);
    // Continuity: the boundary lands ON the hold edge's destination, where the
    // ramp ends and the outer zone begins.
    expect(landing(400)).toBeCloseTo(360, 6);
    // Beyond it, the boundary's own 40px displacement — slope 1, so the rest
    // spacing survives.
    expect(landing(450)).toBeCloseTo(410, 6);
    expect(landing(500)).toBeCloseTo(460, 6);
    expect(landing(500) - landing(450)).toBeCloseTo(50, 6);
    expect(landing(-450)).toBeCloseTo(-410, 6);
    // The ramp, at the midpoint of the band: half way from the plate edge's
    // destination to the hold edge's.
    expect(landing(300)).toBeCloseTo((map.mapX(200) + 360) / 2, 6);
    // On the plate: the grid's own bend, nothing added.
    expect(k.offsets[col(0) * 2]).toBeCloseTo(0, 9);
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

  it("both hair parts carry their own AngleX part warps: the back's bend, the bangs' lead and silhouette hold", () => {
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    const turnWarps = (id: string) =>
      (model.parts.find((p) => p.id === id)!.warps ?? []).filter(
        (w) => w.parameter === StandardParameter.AngleX,
      );
    expect(turnWarps("hair_back")).toHaveLength(1);
    // Two on the bangs, summed: the root-pinned lead across its two ends, and
    // the silhouette hold keyed on all five turn stops.
    expect(
      turnWarps("hair_front")
        .map((w) => w.keyforms.length)
        .sort((a, b) => a - b),
    ).toEqual([2, 5]);
    // Present even without front hair (it is the turn, not the sway).
    const bare = generateIkiFromLayerSet(assemblyLayers(), canvas);
    expect(
      (bare.parts.find((p) => p.id === "hair_back")!.warps ?? []).filter(
        (w) => w.parameter === StandardParameter.AngleX,
      ),
    ).toHaveLength(1);
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
  it("faceWarp grid is FACE_GRID_CELLS per axis", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const faceWarpDef = model.deformers?.find((d) => d.id === "faceWarp");
    const grid = (
      faceWarpDef as { grid: { cols: number; rows: number; points: number[] } }
    ).grid;
    expect(grid.cols).toBe(6);
    expect(grid.rows).toBe(6);
    expect(grid.points).toHaveLength(2 * 49); // (6+1) * (6+1) points
  });

  it("faceWarp grid encloses all faceWarp children (4 bounds)", () => {
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

    // Union of faceWarp children in model space (tight, before margin — the test
    // checks that the tight union fits inside the margined grid).
    const layers = offCenterLayers();
    const faceWarpRoles = ["face", "eye_L", "eye_R", "mouth"]; // all are faceWarp
    let unionMinX = Infinity,
      unionMaxX = -Infinity;
    let unionMinY = Infinity,
      unionMaxY = -Infinity;
    for (const layer of layers.filter((l) => faceWarpRoles.includes(l.role))) {
      const t = bboxToTransform(
        layer.bbox,
        layer.canvasW,
        layer.canvasH,
        layer.role,
      );
      unionMinX = Math.min(unionMinX, t.x - layer.cropW / 2);
      unionMaxX = Math.max(unionMaxX, t.x + layer.cropW / 2);
      unionMinY = Math.min(unionMinY, t.y - layer.cropH / 2);
      unionMaxY = Math.max(unionMaxY, t.y + layer.cropH / 2);
    }

    expect(unionMinX, "unionMinX inside grid").toBeGreaterThanOrEqual(gridMinX);
    expect(unionMaxX, "unionMaxX inside grid").toBeLessThanOrEqual(gridMaxX);
    expect(unionMinY, "unionMinY inside grid").toBeGreaterThanOrEqual(gridMinY);
    expect(unionMaxY, "unionMaxY inside grid").toBeLessThanOrEqual(gridMaxY);
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
  it("bakeEyelidFoldWarp / bakeHairSwayWarp / bakeHairBackTurnWarp all work on an odd-cols mesh", () => {
    // Odd cols/rows deliberately: none of these bakes may assume a stride.
    const mesh = createPixelGridMesh(7, 9, 300, 500);
    const tipShift = 36;

    const fold = bakeEyelidFoldWarp(mesh, "p", -12, 0);
    const sway = bakeHairSwayWarp(mesh, "p", tipShift, 20);
    const turn = bakeHairBackTurnWarp(mesh, "p");
    // Odd face-grid columns too: the silhouette hold reads the grid's own
    // column map, so it must not assume a column on the cylinder's axis.
    const grid = {
      cols: 5,
      rows: 5,
      points: generateGridPoints(5, 5, -260, 260, -300, 300),
    };
    const columnMapAt = (deg: number) =>
      turnColumnMap(grid, 0, 260 * RADIUS_FACTOR, deg);
    const holdBase = plateReach(0, 100, columnMapAt) + 1;
    const hold = bakeHairFrontSilhouetteWarp(
      mesh,
      0,
      0,
      100,
      holdBase,
      () => holdBase,
      columnMapAt,
    );
    for (const k of [
      ...fold.keyforms,
      ...sway.keyforms,
      ...turn.keyforms,
      ...hold.keyforms,
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

    // Turn: rest keyform is all-zero, and no row folds (x-order preserved). A
    // 7-column mesh has no x=0 column to pin directly, so this is the
    // equivalent invariant to bakeHairBackTurnWarp's "pins the centre column" check.
    const turnRest = turn.keyforms.find((k) => k.value === 0)!;
    for (const o of turnRest.offsets) expect(o).toBeCloseTo(0, 10);
    const stride = 8; // 7 cols → 8 vertex columns
    for (const k of turn.keyforms) {
      for (let row = 0; row * stride < mesh.vertices.length / 2; row++) {
        let prev = -Infinity;
        for (let col = 0; col < stride; col++) {
          const p = row * stride + col;
          const x = mesh.vertices[p * 2] + k.offsets[p * 2];
          expect(x).toBeGreaterThan(prev);
          prev = x;
        }
      }
    }

    // Hold: rest keyform all-zero, and every row still lands in x-order.
    const holdRest = hold.keyforms.find((k) => k.value === 0)!;
    for (const o of holdRest.offsets) expect(o).toBeCloseTo(0, 9);
    for (const k of hold.keyforms) {
      const map = columnMapAt(k.value);
      for (let row = 0; row * stride < mesh.vertices.length / 2; row++) {
        let prev = -Infinity;
        for (let col = 0; col < stride; col++) {
          const v = row * stride + col;
          const x = map.mapX(mesh.vertices[v * 2] + k.offsets[v * 2]);
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
    // its ends. It still hangs from headDeformer, not faceWarp: it bends on the
    // turn through its own part warp rather than the face's grid.
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

    const headTurn = head.bindings.find(
      (b) => b.parameter === StandardParameter.AngleX,
    )!;
    const bodyTurn = bodyDeformer.bindings.find(
      (b) => b.parameter === StandardParameter.AngleX,
    )!;
    expect(bodyTurn.channel).toBe("translateX");
    expect(bodyTurn.to).toBeCloseTo(0.3 * headTurn.to, 10);
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
  // Turn depths come from the solve, so a direct bindingsForRole call supplies
  // its own; the shape (nose deepest, mouth with the eyes) is the solver's.
  const units = {
    parallaxUnit: 250,
    parallaxUnitY: 120,
    hasNose: true,
    turnDepths: { eye: 0.26, nose: 0.31, mouth: 0.27 },
  };
  // Mirrors auto-rig.ts's FEATURE_NOD_DEPTH for the eye stack — not exported,
  // so pinned here the way HAIR_FRONT_DEPTH is above.
  const NOD_EYE_DEPTH = 0.04;
  // 30° × NOD_BEND (0.5), the half-angle the nod bends at — mirrored likewise.
  const NOD_THETA = (30 * 0.5 * Math.PI) / 180;
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
  const turnOf = (b: { parameter: string; channel: string }[] | undefined) =>
    slideOf(b, StandardParameter.AngleX, "translateX");
  const nodOf = (b: { parameter: string; channel: string }[] | undefined) =>
    slideOf(b, StandardParameter.AngleY, "translateY");

  it("every feature on the face slides WITH the head on the turn and the nod", () => {
    const roles = [
      "eye_L",
      "iris_R",
      "pupil_L",
      "highlight_R",
      "lash_L",
      "brow_R",
      "mouth",
      "mouth_open",
      "nose",
      "blush_L",
    ];
    for (const role of roles) {
      const b = bindingsForRole(ROLE_TABLE[role], role, 100, 50, {
        ...units,
        hasMouthOpen: true,
      });
      const turn = turnOf(b)!;
      const nod = nodOf(b)!;
      // headDeformer's own AngleX translateX runs -50 -> 50 and its AngleY
      // translateY -30 -> 30, so a positive `to` is WITH the head on both.
      expect(turn.to, role).toBeGreaterThan(0);
      expect(turn.from, role).toBeCloseTo(-turn.to, 10);
      expect(nod.to, role).toBeGreaterThan(0);
      expect(nod.from, role).toBeCloseTo(-nod.to, 10);
    }
  });

  it("the contour, the hair and the body keep their own: face none, bangs nod-only, back hair against", () => {
    const face = bindingsForRole(ROLE_TABLE["face"], "face", 300, 400, units);
    expect(face).toHaveLength(0);
    // The bangs' turn lead is a warp; on the nod they slide with the brows.
    const bangs = bindingsForRole(
      ROLE_TABLE["hair_front"],
      "hair_front",
      700,
      400,
      units,
    );
    expect(turnOf(bangs)).toBeUndefined();
    expect(nodOf(bangs)!.to).toBe(
      nodOf(bindingsForRole(ROLE_TABLE["brow_L"], "brow_L", 120, 40, units))!
        .to,
    );
    expect(
      turnOf(
        bindingsForRole(ROLE_TABLE["hair_back"], "hair_back", 800, 700, units),
      )!.to,
    ).toBeLessThan(0);
    expect(
      bindingsForRole(ROLE_TABLE["body"], "body", 900, 400, units),
    ).toHaveLength(0);
  });

  it("the nose stands off the face; the mouth has its own; the eye stack shares one depth", () => {
    const to = (role: string) =>
      turnOf(bindingsForRole(ROLE_TABLE[role], role, 100, 50, units))!.to;
    expect(to("nose")).toBeGreaterThan(to("mouth"));
    expect(to("mouth")).toBeGreaterThan(to("eye_L"));
    expect(to("mouth_open")).toBe(to("mouth"));
    // iris/pupil/highlight clip to the white and the lash folds onto it: a
    // different slide would drag them across the sclera on every turn.
    for (const role of ["iris_L", "pupil_L", "highlight_L", "lash_L"]) {
      expect(to(role), role).toBe(to("eye_L"));
    }
    // Both sides slide the same way — the pair moves as one toward the far side.
    expect(to("eye_R")).toBe(to("eye_L"));
    expect(to("brow_R")).toBe(to("brow_L"));
  });

  it("without the units no parallax is emitted", () => {
    expect(bindingsForRole(ROLE_TABLE["eye_L"], "eye_L", 100, 50)).toHaveLength(
      0,
    );
    expect(
      turnOf(bindingsForRole(ROLE_TABLE["mouth"], "mouth", 150, 15)),
    ).toBeUndefined();
  });

  it("the generated model's eye nod is the nod depth of the grid's own parallax unit", () => {
    const model = generateIkiFromLayerSet(
      [...hairFrontLayers(), noseLayer()],
      canvas,
    );
    const grid = model.deformers!.find((d) => d.id === "faceWarp")!.grid;
    const ys = grid.points.filter((_, i) => i % 2 === 1);
    const faceY = model.parts.find((p) => p.id === "face")!.transform.y;
    const halfH = Math.max(faceY - Math.min(...ys), Math.max(...ys) - faceY);
    const eye = model.parts.find((p) => p.id === "eye_L")!.bindings;
    expect(nodOf(eye)!.to).toBeCloseTo(
      NOD_EYE_DEPTH * headNodParallaxUnit(halfH),
      6,
    );
    // The turn's own depth is solved, not tabulated — it is checked against the
    // cues it was solved from under "turn targets". The white is a required
    // role, so both slides are on every generated rig with a nose.
    expect(turnOf(eye)!.to).toBeGreaterThan(0);
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
    const w = bakeHeadTurnGridWarp2DCentered(
      grid,
      "ax",
      "ay",
      0,
      0,
      400 * RADIUS_FACTOR, // turn radius: irrelevant here, the nod is on y
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
    // hair keeps its own share either way.
    const noNose = { parallaxUnit: 250, parallaxUnitY: 120 };
    expect(
      bindingsForRole(ROLE_TABLE["eye_L"], "eye_L", 100, 50, noNose),
    ).toHaveLength(0);
    expect(
      turnOf(bindingsForRole(ROLE_TABLE["mouth"], "mouth", 150, 15, noNose)),
    ).toBeUndefined();
    expect(
      bindingsForRole(ROLE_TABLE["hair_front"], "hair_front", 700, 400, noNose),
    ).toHaveLength(0);
    const model = generateIkiFromLayerSet(hairFrontLayers(), canvas);
    const part = (id: string) => model.parts.find((p) => p.id === id)!;
    expect(part("eye_L").bindings).toBeUndefined();
    expect(nodOf(part("hair_front").bindings)).toBeUndefined();
    expect(turnOf(part("hair_back").bindings)!.to).toBeLessThan(0);
  });
});

// ── describe("turn targets") ─────────────────────────────────────────────────

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
  /** The same character with its eyes painted out near the plate's edge, where
   *  the far one has almost no room to slide before it leaves the face. */
  const edgeEyes = (): LayerInput[] =>
    withNose().map((l) =>
      l.role === "eye_L" || l.role === "eye_R"
        ? {
            ...l,
            bbox: { ...l.bbox, x: l.role === "eye_L" ? 600 : 250 },
          }
        : l,
    );
  /** The fixture's face plate half-width: with no measured head, that is what
   *  the shift targets are fractions of. */
  const HH = 300;

  /** The turn slide a part carries at AngleX = -30 — the `from` end of its
   *  AngleX translateX binding, and 0 for a part that has none. */
  const slideAt30 = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    id: string,
  ) => {
    const b = (model.parts.find((p) => p.id === id)!.bindings ?? []).find(
      (x) =>
        x.parameter === StandardParameter.AngleX && x.channel === "translateX",
    ) as { from: number } | undefined;
    return b?.from ?? 0;
  };

  /**
   * The cues a generated rig actually reaches at full turn, re-measured off its
   * OWN grid and bindings the way measure_turn_reference measures a render:
   * where the eye pair's centre lands against a held head, and the far eye's
   * width against the near one, both over their rest values.
   *
   * Deliberately independent of the solver: it reads the shipped translateX
   * bindings and runs them through the shipped grid's column map, in the order
   * the engine does (a part is translated BEFORE its vertices bind to the rest
   * grid).
   */
  const cuesOf = (
    model: ReturnType<typeof generateIkiFromLayerSet>,
    layers: LayerInput[],
    hh: number,
  ) => {
    const grid = model.deformers!.find((d) => d.id === "faceWarp")!.grid;
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    const map = turnColumnMap(grid, faceCenterX, solvedRadiusOf(model), -30);
    const eyeOf = (role: string) => {
      const x = model.parts.find((p) => p.id === role)!.transform.x;
      const w = layers.find((l) => l.role === role)!.cropW;
      const shifted = x + slideAt30(model, role);
      return {
        x,
        landed: map.mapX(shifted),
        scale: (map.mapX(shifted + w / 2) - map.mapX(shifted - w / 2)) / w,
      };
    };
    // A -30° turn foreshortens the -x side, whichever character side that is.
    const eyes = ["eye_L", "eye_R"].map(eyeOf).sort((a, b) => a.x - b.x);
    const [far, near] = eyes;
    return {
      eyeShift: (far.landed - far.x + (near.landed - near.x)) / 2 / hh,
      farEyeRatio: far.scale / near.scale,
    };
  };

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
  const restMap = turnColumnMap(depthGrid, 0, DEPTH_RADIUS, 0);
  const turnedMap = turnColumnMap(depthGrid, 0, DEPTH_RADIUS, -30);
  /** A plate edge far enough out that only the silhouette bound can bite. */
  const FAR_PLATE = -400;

  it("solveTurnDepth: on a map that deforms nothing, the depth IS the target", () => {
    // The 0° stop is the identity, so mapX(x - d*unit) - x is just -d*unit.
    const s = solveTurnDepth(
      60,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      restMap,
      -380,
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
      -380,
      FAR_PLATE,
    );
    const bent = solveTurnDepth(
      60,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      -380,
      FAR_PLATE,
    );
    expect(bent.reached).toBe(true);
    expect(bent.depth).toBeGreaterThan(flat.depth);
    expect(bent.achieved).toBeCloseTo(-60, 6);
  });

  it("solveTurnDepth: the face plate is a bound of its own, and the tighter bound wins", () => {
    // The landmark's far edge is -120, so a plate edge at -200 leaves it 80px
    // of travel where the silhouette alone would have allowed far more.
    const plate = solveTurnDepth(
      100_000,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      -380,
      -200,
    );
    const silhouette = solveTurnDepth(
      100_000,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      -380,
      FAR_PLATE,
    );
    expect(plate.depth).toBeCloseTo(80 / DEPTH_UNIT, 9);
    expect(plate.depth).toBeLessThan(silhouette.depth);
    // At that depth the far edge sits exactly ON the plate, never past it.
    expect(-120 - plate.depth * DEPTH_UNIT).toBeCloseTo(-200, 9);
  });

  it("solveTurnDepth: a slide past both bounds stops at the nearer one, and says what was on offer", () => {
    const s = solveTurnDepth(
      100_000,
      [{ x: -100, w: 40 }],
      DEPTH_UNIT,
      turnedMap,
      -380,
      FAR_PLATE,
    );
    expect(s.reached).toBe(false);
    // Ascending, and the far end is as far as the landmark can travel.
    expect(s.attainable[0]).toBeLessThan(s.attainable[1]);
    expect(s.attainable[0]).toBeGreaterThan(-100_000);
    expect(s.achieved).toBeCloseTo(s.attainable[0], 9);
  });

  it("solveTurnDepth: a family with no landmark is an error, not a depth", () => {
    expect(() =>
      solveTurnDepth(60, [], DEPTH_UNIT, restMap, -380, FAR_PLATE),
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
      -380,
      FAR_PLATE,
    );
    expect(s.reached).toBe(false);
    expect(s.depth).toBe(0);
    expect(s.attainable[1]).toBeCloseTo(drift, 9);
  });

  // ── solveTurnModel ────────────────────────────────────────────────────────

  /** `solveTurnModel` on a layer set, with the grid the generator would build
   *  for THAT layer set. */
  const solveFor = (layers: LayerInput[], targets: TurnTargets = {}) => {
    const grid = generateIkiFromLayerSet(layers, canvas).deformers!.find(
      (d) => d.id === "faceWarp",
    )!.grid;
    return solveTurnModel(
      resolveTurnTargets(targets),
      turnLandmarks(layers),
      grid,
      (grid.points[0] + grid.points[grid.cols * 2]) / 2,
      HH,
    );
  };

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

  it("solveTurnModel: it reports the cues it reached, and clamps nothing it did not have to", () => {
    const s = solveFor(withNose());
    if (s.unreachable) throw new Error("expected a reachable turn");
    // Magnitudes, the units the targets are written in.
    within1Percent(s.achieved.eyeShift, DEFAULT_TURN_TARGETS.eyeShift);
    within1Percent(s.achieved.farEyeRatio, DEFAULT_TURN_TARGETS.farEyeRatio);
    // This fixture's eyes stop 100px short of the plate's edge and the default
    // slide needs less than that, so nothing is cut down.
    expect(s.clamped).toEqual([]);
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

  it("solveTurnModel: the same shift, MEASURED, is refused instead of clamped", () => {
    const s = solveFor(edgeEyes(), {
      eyeShift: DEFAULT_TURN_TARGETS.eyeShift,
    });
    expect(s.unreachable).toBe(true);
    if (!s.unreachable) return;
    expect(s.field).toBe("eyeShift");
    expect(s.value).toBe(DEFAULT_TURN_TARGETS.eyeShift);
    expect(s.attainable[1]).toBeLessThan(DEFAULT_TURN_TARGETS.eyeShift);
    // A measured shift the plate DOES leave room for is met, not clamped.
    // (The default RATIO may still be, which is its own business: a shallower
    // slide puts the far eye somewhere else on the cylinder.)
    const small = solveFor(edgeEyes(), { eyeShift: s.attainable[1] * 0.8 });
    if (small.unreachable) throw new Error("expected a reachable turn");
    expect(small.clamped).not.toContain("eyeShift");
    within1Percent(small.achieved.eyeShift, s.attainable[1] * 0.8);
  });

  // ── the generated rig ─────────────────────────────────────────────────────

  it("the default targets solve, and the rig reaches the cues they name", () => {
    const layers = withNose();
    const cues = cuesOf(generateIkiFromLayerSet(layers, canvas), layers, HH);
    // Negative = toward the far side, the sign measure_turn_reference reports.
    within1Percent(-cues.eyeShift, DEFAULT_TURN_TARGETS.eyeShift);
    within1Percent(cues.farEyeRatio, DEFAULT_TURN_TARGETS.farEyeRatio);
  });

  it("the far eye stays on the face plate, which is what the slide is bounded by", () => {
    const layers = withNose();
    const model = generateIkiFromLayerSet(layers, canvas);
    const grid = model.deformers!.find((d) => d.id === "faceWarp")!.grid;
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    const map = turnColumnMap(grid, faceCenterX, solvedRadiusOf(model), -30);
    // The far eye white's outer edge, translated then mapped, against the
    // plate's own edge through the same map: past it the white is drawn over
    // the side hair, which bends with the plate and swallows it.
    const white = model.parts.find((p) => p.id === "eye_R")!;
    const w = layers.find((l) => l.role === "eye_R")!.cropW;
    const outer = white.transform.x - w / 2 + slideAt30(model, "eye_R");
    expect(map.mapX(outer)).toBeGreaterThan(map.mapX(faceCenterX - HH));
    expect(outer).toBeGreaterThan(faceCenterX - HH);
  });

  it("a bigger eye shift slides the eyes further, and takes the nose and mouth with it", () => {
    const layers = withNose();
    const base = generateIkiFromLayerSet(layers, canvas);
    const more = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: { eyeShift: 0.26 },
    });
    for (const role of ["eye_L", "nose", "mouth"]) {
      expect(slideAt30(more, role), role).toBeLessThan(slideAt30(base, role));
    }
    within1Percent(-cuesOf(more, layers, HH).eyeShift, 0.26);
  });

  it("an explicit nose shift wins over the one derived from the eyes", () => {
    const layers = withNose();
    const derived = generateIkiFromLayerSet(layers, canvas);
    const explicit = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: { noseShift: 0.1 },
    });
    // Same eye target, so the eyes are untouched and only the nose moves.
    expect(slideAt30(explicit, "eye_L")).toBeCloseTo(
      slideAt30(derived, "eye_L"),
      9,
    );
    expect(slideAt30(explicit, "nose")).toBeGreaterThan(
      slideAt30(derived, "nose"),
    );
  });

  it("a flatter far eye is a rounder head: the radius follows the ratio", () => {
    const layers = withNose();
    const flat = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: { farEyeRatio: 0.8 },
    });
    const round = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: { farEyeRatio: 0.62 },
    });
    expect(solvedRadiusOf(round)).toBeLessThan(solvedRadiusOf(flat));
    within1Percent(cuesOf(round, layers, HH).farEyeRatio, 0.62);
    within1Percent(cuesOf(flat, layers, HH).farEyeRatio, 0.8);
  });

  it("the same character at two hair widths reaches the same cues on its own grid", () => {
    const wide = wideBangs();
    const narrow = withNose();
    const wideModel = generateIkiFromLayerSet(wide, canvas);
    const narrowModel = generateIkiFromLayerSet(narrow, canvas);
    for (const [model, layers] of [
      [wideModel, wide],
      [narrowModel, narrow],
    ] as const) {
      const cues = cuesOf(model, layers, HH);
      within1Percent(-cues.eyeShift, DEFAULT_TURN_TARGETS.eyeShift);
      within1Percent(cues.farEyeRatio, DEFAULT_TURN_TARGETS.farEyeRatio);
    }
    // Same cues, different rigs: the grid's columns moved, so the depth that
    // lands the eyes on them did too.
    expect(slideAt30(wideModel, "eye_L")).not.toBeCloseTo(
      slideAt30(narrowModel, "eye_L"),
      6,
    );
  });

  // ── the silhouette ratio ──────────────────────────────────────────────────

  it("a measured head narrows the silhouette by the ratio, and only past the boundary", () => {
    // The wide-bangs variant: its grid reaches past the strands this checks,
    // which the 700px one does not — outside the grid the engine clamps, and
    // the hold has nothing left to say.
    const layers = wideBangs();
    const targets = { headHalfWidth: 400, silhouetteRatio: 0.9 };
    const model = generateIkiFromLayerSet(layers, canvas, {
      turnTargets: targets,
    });
    const grid = model.deformers!.find((d) => d.id === "faceWarp")!.grid;
    const faceCenterX = (grid.points[0] + grid.points[grid.cols * 2]) / 2;
    const turn = solveTurnModel(
      resolveTurnTargets(targets),
      turnLandmarks(layers),
      grid,
      faceCenterX,
      HH,
    );
    if (turn.unreachable) throw new Error("expected a reachable turn");
    expect(turn.radius).toBeCloseTo(solvedRadiusOf(model), 6);
    // The measured head IS the boundary, and it holds its rest place; only its
    // DESTINATION narrows, and only by |deg|/30 of the ratio.
    expect(turn.holdBase).toBe(400);
    expect(turn.holdEdgeAt(0)).toBe(400);
    expect(turn.holdEdgeAt(30)).toBeCloseTo(360, 9);
    expect(turn.holdEdgeAt(-30)).toBeCloseTo(360, 9);
    expect(turn.holdEdgeAt(15)).toBeCloseTo(380, 9);

    // The fixture's own bangs stop short of 400, so the strands that carry the
    // ratio are checked on a mesh wide enough to have some: vertex xs every 50
    // from -500 to 500, about the same face centre.
    const mesh = createPixelGridMesh(20, 2, 1000, 100);
    const col = (x: number) => (x - faceCenterX + 500) / 50;
    const columnMapAt = (deg: number) =>
      turnColumnMap(grid, faceCenterX, turn.radius, deg);
    const warp = bakeHairFrontSilhouetteWarp(
      mesh,
      faceCenterX,
      faceCenterX,
      HH,
      turn.holdBase,
      turn.holdEdgeAt,
      columnMapAt,
    );
    for (const o of warp.keyforms.find((k) => k.value === 0)!.offsets) {
      expect(o).toBeCloseTo(0, 9);
    }
    for (const deg of [-30, -15, 15, 30]) {
      const k = warp.keyforms.find((x) => x.value === deg)!;
      const map = columnMapAt(deg);
      const landing = (d: number) => {
        const x = faceCenterX + d;
        return map.mapX(x + k.offsets[col(x) * 2]) - faceCenterX;
      };
      // The boundary lands on its own destination — the ratio's share of this
      // stop — and the strand outside it takes the SAME displacement, slope 1,
      // so the spacing between them survives. (The next strand out, at 500, is
      // past what the turned grid can reach; see bakeHairFrontSilhouetteWarp.)
      const side = Math.sign(deg);
      const edge = turn.holdEdgeAt(deg);
      expect(landing(side * 400)).toBeCloseTo(side * edge, 6);
      expect(landing(side * 450)).toBeCloseTo(side * (450 - (400 - edge)), 6);
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
          const x = map.mapX(
            faceCenterX + mesh.vertices[v * 2] + k.offsets[v * 2],
          );
          expect(x).toBeGreaterThan(prev);
          prev = x;
        }
      }
    }
  });

  it("a silhouette this layer set cannot hold names the narrowest one it can", () => {
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
    const min = Number(/attainable ([\d.]+)/.exec(tooNarrow)![1]);
    expect(min).toBeGreaterThan(0.6);
    expect(min).toBeLessThan(1);
    // It is the threshold of THIS gate: below it the hold is the complaint,
    // above it the hold is no longer what the layer set cannot do.
    expect(complaintAt(min * 0.99)).toMatch(/silhouetteRatio/);
    expect(complaintAt(min * 1.01)).not.toMatch(/silhouetteRatio/);
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

    generateIkiFromLayerSet(withNose(), canvas, { onTurnSolved });
    expect(reports).toHaveLength(1);
    expect(reports[0].clamped).toEqual([]);
    within1Percent(
      reports[0].achieved.farEyeRatio,
      DEFAULT_TURN_TARGETS.farEyeRatio,
    );
    expect(reports[0].radius).toBeCloseTo(
      solvedRadiusOf(generateIkiFromLayerSet(withNose(), canvas)),
      6,
    );
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
    // Not even an unreachable one throws: nothing is solved at all.
    expect(targeted).toEqual(plain);
    expect(slideAt30(targeted, "eye_L")).toBe(0);
  });
});
