import { describe, expect, it } from "vitest";
import { packAtlas, uvRectFor } from "@iki/editor-core";
import { remapMeshUvsToRect } from "../src/mesh-uv";

// Full local 0..1 square — corners at (0,0) and (1,1), plus interior midpoint.
const BASE_UVS = [0, 0, 1, 0, 0, 1, 1, 1];

const RECT = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };

// ── Corners (no-flip) ────────────────────────────────────────────────────────

describe("remapMeshUvsToRect corners — no flip", () => {
  it("(0,0) maps to (rect.x, rect.y)", () => {
    const out = remapMeshUvsToRect([0, 0], RECT);
    expect(out[0]).toBeCloseTo(RECT.x);
    expect(out[1]).toBeCloseTo(RECT.y);
  });

  it("(1,1) maps to (rect.x+width, rect.y+height)", () => {
    const out = remapMeshUvsToRect([1, 1], RECT);
    expect(out[0]).toBeCloseTo(RECT.x + RECT.width);
    expect(out[1]).toBeCloseTo(RECT.y + RECT.height);
  });

  it("v=0 maps to rect.y — NOT rect.y+height (asserts no vertical flip)", () => {
    const out = remapMeshUvsToRect([0, 0], RECT);
    expect(out[1]).toBeCloseTo(RECT.y);
    expect(out[1]).not.toBeCloseTo(RECT.y + RECT.height);
  });
});

// ── Interior center ──────────────────────────────────────────────────────────

describe("remapMeshUvsToRect interior", () => {
  it("(0.5,0.5) maps to rect center", () => {
    const out = remapMeshUvsToRect([0.5, 0.5], RECT);
    expect(out[0]).toBeCloseTo(RECT.x + 0.5 * RECT.width);
    expect(out[1]).toBeCloseTo(RECT.y + 0.5 * RECT.height);
  });
});

// ── Output length and no-mutate ──────────────────────────────────────────────

describe("remapMeshUvsToRect output length and no-mutate", () => {
  it("output length equals input length", () => {
    const out = remapMeshUvsToRect(BASE_UVS, RECT);
    expect(out.length).toBe(BASE_UVS.length);
  });

  it("input array is NOT mutated", () => {
    const input = BASE_UVS.slice();
    remapMeshUvsToRect(input, RECT);
    expect(input).toEqual(BASE_UVS);
  });
});

// ── Idempotence ──────────────────────────────────────────────────────────────

describe("remapMeshUvsToRect idempotence", () => {
  it("remapping the same base twice yields identical output", () => {
    const first = remapMeshUvsToRect(BASE_UVS, RECT);
    const second = remapMeshUvsToRect(BASE_UVS, RECT);
    expect(second).toEqual(first);
  });

  it("base→rectA then base→rectB gives rectB exactly (not compounding)", () => {
    const RECT_A = { x: 0.0, y: 0.0, width: 0.3, height: 0.3 };
    const RECT_B = { x: 0.5, y: 0.5, width: 0.4, height: 0.4 };
    // Remapping from the original base to rectB must equal the direct remap,
    // proving the base is never overwritten between calls.
    const viaBase = remapMeshUvsToRect(BASE_UVS, RECT_B);
    // Simulate caller that mistakenly re-remaps (should NOT match viaBase if compounding)
    remapMeshUvsToRect(BASE_UVS, RECT_A); // this call must not affect BASE_UVS
    const again = remapMeshUvsToRect(BASE_UVS, RECT_B);
    expect(again).toEqual(viaBase);
  });
});

// ── packAtlas-derived rect stays in [0,1] ────────────────────────────────────

describe("remapMeshUvsToRect components in [0,1] with packAtlas rect", () => {
  it("every output component is in [0,1] when rect comes from packAtlas+uvRectFor", () => {
    const layout = packAtlas([{ id: "tex", width: 64, height: 64 }]);
    const placement = layout.placements[0];
    const page = { width: layout.pageWidth, height: layout.pageHeight };
    const rect = uvRectFor(placement, page);

    const out = remapMeshUvsToRect(BASE_UVS, rect);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ── Odd-length throws ────────────────────────────────────────────────────────

describe("remapMeshUvsToRect odd-length input", () => {
  it("throws a plain Error when input length is odd", () => {
    expect(() => remapMeshUvsToRect([0, 0, 1], RECT)).toThrow(Error);
  });
});
