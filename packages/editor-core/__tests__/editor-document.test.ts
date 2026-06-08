import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, IkiFormatError } from "@iki/format";
import type { IkiModel } from "@iki/format";
import {
  EditorDocument,
  SetPartColor,
  SetPartHeight,
  SetPartOrder,
  SetPartTransform,
  SetPartWidth,
} from "@iki/editor-core";


/**
 * A minimal valid IkiModel with two quad parts. No optional fields (textures,
 * bindings, mesh, deformers) so the fixture stays small and the validator passes.
 * Mirrors the style of packages/format/__tests__/validate.test.ts validModel().
 */
function fixtureModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "fixture",
    canvas: { width: 100, height: 100 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    parts: [
      {
        id: "part-a",
        color: [1, 0, 0, 1],
        width: 50,
        height: 60,
        order: 0,
        transform: { x: 10, y: 20 },
      },
      {
        id: "part-b",
        color: [0, 1, 0, 1],
        width: 30,
        height: 40,
        order: 1,
        transform: { x: -5, y: 5 },
      },
    ],
  };
}

/**
 * A minimal valid IkiModel with two matrix deformers and one warp deformer.
 * Used by the deformer-accessor tests (5e). Must pass parseIkiModel.
 *
 * Deformer layout:
 *   m-root (matrix, pivot 0,0, one binding ParamA→rotate)
 *   m-child (matrix, parent: m-root, pivot 10,0)
 *   w       (warp,   parent: m-root, 1×1 grid, warps: [])
 *
 * Part "mesh-part" hangs from warp deformer "w" and carries the required mesh.
 */
