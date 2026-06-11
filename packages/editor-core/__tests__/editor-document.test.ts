import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, IkiFormatError } from "@iki/format";
import type { IkiModel, IkiTransformChannel } from "@iki/format";
import {
  EditorDocument,
  SetDeformerBindings,
  SetDeformerParent,
  SetDeformerPivotX,
  SetDeformerPivotY,
  SetDeformerTransform,
  SetPartBindings,
  SetPartColor,
  SetPartDeformer,
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

// ── Deformer pivot/transform commands ────────────────────────────────────────

describe("deformer commands", () => {
  // m-root in the fixture has pivot { x: 0, y: 0 } and NO transform — confirmed
  // by reading fixtureModelWithDeformers above.

  it("SetDeformerPivotX — apply/undo/redo restores prior pivot.x", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    const original = doc.findMatrixDeformer("m-root").pivot.x; // 0

    doc.execute(new SetDeformerPivotX("m-root", 99));
    expect(doc.findMatrixDeformer("m-root").pivot.x).toBe(99);
    expect(doc.canUndo()).toBe(true);

    doc.undo();
    expect(doc.findMatrixDeformer("m-root").pivot.x).toBe(original);
    expect(doc.canRedo()).toBe(true);

    doc.redo();
    expect(doc.findMatrixDeformer("m-root").pivot.x).toBe(99);
  });

  it("SetDeformerPivotY — apply/undo/redo restores prior pivot.y", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    const original = doc.findMatrixDeformer("m-root").pivot.y; // 0

    doc.execute(new SetDeformerPivotY("m-root", 55));
    expect(doc.findMatrixDeformer("m-root").pivot.y).toBe(55);

    doc.undo();
    expect(doc.findMatrixDeformer("m-root").pivot.y).toBe(original);

    doc.redo();
    expect(doc.findMatrixDeformer("m-root").pivot.y).toBe(55);
  });

  it("SetDeformerTransform — rotation on a deformer with NO transform produces { x:0, y:0, rotation:45 }", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // Confirm m-root starts with no transform
    expect(doc.findMatrixDeformer("m-root").transform).toBeUndefined();

    doc.execute(new SetDeformerTransform("m-root", "rotation", 45));
    expect(doc.findMatrixDeformer("m-root").transform).toEqual({
      x: 0,
      y: 0,
      rotation: 45,
    });

    // Undo must restore transform === undefined
    doc.undo();
    expect(doc.findMatrixDeformer("m-root").transform).toBeUndefined();

    // Redo re-applies
    doc.redo();
    expect(doc.findMatrixDeformer("m-root").transform).toEqual({
      x: 0,
      y: 0,
      rotation: 45,
    });
  });

  it("SetDeformerTransform — editing scaleX on a deformer that already has transform preserves x/y", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // m-child has no transform in the fixture; install one directly so we can
    // test the "existing transform" branch.
    const mChild = doc.findMatrixDeformer("m-child");
    mChild.transform = { x: 10, y: 20 };

    const scaleVal = 2.5;
    doc.execute(new SetDeformerTransform("m-child", "scaleX", scaleVal));
    expect(doc.findMatrixDeformer("m-child").transform).toEqual({
      x: 10,
      y: 20,
      scaleX: scaleVal,
    });

    // Undo restores the exact prior { x: 10, y: 20 } (no scaleX)
    doc.undo();
    expect(doc.findMatrixDeformer("m-child").transform).toEqual({
      x: 10,
      y: 20,
    });

    doc.redo();
    expect(doc.findMatrixDeformer("m-child").transform).toEqual({
      x: 10,
      y: 20,
      scaleX: scaleVal,
    });
  });

  it("SetDeformerTransform — exported model after rotation-only edit passes toIkiModel", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    doc.execute(new SetDeformerTransform("m-root", "rotation", 30));
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("SetDeformerTransform — capture-once: redo yields the original captured new value even if model is dirtied between undo/redo", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());

    doc.execute(new SetDeformerTransform("m-root", "rotation", 45));
    doc.undo();

    // Dirty pivot.x via getModel() — this should not affect the captured new value
    doc.findMatrixDeformer("m-root").pivot.x = 999;

    doc.redo();
    // The captured new transform (rotation:45) must be re-applied regardless
    expect(doc.findMatrixDeformer("m-root").transform).toEqual({
      x: 0,
      y: 0,
      rotation: 45,
    });
  });
});

