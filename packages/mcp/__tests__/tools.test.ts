import { describe, expect, it } from "vitest";
import {
  IKI_FORMAT_VERSION,
  StandardParameter,
  parseIkiModel,
} from "@iki/format";
import { validateIki, describeIki, listStandardParameters } from "../src/tools";

// Minimal valid model used across several tests.
function validModel() {
  return {
    version: IKI_FORMAT_VERSION,
    name: "test-model",
    canvas: { width: 800, height: 600 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    parts: [
      {
        id: "part1",
        color: [1, 1, 1, 1] as [number, number, number, number],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
      },
    ],
  };
}

// Warp deformer grid helpers (cols=2, rows=1 → 6 control points)
const WARP_GRID_POINTS = [-10, 10, 0, 10, 10, 10, -10, -10, 0, -10, 10, -10];

function warpChildMesh() {
  return {
    vertices: [0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  };
}

describe("validateIki", () => {
  it("returns {ok:true} for a valid model object", () => {
    expect(validateIki(validModel())).toEqual({ ok: true });
  });

  it("returns {ok:false} for invalid model (parts[0].order = NaN)", () => {
    const invalidModel = {
      ...validModel(),
      parts: [{ ...validModel().parts[0], order: NaN }],
    };

    // Capture the exact error message thrown by parseIkiModel.
    let exactMessage: string;
    try {
      parseIkiModel(invalidModel);
      throw new Error("expected parseIkiModel to throw");
    } catch (e) {
      exactMessage = (e as Error).message;
    }

    expect(validateIki(invalidModel)).toEqual({
      ok: false,
      error: exactMessage,
    });
  });

  it("returns {ok:true} for a valid JSON string", () => {
    expect(validateIki(JSON.stringify(validModel()))).toEqual({ ok: true });
  });

  it("returns {ok:false} for invalid JSON string with error starting 'invalid JSON:'", () => {
    const result = validateIki("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^invalid JSON:/);
    }
  });
});

describe("describeIki", () => {
  it("returns {ok:false,error} for invalid model", () => {
    const result = describeIki({ version: IKI_FORMAT_VERSION });
    expect(result.ok).toBe(false);
  });

  it("summarises a model with a matrix deformer parent and a 1D-warp child deformer", () => {
    const model = {
      ...validModel(),
      deformers: [
        // root matrix deformer
        {
          kind: undefined,
          id: "head",
          pivot: { x: 0, y: 0 },
        },
        // warp deformer child of head with 1D warp
        {
          kind: "warp",
          id: "faceWarp",
          parent: "head",
          grid: { cols: 2, rows: 1, points: WARP_GRID_POINTS },
          warps: [
            {
              parameter: "ParamA",
              keyforms: [
                { value: -1, offsets: Array(12).fill(0) },
                { value: 1, offsets: Array(12).fill(0.5) },
              ],
            },
          ],
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "faceWarp",
          mesh: warpChildMesh(),
        },
      ],
    };

    const result = describeIki(model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { summary } = result;
    expect(summary.name).toBe("test-model");
    expect(summary.canvas).toEqual({ width: 800, height: 600 });
    expect(summary.parameters).toEqual([
      { id: "ParamA", min: -1, max: 1, default: 0 },
    ]);
    expect(summary.parts).toEqual([
      { id: "part1", order: 0, deformer: "faceWarp" },
    ]);

    expect(summary.deformers).toHaveLength(2);

    const matDef = summary.deformers.find((d) => d.id === "head")!;
    expect(matDef.kind).toBe("matrix");
    expect(matDef.parent).toBeUndefined();
    expect(matDef.warp).toBeUndefined();

    const warpDef = summary.deformers.find((d) => d.id === "faceWarp")!;
    expect(warpDef.kind).toBe("warp");
    expect(warpDef.parent).toBe("head");
    expect(warpDef.warp).toEqual({ mode: "1d", parameters: ["ParamA"] });
  });

  it("summarises a model with a 2D-warp deformer", () => {
    // Need two parameters for the 2D warp axes.
    const model = {
      ...validModel(),
      parameters: [
        { id: "ParamX", min: -30, max: 30, default: 0 },
        { id: "ParamY", min: -30, max: 30, default: 0 },
      ],
      deformers: [
        {
          kind: "warp",
          id: "face2D",
          grid: { cols: 2, rows: 1, points: WARP_GRID_POINTS },
          warp2d: {
            parameter: "ParamX",
            parameterY: "ParamY",
            valuesX: [-30, 0, 30],
            valuesY: [-30, 30],
            // 3 * 2 = 6 keyforms, each with 12 offsets (6 points * 2)
            keyforms2d: Array(6).fill({ offsets: Array(12).fill(0) }),
          },
        },
      ],
      parts: [
        {
          ...validModel().parts[0],
          deformer: "face2D",
          mesh: warpChildMesh(),
        },
      ],
    };

    const result = describeIki(model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { summary } = result;
    expect(summary.deformers).toHaveLength(1);
    const warpDef = summary.deformers[0];
    expect(warpDef.kind).toBe("warp");
    expect(warpDef.parent).toBeUndefined();
    expect(warpDef.warp).toEqual({
      mode: "2d",
      parameterX: "ParamX",
      parameterY: "ParamY",
      gridX: 2,
      gridY: 1,
    });
  });
});

describe("listStandardParameters", () => {
  it("returns exactly 10 entries", () => {
    expect(listStandardParameters()).toHaveLength(10);
  });

  it("ids match the full set of StandardParameter values", () => {
    const ids = listStandardParameters().map((p) => p.id);
    expect(new Set(ids)).toEqual(new Set(Object.values(StandardParameter)));
  });

  it("every entry has a non-empty description", () => {
    for (const p of listStandardParameters()) {
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});
