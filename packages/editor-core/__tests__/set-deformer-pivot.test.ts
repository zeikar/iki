import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION } from "@iki/format";
import type { IkiModel } from "@iki/format";
import { EditorDocument, SetDeformerPivot } from "@iki/editor-core";

/**
 * Minimal valid model with one matrix deformer carrying pivot { x: 3, y: 7 }.
 * No warp deformers or mesh parts to keep the fixture small.
 */
function pivotModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "pivot-fixture",
    canvas: { width: 100, height: 100 },
    parameters: [],
    parts: [],
    deformers: [
      {
        id: "d1",
        pivot: { x: 3, y: 7 },
      },
    ],
  };
}

describe("SetDeformerPivot", () => {
  it("apply sets the new pivot and model round-trips", () => {
    const doc = new EditorDocument(pivotModel());
    doc.execute(new SetDeformerPivot("d1", { x: 10, y: -5 }));
    const pivot = doc.findMatrixDeformer("d1").pivot;
    expect(pivot).toEqual({ x: 10, y: -5 });
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("undo restores original pivot, redo re-applies new pivot (capture-once)", () => {
    const doc = new EditorDocument(pivotModel());
    const cmd = new SetDeformerPivot("d1", { x: 10, y: -5 });

    doc.execute(cmd);
    expect(doc.findMatrixDeformer("d1").pivot).toEqual({ x: 10, y: -5 });
    expect(() => doc.toIkiModel()).not.toThrow();

    doc.undo();
    expect(doc.findMatrixDeformer("d1").pivot).toEqual({ x: 3, y: 7 });
    expect(() => doc.toIkiModel()).not.toThrow();

    // Re-apply the SAME command object to exercise the capture-once flag.
    doc.execute(cmd);
    expect(doc.findMatrixDeformer("d1").pivot).toEqual({ x: 10, y: -5 });
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("aliasing guard — mutating caller arg after construction has no effect", () => {
    const doc = new EditorDocument(pivotModel());
    const arg = { x: 1, y: 2 };
    doc.execute(new SetDeformerPivot("d1", arg));
    arg.x = 999;
    expect(doc.findMatrixDeformer("d1").pivot).toEqual({ x: 1, y: 2 });
  });

  it("multi-command undo-stack — two commands, two undos restore original", () => {
    const doc = new EditorDocument(pivotModel());
    doc.execute(new SetDeformerPivot("d1", { x: 10, y: -5 }));
    doc.execute(new SetDeformerPivot("d1", { x: 0, y: 0 }));
    expect(doc.findMatrixDeformer("d1").pivot).toEqual({ x: 0, y: 0 });

    doc.undo();
    expect(doc.findMatrixDeformer("d1").pivot).toEqual({ x: 10, y: -5 });

    doc.undo();
    expect(doc.findMatrixDeformer("d1").pivot).toEqual({ x: 3, y: 7 });
  });

  it("throws when the deformer id does not exist", () => {
    const doc = new EditorDocument(pivotModel());
    expect(() =>
      doc.execute(new SetDeformerPivot("nope", { x: 0, y: 0 })),
    ).toThrow();
  });
});
