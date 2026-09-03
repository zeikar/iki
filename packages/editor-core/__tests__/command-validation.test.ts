import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, parseIkiModel } from "@ikijs/format";
import type { IkiModel } from "@ikijs/format";
import {
  DeleteDeformer,
  EditorDocument,
  SetDeformerBindings,
  SetDeformerParent,
} from "@ikijs/editor-core";

/**
 * A command must never leave the document in a state `toIkiModel()` rejects.
 * Each case here mutated the model successfully before the fix and only blew
 * up later, at export time, with no way back except undo.
 */
function chainModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "chains",
    canvas: { width: 1000, height: 1000 },
    parameters: [
      { id: "ParamAngleX", min: -30, max: 30, default: 0 },
      { id: "ParamLock0", min: -20, max: 20, default: 0 },
    ],
    parts: [
      {
        id: "quad",
        color: [1, 1, 1, 1],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
      },
    ],
    deformers: [
      { kind: "matrix", id: "anchor", pivot: { x: 0, y: 0 } },
      {
        kind: "matrix",
        id: "swayer",
        pivot: { x: 0, y: 0 },
        bindings: [
          {
            parameter: "ParamLock0",
            channel: "rotate",
            from: -10,
            to: 10,
          },
        ],
      },
    ],
    physicsChains: [
      {
        id: "c1",
        anchorDeformer: "anchor",
        gravity: { angle: -90, strength: 10 },
        segments: [
          {
            output: { parameter: "ParamLock0", scale: 1 },
            mass: 1,
            stiffness: 10,
            damping: 1,
          },
        ],
      },
    ],
  };
}

describe("fixture sanity", () => {
  it("the base chain model is valid", () => {
    expect(() => parseIkiModel(chainModel())).not.toThrow();
  });
});

describe("DeleteDeformer refuses a deformer a physics chain anchors to", () => {
  it("throws and leaves the model exportable", () => {
    const doc = new EditorDocument(chainModel());
    expect(() => doc.execute(new DeleteDeformer("anchor"))).toThrow(/anchor/);
    expect(doc.getModel().deformers).toHaveLength(2);
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("still deletes an unreferenced deformer", () => {
    const doc = new EditorDocument(chainModel());
    doc.execute(new DeleteDeformer("swayer"));
    expect(doc.getModel().deformers).toHaveLength(1);
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

describe("SetDeformerBindings validates before mutating", () => {
  it("rejects an unknown parameter and leaves bindings untouched", () => {
    const doc = new EditorDocument(chainModel());
    expect(() =>
      doc.execute(
        new SetDeformerBindings("swayer", [
          { parameter: "ParamNope", channel: "rotate", from: 0, to: 1 },
        ]),
      ),
    ).toThrow();
    expect(doc.findMatrixDeformer("swayer").bindings?.[0].parameter).toBe(
      "ParamLock0",
    );
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("rejects a non-finite endpoint", () => {
    const doc = new EditorDocument(chainModel());
    expect(() =>
      doc.execute(
        new SetDeformerBindings("swayer", [
          { parameter: "ParamAngleX", channel: "rotate", from: NaN, to: 1 },
        ]),
      ),
    ).toThrow();
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("still accepts a valid binding set", () => {
    const doc = new EditorDocument(chainModel());
    doc.execute(
      new SetDeformerBindings("swayer", [
        { parameter: "ParamAngleX", channel: "rotate", from: -5, to: 5 },
      ]),
    );
    expect(doc.findMatrixDeformer("swayer").bindings?.[0].parameter).toBe(
      "ParamAngleX",
    );
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

describe("SetDeformerParent validates before mutating", () => {
  it("rejects a reparent that feeds a chain output into its own anchor", () => {
    const doc = new EditorDocument(chainModel());
    expect(() =>
      doc.execute(new SetDeformerParent("anchor", "swayer")),
    ).toThrow(/feedback/);
    expect(doc.findDeformer("anchor").parent).toBeUndefined();
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("still accepts a harmless reparent", () => {
    const doc = new EditorDocument(chainModel());
    doc.execute(new SetDeformerParent("swayer", "anchor"));
    expect(doc.findDeformer("swayer").parent).toBe("anchor");
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});
