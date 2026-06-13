import { StandardParameter, parseIkiModel } from "@iki/format";
import { describe, expect, it } from "vitest";
import {
  ROLE_TABLE,
  bboxToTransform,
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
    expect(() => parseLayerRoles(files)).toThrow(/missing required role "eye_L"/);
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

  it("model contains all 8 standard parameter ids", () => {
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
