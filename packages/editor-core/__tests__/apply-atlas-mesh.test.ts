import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION } from "@iki/format";
import type { IkiModel, IkiUvRect } from "@iki/format";
import { EditorDocument } from "@iki/editor-core";
import { remapMeshUvsToRect } from "../src/mesh-uv";

// A rect that keeps all remapped UVs within 0..1 (base is 0..1 square).
const RECT: IkiUvRect = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
const RECT_B: IkiUvRect = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };

// Base local UVs: full 0..1 square, 4 vertices.
const BASE_UVS = [0, 0, 1, 0, 0, 1, 1, 1];

/**
 * A minimal valid IkiModel with one quad part (part-a) and one mesh part
 * (mesh-part). The mesh is a 2-triangle quad: 4 verts, local ±0.5 frame,
 * uvs = full 0..1 square. No deformer — mesh alone is valid.
 */
function fixtureModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "atlas-mesh-fixture",
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
        id: "mesh-part",
        color: [1, 1, 1, 1],
        width: 50,
        height: 50,
        order: 1,
        transform: { x: 0, y: 0 },
        mesh: {
          // 4 vertices in part LOCAL ±0.5 frame
          vertices: [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5],
          // Base local UVs: full 0..1 square (captured at construction)
          uvs: BASE_UVS.slice(),
          // 2 triangles covering the quad
          indices: [0, 1, 2, 2, 1, 3],
        },
      },
    ],
  };
}

// ── Texture sets texture + remapped uvs ───────────────────────────────────────

describe("applyAtlas mesh — texture assignment", () => {
  it("assigns texture and remaps mesh.uvs from base into RECT", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "mesh-part", uv: RECT }],
    });

    const part = doc.findPart("mesh-part");
    // texture must be set with index 0 and the assigned rect
    expect(part.texture).toEqual({ index: 0, uv: RECT });
    // mesh.uvs must be remapped from the base
    expect(part.mesh!.uvs).toEqual(remapMeshUvsToRect(BASE_UVS, RECT));
    // Corner check: (0,0) → (RECT.x, RECT.y), no flip
    const uvs = part.mesh!.uvs;
    expect(uvs[0]).toBeCloseTo(RECT.x);
    expect(uvs[1]).toBeCloseTo(RECT.y);
  });

  it("toIkiModel() does not throw after mesh texture assignment", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "mesh-part", uv: RECT }],
    });

    expect(() => doc.toIkiModel()).not.toThrow();
  });
});

// ── Clear restores base uvs and removes texture ───────────────────────────────

describe("applyAtlas mesh — clear restores base", () => {
  it("omitting mesh-part in a subsequent call restores base uvs and removes texture", () => {
    const doc = new EditorDocument(fixtureModel());

    // First: texture the mesh part
    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "mesh-part", uv: RECT }],
    });

    // Then: empty call (no assignments) — mesh-part must revert
    doc.applyAtlas({ textures: [], partTextureAssignments: [] });

    const part = doc.findPart("mesh-part");
    expect(part.mesh!.uvs).toEqual(BASE_UVS);
    expect(part).not.toHaveProperty("texture");
  });
});

// ── Idempotence / no compounding ──────────────────────────────────────────────

describe("applyAtlas mesh — idempotence / no compounding", () => {
  it("texture rectA then rectB yields uvs remapped from construction base, not from rectA output", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "mesh-part", uv: RECT }],
    });

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,BB==" }],
      partTextureAssignments: [{ partId: "mesh-part", uv: RECT_B }],
    });

    const part = doc.findPart("mesh-part");
    // Must equal remap of ORIGINAL base into rectB — not rectA output into rectB
    expect(part.mesh!.uvs).toEqual(remapMeshUvsToRect(BASE_UVS, RECT_B));
  });
});

// ── Empty apply restores base ─────────────────────────────────────────────────

describe("applyAtlas mesh — empty apply restores base", () => {
  it("after texturing, empty applyAtlas clears textures and restores mesh.uvs to base", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "mesh-part", uv: RECT }],
    });

    doc.applyAtlas({ textures: [], partTextureAssignments: [] });

    expect(doc.getModel().textures).toBeUndefined();
    const part = doc.findPart("mesh-part");
    expect(part.mesh!.uvs).toEqual(BASE_UVS);
    expect(part).not.toHaveProperty("texture");
  });
});

// ── Quad part regression ──────────────────────────────────────────────────────

