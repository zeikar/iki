import { describe, expect, it } from "vitest";
import { captureBindingEndpoint } from "@iki/editor-core";

describe("captureBindingEndpoint", () => {
  describe("additive channels", () => {
    it("translateX: returns posedValue - restValue", () => {
      expect(captureBindingEndpoint("translateX", 10, 25)).toBe(15);
    });

    it("translateX: returns negative delta when posed < rest", () => {
      expect(captureBindingEndpoint("translateX", 10, 4)).toBe(-6);
    });

    it("translateY: additive case", () => {
      expect(captureBindingEndpoint("translateY", 5, 12)).toBe(7);
    });

    it("rotate: additive case", () => {
      expect(captureBindingEndpoint("rotate", 0, 45)).toBe(45);
    });

    it("scaleX: additive case", () => {
      expect(captureBindingEndpoint("scaleX", 1, 2)).toBe(1);
    });

    it("scaleY: additive case", () => {
      expect(captureBindingEndpoint("scaleY", 2, 3)).toBe(1);
    });
  });

  describe("opacity (multiplicative)", () => {
    it("opacity: returns posedValue / restValue", () => {
      expect(captureBindingEndpoint("opacity", 0.5, 0.25)).toBe(0.5);
    });

    it("opacity: rest=0 returns 0, not posedValue", () => {
      const result = captureBindingEndpoint("opacity", 0, 0.8);
      expect(result).toBe(0);
      expect(result).not.toBe(0.8);
    });
  });

  describe("non-finite input propagation", () => {
    it("restValue=NaN propagates as non-finite", () => {
      const result = captureBindingEndpoint("translateX", NaN, 5);
      expect(Number.isFinite(result)).toBe(false);
    });

    it("posedValue=NaN propagates as non-finite", () => {
      const result = captureBindingEndpoint("translateX", 10, NaN);
      expect(Number.isFinite(result)).toBe(false);
    });

    it("opacity: restValue=NaN propagates as non-finite", () => {
      const result = captureBindingEndpoint("opacity", NaN, 0.5);
      expect(Number.isFinite(result)).toBe(false);
    });

    it("opacity: posedValue=NaN propagates as non-finite", () => {
      const result = captureBindingEndpoint("opacity", 0.5, NaN);
      expect(Number.isFinite(result)).toBe(false);
    });

    /**
     * This test documents that captureBindingEndpoint does NOT guard against
     * non-finite values. The store's captureEndpoint finite-value guard is the
     * layer that prevents NaN/Infinity from being stored as a captured endpoint
     * value.
     */
    it("documents: helper does not validate finiteness; the store layer does", () => {
      expect(
        Number.isFinite(captureBindingEndpoint("translateX", NaN, 5)),
      ).toBe(false);
    });
  });
});
