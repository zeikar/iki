import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION } from "@iki/format";
import type { IkiModel, IkiUvRect } from "@iki/format";
import {
  EditorDocument,
  SetPartWidth,
  type ApplyAtlasInput,
} from "@iki/editor-core";

const VALID_UV: IkiUvRect = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };

/**
 * A minimal valid IkiModel with two quad parts. part-b already has a texture
 * assigned (texture index 0) so tests can verify it gets cleared on atlas apply.
 */
function fixtureModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "atlas-fixture",
    canvas: { width: 100, height: 100 },
    parameters: [{ id: "ParamA", min: -1, max: 1, default: 0 }],
    textures: [{ source: "data:image/png;base64,AA==" }],
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
        texture: {
          index: 0,
          uv: { x: 0.0, y: 0.0, width: 0.5, height: 0.5 },
        },
      },
    ],
  };
}

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("applyAtlas round-trip", () => {
  it("sets textures[0].source, assigns uv to mapped part, clears texture on unmapped part", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,BB==" }],
      partTextureAssignments: [{ partId: "part-a", uv: VALID_UV }],
    });

    // New texture source is applied
    expect(doc.getModel().textures?.[0].source).toBe(
      "data:image/png;base64,BB==",
    );

    // part-a gets the new texture assignment
    const partA = doc.findPart("part-a");
    expect(partA.texture).toBeDefined();
    expect(partA.texture!.index).toBe(0);
    expect(partA.texture!.uv).toEqual(VALID_UV);

    // part-b was not in the assignments — its texture must be cleared
    const partB = doc.findPart("part-b");
    expect(partB).not.toHaveProperty("texture");
  });

  it("toIkiModel() does not throw after applyAtlas (no stale index)", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,BB==" }],
      partTextureAssignments: [{ partId: "part-a", uv: VALID_UV }],
    });

    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

// ── Non-undoable / undo isolation ─────────────────────────────────────────────

describe("applyAtlas undo isolation", () => {
  it("does not push or clear the undo/redo stacks", () => {
    const doc = new EditorDocument(fixtureModel());

    // Build non-empty undo stack first
    doc.execute(new SetPartWidth("part-a", 99));
    const canUndoBefore = doc.canUndo();
    const canRedoBefore = doc.canRedo();

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,BB==" }],
      partTextureAssignments: [{ partId: "part-a", uv: VALID_UV }],
    });

    expect(doc.canUndo()).toBe(canUndoBefore);
    expect(doc.canRedo()).toBe(canRedoBefore);
  });

  it("undo reverts only the field command; atlas textures + part textures stay applied", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.execute(new SetPartWidth("part-a", 99));
    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,BB==" }],
      partTextureAssignments: [{ partId: "part-a", uv: VALID_UV }],
    });

    // Undo should revert the field command (SetPartWidth)
    doc.undo();
    expect(doc.findPart("part-a").width).toBe(50); // original fixture width

    // Atlas changes must remain
    expect(doc.getModel().textures?.[0].source).toBe(
      "data:image/png;base64,BB==",
    );
    expect(doc.findPart("part-a").texture).toBeDefined();
    expect(doc.findPart("part-a").texture!.uv).toEqual(VALID_UV);
    expect(doc.findPart("part-b")).not.toHaveProperty("texture");
  });
});

// ── Validate-then-apply atomicity ─────────────────────────────────────────────

describe("applyAtlas atomicity", () => {
  it("throws on unknown partId and leaves model completely unchanged", () => {
    const doc = new EditorDocument(fixtureModel());
    const before = structuredClone(doc.getModel());

    expect(() =>
      doc.applyAtlas({
        textures: [{ source: "data:image/png;base64,BB==" }],
        partTextureAssignments: [{ partId: "does-not-exist", uv: VALID_UV }],
      }),
    ).toThrow();

    expect(doc.getModel()).toEqual(before);
  });
});

// ── Structural input validation ───────────────────────────────────────────────

