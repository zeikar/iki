import { describe, expect, it } from "vitest";
import { curveSlopes, sampleCurve } from "../src/clip-player";
import { smoothstep } from "../src/math";

type Keys = [number, number][];

/** The smooth sampler, its slopes worked out as ClipPlayer does once. */
function smooth(keys: Keys): (t: number) => number {
  const slopes = curveSlopes(keys);
  return (t) => sampleCurve(keys, t, slopes);
}

/** `count + 1` evenly spaced samples of `f` over `[a, b]`. */
function samples(f: (t: number) => number, a: number, b: number, count = 256) {
  return Array.from({ length: count + 1 }, (_, i) =>
    f(a + ((b - a) * i) / count),
  );
}

// --- linear --------------------------------------------------------------------

describe("sampleCurve, linear (no slopes)", () => {
  const keys: Keys = [
    [0.5, 2],
    [1, 4],
    [2, 0],
  ];

  it("holds the first value before the first key", () => {
    expect(sampleCurve(keys, 0)).toBe(2);
    expect(sampleCurve(keys, -1)).toBe(2);
  });

  it("returns a key's value exactly on it", () => {
    expect(sampleCurve(keys, 0.5)).toBe(2);
    expect(sampleCurve(keys, 1)).toBe(4);
    expect(sampleCurve(keys, 2)).toBe(0);
  });

  it("interpolates linearly between keys", () => {
    expect(sampleCurve(keys, 0.75)).toBe(3);
    expect(sampleCurve(keys, 1.5)).toBe(2);
    expect(sampleCurve(keys, 1.75)).toBe(1);
  });

  it("holds the last value after the last key", () => {
    expect(sampleCurve(keys, 3)).toBe(0);
  });

  it("holds a single key's value everywhere", () => {
    const one: Keys = [[1, 7]];
    expect(sampleCurve(one, 0)).toBe(7);
    expect(sampleCurve(one, 1)).toBe(7);
    expect(sampleCurve(one, 5)).toBe(7);
  });
});

// --- smooth --------------------------------------------------------------------

describe("sampleCurve, smooth (monotone cubic)", () => {
  it("returns a key's value exactly on it, and holds before and after the keys", () => {
    const keys: Keys = [
      [0.5, 2],
      [1, 4],
      [1.5, 5],
      [2, 0],
    ];
    const f = smooth(keys);
    for (const [t, v] of keys) expect(f(t)).toBe(v);
    expect(f(0)).toBe(2);
    expect(f(-1)).toBe(2);
    expect(f(3)).toBe(0);
  });

  it("eases between two keys: the smoothstep of the segment", () => {
    const f = smooth([
      [1, 2],
      [3, 10],
    ]);
    for (const u of [0.125, 0.25, 0.5, 0.75, 0.875]) {
      expect(f(1 + 2 * u)).toBeCloseTo(2 + 8 * smoothstep(u), 12);
    }
  });

  it("holds a single key's value everywhere", () => {
    const f = smooth([[1, 7]]);
    for (const t of [0, 1, 5]) expect(f(t)).toBe(7);
  });

  it("never overshoots a zig-zag: each segment stays between its two keys", () => {
    const keys: Keys = [
      [0, 0],
      [0.25, 10],
      [1, -10],
      [1.125, 5],
      [2, 5],
      [3, -1],
    ];
    const f = smooth(keys);
    for (let i = 1; i < keys.length; i++) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      for (const v of samples(f, t0, t1)) {
        expect(v).toBeGreaterThanOrEqual(Math.min(v0, v1) - 1e-12);
        expect(v).toBeLessThanOrEqual(Math.max(v0, v1) + 1e-12);
      }
    }
  });

  it("keeps rising keys rising, through a steep and uneven run", () => {
    const f = smooth([
      [0, 0],
      [1, 1],
      [1.25, 6],
      [3, 7],
      [3.5, 20],
    ]);
    const vs = samples(f, 0, 3.5, 1024);
    for (let i = 1; i < vs.length; i++) {
      expect(vs[i]).toBeGreaterThanOrEqual(vs[i - 1]);
    }
  });

  it("is flat at the first and last key and at a peak, so it joins the holds without a kink", () => {
    const f = smooth([
      [0, 0],
      [1, 5],
      [2, 10],
      [3, 4],
    ]);
    const h = 1e-5;
    const slope = (t: number) => (f(t + h) - f(t - h)) / (2 * h);
    expect(Math.abs(slope(0 + h))).toBeLessThan(1e-3); // the first key
    expect(Math.abs(slope(2))).toBeLessThan(1e-3); // the peak
    expect(Math.abs(slope(3 - h))).toBeLessThan(1e-3); // the last key
    // A key on a straight run keeps the run's slope, from both sides (the
    // curvature changes there, so the difference is only good to O(h)).
    expect(slope(1)).toBeCloseTo(5, 3);
  });

  it("puts a zero slope on every key a flat run touches", () => {
    expect(
      curveSlopes([
        [0, 0],
        [1, 3],
        [2, 3],
        [3, 6],
      ]),
    ).toEqual([0, 0, 0, 0]);
  });
});