// ── SetDeformerBindings ───────────────────────────────────────────────────────

describe("SetDeformerBindings", () => {
  it("add a binding to m-child (originally no bindings) — present after apply, undo removes the key, redo re-adds", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // m-child has no bindings in the fixture
    expect(doc.findMatrixDeformer("m-child").bindings).toBeUndefined();

    const newBinding = {
      parameter: "ParamA",
      channel: "rotate" as const,
      from: -10,
      to: 10,
    };
    doc.execute(new SetDeformerBindings("m-child", [newBinding]));

    const afterApply = doc.findMatrixDeformer("m-child").bindings;
    expect(afterApply).toHaveLength(1);
    expect(afterApply![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -10,
      to: 10,
    });

    // Undo must remove the key entirely (absent, not empty array)
    doc.undo();
    expect(doc.findMatrixDeformer("m-child").bindings).toBeUndefined();
    expect(doc.findMatrixDeformer("m-child")).not.toHaveProperty("bindings");

    // Redo re-adds the binding
    doc.redo();
    expect(doc.findMatrixDeformer("m-child").bindings).toHaveLength(1);
    expect(doc.findMatrixDeformer("m-child").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -10,
      to: 10,
    });
  });

  it("edit m-root's existing ParamA/rotate binding from/to — applied, undo restores { from: -6, to: 6 }", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // m-root starts with [{ parameter: "ParamA", channel: "rotate", from: -6, to: 6 }]
    expect(doc.findMatrixDeformer("m-root").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -6,
      to: 6,
    });

    doc.execute(
      new SetDeformerBindings("m-root", [
        { parameter: "ParamA", channel: "rotate" as const, from: -30, to: 30 },
      ]),
    );
    expect(doc.findMatrixDeformer("m-root").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -30,
      to: 30,
    });

    doc.undo();
    expect(doc.findMatrixDeformer("m-root").bindings).toHaveLength(1);
    expect(doc.findMatrixDeformer("m-root").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -6,
      to: 6,
    });

    doc.redo();
    expect(doc.findMatrixDeformer("m-root").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -30,
      to: 30,
    });
  });

  it("remove the only binding on m-root (pass []) — bindings key absent, undo restores it", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());

    doc.execute(new SetDeformerBindings("m-root", []));
    // delete-on-empty: the key must be absent, not an empty array
    expect(doc.findMatrixDeformer("m-root")).not.toHaveProperty("bindings");

    doc.undo();
    expect(doc.findMatrixDeformer("m-root").bindings).toHaveLength(1);
    expect(doc.findMatrixDeformer("m-root").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -6,
      to: 6,
    });

    doc.redo();
    expect(doc.findMatrixDeformer("m-root")).not.toHaveProperty("bindings");
  });

  it("construction deep-copy: mutating the passed array and binding object after execute does not corrupt the deformer", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    const binding = {
      parameter: "ParamA",
      channel: "rotate" as const,
      from: -10,
      to: 10,
    };
    const arr = [binding];

    doc.execute(new SetDeformerBindings("m-child", arr));

    // Mutate the caller's array and object AFTER execute
    arr.push({
      parameter: "ParamA",
      channel: "translateX" as const,
      from: 0,
      to: 1,
    });
    binding.from = -999;
    binding.to = 999;

    // The deformer's bindings must still reflect the intended values, not the mutations
    const stored = doc.findMatrixDeformer("m-child").bindings!;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -10,
      to: 10,
    });
  });

  it("capture-once + no-alias-on-invert: undo, mutate model bindings, redo yields the intended array", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    const intended = [
      { parameter: "ParamA", channel: "rotate" as const, from: -20, to: 20 },
    ];

    doc.execute(new SetDeformerBindings("m-root", intended));
    doc.undo();

    // Dirty the model's bindings directly between undo and redo
    doc.findMatrixDeformer("m-root").bindings![0].from = 999;

    doc.redo();
    // Redo must re-apply the originally-intended value, not the dirty value
    expect(doc.findMatrixDeformer("m-root").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "rotate",
      from: -20,
      to: 20,
    });
  });
});