function fixtureModelWithDeformers(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "fixture-deformers",
    canvas: { width: 100, height: 100 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    parts: [
      {
        id: "mesh-part",
        color: [1, 1, 1, 1],
        width: 20,
        height: 20,
        order: 0,
        transform: { x: 0, y: 0 },
        deformer: "w",
        // Minimal triangle mesh (3 vertices). uvs must be 0..1.
        mesh: {
          vertices: [-10, 10, 10, 10, 0, -10],
          uvs: [0, 0, 1, 0, 0.5, 1],
          indices: [0, 1, 2],
        },
      },
    ],
    deformers: [
      {
        id: "m-root",
        pivot: { x: 0, y: 0 },
        bindings: [{ parameter: "ParamA", channel: "rotate", from: -6, to: 6 }],
      },
      {
        id: "m-child",
        parent: "m-root",
        pivot: { x: 10, y: 0 },
      },
      {
        kind: "warp" as const,
        id: "w",
        parent: "m-root",
        // 1×1 grid → (1+1)*(1+1) = 4 control points.
        // Row 0 (top) first: [-10,10] [10,10]; row 1 (bottom): [-10,-10] [10,-10]
        grid: {
          cols: 1,
          rows: 1,
          points: [-10, 10, 10, 10, -10, -10, 10, -10],
        },
        warps: [],
      },
    ],
  };
}

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("round-trip", () => {
  it("exports a valid model without throwing", () => {
    const doc = new EditorDocument(fixtureModel());
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("exported model preserves specific field values", () => {
    const doc = new EditorDocument(fixtureModel());
    const result = doc.toIkiModel();
    expect(result.parts[0].width).toBe(50);
    expect(result.parts[0].height).toBe(60);
    expect(result.parts[0].color).toEqual([1, 0, 0, 1]);
    expect(result.parts[1].order).toBe(1);
    // Optional transform channels are undefined — NOT absent-key, just undefined
    expect(result.parts[0].transform.rotation).toBeUndefined();
    expect(result.parts[0].transform.scaleX).toBeUndefined();
    expect(result.parts[0].transform.opacity).toBeUndefined();
  });

  it("throws IkiFormatError with path-qualified message on invalid export", () => {
    const doc = new EditorDocument(fixtureModel());
    // Corrupt via the live model reference — NaN is not a finite number
    (doc.getModel().parts[0] as Record<string, unknown>).width = NaN;
    expect(() => doc.toIkiModel()).toThrow(IkiFormatError);
    // The error message must be path-qualified (contains "parts[")
    let caught: unknown;
    try {
      doc.toIkiModel();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IkiFormatError);
    expect((caught as IkiFormatError).message).toMatch(/parts\[/);
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe("commands", () => {
  it("SetPartWidth — apply changes width, undo restores, redo re-applies", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-a";
    const original = doc.findPart(partId).width; // 50
    const newWidth = 99;

    expect(doc.canUndo()).toBe(false);
    expect(doc.canRedo()).toBe(false);

    doc.execute(new SetPartWidth(partId, newWidth));
    expect(doc.findPart(partId).width).toBe(newWidth);
    expect(doc.canUndo()).toBe(true);
    expect(doc.canRedo()).toBe(false);

    doc.undo();
    expect(doc.findPart(partId).width).toBe(original);
    expect(doc.canUndo()).toBe(false);
    expect(doc.canRedo()).toBe(true);

    doc.redo();
    expect(doc.findPart(partId).width).toBe(newWidth);
    expect(doc.canUndo()).toBe(true);
    expect(doc.canRedo()).toBe(false);
  });

  it("SetPartOrder — apply/undo/redo", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-b";
    const original = doc.findPart(partId).order; // 1

    doc.execute(new SetPartOrder(partId, 5));
    expect(doc.findPart(partId).order).toBe(5);

    doc.undo();
    expect(doc.findPart(partId).order).toBe(original);

    doc.redo();
    expect(doc.findPart(partId).order).toBe(5);
  });

  it("SetPartHeight — apply/undo/redo", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-a";
    const original = doc.findPart(partId).height; // 60

    doc.execute(new SetPartHeight(partId, 120));
    expect(doc.findPart(partId).height).toBe(120);

    doc.undo();
    expect(doc.findPart(partId).height).toBe(original);

    doc.redo();
    expect(doc.findPart(partId).height).toBe(120);
  });

  it("SetPartTransform (channel x) — apply/undo/redo", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-a";
    const original = doc.findPart(partId).transform.x; // 10

    doc.execute(new SetPartTransform(partId, "x", 77));
    expect(doc.findPart(partId).transform.x).toBe(77);
    expect(doc.canUndo()).toBe(true);

    doc.undo();
    expect(doc.findPart(partId).transform.x).toBe(original);
    expect(doc.canRedo()).toBe(true);

    doc.redo();
    expect(doc.findPart(partId).transform.x).toBe(77);
  });

  it("SetPartColor — cloning: external mutation of caller array cannot corrupt the command or redo", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-a";
    const newRgba: [number, number, number, number] = [0.1, 0.2, 0.3, 1];

    doc.execute(new SetPartColor(partId, newRgba));
    // Mutate the caller's array AFTER execute — command owns an independent copy
    newRgba[0] = 9;
    // Part's color must still reflect the intended value, not the mutated one
    expect(doc.findPart(partId).color).toEqual([0.1, 0.2, 0.3, 1]);

    // Undo restores original fixture color
    doc.undo();
    expect(doc.findPart(partId).color).toEqual([1, 0, 0, 1]);

    // Redo must yield the INTENDED new color [0.1,0.2,0.3,1], NOT [9,0.2,0.3,1]
    doc.redo();
    expect(doc.findPart(partId).color).toEqual([0.1, 0.2, 0.3, 1]);
  });

  it("SetPartTransform (optional channel) — undo removes the key when it was originally absent", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-a";

    // Confirm rotation was NOT present on the fixture part
    expect(doc.getModel().parts[0].transform).not.toHaveProperty("rotation");

    // Edit rotation on a part that had no rotation
    doc.execute(new SetPartTransform(partId, "rotation", 45));
    expect(doc.findPart(partId).transform.rotation).toBe(45);

    // Undo must restore the original absence — checked on the WORKING model
    doc.undo();
    const restored = doc.getModel().parts[0].transform;
    expect(restored).not.toHaveProperty("rotation");
  });

  it("new command after undo clears the redo stack", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-b";

    doc.execute(new SetPartWidth(partId, 10));
    doc.undo();
    expect(doc.canRedo()).toBe(true);

    // Execute a brand-new command — redo stack must be cleared
    doc.execute(new SetPartWidth(partId, 20));
    expect(doc.canRedo()).toBe(false);
  });

  it("redo reuses the once-captured prior value (capture-once semantics)", () => {
    const doc = new EditorDocument(fixtureModel());
    const partId = "part-a";
    const newWidth = 200;

    doc.execute(new SetPartWidth(partId, newWidth));
    // Dirty the model between undo and redo to confirm redo re-applies original capture
    doc.undo();
    // Corrupt the field via getModel() — redo must still yield newWidth, not whatever is here
    doc.getModel().parts[0].width = 999;
    doc.redo();
    expect(doc.findPart(partId).width).toBe(newWidth);
  });
});

// ── Deformer accessors ────────────────────────────────────────────────────────

describe("deformer accessors", () => {
  it("fixtureModelWithDeformers passes parseIkiModel (sanity)", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("findMatrixDeformer returns the matrix deformer for a known id", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    const d = doc.findMatrixDeformer("m-root");
    expect(d.id).toBe("m-root");
    expect(d.kind).toBeUndefined();
    expect(d.bindings).toHaveLength(1);
  });

  it("findMatrixDeformer throws when the id belongs to a warp deformer", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    expect(() => doc.findMatrixDeformer("w")).toThrow(
      /deformers: no matrix deformer/,
    );
  });

  it("findMatrixDeformer throws when the id is unknown", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    expect(() => doc.findMatrixDeformer("nope")).toThrow(
      /deformers: no matrix deformer/,
    );
  });

  it("findDeformer returns a warp deformer by id", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    const d = doc.findDeformer("w");
    expect(d.id).toBe("w");
    expect(d.kind).toBe("warp");
  });

  it("findDeformer throws when the id is unknown", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    expect(() => doc.findDeformer("nope")).toThrow(/no deformer with id/);
  });
});
