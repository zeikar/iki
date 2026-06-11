import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, IkiFormatError, parseIkiModel } from "@iki/format";
import type { IkiModel } from "@iki/format";
import {
  AddDeformer,
  EditorDocument,
  SetPartDeformer,
  SetPartMesh,
  createDefaultWarpDeformer,
  createGridMesh,
} from "@iki/editor-core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal valid model: one meshless color part, no deformers. */
function meshlessModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "meshless",
    canvas: { width: 1000, height: 1000 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    parts: [
      {
        id: "part-a",
        color: [1, 0.5, 0, 1],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
      },
    ],
  };
}

/** Model with a part that has a mesh AND non-empty warps matching its vertex count. */
function warpedMeshModel(meshCols: number, meshRows: number): IkiModel {
  const mesh = createGridMesh(meshCols, meshRows);
  const vertexCount = mesh.vertices.length; // 2 floats per vertex
  const offsets = new Array<number>(vertexCount).fill(0);
  return {
    version: IKI_FORMAT_VERSION,
    name: "warped",
    canvas: { width: 1000, height: 1000 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    parts: [
      {
        id: "warp-part",
        color: [1, 1, 1, 1],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
        mesh,
        warps: [
          {
            parameter: "ParamA",
            keyforms: [{ value: 0, offsets }],
          },
        ],
      },
    ],
  };
}

/** Model with a part that has a mesh AND warps: [] (empty but present). */
function emptyWarpsModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "empty-warps",
    canvas: { width: 1000, height: 1000 },
    parameters: [],
    parts: [
      {
        id: "ep",
        color: [1, 1, 1, 1],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
        mesh: createGridMesh(2, 2),
        warps: [],
      },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Small atlas UV rect fully within 0..1 for applyAtlas tests. */
const TINY_UV = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };

/** Minimal atlas texture source. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

// ── 1. createGridMesh validity ────────────────────────────────────────────────

describe("createGridMesh validity", () => {
  it("1×1 grid: vertex/index counts correct and passes parseIkiModel", () => {
    const mesh = createGridMesh(1, 1);
    const cols = 1;
    const rows = 1;
    const vertexCount = (cols + 1) * (rows + 1); // 4
    expect(mesh.vertices.length).toBe(vertexCount * 2); // 2 floats per vertex
    expect(mesh.uvs.length).toBe(vertexCount * 2);
    expect(mesh.indices.length).toBe(cols * rows * 6); // 6 indices per cell

    // All indices within bounds
    for (const idx of mesh.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertexCount);
    }
    // UVs within 0..1
    for (const uv of mesh.uvs) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }

    // Embed in a minimal model and validate
    const model: IkiModel = {
      ...meshlessModel(),
      parts: [
        {
          id: "part-a",
          color: [1, 0, 0, 1],
          width: 100,
          height: 100,
          transform: { x: 0, y: 0 },
          order: 0,
          mesh,
        },
      ],
    };
    expect(() => parseIkiModel(model)).not.toThrow();
  });

  it("4×4 grid: vertex/index counts correct and passes parseIkiModel", () => {
    const mesh = createGridMesh(4, 4);
    const cols = 4;
    const rows = 4;
    const vertexCount = (cols + 1) * (rows + 1); // 25
    expect(mesh.vertices.length).toBe(vertexCount * 2);
    expect(mesh.uvs.length).toBe(vertexCount * 2);
    expect(mesh.indices.length).toBe(cols * rows * 6);

    for (const idx of mesh.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertexCount);
    }
    for (const uv of mesh.uvs) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }

    const model: IkiModel = {
      ...meshlessModel(),
      parts: [
        {
          id: "part-a",
          color: [1, 0, 0, 1],
          width: 100,
          height: 100,
          transform: { x: 0, y: 0 },
          order: 0,
          mesh,
        },
      ],
    };
    expect(() => parseIkiModel(model)).not.toThrow();
  });

  it("createGridMesh(0, 1) throws", () => {
    expect(() => createGridMesh(0, 1)).toThrow();
  });

  it("createGridMesh(1, 0) throws", () => {
    expect(() => createGridMesh(1, 0)).toThrow();
  });

  it("over-limit (300×300) throws — bounds guard fires before allocation", () => {
    // (300+1)*(300+1) = 90601 > 65536
    expect(() => createGridMesh(300, 300)).toThrow();
  });
});

// ── 2. add / regenerate / remove undo-redo round-trip ────────────────────────

describe("SetPartMesh add undo-redo round-trip", () => {
  it("(a) add mesh → undo → redo; parseIkiModel passes at each step", () => {
    const doc = new EditorDocument(meshlessModel());
    const partId = "part-a";

    // execute add
    doc.execute(new SetPartMesh(partId, createGridMesh(4, 4)));

    const part = doc.getModel().parts.find((p) => p.id === partId)!;
    expect(part.mesh).toBeDefined();
    expect(doc.canUndo()).toBe(true);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();

    // undo → mesh absent, key should not exist
    doc.undo();
    const afterUndo = doc.getModel().parts.find((p) => p.id === partId)!;
    expect("mesh" in afterUndo).toBe(false);
    expect(doc.canUndo()).toBe(false);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();

    // redo → mesh back
    doc.redo();
    const afterRedo = doc.getModel().parts.find((p) => p.id === partId)!;
    expect(afterRedo.mesh!.vertices.length).toBe((4 + 1) * (4 + 1) * 2);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();
  });

  it("(b) regenerate: undo restores prior mesh EXACTLY; redo restores new one", () => {
    const doc = new EditorDocument(meshlessModel());
    const partId = "part-a";

    // Start with a 2×2 mesh
    doc.execute(new SetPartMesh(partId, createGridMesh(2, 2)));
    const mesh2x2 = structuredClone(
      doc.getModel().parts.find((p) => p.id === partId)!.mesh!,
    );

    // Regenerate to 5×5
    doc.execute(new SetPartMesh(partId, createGridMesh(5, 5)));
    const afterRegen = doc.getModel().parts.find((p) => p.id === partId)!;
    expect(afterRegen.mesh!.vertices.length).toBe((5 + 1) * (5 + 1) * 2);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();

    // undo → restores 2×2 exactly
    doc.undo();
    const afterUndo = doc.getModel().parts.find((p) => p.id === partId)!;
    expect(afterUndo.mesh).toEqual(mesh2x2);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();

    // redo → restores 5×5
    doc.redo();
    const afterRedo = doc.getModel().parts.find((p) => p.id === partId)!;
    expect(afterRedo.mesh!.vertices.length).toBe((5 + 1) * (5 + 1) * 2);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();
  });

  it("(c) remove: undo restores mesh exactly; validator passes at each step", () => {
    const doc = new EditorDocument(meshlessModel());
    const partId = "part-a";

    // Add a mesh first
    doc.execute(new SetPartMesh(partId, createGridMesh(3, 3)));
    const meshBefore = structuredClone(
      doc.getModel().parts.find((p) => p.id === partId)!.mesh!,
    );

    // Remove it
    doc.execute(new SetPartMesh(partId, undefined));
    const afterRemove = doc.getModel().parts.find((p) => p.id === partId)!;
    expect("mesh" in afterRemove).toBe(false);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();

    // undo → mesh restored exactly
    doc.undo();
    const afterUndo = doc.getModel().parts.find((p) => p.id === partId)!;
    expect(afterUndo.mesh).toEqual(meshBefore);
    expect(() => parseIkiModel(doc.toIkiModel())).not.toThrow();
  });
});

// ── 3. side-table applyAtlas regression ──────────────────────────────────────

describe("SetPartMesh side-table applyAtlas regression", () => {
  it("add mesh → applyAtlas succeeds; undo → redo → applyAtlas still succeeds", () => {
    const doc = new EditorDocument(meshlessModel());
    const partId = "part-a";

    doc.execute(new SetPartMesh(partId, createGridMesh(2, 2)));

    // applyAtlas must NOT throw "no base mesh uvs captured"
    expect(() =>
      doc.applyAtlas({
        textures: [{ source: TINY_PNG }],
        partTextureAssignments: [{ partId, uv: TINY_UV }],
      }),
    ).not.toThrow();

    const part = doc.findPart(partId);
    expect(part.texture).toEqual({ index: 0, uv: TINY_UV });

    // Clear atlas (non-undoable) before undo/redo so the texture ref is gone
    doc.applyAtlas({ textures: [], partTextureAssignments: [] });

    doc.undo();
    doc.redo();

    // After redo, applyAtlas must still work
    expect(() =>
      doc.applyAtlas({
        textures: [{ source: TINY_PNG }],
        partTextureAssignments: [{ partId, uv: TINY_UV }],
      }),
    ).not.toThrow();

    expect(doc.findPart(partId).texture).toEqual({ index: 0, uv: TINY_UV });
  });
});

// ── 4. warp fail-fast leaves model + stacks untouched ────────────────────────

describe("SetPartMesh warp fail-fast", () => {
  it("(a) remove-with-warps: throws IkiFormatError, model+stacks unchanged", () => {
    const doc = new EditorDocument(warpedMeshModel(2, 2));
    const before = JSON.stringify(doc.toIkiModel());
    const undoBefore = doc.canUndo();

    expect(() =>
      doc.execute(new SetPartMesh("warp-part", undefined)),
    ).toThrow(IkiFormatError);

    expect(JSON.stringify(doc.toIkiModel())).toBe(before);
    expect(doc.canUndo()).toBe(undoBefore);
  });

  it("(b) remove-with-EMPTY-warps (presence guard): throws IkiFormatError even when warps: []", () => {
    const doc = new EditorDocument(emptyWarpsModel());
    const before = JSON.stringify(doc.toIkiModel());
    const undoBefore = doc.canUndo();

    expect(() =>
      doc.execute(new SetPartMesh("ep", undefined)),
    ).toThrow(IkiFormatError);

    expect(JSON.stringify(doc.toIkiModel())).toBe(before);
    expect(doc.canUndo()).toBe(undoBefore);
  });

  it("(c) regenerate-with-non-empty-warps: any cols×rows throws IkiFormatError", () => {
    const doc = new EditorDocument(warpedMeshModel(2, 2));
    const before = JSON.stringify(doc.toIkiModel());
    const undoBefore = doc.canUndo();

    expect(() =>
      doc.execute(new SetPartMesh("warp-part", createGridMesh(3, 3))),
    ).toThrow(IkiFormatError);

    expect(JSON.stringify(doc.toIkiModel())).toBe(before);
    expect(doc.canUndo()).toBe(undoBefore);
  });

  it("(d) same-vertex-count topology swap (1×3 → 3×1) still throws — count-only check is insufficient", () => {
    // createGridMesh(1,3): (1+1)*(3+1) = 8 verts = 16 components
    // createGridMesh(3,1): (3+1)*(1+1) = 8 verts = 16 components
    // Both have identical vertex counts but different topology.
    const doc = new EditorDocument(warpedMeshModel(1, 3));
    const before = JSON.stringify(doc.toIkiModel());
    const undoBefore = doc.canUndo();

    // Attempting to swap to 3×1 (same vert count, different grid shape) must STILL throw
    expect(() =>
      doc.execute(new SetPartMesh("warp-part", createGridMesh(3, 1))),
    ).toThrow(IkiFormatError);

    expect(JSON.stringify(doc.toIkiModel())).toBe(before);
    expect(doc.canUndo()).toBe(undoBefore);
  });
});

// ── 5. attach-to-warp gate (headline unblock) ─────────────────────────────────

describe("attach-to-warp gate", () => {
  it("meshless part fails SetPartDeformer(warp); add mesh; SetPartDeformer(warp) succeeds", () => {
    const doc = new EditorDocument(meshlessModel());
    const partId = "part-a";

    // Add a warp deformer to the model
    const warp = createDefaultWarpDeformer(doc.getModel());
    doc.execute(new AddDeformer(warp));

    // Attach meshless part → must throw "requires a mesh"
    expect(() =>
      doc.execute(new SetPartDeformer(partId, warp.id)),
    ).toThrow(/requires a mesh/);

    // Give the part a mesh
    doc.execute(new SetPartMesh(partId, createGridMesh(2, 2)));

    // Now attach should succeed
    expect(() =>
      doc.execute(new SetPartDeformer(partId, warp.id)),
    ).not.toThrow();

    const part = doc.getModel().parts.find((p) => p.id === partId)!;
    expect(part.deformer).toBe(warp.id);
  });
});

// ── 6. path rewrite on degenerate candidate ───────────────────────────────────

describe("SetPartMesh path rewrite on degenerate candidate", () => {
  it("degenerate mesh (< 3 vertices) throws IkiFormatError with parts.\"part-a\" in message", () => {
    const doc = new EditorDocument(meshlessModel());
    const before = JSON.stringify(doc.toIkiModel());
    const undoBefore = doc.canUndo();

    let caughtError: unknown;
    try {
      doc.execute(
        new SetPartMesh("part-a", { vertices: [0, 0], uvs: [0, 0], indices: [] }),
      );
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(IkiFormatError);
    // Path must use the real id ("part-a"), NOT positional "parts[0]"
    expect((caughtError as IkiFormatError).message).toContain('parts."part-a"');

    // Model and undo stack must be untouched
    expect(JSON.stringify(doc.toIkiModel())).toBe(before);
    expect(doc.canUndo()).toBe(undoBefore);
  });
});