// ── SetDeformerParent ─────────────────────────────────────────────────────────

describe("SetDeformerParent", () => {
  it("detach m-child from m-root (newParentId=undefined) — parent key absent after apply, undo restores parent=m-root, redo re-detaches", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // m-child starts with parent === "m-root"
    expect(doc.findDeformer("m-child").parent).toBe("m-root");

    doc.execute(new SetDeformerParent("m-child", undefined));

    // After apply: parent key must be absent (not just undefined)
    const afterApply = doc.findDeformer("m-child");
    expect(Object.prototype.hasOwnProperty.call(afterApply, "parent")).toBe(
      false,
    );
    expect(doc.canUndo()).toBe(true);

    // Undo restores parent === "m-root"
    doc.undo();
    const afterUndo = doc.findDeformer("m-child");
    expect(afterUndo.parent).toBe("m-root");
    expect(Object.prototype.hasOwnProperty.call(afterUndo, "parent")).toBe(
      true,
    );
    expect(doc.canRedo()).toBe(true);

    // Redo re-detaches
    doc.redo();
    expect(
      Object.prototype.hasOwnProperty.call(
        doc.findDeformer("m-child"),
        "parent",
      ),
    ).toBe(false);
  });

  it("meaningful matrix→matrix reparent: detach m-child from m-root first, then reparent back — exercises a real parent CHANGE from absent to present", () => {
    // Strategy: start fresh, use SetDeformerParent("m-child", undefined) to make
    // m-child a root deformer (no parent), then use SetDeformerParent("m-child", "m-root")
    // to assign a new parent. This is a REAL parent change: absent → "m-root".
    const doc = new EditorDocument(fixtureModelWithDeformers());

    // Step 1: detach m-child to root
    doc.execute(new SetDeformerParent("m-child", undefined));
    expect(
      Object.prototype.hasOwnProperty.call(
        doc.findDeformer("m-child"),
        "parent",
      ),
    ).toBe(false);

    // Step 2: reparent m-child to m-root (absent → present, real parent change)
    doc.execute(new SetDeformerParent("m-child", "m-root"));
    expect(doc.findDeformer("m-child").parent).toBe("m-root");

    // Undo step 2: back to absent parent
    doc.undo();
    expect(
      Object.prototype.hasOwnProperty.call(
        doc.findDeformer("m-child"),
        "parent",
      ),
    ).toBe(false);

    // Redo step 2: re-root under m-root
    doc.redo();
    expect(doc.findDeformer("m-child").parent).toBe("m-root");
  });

  it("INVALID: cycle — SetDeformerParent(m-root, m-child) creates a cycle — throws, model unchanged, canUndo()===false", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // m-root has no parent; m-child.parent === m-root. Making m-root's parent m-child creates a cycle.
    const mRootBefore = doc.findDeformer("m-root").parent;

    expect(() =>
      doc.execute(new SetDeformerParent("m-root", "m-child")),
    ).toThrow();
    // Model unchanged
    expect(doc.findDeformer("m-root").parent).toBe(mRootBefore);
    // Nothing was pushed — validate-first threw before execute could push
    expect(doc.canUndo()).toBe(false);
  });

  it("INVALID: warp deformer as parent — SetDeformerParent(m-child, w) — throws, model unchanged, canUndo()===false", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    const prevParent = doc.findDeformer("m-child").parent; // "m-root"

    expect(() => doc.execute(new SetDeformerParent("m-child", "w"))).toThrow();
    // Model unchanged
    expect(doc.findDeformer("m-child").parent).toBe(prevParent);
    expect(doc.canUndo()).toBe(false);
  });
});

