import { describe, expect, it } from "vitest";
import { occlusionAmount } from "../src/occlusion";

const stops = (...s: [number, number][]) => ({
  stops: s.map(([value, amount]) => ({ value, amount })),
});

describe("occlusionAmount", () => {
  const o = stops([5, 0], [15, 1]);

  it("holds the first stop's amount before it", () => {
    expect(occlusionAmount(o, -30)).toBe(0);
    expect(occlusionAmount(o, 5)).toBe(0);
  });

  it("gives each stop's amount at the stop", () => {
    const three = stops([0, 0.2], [1, 0.6], [3, 1]);
    expect(occlusionAmount(three, 0)).toBe(0.2);
    expect(occlusionAmount(three, 1)).toBe(0.6);
    expect(occlusionAmount(three, 3)).toBe(1);
  });

  it("is linear midway between stops", () => {
    expect(occlusionAmount(o, 10)).toBeCloseTo(0.5);
    expect(occlusionAmount(o, 7.5)).toBeCloseTo(0.25);
    const three = stops([0, 0.2], [1, 0.6], [3, 1]);
    expect(occlusionAmount(three, 2)).toBeCloseTo(0.8);
  });

  it("holds the last stop's amount past it", () => {
    expect(occlusionAmount(o, 15)).toBe(1);
    expect(occlusionAmount(o, 99)).toBe(1);
  });

  it("is exact at an inner stop", () => {
    const inner = stops([9.5, 0.3], [11, 1], [20, 1]);
    expect(occlusionAmount(inner, 9.5)).toBe(0.3);
    expect(occlusionAmount(inner, 11)).toBe(1);
  });

  it("is a constant with one stop", () => {
    const one = stops([2, 0.7]);
    expect(occlusionAmount(one, -5)).toBe(0.7);
    expect(occlusionAmount(one, 2)).toBe(0.7);
    expect(occlusionAmount(one, 5)).toBe(0.7);
  });

  it("follows amounts that fall as the value rises", () => {
    const falling = stops([0, 1], [10, 0]);
    expect(occlusionAmount(falling, -1)).toBe(1);
    expect(occlusionAmount(falling, 2.5)).toBeCloseTo(0.75);
    expect(occlusionAmount(falling, 10)).toBe(0);
    expect(occlusionAmount(falling, 20)).toBe(0);
  });
});
