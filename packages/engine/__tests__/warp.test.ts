import { describe, expect, it } from "vitest";
import type { IkiParameter, IkiWarp } from "@iki/format";
import { ParameterStore } from "@iki/engine";
import { applyWarps } from "../src/warp";

// --- helpers ------------------------------------------------------------------

function makeStore(params: IkiParameter[] = []): ParameterStore {
  return new ParameterStore(params);
}

// 2-vertex rest fixture: [x0, y0, x1, y1]
const REST = new Float32Array([0, 0, 1, 0]);

const PARAM_ANGLE_X: IkiParameter = {
  id: "ParamAngleX",
  min: -30,
  max: 30,
  default: 0,
};

// --- (a) single keyform -------------------------------------------------------

describe("applyWarps — single keyform", () => {
  it("applies its offsets regardless of the live value", () => {
    const warp: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [{ value: 0, offsets: [1, 2, 3, 4] }],
    };
    const store = makeStore([PARAM_ANGLE_X]);
    const out = new Float32Array(4);

    // Value well above the single keyform's value — should still use that keyform.
    store.set("ParamAngleX", 25);
    applyWarps(REST, [warp], store, out);

    expect(out[0]).toBeCloseTo(0 + 1);
    expect(out[1]).toBeCloseTo(0 + 2);
    expect(out[2]).toBeCloseTo(1 + 3);
    expect(out[3]).toBeCloseTo(0 + 4);
  });
});

// --- (b) value below first keyform → clamp to first -------------------------

describe("applyWarps — clamp below first keyform", () => {
  it("uses first keyform offsets when value is below first keyform value", () => {
    const warp: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [
        { value: -10, offsets: [5, 6, 7, 8] },
        { value: 10, offsets: [1, 2, 3, 4] },
      ],
    };
    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", -30); // below -10
    const out = new Float32Array(4);

    applyWarps(REST, [warp], store, out);

    // Should use ks[0].offsets: [5, 6, 7, 8]
    expect(out[0]).toBeCloseTo(0 + 5);
    expect(out[1]).toBeCloseTo(0 + 6);
    expect(out[2]).toBeCloseTo(1 + 7);
    expect(out[3]).toBeCloseTo(0 + 8);
  });
});

// --- (c) value above last keyform → clamp to last ---------------------------

describe("applyWarps — clamp above last keyform", () => {
  it("uses last keyform offsets when value is above last keyform value", () => {
    const warp: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [
        { value: -10, offsets: [5, 6, 7, 8] },
        { value: 10, offsets: [1, 2, 3, 4] },
      ],
    };
    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", 30); // above 10
    const out = new Float32Array(4);

    applyWarps(REST, [warp], store, out);

    // Should use ks[last].offsets: [1, 2, 3, 4]
    expect(out[0]).toBeCloseTo(0 + 1);
    expect(out[1]).toBeCloseTo(0 + 2);
    expect(out[2]).toBeCloseTo(1 + 3);
    expect(out[3]).toBeCloseTo(0 + 4);
  });
});

// --- (d) value exactly on a keyform value ------------------------------------

describe("applyWarps — value exactly on keyform", () => {
  it("uses that keyform's offsets exactly", () => {
    const warp: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [
        { value: -10, offsets: [5, 6, 7, 8] },
        { value: 0, offsets: [1, 2, 3, 4] },
        { value: 10, offsets: [9, 8, 7, 6] },
      ],
    };
    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", 0); // exactly on middle keyform
    const out = new Float32Array(4);

    applyWarps(REST, [warp], store, out);

    // v === ks[1].value == 0, so lo=ks[1], hi=ks[2], t=0 → exactly ks[1].offsets
    expect(out[0]).toBeCloseTo(0 + 1);
    expect(out[1]).toBeCloseTo(0 + 2);
    expect(out[2]).toBeCloseTo(1 + 3);
    expect(out[3]).toBeCloseTo(0 + 4);
  });
});

// --- (e) midway lerp ---------------------------------------------------------

describe("applyWarps — midway interpolation", () => {
  it("linearly interpolates offsets and adds to rest", () => {
    const warp: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [
        { value: -10, offsets: [0, 0, 0, 0] },
        { value: 10, offsets: [4, 6, 8, 10] },
      ],
    };
    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", 0); // midway between -10 and 10 → t=0.5
    const out = new Float32Array(4);

    applyWarps(REST, [warp], store, out);

    // t=0.5: offsets = 0 + (4-0)*0.5=2, 0+(6)*0.5=3, 0+(8)*0.5=4, 0+(10)*0.5=5
    // out = rest + offsets = [0+2, 0+3, 1+4, 0+5]
    expect(out[0]).toBeCloseTo(2);
    expect(out[1]).toBeCloseTo(3);
    expect(out[2]).toBeCloseTo(5);
    expect(out[3]).toBeCloseTo(5);
  });
});

// --- (f) undefined warps → identity copy ------------------------------------

describe("applyWarps — undefined warps", () => {
  it("copies rest into out unchanged when warps is undefined", () => {
    const out = new Float32Array(4);
    applyWarps(REST, undefined, makeStore(), out);

    expect(out[0]).toBe(REST[0]);
    expect(out[1]).toBe(REST[1]);
    expect(out[2]).toBe(REST[2]);
    expect(out[3]).toBe(REST[3]);
  });
});

// --- (g) two warps accumulate additively -------------------------------------

describe("applyWarps — multiple warps accumulate additively", () => {
  it("adds contributions from two warps together", () => {
    const warp1: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [{ value: 0, offsets: [1, 0, 0, 0] }],
    };
    const warp2: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [{ value: 0, offsets: [0, 2, 0, 3] }],
    };
    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", 0);
    const out = new Float32Array(4);

    applyWarps(REST, [warp1, warp2], store, out);

    // rest=[0,0,1,0] + warp1=[1,0,0,0] + warp2=[0,2,0,3]
    expect(out[0]).toBeCloseTo(0 + 1 + 0); // 1
    expect(out[1]).toBeCloseTo(0 + 0 + 2); // 2
    expect(out[2]).toBeCloseTo(1 + 0 + 0); // 1
    expect(out[3]).toBeCloseTo(0 + 0 + 3); // 3
  });
});

// --- (h) out mutated in place, rest unmutated --------------------------------

describe("applyWarps — no allocation, rest preserved", () => {
  it("writes into the provided out buffer without mutating rest", () => {
    const warp: IkiWarp = {
      parameter: "ParamAngleX",
      keyforms: [{ value: 0, offsets: [10, 20, 30, 40] }],
    };
    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", 0);

    const rest = new Float32Array([0, 0, 1, 0]);
    const out = new Float32Array(4);
    const restSnapshot = Array.from(rest);

    applyWarps(rest, [warp], store, out);

    // rest is unchanged
    expect(Array.from(rest)).toEqual(restSnapshot);

    // out is mutated in place (not reallocated)
    expect(out[0]).toBeCloseTo(0 + 10);
    expect(out[1]).toBeCloseTo(0 + 20);
    expect(out[2]).toBeCloseTo(1 + 30);
    expect(out[3]).toBeCloseTo(0 + 40);
  });
});