// ── SetPartBindings ───────────────────────────────────────────────────────────

describe("SetPartBindings", () => {
  it("apply/undo/redo — translateX binding on part-a (no prior bindings)", () => {
    const doc = new EditorDocument(fixtureModel());
    // part-a has no bindings in the fixture
    expect(doc.findPart("part-a")).not.toHaveProperty("bindings");

    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "translateX", from: -5, to: 5 },
      ]),
    );
    const afterApply = doc.findPart("part-a").bindings;
    expect(afterApply).toHaveLength(1);
    expect(afterApply![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -5,
      to: 5,
    });

    // Undo must remove the key entirely (absent, not empty array)
    doc.undo();
    expect(
      doc.getModel().parts.find((p) => p.id === "part-a"),
    ).not.toHaveProperty("bindings");

    // Redo re-adds the binding
    doc.redo();
    expect(doc.findPart("part-a").bindings).toHaveLength(1);
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -5,
      to: 5,
    });
  });

  it("opacity channel round-trips through toIkiModel without throwing", () => {
    const doc = new EditorDocument(fixtureModel());
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "opacity", from: 0, to: 1 },
      ]),
    );
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("absent-vs-empty: SetPartBindings(part-a, []) deletes the key; undo restores prior absent state", () => {
    const doc = new EditorDocument(fixtureModel());
    // part-a starts with no bindings
    expect(doc.findPart("part-a")).not.toHaveProperty("bindings");

    doc.execute(new SetPartBindings("part-a", []));
    // delete-on-empty: key must be absent, not an empty array
    expect(doc.findPart("part-a")).not.toHaveProperty("bindings");

    // Undo restores the prior absent state
    doc.undo();
    expect(doc.findPart("part-a")).not.toHaveProperty("bindings");
  });

  it("construction deep-copy: mutating the passed array/objects after construction does not corrupt the stored bindings", () => {
    const doc = new EditorDocument(fixtureModel());
    const binding = {
      parameter: "ParamA",
      channel: "translateX" as const,
      from: -5,
      to: 5,
    };
    const arr = [binding];

    const cmd = new SetPartBindings("part-a", arr);

    // Mutate AFTER construction but BEFORE execute
    arr.push({
      parameter: "ParamA",
      channel: "opacity" as const,
      from: 0,
      to: 1,
    });
    binding.from = -999;
    binding.to = 999;

    doc.execute(cmd);
    const stored = doc.findPart("part-a").bindings!;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -5,
      to: 5,
    });
  });

  it("capture-once / no-alias-on-invert: redo after undo + model dirty yields the intended bindings", () => {
    const doc = new EditorDocument(fixtureModel());
    const intended = [
      { parameter: "ParamA", channel: "translateX" as const, from: -1, to: 1 },
    ];

    doc.execute(new SetPartBindings("part-a", intended));
    doc.undo();

    // Dirty the model between undo and redo — redo must still yield the intended value
    // part-a has no bindings after undo, so we add a dirty state via getModel()
    const part = doc.getModel().parts.find((p) => p.id === "part-a")!;
    part.bindings = [
      { parameter: "ParamA", channel: "opacity" as const, from: 0, to: 0 },
    ];

    doc.redo();
    expect(doc.findPart("part-a").bindings).toHaveLength(1);
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -1,
      to: 1,
    });
  });

  it("narrow-candidate fail-fast: undeclared parameter → execute throws IkiFormatError; part-a.bindings absent; canUndo()===false", () => {
    const doc = new EditorDocument(fixtureModel());
    expect(() =>
      doc.execute(
        new SetPartBindings("part-a", [
          { parameter: "Nope", channel: "translateX", from: 0, to: 1 },
        ]),
      ),
    ).toThrow(IkiFormatError);
    expect(doc.findPart("part-a")).not.toHaveProperty("bindings");
    expect(doc.canUndo()).toBe(false);
  });

  it("narrow-candidate fail-fast: invalid channel → execute throws; model + canUndo() untouched", () => {
    const doc = new EditorDocument(fixtureModel());
    expect(() =>
      doc.execute(
        new SetPartBindings("part-a", [
          {
            parameter: "ParamA",
            channel: "bogusChannel" as IkiTransformChannel,
            from: 0,
            to: 1,
          },
        ]),
      ),
    ).toThrow(IkiFormatError);
    expect(doc.findPart("part-a")).not.toHaveProperty("bindings");
    expect(doc.canUndo()).toBe(false);
  });

  it("ISOLATION: corrupt an unrelated part's width to NaN; a VALID SetPartBindings on part-a still succeeds", () => {
    const doc = new EditorDocument(fixtureModel());
    // Corrupt part-b (an unrelated part) with an invalid width
    doc.getModel().parts.find((p) => p.id === "part-b")!.width = NaN;

    // A valid binding op on part-a should NOT be rejected due to part-b's invalid state
    expect(() =>
      doc.execute(
        new SetPartBindings("part-a", [
          { parameter: "ParamA", channel: "translateX", from: -1, to: 1 },
        ]),
      ),
    ).not.toThrow();

    expect(doc.findPart("part-a").bindings).toHaveLength(1);
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -1,
      to: 1,
    });
  });

  it("toIkiModel() passes after a valid binding op on an otherwise-clean fixtureModel()", () => {
    const doc = new EditorDocument(fixtureModel());
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "scaleX", from: 0.5, to: 2 },
      ]),
    );
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

