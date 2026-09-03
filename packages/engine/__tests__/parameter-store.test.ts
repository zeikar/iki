import { describe, expect, it } from "vitest";
import type { IkiParameter } from "@ikijs/format";
import { ParameterStore } from "@ikijs/engine";

const params: IkiParameter[] = [
  { id: "open", min: 0, max: 1, default: 0.25 },
  // default deliberately outside the range to prove construction clamps it.
  { id: "angle", min: -30, max: 30, default: 99 },
  // degenerate range for the normalized() divide-by-zero guard.
  { id: "fixed", min: 5, max: 5, default: 5 },
];

const store = () => new ParameterStore(params);

describe("ParameterStore construction", () => {
  it("seeds each parameter with its default, clamped to range", () => {
    const s = store();
    expect(s.get("open")).toBe(0.25);
    expect(s.get("angle")).toBe(30); // 99 clamped to max
  });

  it("returns 0 for unknown ids", () => {
    expect(store().get("nope")).toBe(0);
  });

  it("lists every declared parameter", () => {
    expect(
      store()
        .list()
        .map((p) => p.id),
    ).toEqual(["open", "angle", "fixed"]);
  });
});

describe("ParameterStore.set", () => {
  it("clamps writes to the parameter range", () => {
    const s = store();
    s.set("open", 5);
    expect(s.get("open")).toBe(1);
    s.set("open", -5);
    expect(s.get("open")).toBe(0);
    s.set("angle", 10);
    expect(s.get("angle")).toBe(10);
  });

  it("ignores unknown ids without throwing", () => {
    const s = store();
    expect(() => s.set("nope", 1)).not.toThrow();
    expect(s.get("nope")).toBe(0);
  });

  it("drops non-finite writes and holds the last good value", () => {
    const s = store();
    s.set("angle", 10);
    for (const bad of [NaN, Infinity, -Infinity]) {
      s.set("angle", bad);
      expect(s.get("angle")).toBe(10);
    }
  });

  it("keeps normalized() finite after a non-finite write", () => {
    const s = store();
    s.set("angle", NaN);
    expect(Number.isFinite(s.normalized("angle"))).toBe(true);
  });
});

describe("ParameterStore.normalized", () => {
  it("reports position within range as 0..1", () => {
    const s = store();
    s.set("angle", 0);
    expect(s.normalized("angle")).toBeCloseTo(0.5);
    s.set("angle", -30);
    expect(s.normalized("angle")).toBe(0);
    s.set("angle", 30);
    expect(s.normalized("angle")).toBe(1);
  });

  it("returns 0 for a zero-width range and unknown ids", () => {
    const s = store();
    expect(s.normalized("fixed")).toBe(0);
    expect(s.normalized("nope")).toBe(0);
  });
});

describe("ParameterStore.reset", () => {
  it("restores every parameter to its clamped default", () => {
    const s = store();
    s.set("open", 1);
    s.set("angle", -10);
    s.reset();
    expect(s.get("open")).toBe(0.25);
    expect(s.get("angle")).toBe(30);
  });
});
