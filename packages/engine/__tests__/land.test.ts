import { describe, expect, it } from "vitest";
import type { IkiModel, IkiParameter, IkiPart } from "@ikijs/format";
import { landParts } from "@ikijs/engine";

const ANGLE_X: IkiParameter = {
  id: "ParamAngleX",
  min: -30,
  max: 30,
  default: 0,
};

function part(id: string, more: Partial<IkiPart> = {}): IkiPart {
  return {
    id,
    color: [1, 1, 1, 1],
    width: 10,
    height: 10,
    transform: { x: 0, y: 0 },
    order: 0,
    ...more,
  };
}

function model(parts: IkiPart[], more: Partial<IkiModel> = {}): IkiModel {
  return {
    version: 1,
    name: "t",
    canvas: { width: 100, height: 100 },
    parameters: [ANGLE_X],
    parts,
    ...more,
  };
}

/** 3x3-point rest grid on x,y in [-1, 1], row-major, +y up (the folds test's). */
const GRID = {
  cols: 2,
  rows: 2,
  points: [-1, 1, 0, 1, 1, 1, -1, 0, 0, 0, 1, 0, -1, -1, 0, -1, 1, -1],
};

describe("landParts", () => {
  it("(a) a free part lands its unit quad on the corners of its box", () => {
    const m = model([part("p", { transform: { x: 100, y: 50 } })]);
    const landed = landParts(m, {}, ["p"]).get("p")!;
    expect(Array.from(landed)).toEqual([95, 45, 105, 45, 95, 55, 105, 55]);
  });

  it("(b) a binding moves the part with the value, in a distinct array", () => {
    const m = model([
      part("p", {
        bindings: [
          {
            parameter: "ParamAngleX",
            channel: "translateX",
            from: -30,
            to: 30,
          },
        ],
      }),
    ]);
    const rest = landParts(m, {}, ["p"]).get("p")!;
    const posed = landParts(m, { ParamAngleX: 15 }, ["p"]).get("p")!;
    expect(posed).not.toBe(rest);
    for (let i = 0; i < rest.length; i += 2) {
      expect(posed[i] - rest[i]).toBeCloseTo(15, 5);
      expect(posed[i + 1]).toBeCloseTo(rest[i + 1], 5);
    }
  });

  it("(c) a warp child lands where the grid's keyform moves it", () => {
    const offsets = new Array<number>(18).fill(0);
    offsets[4 * 2] = 0.3;
    offsets[4 * 2 + 1] = -0.3;
    const m = model(
      [
        part("p", {
          width: 1,
          height: 1,
          deformer: "w",
          mesh: {
            vertices: [-0.5, -0.5, 0.5, -0.5, 0, 0, 0.5, 0.5, -0.5, 0.5],
            uvs: new Array<number>(10).fill(0),
            indices: [0, 1, 2, 1, 3, 2, 3, 4, 2, 4, 0, 2],
          },
        }),
      ],
      {
        deformers: [
          {
            kind: "warp",
            id: "w",
            grid: GRID,
            warps: [
              {
                parameter: "ParamAngleX",
                keyforms: [
                  { value: 0, offsets: new Array<number>(18).fill(0) },
                  { value: 30, offsets },
                ],
              },
            ],
          },
        ],
      },
    );
    const rest = landParts(m, {}, ["p"]).get("p")!;
    const posed = landParts(m, { ParamAngleX: 30 }, ["p"]).get("p")!;
    expect(landParts(m, { ParamAngleX: 0 }, ["p"]).get("p")).toEqual(rest);
    // The mesh's centre vertex sits on the moved control point.
    expect(posed[4] - rest[4]).toBeCloseTo(0.3, 5);
    expect(posed[5] - rest[5]).toBeCloseTo(-0.3, 5);
  });

  it("(d) an unknown id is absent and no ids give an empty map", () => {
    const m = model([part("p")]);
    expect(landParts(m, {}, ["nope"]).has("nope")).toBe(false);
    expect(landParts(m, {}, []).size).toBe(0);
  });

  it("(e) a part without a mesh lands exactly four points", () => {
    const m = model([part("p")]);
    expect(landParts(m, {}, ["p"]).get("p")).toHaveLength(8);
  });
});