// ── Ephemeral transform methods ───────────────────────────────────────────────

describe("ephemeral transform methods", () => {
  it("setPartTransformEphemeral replaces the whole transform; canUndo/canRedo remain false; restoring the snapshot restores the original shape", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // mesh-part starts with transform { x: 0, y: 0 } — no rotation or other optional keys
    const original = { ...doc.findPart("mesh-part").transform };
    expect(original).not.toHaveProperty("rotation");

    // Apply an ephemeral transform
    doc.setPartTransformEphemeral("mesh-part", { x: 99, y: 77 });
    expect(doc.findPart("mesh-part").transform).toEqual({ x: 99, y: 77 });
    expect(doc.canUndo()).toBe(false);
    expect(doc.canRedo()).toBe(false);

    // Restore by passing back the captured snapshot
    doc.setPartTransformEphemeral("mesh-part", original);
    const restored = doc.findPart("mesh-part").transform;
    expect(restored).toEqual({ x: 0, y: 0 });
    // Optional keys that were absent should still be absent after restore
    expect(restored).not.toHaveProperty("rotation");
    expect(restored).not.toHaveProperty("scaleX");
    expect(restored).not.toHaveProperty("opacity");
  });

  it("setDeformerTransformEphemeral sets and then deletes the transform key (m-child has no transform in fixture)", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // m-child has no transform in the fixture
    expect(doc.findMatrixDeformer("m-child").transform).toBeUndefined();

    // Set a transform
    doc.setDeformerTransformEphemeral("m-child", { x: 5, y: 6 });
    expect(doc.findMatrixDeformer("m-child").transform).toEqual({ x: 5, y: 6 });
    expect(doc.canUndo()).toBe(false);

    // Pass undefined to delete the key
    doc.setDeformerTransformEphemeral("m-child", undefined);
    expect(doc.findMatrixDeformer("m-child")).not.toHaveProperty("transform");
    expect(doc.canUndo()).toBe(false);
  });

  it("redo-stack preservation: ephemeral setter does not touch undo or redo stacks", () => {
    const doc = new EditorDocument(fixtureModel());

    // Build up a redo entry: execute a real command then undo it
    doc.execute(new SetPartWidth("part-a", 200));
    doc.undo();
    expect(doc.canRedo()).toBe(true);
    expect(doc.canUndo()).toBe(false);

    // Call an ephemeral setter
    doc.setPartTransformEphemeral("part-a", { x: 0, y: 0, rotation: 45 });

    // Both stacks must be unchanged
    expect(doc.canRedo()).toBe(true);
    expect(doc.canUndo()).toBe(false);
  });
});

