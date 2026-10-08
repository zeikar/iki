import { describe, expect, it } from "vitest";
import { scale, type Affine } from "../src/affine";
import { checkedView, projectView } from "../src/view";

// Model-space point -> clip space through an Affine.
function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

describe("projectView", () => {
  it("the model-box view is exactly the plain fit scale, with +0 offsets", () => {
    const w = 700;
    const h = 700;
    const fit = Math.min(w / 1100, h / 1100);
    const m = projectView(w, h, { x: 0, y: 0, width: 1100, height: 1100 });
    expect(m).toEqual(scale((fit * 2) / w, (fit * 2) / h));
  });

  it("a view 2.5x the width in a tall viewport fits like a bust", () => {
    const m = projectView(2800, 3812, {
      x: 0,
      y: 0,
      width: 2750,
      height: 3742,
    });
    // The fit is the same double as a 1120-wide bust canvas on a 1100 model.
    expect(m[0]).toBe((2 * (1120 / 1100)) / 2800);
    expect(apply(m, 1375, 0)[0]).toBeCloseTo(1, 12);
    expect(apply(m, -1375, 0)[0]).toBeCloseTo(-1, 12);
    expect(Math.abs(apply(m, 0, 1871)[1])).toBeLessThan(1);
    expect(apply(m, 550, 0)[0]).toBeCloseTo(0.4, 12);
  });

  it("a wide viewport with a tall view fits by height", () => {
    const m = projectView(2000, 1000, { x: 0, y: 0, width: 500, height: 1000 });
    expect(apply(m, 0, 500)[1]).toBeCloseTo(1, 12);
    expect(apply(m, 250, 0)[0]).toBeLessThan(1);
  });

  it("an off-centre view maps its centre to the middle; a crop scales up", () => {
    const view = { x: 100, y: 300, width: 200, height: 200 };
    const m = projectView(800, 800, view);
    const [cx, cy] = apply(m, 100, 300);
    expect(Math.abs(cx)).toBe(0);
    expect(Math.abs(cy)).toBe(0);
    expect(apply(m, 200, 300)[0]).toBeCloseTo(1, 12);
    expect(apply(m, 100, 200)[1]).toBeCloseTo(-1, 12);
  });
});

describe("checkedView", () => {
  it("returns a copy", () => {
    const input = { x: 1, y: 2, width: 3, height: 4 };
    const out = checkedView(input);
    input.width = 99;
    expect(out).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("throws on bad numbers", () => {
    const ok = { x: 0, y: 0, width: 1, height: 1 };
    expect(() => checkedView({ ...ok, x: NaN })).toThrow(/setView/);
    expect(() => checkedView({ ...ok, x: Infinity })).toThrow(/setView/);
    expect(() => checkedView({ ...ok, y: NaN })).toThrow(/setView/);
    expect(() => checkedView({ ...ok, width: 0 })).toThrow(/setView/);
    expect(() => checkedView({ ...ok, width: -1 })).toThrow(/setView/);
    expect(() => checkedView({ ...ok, height: Infinity })).toThrow(/setView/);
  });
});
