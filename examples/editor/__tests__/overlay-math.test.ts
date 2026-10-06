import { describe, expect, it } from "vitest";
import type { IkiDeformer } from "@ikijs/format";
import { hasWarpAncestor } from "../src/overlay-math";

const matrix = (id: string, parent?: string): IkiDeformer => ({
  id,
  kind: "matrix",
  parent,
  pivot: { x: 0, y: 0 },
});

const warp = (id: string, parent?: string): IkiDeformer =>
  ({
    id,
    kind: "warp",
    parent,
    grid: { columns: 1, rows: 1, points: [0, 0, 1, 0, 0, 1, 1, 1] },
  }) as IkiDeformer;

describe("hasWarpAncestor", () => {
  it("is false for an undefined id", () => {
    expect(hasWarpAncestor(undefined, [matrix("A")])).toBe(false);
  });

  it("is false for a root matrix deformer", () => {
    expect(hasWarpAncestor("A", [matrix("A")])).toBe(false);
  });

  it("is false for an all-matrix chain", () => {
    const ds = [matrix("A"), matrix("B", "A"), matrix("C", "B")];
    expect(hasWarpAncestor("C", ds)).toBe(false);
  });

  it("is true when the parent is a warp", () => {
    expect(hasWarpAncestor("B", [warp("W"), matrix("B", "W")])).toBe(true);
  });

  it("is true when a warp sits two levels up", () => {
    const ds = [
      matrix("A"),
      warp("W", "A"),
      matrix("B", "W"),
      matrix("C", "B"),
    ];
    expect(hasWarpAncestor("C", ds)).toBe(true);
  });

  it("counts the id itself", () => {
    expect(hasWarpAncestor("W", [matrix("A"), warp("W", "A")])).toBe(true);
  });

  it("is false when the parent id is not declared", () => {
    expect(hasWarpAncestor("B", [matrix("B", "ghost")])).toBe(false);
  });

  it("terminates on a self-referencing parent", () => {
    expect(hasWarpAncestor("A", [matrix("A", "A")])).toBe(false);
  });
});