describe("applyAtlas mesh — quad part regression", () => {
  it("quad part-a still gets texture.uv set correctly when assigned", () => {
    const doc = new EditorDocument(fixtureModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "part-a", uv: RECT }],
    });

    const partA = doc.findPart("part-a");
    expect(partA.texture).toBeDefined();
    expect(partA.texture!.index).toBe(0);
    expect(partA.texture!.uv).toEqual(RECT);
  });

  it("quad part-a texture is cleared when omitted from assignments", () => {
    const doc = new EditorDocument(fixtureModel());

    // Assign first
    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "part-a", uv: RECT }],
    });

    // Clear via empty apply
    doc.applyAtlas({ textures: [], partTextureAssignments: [] });

    expect(doc.findPart("part-a")).not.toHaveProperty("texture");
  });
});

// ── Atomicity — unknown partId leaves model unchanged ────────────────────────

describe("applyAtlas mesh — atomicity", () => {
  it("unknown partId throws and leaves the model unchanged including mesh.uvs", () => {
    const doc = new EditorDocument(fixtureModel());

    // Pre-texture so the model is in a non-default state
    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "mesh-part", uv: RECT }],
    });

    const before = structuredClone(doc.getModel());

    expect(() =>
      doc.applyAtlas({
        textures: [{ source: "data:image/png;base64,BB==" }],
        partTextureAssignments: [
          { partId: "mesh-part", uv: RECT_B },
          { partId: "does-not-exist", uv: RECT_B },
        ],
      }),
    ).toThrow();

    // Model must be exactly as it was before the failed call
    expect(doc.getModel()).toEqual(before);
    // Specifically the mesh uvs are unchanged (still remapped to RECT)
    expect(doc.findPart("mesh-part").mesh!.uvs).toEqual(
      remapMeshUvsToRect(BASE_UVS, RECT),
    );
  });
});

// ── Shared-mesh aliasing regression ──────────────────────────────────────────

describe("applyAtlas mesh — shared mesh object de-aliasing", () => {
  /** Two mesh parts that share the EXACT SAME mesh object reference, mirroring
   *  the sample-model pattern where eyeL and eyeR both set `mesh: eyeMesh`. */
  function sharedMeshModel(): IkiModel {
    const shared = {
      vertices: [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5],
      uvs: BASE_UVS.slice(),
      indices: [0, 1, 2, 2, 1, 3],
    };
    return {
      version: IKI_FORMAT_VERSION,
      name: "shared-mesh-fixture",
      canvas: { width: 100, height: 100 },
      parameters: [],
      parts: [
        {
          id: "part-a",
          color: [1, 1, 1, 1],
          width: 50,
          height: 50,
          order: 0,
          transform: { x: 0, y: 0 },
          mesh: shared,
        },
        {
          id: "part-b",
          color: [1, 1, 1, 1],
          width: 50,
          height: 50,
          order: 1,
          transform: { x: 10, y: 0 },
          mesh: shared,
        },
      ],
    };
  }

  it("texturing both parts with different rects gives each its OWN remapped uvs (no last-wins)", () => {
    const doc = new EditorDocument(sharedMeshModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [
        { partId: "part-a", uv: RECT },
        { partId: "part-b", uv: RECT_B },
      ],
    });

    const a = doc.findPart("part-a");
    const b = doc.findPart("part-b");

    expect(a.mesh!.uvs).toEqual(remapMeshUvsToRect(BASE_UVS, RECT));
    expect(b.mesh!.uvs).toEqual(remapMeshUvsToRect(BASE_UVS, RECT_B));
    // Each part must own its own mesh object after the op.
    expect(a.mesh).not.toBe(b.mesh);
  });

  it("texturing one part, leaving the other unassigned: no cross-contamination", () => {
    const doc = new EditorDocument(sharedMeshModel());

    doc.applyAtlas({
      textures: [{ source: "data:image/png;base64,AA==" }],
      partTextureAssignments: [{ partId: "part-a", uv: RECT }],
    });

    const a = doc.findPart("part-a");
    const b = doc.findPart("part-b");

    // Textured part gets remapped uvs + texture.
    expect(a.mesh!.uvs).toEqual(remapMeshUvsToRect(BASE_UVS, RECT));
    expect(a.texture).toEqual({ index: 0, uv: RECT });
    // Unassigned part stays at base uvs and has no texture.
    expect(b.mesh!.uvs).toEqual(BASE_UVS);
    expect(b).not.toHaveProperty("texture");
    // Still de-aliased.
    expect(a.mesh).not.toBe(b.mesh);
  });
});