// ── Ephemeral bindings methods ────────────────────────────────────────────────

describe("ephemeral bindings methods", () => {
  it("setPartBindingsEphemeral: set neutralizes a row; canUndo/canRedo unchanged; restoring rowRest values via set round-trips the original", () => {
    const doc = new EditorDocument(fixtureModel());
    // Start with a known binding on part-a.
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "translateX", from: -50, to: 50 },
      ]),
    );
    expect(doc.canUndo()).toBe(true);
    expect(doc.canRedo()).toBe(false);

    // Neutralize (zero) the row ephemerally — simulates enterCapture.
    doc.setPartBindingsEphemeral("part-a", [
      { parameter: "ParamA", channel: "translateX", from: 0, to: 0 },
    ]);
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: 0,
      to: 0,
    });
    // Undo/redo stacks must be unaffected.
    expect(doc.canUndo()).toBe(true);
    expect(doc.canRedo()).toBe(false);

    // Restore the original values — simulates clearCapture restoring rowRest.
    doc.setPartBindingsEphemeral("part-a", [
      { parameter: "ParamA", channel: "translateX", from: -50, to: 50 },
    ]);
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -50,
      to: 50,
    });
    expect(doc.canUndo()).toBe(true);
    expect(doc.canRedo()).toBe(false);
  });

  it("setPartBindingsEphemeral: empty array deletes the bindings key", () => {
    const doc = new EditorDocument(fixtureModel());
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "scaleX", from: 0.5, to: 2 },
      ]),
    );
    expect(doc.findPart("part-a")).toHaveProperty("bindings");

    doc.setPartBindingsEphemeral("part-a", []);
    expect(doc.findPart("part-a")).not.toHaveProperty("bindings");
    expect(doc.canUndo()).toBe(true);
  });

  it("recapture round-trip: SetPartBindings replaces original binding; Undo restores original from/to", () => {
    const doc = new EditorDocument(fixtureModel());

    // Establish initial binding {from:-50, to:50}.
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "translateX", from: -50, to: 50 },
      ]),
    );
    expect(doc.canUndo()).toBe(true);

    // Simulate enterCapture: zero the row ephemerally.
    doc.setPartBindingsEphemeral("part-a", [
      { parameter: "ParamA", channel: "translateX", from: 0, to: 0 },
    ]);

    // Simulate commitCapture: restore original before executing the command so
    // the command's prevBindings snapshot sees {from:-50, to:50}.
    doc.setPartBindingsEphemeral("part-a", [
      { parameter: "ParamA", channel: "translateX", from: -50, to: 50 },
    ]);

    // Execute the undoable command with new captured values.
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "translateX", from: -30, to: 80 },
      ]),
    );
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -30,
      to: 80,
    });

    // Undo must restore the ORIGINAL {from:-50, to:50}, not the zeroed row.
    doc.undo();
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "translateX",
      from: -50,
      to: 50,
    });
    expect(doc.canRedo()).toBe(true);
  });

  it("opacity recapture round-trip: neutralize with ×1, commit new values, Undo restores original", () => {
    const doc = new EditorDocument(fixtureModel());

    // Establish initial opacity binding {from:0.2, to:1}.
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "opacity", from: 0.2, to: 1 },
      ]),
    );
    expect(doc.canUndo()).toBe(true);

    // Simulate enterCapture for opacity: neutralize with ×1 identity (not 0).
    // Using from:0/to:0 would make the part invisible in the preview (opacity×0=0).
    doc.setPartBindingsEphemeral("part-a", [
      { parameter: "ParamA", channel: "opacity", from: 1, to: 1 },
    ]);
    // The ×1 row leaves the preview unaffected by this binding (identity).
    expect(doc.findPart("part-a").bindings![0]).toMatchObject({
      from: 1,
      to: 1,
    });
    expect(doc.canUndo()).toBe(true);
    expect(doc.canRedo()).toBe(false);

    // Simulate commitCapture: restore original so the command snapshot sees {from:0.2, to:1}.
    doc.setPartBindingsEphemeral("part-a", [
      { parameter: "ParamA", channel: "opacity", from: 0.2, to: 1 },
    ]);

    // Execute the undoable command with new captured values.
    doc.execute(
      new SetPartBindings("part-a", [
        { parameter: "ParamA", channel: "opacity", from: 0.5, to: 0.8 },
      ]),
    );
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "opacity",
      from: 0.5,
      to: 0.8,
    });

    // Undo must restore the ORIGINAL {from:0.2, to:1}, not the neutralized ×1 row.
    doc.undo();
    expect(doc.findPart("part-a").bindings![0]).toEqual({
      parameter: "ParamA",
      channel: "opacity",
      from: 0.2,
      to: 1,
    });
    expect(doc.canRedo()).toBe(true);
  });
});

