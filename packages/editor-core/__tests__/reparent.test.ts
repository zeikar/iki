import { describe, expect, it } from "vitest";
import type { IkiDeformer, IkiPart } from "@iki/format";
import { validateDeformerReparent, validatePartAttach } from "@iki/editor-core";

// ── Fixture ──────────────────────────────────────────────────────────────────
//
//   A (matrix, root)
//   └─ B (matrix, parent A)
//      └─ C (matrix, parent B)
//   └─ W (warp, parent A)
//
// Parts:
//   p  — meshless, no deformer
//   m  — has mesh, attached to W

const deformers: IkiDeformer[] = [
  { id: "A", pivot: { x: 0, y: 0 } },
  { id: "B", parent: "A", pivot: { x: 0, y: 0 } },
  { id: "C", parent: "B", pivot: { x: 0, y: 0 } },
  {
    kind: "warp",
    id: "W",
    parent: "A",
    grid: { cols: 2, rows: 2, points: [0, 0, 1, 0, 2, 0, 0, 1, 1, 1, 2, 1, 0, 2, 1, 2, 2, 2] },
  },
];

const mesh = {
  vertices: [0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
};

const parts: IkiPart[] = [
  {
    id: "p",
    color: [1, 1, 1, 1],
    width: 1,
    height: 1,
    transform: { x: 0, y: 0 },
    order: 0,
  },
  {
    id: "m",
    color: [1, 1, 1, 1],
    width: 1,
    height: 1,
    transform: { x: 0, y: 0 },
    order: 1,
    deformer: "W",
    mesh,
  },
];

// ── validateDeformerReparent ─────────────────────────────────────────────────

describe("validateDeformerReparent", () => {
  it("valid reparent C under A does not throw", () => {
    expect(() => validateDeformerReparent(deformers, "C", "A")).not.toThrow();
  });

  it("reparent to undefined (root) does not throw", () => {
    expect(() => validateDeformerReparent(deformers, "B", undefined)).not.toThrow();
  });

  it("self-reference A→A throws /self-reference/", () => {
    expect(() => validateDeformerReparent(deformers, "A", "A")).toThrow(
      /self-reference/,
    );
  });

  it("cycle A under C throws /would create a cycle/", () => {
    expect(() => validateDeformerReparent(deformers, "A", "C")).toThrow(
      /would create a cycle/,
    );
  });

  it("non-matrix parent B under W throws /must be a matrix deformer/", () => {
    expect(() => validateDeformerReparent(deformers, "B", "W")).toThrow(
      /must be a matrix deformer/,
    );
  });

  it("undeclared parent B under 'nope' throws /not a declared deformer/", () => {
    expect(() => validateDeformerReparent(deformers, "B", "nope")).toThrow(
      /not a declared deformer/,
    );
  });

  it("unknown target deformer throws /no deformer with id/", () => {
    expect(() => validateDeformerReparent(deformers, "ghost", "A")).toThrow(
      /no deformer with id/,
    );
  });
});

// ── validatePartAttach ───────────────────────────────────────────────────────

describe("validatePartAttach", () => {
  it("meshless part p→W throws /requires a mesh/", () => {
    expect(() => validatePartAttach(deformers, "p", parts, "W")).toThrow(
      /requires a mesh/,
    );
  });

  it("mesh part m→W does not throw", () => {
    expect(() => validatePartAttach(deformers, "m", parts, "W")).not.toThrow();
  });

  it("meshless part p→A (matrix) does not throw", () => {
    expect(() => validatePartAttach(deformers, "p", parts, "A")).not.toThrow();
  });

  it("p→'nope' throws /not a declared deformer/", () => {
    expect(() => validatePartAttach(deformers, "p", parts, "nope")).toThrow(
      /not a declared deformer/,
    );
  });

  it("p→undefined does not throw", () => {
    expect(() => validatePartAttach(deformers, "p", parts, undefined)).not.toThrow();
  });

  it("unknown part throws /no part with id/", () => {
    expect(() => validatePartAttach(deformers, "ghost", parts, "A")).toThrow(
      /no part with id/,
    );
  });
});
