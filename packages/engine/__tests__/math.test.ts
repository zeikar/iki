import { describe, expect, it } from "vitest";
import { smoothstep } from "../src/math";

describe("smoothstep", () => {
  it("is 0, 1/2 and 1 at 0, 1/2 and 1, exactly", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
  });

  it("is x²(3 − 2x) inside [0, 1], exact on dyadic inputs", () => {
    expect(smoothstep(0.25)).toBe(5 / 32);
    expect(smoothstep(0.75)).toBe(27 / 32);
  });

  it("clamps its input to [0, 1]", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });

  it("starts and ends flat", () => {
    const h = 1e-4;
    expect(smoothstep(h) / h).toBeLessThan(1e-3);
    expect((1 - smoothstep(1 - h)) / h).toBeLessThan(1e-3);
  });
});