// ── SetPartDeformer ───────────────────────────────────────────────────────────

describe("SetPartDeformer", () => {
  it("attach mesh-part to m-root (matrix deformer) — apply/undo/redo; undo restores original deformer=w", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());
    // mesh-part starts with deformer === "w"
    expect(doc.findPart("mesh-part").deformer).toBe("w");

    doc.execute(new SetPartDeformer("mesh-part", "m-root"));
    expect(doc.findPart("mesh-part").deformer).toBe("m-root");
    expect(doc.canUndo()).toBe(true);

    // Undo restores deformer === "w" (the ORIGINAL value, not just any value)
    doc.undo();
    const afterUndo = doc.findPart("mesh-part");
    expect(afterUndo.deformer).toBe("w");
    expect(Object.prototype.hasOwnProperty.call(afterUndo, "deformer")).toBe(
      true,
    );
    expect(doc.canRedo()).toBe(true);

    // Redo re-attaches to m-root
    doc.redo();
    expect(doc.findPart("mesh-part").deformer).toBe("m-root");
  });

  it("detach mesh-part (newDeformerId=undefined) — deformer key absent after apply, undo restores deformer=w exactly", () => {
    const doc = new EditorDocument(fixtureModelWithDeformers());

    doc.execute(new SetPartDeformer("mesh-part", undefined));

    // After detach: key must be absent
    expect(
      Object.prototype.hasOwnProperty.call(
        doc.findPart("mesh-part"),
        "deformer",
      ),
    ).toBe(false);

    // Undo restores the ORIGINAL value/presence exactly
    doc.undo();
    const afterUndo = doc.findPart("mesh-part");
    expect(afterUndo.deformer).toBe("w");
    expect(Object.prototype.hasOwnProperty.call(afterUndo, "deformer")).toBe(
      true,
    );

    doc.redo();
    expect(
      Object.prototype.hasOwnProperty.call(
        doc.findPart("mesh-part"),
        "deformer",
      ),
    ).toBe(false);
  });

  it("INVALID: meshless part → warp deformer — throws, part.deformer unchanged, canUndo()===false", () => {
    // Add a meshless part to the model to test this case.
    const model = fixtureModelWithDeformers();
    model.parts.push({
      id: "no-mesh",
      color: [0, 0, 1, 1],
      width: 10,
      height: 10,
      order: 1,
      transform: { x: 0, y: 0 },
    });
    const doc = new EditorDocument(model);

    // no-mesh has no deformer initially
    expect(
      Object.prototype.hasOwnProperty.call(doc.findPart("no-mesh"), "deformer"),
    ).toBe(false);

    // Attaching a meshless part to the warp deformer "w" must fail
    expect(() => doc.execute(new SetPartDeformer("no-mesh", "w"))).toThrow();
    // Model unchanged — deformer key still absent
    expect(
      Object.prototype.hasOwnProperty.call(doc.findPart("no-mesh"), "deformer"),
    ).toBe(false);
    expect(doc.canUndo()).toBe(false);
  });
});
