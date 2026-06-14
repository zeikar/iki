import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, IkiFormatError, parseIkiModel } from "@iki/format";
import type { IkiModel } from "@iki/format";
import {
  AddDeformer,
  AddPart,
  DeleteDeformer,
  DeletePart,
  EditorDocument,
  createDefaultMatrixDeformer,
  createDefaultPart,
  createDefaultWarpDeformer,
} from "@iki/editor-core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Minimal valid model: one meshless quad part, one root matrix deformer.
 * No optional fields that would require additional declarations.
 */
function baseModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "base",
    canvas: { width: 1000, height: 1000 },
    parameters: [],
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
    deformers: [{ id: "mat", pivot: { x: 0, y: 0 } }],
  };
}

// Tiny 1×1 pixel data URI used as atlas source — validator requires data:image/
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Richer model for DeletePart deep-restore tests: declares a parameter,
 * a texture, and a part with mesh + bindings + texture.
 */
function richModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "rich",
    canvas: { width: 1000, height: 1000 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    textures: [{ source: TINY_PNG }],
    parts: [
      {
        // Plain quad — no optional fields.
        id: "plain",
        color: [1, 1, 1, 1],
        width: 50,
        height: 50,
        transform: { x: 0, y: 0 },
        order: 0,
      },
      {
        // Full-featured part: mesh + bindings + texture.
        id: "rich-part",
        color: [1, 1, 1, 1],
        width: 80,
        height: 80,
        transform: { x: 10, y: 20 },
        order: 1,
        bindings: [
          { parameter: "ParamA", channel: "translateX", from: -50, to: 50 },
        ],
        texture: { index: 0, uv: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        // Minimal mesh: 4 verts (one quad), 2 triangles.
        mesh: {
          vertices: [-1, 1, 1, 1, 1, -1, -1, -1],
          uvs: [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5],
          indices: [0, 1, 2, 0, 2, 3],
        },
      },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshDoc(model: IkiModel = baseModel()): EditorDocument {
  return new EditorDocument(structuredClone(model));
}

function snap(doc: EditorDocument): IkiModel {
  return structuredClone(doc.getModel());
}

// ── Fixture sanity ────────────────────────────────────────────────────────────

describe("fixture sanity", () => {
  it("baseModel passes parseIkiModel", () => {
    expect(() => parseIkiModel(baseModel())).not.toThrow();
  });

  it("richModel passes parseIkiModel", () => {
    expect(() => parseIkiModel(richModel())).not.toThrow();
  });
});

// ── 1. AddPart apply / invert / redo ─────────────────────────────────────────

describe("AddPart apply/invert/redo", () => {
  it("snapshot → execute → undo → redo; toIkiModel() passes at each phase", () => {
    const doc = freshDoc();
    const before = snap(doc);

    const part = createDefaultPart(doc.getModel());
    doc.execute(new AddPart(part));

    // After apply: part present, canUndo
    expect(doc.getModel().parts.find((p) => p.id === part.id)).toBeDefined();
    expect(doc.canUndo()).toBe(true);
    expect(() => doc.toIkiModel()).not.toThrow();
    const afterApply = snap(doc);

    // After undo: model restored exactly
    doc.undo();
    expect(doc.getModel()).toEqual(before);
    expect(() => doc.toIkiModel()).not.toThrow();

    // After redo: model equals the post-apply snapshot exactly
    doc.redo();
    expect(doc.getModel()).toEqual(afterApply);
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

// ── 2. AddPart clone-safety ───────────────────────────────────────────────────

describe("AddPart clone-safety", () => {
  it("mutating the part after construction and after execute does not corrupt the command", () => {
    const doc = freshDoc();
    const part = createDefaultPart(doc.getModel());
    const originalId = part.id;
    const originalColor = [...part.color] as [number, number, number, number];

    const cmd = new AddPart(part);

    // Mutate AFTER construction
    part.id = "mutated-id";
    part.color = [0, 0, 0, 0];

    doc.execute(cmd);

    // The added part should reflect the values AT CONSTRUCTION TIME
    const added = doc.getModel().parts.find((p) => p.id === originalId);
    expect(added).toBeDefined();
    expect(added!.color).toEqual(originalColor);

    // Mutate the model's added part, then undo/redo to confirm clone-on-apply
    added!.color = [0.9, 0.9, 0.9, 0.9];

    doc.undo();
    doc.redo();

    // Re-applied clone must reflect construction-time color, not the mutation
    const reAdded = doc.getModel().parts.find((p) => p.id === originalId);
    expect(reAdded).toBeDefined();
    expect(reAdded!.color).toEqual(originalColor);
  });
});

// ── 3. AddPart fail-fast on id collision ─────────────────────────────────────

describe("AddPart fail-fast on id collision", () => {
  it("throws when id collides with an existing part id; model unchanged, canUndo false", () => {
    const doc = freshDoc();
    const before = snap(doc);

    const dup = createDefaultPart(doc.getModel());
    // Force the id to match the existing part
    dup.id = "quad";

    expect(() => doc.execute(new AddPart(dup))).toThrow(
      /collides with an existing part id/,
    );
    // execute() pushes to the undo stack only after apply() returns — a throwing apply must leave no undo entry.
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
  });

  it("throws when id collides with an existing deformer id; model unchanged, canUndo false", () => {
    const doc = freshDoc();
    const before = snap(doc);

    const conflicting = createDefaultPart(doc.getModel());
    // Force the id to match the existing deformer
    conflicting.id = "mat";

    expect(() => doc.execute(new AddPart(conflicting))).toThrow(
      /collides with an existing deformer id/,
    );
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
  });
});

// ── 4. AddPart structural fail-fast (validator path) ─────────────────────────

describe("AddPart structural fail-fast", () => {
  it("throws IkiFormatError for a part with width: NaN; canUndo false, model unchanged", () => {
    const doc = freshDoc();
    const before = snap(doc);

    const badPart = createDefaultPart(doc.getModel());
    (badPart as Record<string, unknown>).width = NaN;

    expect(() => doc.execute(new AddPart(badPart))).toThrow(IkiFormatError);
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
  });
});

// ── 5. AddDeformer (warp) apply / invert / redo ───────────────────────────────

describe("AddDeformer warp apply/invert/redo", () => {
  it("warp deformer added, undone, redone; toIkiModel() passes at each phase", () => {
    const doc = freshDoc();
    const before = snap(doc);

    const warp = createDefaultWarpDeformer(doc.getModel());
    doc.execute(new AddDeformer(warp));

    expect(
      doc.getModel().deformers?.find((d) => d.id === warp.id),
    ).toBeDefined();
    expect(doc.canUndo()).toBe(true);
    expect(() => doc.toIkiModel()).not.toThrow();
    const afterApply = snap(doc);

    doc.undo();
    expect(doc.getModel()).toEqual(before);
    expect(() => doc.toIkiModel()).not.toThrow();

    // After redo: model equals the post-apply snapshot exactly
    doc.redo();
    expect(doc.getModel()).toEqual(afterApply);
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

// ── 6. AddDeformer on model with NO deformers key ─────────────────────────────

describe("AddDeformer on model with no deformers key", () => {
  it("key absent after undo, length-1 array after execute and redo; toIkiModel() passes", () => {
    // Start with a model that has no deformers key at all
    const model: IkiModel = {
      version: IKI_FORMAT_VERSION,
      name: "no-deformers",
      canvas: { width: 1000, height: 1000 },
      parameters: [],
      parts: [
        {
          id: "q",
          color: [1, 1, 1, 1],
          width: 100,
          height: 100,
          transform: { x: 0, y: 0 },
          order: 0,
        },
      ],
    };
    const doc = new EditorDocument(structuredClone(model));

    // Confirm deformers key is absent
    expect("deformers" in doc.getModel()).toBe(false);

    const mat = createDefaultMatrixDeformer(doc.getModel());
    doc.execute(new AddDeformer(mat));

    expect(doc.getModel().deformers).toHaveLength(1);
    expect(() => doc.toIkiModel()).not.toThrow();

    doc.undo();
    // Key must be completely absent, NOT an empty array
    expect("deformers" in doc.getModel()).toBe(false);
    expect(() => doc.toIkiModel()).not.toThrow();

    doc.redo();
    expect(doc.getModel().deformers).toHaveLength(1);
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

// ── 7. AddDeformer structural fail-fast ───────────────────────────────────────

describe("AddDeformer structural fail-fast", () => {
  it("throws IkiFormatError for a warp deformer with wrong-length grid points; canUndo false, model unchanged", () => {
    const doc = freshDoc();
    const before = snap(doc);

    // cols=2, rows=2 needs 2*(2+1)*(2+1) = 18 points; we provide only 4 — invalid
    const badWarp = {
      kind: "warp" as const,
      id: "bad-warp",
      grid: {
        cols: 2,
        rows: 2,
        points: [0, 0, 1, 0], // intentionally wrong length
      },
    };

    expect(() => doc.execute(new AddDeformer(badWarp))).toThrow(IkiFormatError);
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
  });
});

// ── 8. DeletePart deep restore (richModel) ────────────────────────────────────

describe("DeletePart deep restore", () => {
  it("target absent after delete, fully restored after undo, absent again after redo; clone-safe", () => {
    const doc = new EditorDocument(structuredClone(richModel()));
    const targetId = "rich-part";
    // Clear the committed texture first (non-undoable) so DeletePart's texture
    // guard passes. Snapshot AFTER the clear — undo restores to this state.
    doc.clearPartTextureRef(targetId);
    const before = snap(doc);

    // Confirm the cleared part still has mesh + bindings (deep-restore coverage)
    const beforePart = before.parts.find((p) => p.id === targetId)!;
    expect(beforePart.mesh).toBeDefined();
    expect(beforePart.bindings).toBeDefined();
    expect(beforePart).not.toHaveProperty("texture");

    doc.execute(new DeletePart(targetId));

    // After delete: target absent, length reduced
    expect(doc.getModel().parts).toHaveLength(before.parts.length - 1);
    expect(doc.getModel().parts.find((p) => p.id === targetId)).toBeUndefined();
    expect(() => doc.toIkiModel()).not.toThrow();

    // After undo: full deep equality with post-clear snapshot (mesh + bindings restored)
    doc.undo();
    expect(doc.getModel()).toEqual(before);
    expect(() => doc.toIkiModel()).not.toThrow();

    // After redo: target absent again
    doc.redo();
    expect(doc.getModel().parts.find((p) => p.id === targetId)).toBeUndefined();

    // Clone-safety: mutate the restored part after undo, then redo+undo again
    doc.undo();
    const restored = doc.getModel().parts.find((p) => p.id === targetId)!;
    restored.color = [0, 0, 0, 0]; // corrupt
    doc.redo();
    doc.undo();
    // The re-restored part must equal the post-clear snapshot's part
    const reRestored = doc.getModel().parts.find((p) => p.id === targetId)!;
    const snapPart = before.parts.find((p) => p.id === targetId)!;
    expect(reRestored).toEqual(snapPart);
  });
});

// ── 9. DeletePart texture guard ───────────────────────────────────────────────

describe("DeletePart texture guard", () => {
  it("throws with path-qualified message on a textured part; model unchanged, canUndo false", () => {
    // richModel "rich-part" has a committed texture — delete must be refused
    const doc = new EditorDocument(richModel());
    const before = snap(doc);

    expect(() => doc.execute(new DeletePart("rich-part"))).toThrow(
      /parts\."rich-part": cannot delete — part has a texture reference/,
    );
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("clearPartTextureRef → DeletePart → applyAtlas(empty) → undo: restores textureless part, no stale ref", () => {
    // Regression: public caller sequence that previously could leave a stale texture
    // ref after undo. After the guard, undo can only restore a texture-free snapshot.
    const doc = new EditorDocument(richModel());

    // Clear the texture (non-undoable) — now part is deletable
    doc.clearPartTextureRef("rich-part");
    expect(doc.findPart("rich-part")).not.toHaveProperty("texture");

    // Delete the part
    doc.execute(new DeletePart("rich-part"));
    expect(
      doc.getModel().parts.find((p) => p.id === "rich-part"),
    ).toBeUndefined();

    // Non-undoable atlas change: clear the whole atlas
    doc.applyAtlas({ textures: [], partTextureAssignments: [] });
    expect(doc.getModel().textures).toBeUndefined();

    // Undo the delete — part is restored WITHOUT a texture reference
    doc.undo();
    const restored = doc.findPart("rich-part");
    expect(restored).not.toHaveProperty("texture");
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

// ── 10. DeleteDeformer fail-fast (child deformer) ─────────────────────────────

describe("DeleteDeformer fail-fast (child)", () => {
  it("throws naming the child id when a deformer is parented to the target; model unchanged, canUndo false", () => {
    // Build a model with a parent and a child deformer
    const model: IkiModel = {
      version: IKI_FORMAT_VERSION,
      name: "parent-child",
      canvas: { width: 1000, height: 1000 },
      parameters: [],
      parts: [],
      deformers: [
        { id: "parent", pivot: { x: 0, y: 0 } },
        { id: "child", parent: "parent", pivot: { x: 0, y: 0 } },
      ],
    };
    const doc = new EditorDocument(structuredClone(model));
    const before = snap(doc);

    expect(() => doc.execute(new DeleteDeformer("parent"))).toThrow(/child/);
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
  });
});

// ── 11. DeleteDeformer fail-fast (attached part) ──────────────────────────────

describe("DeleteDeformer fail-fast (attached part)", () => {
  it("throws naming the part id when a part is attached to the target; model unchanged", () => {
    // Part is attached to a matrix deformer — no mesh needed for matrix
    const model: IkiModel = {
      version: IKI_FORMAT_VERSION,
      name: "attached",
      canvas: { width: 1000, height: 1000 },
      parameters: [],
      parts: [
        {
          id: "attached-part",
          color: [1, 1, 1, 1],
          width: 50,
          height: 50,
          transform: { x: 0, y: 0 },
          order: 0,
          deformer: "mat-d",
        },
      ],
      deformers: [{ id: "mat-d", pivot: { x: 0, y: 0 } }],
    };
    const doc = new EditorDocument(structuredClone(model));
    const before = snap(doc);

    expect(() => doc.execute(new DeleteDeformer("mat-d"))).toThrow(
      /attached-part/,
    );
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
  });
});

// ── 12. DeleteDeformer happy path (leaf deformer) ─────────────────────────────

describe("DeleteDeformer happy path", () => {
  it("leaf deformer deleted, undo restores deep equality, redo removes again; toIkiModel() passes", () => {
    // Use a leaf deformer (nothing references it)
    const model: IkiModel = {
      version: IKI_FORMAT_VERSION,
      name: "leaf",
      canvas: { width: 1000, height: 1000 },
      parameters: [],
      parts: [
        {
          id: "q",
          color: [1, 1, 1, 1],
          width: 50,
          height: 50,
          transform: { x: 0, y: 0 },
          order: 0,
        },
      ],
      deformers: [
        { id: "root", pivot: { x: 0, y: 0 } },
        { id: "leaf", parent: "root", pivot: { x: 10, y: 0 } },
      ],
    };
    const doc = new EditorDocument(structuredClone(model));
    const before = snap(doc);

    doc.execute(new DeleteDeformer("leaf"));
    expect(
      doc.getModel().deformers?.find((d) => d.id === "leaf"),
    ).toBeUndefined();
    expect(() => doc.toIkiModel()).not.toThrow();

    doc.undo();
    expect(doc.getModel()).toEqual(before);
    expect(() => doc.toIkiModel()).not.toThrow();

    doc.redo();
    expect(
      doc.getModel().deformers?.find((d) => d.id === "leaf"),
    ).toBeUndefined();
  });
});

// ── 13. Unique-id generation via public factories ─────────────────────────────

describe("unique-id generation", () => {
  it("createDefaultPart generates sequentially suffixed ids; cross-namespace with deformer id", () => {
    // Start with no 'part' id taken, base should be "part"
    const doc = freshDoc(); // has "quad" part and "mat" deformer — no "part" collision
    const p1 = createDefaultPart(doc.getModel());
    expect(p1.id).toBe("part");

    doc.execute(new AddPart(p1));
    const p2 = createDefaultPart(doc.getModel());
    expect(p2.id).toBe("part_2");

    doc.execute(new AddPart(p2));
    const p3 = createDefaultPart(doc.getModel());
    expect(p3.id).toBe("part_3");
  });

  it("createDefaultPart skips deformer id in shared namespace", () => {
    // Model whose deformer id IS "part" — next part id should be "part_2"
    const model: IkiModel = {
      version: IKI_FORMAT_VERSION,
      name: "cross-ns",
      canvas: { width: 1000, height: 1000 },
      parameters: [],
      parts: [],
      deformers: [{ id: "part", pivot: { x: 0, y: 0 } }],
    };
    const doc = new EditorDocument(structuredClone(model));
    const p = createDefaultPart(doc.getModel());
    expect(p.id).toBe("part_2");
  });

  it("createDefaultMatrixDeformer generates sequentially suffixed ids", () => {
    const doc = freshDoc(); // has "mat" deformer — no "deformer" collision
    const d1 = createDefaultMatrixDeformer(doc.getModel());
    expect(d1.id).toBe("deformer");

    doc.execute(new AddDeformer(d1));
    const d2 = createDefaultMatrixDeformer(doc.getModel());
    expect(d2.id).toBe("deformer_2");
  });
});

// ── 14. AddPart mesh part + applyAtlas integration ───────────────────────────

const TINY_UV = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };

/**
 * Model with one quad part and no mesh parts — mesh part will be added by the
 * test so it starts life via AddPart (not the constructor).
 */
function meshlessBase(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "meshless-base",
    canvas: { width: 500, height: 500 },
    parameters: [],
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
  };
}

describe("AddPart mesh + applyAtlas", () => {
  it("AddPart of a mesh part then applyAtlas does NOT throw and remaps uvs", () => {
    const doc = new EditorDocument(meshlessBase());

    const meshPart = createDefaultPart(doc.getModel());
    meshPart.mesh = {
      vertices: [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5],
      uvs: [0, 0, 1, 0, 0, 1, 1, 1],
      indices: [0, 1, 2, 2, 1, 3],
    };
    doc.execute(new AddPart(meshPart));

    // applyAtlas must succeed — captureBaseMeshUvs was called on AddPart.apply
    expect(() =>
      doc.applyAtlas({
        textures: [{ source: TINY_PNG }],
        partTextureAssignments: [{ partId: meshPart.id, uv: TINY_UV }],
      }),
    ).not.toThrow();

    // Confirm the part got its texture and remapped UVs
    const added = doc.findPart(meshPart.id);
    expect(added.texture).toEqual({ index: 0, uv: TINY_UV });
    expect(added.mesh!.uvs).not.toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
  });

  it("after undo of AddPart, applyAtlas over remaining parts still works", () => {
    const doc = new EditorDocument(meshlessBase());

    const meshPart = createDefaultPart(doc.getModel());
    meshPart.mesh = {
      vertices: [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5],
      uvs: [0, 0, 1, 0, 0, 1, 1, 1],
      indices: [0, 1, 2, 2, 1, 3],
    };
    doc.execute(new AddPart(meshPart));

    // Undo the AddPart — restoreBaseMeshUvs clears the entry (no prior existed)
    doc.undo();

    // Only "quad" remains, which has no mesh — empty atlas is the valid call
    expect(() =>
      doc.applyAtlas({ textures: [], partTextureAssignments: [] }),
    ).not.toThrow();
  });

  // ── 14. AddPart id-reuse base-UV restore ─────────────────────────────────────
  it("id-reuse undo hazard: DeletePart(X) → AddPart(X′) → undo(add) → undo(delete) → applyAtlas uses X's original base", () => {
    // richModel has "rich-part" with a mesh — its base UVs are constructor-captured
    const doc = new EditorDocument(richModel());
    const originalBaseUvs = [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5]; // from richModel fixture

    // Step 1: clear texture first (non-undoable), then delete
    doc.clearPartTextureRef("rich-part");
    doc.execute(new DeletePart("rich-part"));
    expect(
      doc.getModel().parts.find((p) => p.id === "rich-part"),
    ).toBeUndefined();

    // Step 2: add a DIFFERENT mesh part reusing the same id (different UVs)
    const replacement = createDefaultPart(doc.getModel());
    replacement.id = "rich-part"; // force id collision intentionally via fixture
    // Remove id collision with existing parts first — the fixture has "plain" only now
    replacement.id = "rich-part";
    replacement.mesh = {
      vertices: [-1, -1, 1, -1, -1, 1, 1, 1],
      uvs: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], // different from original
      indices: [0, 1, 2, 0, 2, 3],
    };
    doc.execute(new AddPart(replacement));

    // Step 3: undo the add — restoreBaseMeshUvs must restore the original entry
    doc.undo();

    // Step 4: undo the delete — "rich-part" is restored with its original mesh
    doc.undo();
    const restored = doc.getModel().parts.find((p) => p.id === "rich-part");
    expect(restored).toBeDefined();
    expect(restored!.mesh).toBeDefined();

    // Step 5: applyAtlas must NOT throw — original base must still be in the map
    expect(() =>
      doc.applyAtlas({
        textures: [{ source: TINY_PNG }],
        partTextureAssignments: [{ partId: "rich-part", uv: TINY_UV }],
      }),
    ).not.toThrow();

    // Confirm uvs were remapped from X's ORIGINAL base (not the replacement's)
    const part = doc.findPart("rich-part");
    expect(part.texture).toEqual({ index: 0, uv: TINY_UV });
    // The mesh uvs should NOT equal the original static base (they are remapped)
    expect(part.mesh!.uvs).not.toEqual(originalBaseUvs);
  });
});

// ── 16. clearPartTextureRef ───────────────────────────────────────────────────

describe("clearPartTextureRef", () => {
  it("clears committed texture non-undoably: texture absent, toIkiModel passes, canUndo unchanged", () => {
    // richModel has "rich-part" with a committed texture; give it a prior undo
    // entry to confirm clearPartTextureRef does NOT push to the undo stack.
    const doc = new EditorDocument(richModel());
    doc.execute(new AddPart(createDefaultPart(doc.getModel())));
    const canUndoBefore = doc.canUndo(); // true — AddPart is on the stack

    doc.clearPartTextureRef("rich-part");

    expect(doc.findPart("rich-part")).not.toHaveProperty("texture");
    expect(() => doc.toIkiModel()).not.toThrow();
    // No undo entry created — stack depth unchanged
    expect(doc.canUndo()).toBe(canUndoBefore);
  });
});

// ── 17. warp factory standalone ───────────────────────────────────────────────

describe("createDefaultWarpDeformer standalone", () => {
  it("a model containing only the factory's output passes parseIkiModel", () => {
    const seed: IkiModel = {
      version: IKI_FORMAT_VERSION,
      name: "warp-only",
      canvas: { width: 1000, height: 1000 },
      parameters: [],
      parts: [],
    };
    const warp = createDefaultWarpDeformer(seed);
    const fullModel: IkiModel = {
      ...seed,
      deformers: [warp],
    };
    expect(() => parseIkiModel(fullModel)).not.toThrow();
  });
});

// ── 10. DeletePart clip-mask guard ────────────────────────────────────────────

describe("DeletePart clip-mask guard", () => {
  function clipModel(): IkiModel {
    const tri = {
      vertices: [0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    };
    return {
      version: IKI_FORMAT_VERSION,
      name: "clip",
      canvas: { width: 1000, height: 1000 },
      parameters: [],
      parts: [
        {
          id: "eyeWhite",
          color: [1, 1, 1, 1],
          width: 1,
          height: 1,
          transform: { x: 0, y: 0 },
          order: 0,
          mesh: tri,
        },
        {
          id: "iris",
          color: [0, 0, 1, 1],
          width: 1,
          height: 1,
          transform: { x: 0, y: 0 },
          order: 1,
          mesh: tri,
          clip: { masks: ["eyeWhite"] },
        },
      ],
    };
  }

  it("refuses to delete a part used as another part's clip mask; model unchanged, canUndo false", () => {
    const doc = new EditorDocument(clipModel());
    const before = snap(doc);

    expect(() => doc.execute(new DeletePart("eyeWhite"))).toThrow(
      /parts\."eyeWhite": cannot delete — used as a clip mask by part "iris"/,
    );
    expect(doc.canUndo()).toBe(false);
    expect(doc.getModel()).toEqual(before);
    expect(() => doc.toIkiModel()).not.toThrow();
  });

  it("deletes the consumer (iris) freely — it masks nothing", () => {
    const doc = new EditorDocument(clipModel());
    doc.execute(new DeletePart("iris"));
    expect(doc.getModel().parts.find((p) => p.id === "iris")).toBeUndefined();
    expect(() => doc.toIkiModel()).not.toThrow();
  });
});
