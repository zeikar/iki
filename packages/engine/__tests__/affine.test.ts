import { describe, expect, it } from "vitest";
import {
  type Affine,
  multiply,
  rotate,
  scale,
  toMat3,
  translate,
} from "@iki/engine";

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

describe("affine builders", () => {
  it("translate writes the offset into the e/f slots", () => {
    expect(translate(3, -4)).toEqual([1, 0, 0, 1, 3, -4]);
  });

  it("scale writes factors onto the diagonal", () => {
    expect(scale(2, 5)).toEqual([2, 0, 0, 5, 0, 0]);
  });

  it("rotate(0) is the identity rotation", () => {
    const m = rotate(0);
    expect(m[0]).toBeCloseTo(1);
    expect(m[1]).toBeCloseTo(0);
    expect(m[2]).toBeCloseTo(0);
    expect(m[3]).toBeCloseTo(1);
  });

  it("rotate(90) maps cos→0, sin→1", () => {
    const [a, b, c, d] = rotate(90);
    expect(a).toBeCloseTo(0);
    expect(b).toBeCloseTo(1);
    expect(c).toBeCloseTo(-1);
    expect(d).toBeCloseTo(0);
  });
});

describe("multiply", () => {
  it("treats the identity as a no-op on both sides", () => {
    const m = translate(7, 8);
    expect(multiply(m, IDENTITY)).toEqual(m);
    expect(multiply(IDENTITY, m)).toEqual(m);
  });

  it("composes translate ∘ scale to a hand-computed result", () => {
    // translate(1,2) * scale(2,3) => diagonal from scale, offset from translate
    expect(multiply(translate(1, 2), scale(2, 3))).toEqual([2, 0, 0, 3, 1, 2]);
  });

  it("applies the left matrix's offset when composing scale ∘ translate", () => {
    // scale(2,3) * translate(1,2) scales the translation offset
    expect(multiply(scale(2, 3), translate(1, 2))).toEqual([2, 0, 0, 3, 2, 6]);
  });
});

describe("toMat3", () => {
  it("expands the 6-tuple into a column-major mat3", () => {
    const out = toMat3([1, 2, 3, 4, 5, 6]);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([1, 2, 0, 3, 4, 0, 5, 6, 1]);
  });
});