describe("applyAtlas structural validation", () => {
  it("(a) throws when textures is empty but partTextureAssignments is non-empty", () => {
    const doc = new EditorDocument(fixtureModel());
    const before = structuredClone(doc.getModel());

    expect(() =>
      doc.applyAtlas({
        textures: [],
        partTextureAssignments: [{ partId: "part-a", uv: VALID_UV }],
      }),
    ).toThrow();

    expect(doc.getModel()).toEqual(before);
  });

  it("(b) throws when textures has more than one entry", () => {
    const doc = new EditorDocument(fixtureModel());
    const before = structuredClone(doc.getModel());

    expect(() =>
      doc.applyAtlas({
        textures: [
          { source: "data:image/png;base64,AA==" },
          { source: "data:image/png;base64,BB==" },
        ],
        partTextureAssignments: [],
      }),
    ).toThrow();

    expect(doc.getModel()).toEqual(before);
  });

  it("(c) throws when partTextureAssignments has duplicate partIds", () => {
    const doc = new EditorDocument(fixtureModel());
    const before = structuredClone(doc.getModel());

    expect(() =>
      doc.applyAtlas({
        textures: [{ source: "data:image/png;base64,BB==" }],
        partTextureAssignments: [
          { partId: "part-a", uv: VALID_UV },
          { partId: "part-a", uv: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
        ],
      }),
    ).toThrow();

    expect(doc.getModel()).toEqual(before);
  });

  it("valid: zero textures + zero assignments does not throw", () => {
    const doc = new EditorDocument(fixtureModel());
    expect(() =>
      doc.applyAtlas({ textures: [], partTextureAssignments: [] }),
    ).not.toThrow();
  });

  it("valid: one texture + N distinct-partId assignments does not throw", () => {
    const doc = new EditorDocument(fixtureModel());
    expect(() =>
      doc.applyAtlas({
        textures: [{ source: "data:image/png;base64,BB==" }],
        partTextureAssignments: [
          { partId: "part-a", uv: VALID_UV },
          { partId: "part-b", uv: { x: 0.6, y: 0.1, width: 0.3, height: 0.3 } },
        ],
      }),
    ).not.toThrow();
  });
});

// ── No-aliasing ───────────────────────────────────────────────────────────────

describe("applyAtlas no-aliasing", () => {
  it("mutating textures array after the call does not affect the model", () => {
    const doc = new EditorDocument(fixtureModel());
    const textures: ApplyAtlasInput["textures"] = [
      { source: "data:image/png;base64,BB==" },
    ];

    doc.applyAtlas({ textures, partTextureAssignments: [] });

    // Mutate the caller's array entry after the call
    textures[0].source = "MUTATED";

    expect(doc.getModel().textures?.[0].source).toBe(
      "data:image/png;base64,BB==",
    );
  });

  it("mutating uv object after the call does not affect the model", () => {
    const doc = new EditorDocument(fixtureModel());
    const uv: IkiUvRect = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,BB==" }],
      partTextureAssignments: [{ partId: "part-a", uv }],
    });

    // Mutate the caller's uv object after the call
    uv.x = 0.9;
    uv.width = 0.01;

    const stored = doc.findPart("part-a").texture!.uv;
    expect(stored.x).toBe(0.1);
    expect(stored.width).toBe(0.5);
  });
});

// ── Empty-atlas path ──────────────────────────────────────────────────────────

describe("applyAtlas empty-atlas path", () => {
  it("textures is omitted (undefined) and every part's texture is cleared", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({ textures: [], partTextureAssignments: [] });

    expect(doc.getModel().textures).toBeUndefined();

    for (const part of doc.getModel().parts) {
      expect(part).not.toHaveProperty("texture");
    }
  });

  it("toIkiModel() does not throw after empty applyAtlas", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({ textures: [], partTextureAssignments: [] });

    expect(() => doc.toIkiModel()).not.toThrow();
  });
});
