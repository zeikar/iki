import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, parseIkiModel } from "@iki/format";
import type { IkiGridKeyform, IkiModel } from "@iki/format";
import {
  CaptureGridKeyform,
  EditorDocument,
  computeGridOffsets,
  interpolateGridOffsets,
  upsertGridKeyform,
} from "@iki/editor-core";

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("interpolateGridOffsets", () => {
  const keyforms = [
    { value: -1, offsets: [-30, -30] },
    { value: 1, offsets: [30, 30] },
  ];

  it("clamps below the first keyform (no extrapolation)", () => {
    expect(interpolateGridOffsets(keyforms, -5)).toEqual([-30, -30]);
  });

  it("clamps above the last keyform (no extrapolation)", () => {
    expect(interpolateGridOffsets(keyforms, 5)).toEqual([30, 30]);
  });

  it("lerps the bracketing pair at the midpoint (value 0 → average)", () => {
    expect(interpolateGridOffsets(keyforms, 0)).toEqual([0, 0]);
  });

  it("lerps the correct middle pair with three keyforms", () => {
    const three = [
      { value: -1, offsets: [-10, -10] },
      { value: 0, offsets: [0, 0] },
      { value: 1, offsets: [20, 20] },
    ];
    // value 0.5 is between keyforms[1] and keyforms[2] → average of 0 and 20
    expect(interpolateGridOffsets(three, 0.5)).toEqual([10, 10]);
  });

  it("returns a fresh array (not aliasing a keyform's offsets)", () => {
    const result = interpolateGridOffsets(keyforms, -5);
    expect(result).not.toBe(keyforms[0].offsets);
    result[0] = 999;
    expect(keyforms[0].offsets[0]).toBe(-30);
  });

  it("throws on empty keyforms", () => {
    expect(() => interpolateGridOffsets([], 0)).toThrow();
  });
});

describe("computeGridOffsets", () => {
  it("produces dragged − rest per component", () => {
    const rest = [0, 0, 10, 0];
    const dragged = [1, 2, 13, -4];
    expect(computeGridOffsets(rest, dragged)).toEqual([1, 2, 3, -4]);
  });

  it("returns a fresh array of length === restPoints.length", () => {
    const rest = [0, 0];
    const result = computeGridOffsets(rest, [5, 5]);
    expect(result).toHaveLength(rest.length);
    expect(result).not.toBe(rest);
  });

  it("throws path-qualified on length mismatch", () => {
    expect(() => computeGridOffsets([0, 0], [1, 2, 3, 4])).toThrow(
      /computeGridOffsets:/,
    );
  });

  it("throws path-qualified on odd length", () => {
    expect(() => computeGridOffsets([0, 0, 0], [1, 2, 3])).toThrow(
      /computeGridOffsets:/,
    );
  });
});

describe("upsertGridKeyform", () => {
  function base(): IkiGridKeyform[] {
    return [
      { value: -1, offsets: [-1, -1] },
      { value: 1, offsets: [1, 1] },
    ];
  }

  it("REPLACE at an existing value does not grow the array", () => {
    const result = upsertGridKeyform(base(), 1, [9, 9]);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ value: 1, offsets: [9, 9] });
  });

  it("INSERT keeps the array strictly ascending by value", () => {
    const result = upsertGridKeyform(base(), 0, [0, 0]);
    expect(result.map((kf) => kf.value)).toEqual([-1, 0, 1]);
  });

  it("INSERT at the end appends when value is the largest", () => {
    const result = upsertGridKeyform(base(), 5, [5, 5]);
    expect(result.map((kf) => kf.value)).toEqual([-1, 1, 5]);
  });

  it("does not mutate the input array or its keyforms", () => {
    const input = base();
    upsertGridKeyform(input, 1, [9, 9]);
    expect(input).toHaveLength(2);
    expect(input[1].offsets).toEqual([1, 1]);
  });

  it("result offsets do not alias the caller's offsets array", () => {
    const offsets = [7, 7];
    const result = upsertGridKeyform(base(), 0, offsets);
    offsets[0] = 999;
    const inserted = result.find((kf) => kf.value === 0)!;
    expect(inserted.offsets).toEqual([7, 7]);
  });

  it("is idempotent — upserting the same value twice yields equal arrays", () => {
    const once = upsertGridKeyform(base(), 0, [2, 3]);
    const twice = upsertGridKeyform(once, 0, [2, 3]);
    expect(twice).toEqual(once);
  });
});

// ── CaptureGridKeyform round-trip ───────────────────────────────────────────

/**
 * A minimal valid model with a `faceWarp`-shaped warp deformer: a regular 1×1
 * grid (4 control points) driven by one keyform. The grid is the smallest
 * regular axis-aligned lattice the validator accepts. Helpers stay
 * grid-size-agnostic, so this small grid exercises the same paths as the 4×4
 * sample.
 */
function warpModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "warp-fixture",
    canvas: { width: 100, height: 100 },
    parameters: [{ id: "faceAngleX", min: -30, max: 30, default: 0 }],
    parts: [
      {
        id: "face",
        color: [1, 1, 1, 1],
        width: 50,
        height: 50,
        order: 0,
        transform: { x: 0, y: 0 },
        deformer: "faceWarp",
        mesh: {
          vertices: [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5],
          uvs: [0, 1, 1, 1, 1, 0],
          indices: [0, 1, 2],
        },
      },
    ],
    deformers: [
      {
        kind: "warp",
        id: "faceWarp",
        // 1×1 grid: row 0 top (largest y), column 0 left (smallest x).
        grid: { cols: 1, rows: 1, points: [-20, 20, 20, 20, -20, -20, 20, -20] },
        warps: [
          {
            parameter: "faceAngleX",
            keyforms: [{ value: 0, offsets: [0, 0, 0, 0, 0, 0, 0, 0] }],
          },
        ],
      },
    ],
  };
}

function gridWarp(doc: EditorDocument) {
  return doc.findWarpDeformer("faceWarp").warps![0];
}

describe("CaptureGridKeyform", () => {
  const offsets = [1, 2, 3, 4, 5, 6, 7, 8];

  it("clones offsets on construction — later caller mutation cannot corrupt apply", () => {
    const doc = new EditorDocument(warpModel());
    const caller = [...offsets];
    const cmd = new CaptureGridKeyform("faceWarp", 10, caller);
    caller[0] = 999;
    doc.execute(cmd);
    const captured = gridWarp(doc).keyforms.find((kf) => kf.value === 10)!;
    expect(captured.offsets).toEqual(offsets);
  });

  it("execute replaces keyform offsets at an existing value", () => {
    const doc = new EditorDocument(warpModel());
    doc.execute(new CaptureGridKeyform("faceWarp", 0, offsets));
    const keyforms = gridWarp(doc).keyforms;
    expect(keyforms).toHaveLength(1);
    expect(keyforms[0]).toEqual({ value: 0, offsets });
  });

  it("execute inserts a new keyform keeping ascending order", () => {
    const doc = new EditorDocument(warpModel());
    doc.execute(new CaptureGridKeyform("faceWarp", 20, offsets));
    expect(gridWarp(doc).keyforms.map((kf) => kf.value)).toEqual([0, 20]);
  });

  it("undo restores the EXACT prior keyforms, redo re-applies", () => {
    const doc = new EditorDocument(warpModel());
    const before = structuredClone(gridWarp(doc).keyforms);

    doc.execute(new CaptureGridKeyform("faceWarp", 20, offsets));
    expect(gridWarp(doc).keyforms).toHaveLength(2);

    doc.undo();
    expect(gridWarp(doc).keyforms).toEqual(before);

    doc.redo();
    expect(gridWarp(doc).keyforms.map((kf) => kf.value)).toEqual([0, 20]);
    const redone = gridWarp(doc).keyforms.find((kf) => kf.value === 20)!;
    expect(redone.offsets).toEqual(offsets);
  });

  it("apply throws path-qualified on offsets-length mismatch and leaves the model unmutated", () => {
    const doc = new EditorDocument(warpModel());
    const before = structuredClone(gridWarp(doc).keyforms);
    expect(() =>
      doc.execute(new CaptureGridKeyform("faceWarp", 10, [1, 2, 3, 4])),
    ).toThrow(/deformers\."faceWarp"/);
    expect(gridWarp(doc).keyforms).toEqual(before);
  });

  it("apply throws path-qualified on out-of-range value and leaves the model unmutated", () => {
    const doc = new EditorDocument(warpModel());
    const before = structuredClone(gridWarp(doc).keyforms);
    expect(() =>
      doc.execute(new CaptureGridKeyform("faceWarp", 999, offsets)),
    ).toThrow(/deformers\."faceWarp"/);
    expect(gridWarp(doc).keyforms).toEqual(before);
  });

  it("the post-apply model still passes parseIkiModel", () => {
    const doc = new EditorDocument(warpModel());
    doc.execute(new CaptureGridKeyform("faceWarp", 30, offsets));
    expect(() => doc.toIkiModel()).not.toThrow();
    const parsed = parseIkiModel(doc.toIkiModel());
    const warp = parsed.deformers!.find((d) => d.id === "faceWarp")!;
    expect(warp.kind).toBe("warp");
  });

  it("findWarpDeformer throws path-qualified for an unknown id", () => {
    const doc = new EditorDocument(warpModel());
    expect(() => doc.findWarpDeformer("nope")).toThrow(
      /deformers: no warp deformer with id "nope"/,
    );
  });
});
