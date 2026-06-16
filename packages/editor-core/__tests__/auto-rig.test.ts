import { StandardParameter, parseIkiModel } from "@iki/format";
import { describe, expect, it } from "vitest";
import {
  ROLE_TABLE,
  bakeEyelidFoldWarp,
  bakeHeadTurnGridWarpCentered,
  bboxToTransform,
  bindingsForRole,
  createPixelGridMesh,
  generateGridPoints,
  generateIkiFromLayerSet,
  parseLayerRoles,
  validateLayerInputs,
  type LayerInput,
} from "../src/auto-rig";

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

  it("faceWarp.warps[0] has a value-0 keyform with all-zero offsets", () => {
    const canvas = { width: 1000, height: 1000 };
    const model = generateIkiFromLayerSet(offCenterLayers(), canvas);
    const faceWarpDef = model.deformers?.find((d) => d.id === "faceWarp") as
      | { warps?: { keyforms: { value: number; offsets: number[] }[] }[] }
      | undefined;
    expect(faceWarpDef?.warps).toBeDefined();
    const warp = faceWarpDef!.warps![0];
    const centerKeyform = warp.keyforms.find((k) => k.value === 0);
    expect(centerKeyform).toBeDefined();
    for (const offset of centerKeyform!.offsets) {
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

    const warp = bakeHeadTurnGridWarpCentered(grid, "ParamAngleX", faceCenterX);
    const kf30 = warp.keyforms.find((k) => k.value === 30)!;

    // Point i=0: x = faceGridMinX = -398
    const x = grid.points[0]; // -398
    const halfWidth = (grid.points[grid.cols * 2] - grid.points[0]) / 2; // (198-(-398))/2 = 298
    const RADIUS = halfWidth * (0.6 / 0.5); // 357.6
    const theta = 30 * (Math.PI / 180);
    const localX = x - faceCenterX; // -298
    const alpha = Math.asin(Math.max(-1, Math.min(1, localX / RADIUS)));
    const xPrime = faceCenterX + RADIUS * Math.sin(alpha + theta);
    const expectedDx = xPrime - x;

    expect(kf30.offsets[0]).toBeCloseTo(expectedDx, 8);

    // Verify this DIFFERS from the old absolute-x bake (would fail the test
    // if someone reverts to the non-center-relative formula).
    const alphaAbsolute = Math.asin(Math.max(-1, Math.min(1, x / RADIUS)));
    const xPrimeAbsolute = RADIUS * Math.sin(alphaAbsolute + theta);
    const oldDx = xPrimeAbsolute - x;
    expect(kf30.offsets[0]).not.toBeCloseTo(oldDx, 3);
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
    // Blink is a fold WARP, not a binding; the white also has no gaze.
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

  it("bindingsForRole: hair_back (static) returns empty array", () => {
    const spec = ROLE_TABLE["hair_back"];
    expect(bindingsForRole(spec, "hair_back", 800, 700)).toHaveLength(0);
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

  it("mesh parts have mesh.vertices.length === 2 * (cols+1) * (rows+1) for 4×4 grid", () => {
    // 4×4 grid → 5×5 = 25 vertices → 50 components
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    for (const layer of assemblyLayers()) {
      const spec = ROLE_TABLE[layer.role];
      if (spec.mesh) {
        const part = model.parts.find((p) => p.id === layer.role);
        expect(
          part?.mesh?.vertices.length,
          `${layer.role}.mesh.vertices.length`,
        ).toBe(2 * 5 * 5);
      }
    }
  });

  it("static hair_back part has no mesh and width/height equal to cropW/cropH", () => {
    const model = generateIkiFromLayerSet(assemblyLayers(), {
      width: 1000,
      height: 1000,
    });
    const hairBack = assemblyLayers().find((l) => l.role === "hair_back")!;
    const part = model.parts.find((p) => p.id === "hair_back");
    expect(part?.mesh).toBeUndefined();
    expect(part?.width).toBe(hairBack.cropW);
    expect(part?.height).toBe(hairBack.cropH);
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
