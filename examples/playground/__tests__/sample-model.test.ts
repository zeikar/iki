import { describe, expect, it } from "vitest";
import { StandardParameter, parseIkiModel, type IkiPart } from "@ikijs/format";
import { sampleModel } from "../src/sample-model";

/**
 * `Left`/`Right` standard parameters name the CHARACTER's side, so the part
 * they drive must sit on the opposite screen side: character-left = +x.
 * See the SIDE CONVENTION block in @ikijs/format's parameters.ts.
 */
const SIDE_OF = new Map<string, "left" | "right">([
  [StandardParameter.EyeOpenLeft, "left"],
  [StandardParameter.EyeOpenRight, "right"],
  [StandardParameter.BrowLeftY, "left"],
  [StandardParameter.BrowRightY, "right"],
  [StandardParameter.BrowLeftAngle, "left"],
  [StandardParameter.BrowRightAngle, "right"],
]);

/** Every side-typed standard parameter a part reads, via bindings or warps. */
function sidesDriving(part: IkiPart): Set<"left" | "right"> {
  const sides = new Set<"left" | "right">();
  for (const b of part.bindings ?? []) {
    const side = SIDE_OF.get(b.parameter);
    if (side) sides.add(side);
  }
  for (const w of part.warps ?? []) {
    const side = SIDE_OF.get(w.parameter);
    if (side) sides.add(side);
  }
  return sides;
}

describe("playground sample: standard-parameter side convention", () => {
  const driven = sampleModel.parts
    .map((part) => ({ part, sides: sidesDriving(part) }))
    .filter((e) => e.sides.size > 0);

  it("is a valid .iki model", () => {
    expect(() => parseIkiModel(sampleModel)).not.toThrow();
  });

  it("has parts driven by side-typed parameters", () => {
    expect(driven.length).toBeGreaterThan(0);
  });

  it("never drives one part from both sides", () => {
    for (const { part, sides } of driven) {
      expect(`${part.id}:${sides.size}`).toBe(`${part.id}:1`);
    }
  });

  it("names every side-suffixed part for the character's side it sits on", () => {
    // The binding check above only sees parts driven by a side-typed parameter,
    // so ids like blush/brow/ear — and any part whose name and parameter
    // disagree — would slip through. The name is what a human reads, so pin it.
    const suffixed = sampleModel.parts.filter((p) => /[LR]\d*$/.test(p.id));
    expect(suffixed.length).toBeGreaterThan(0);
    for (const part of suffixed) {
      // Parts whose geometry lives in the mesh sit at x: 0; their transform
      // says nothing about which side they are on.
      if (part.transform.x === 0) continue;
      const side = /L\d*$/.test(part.id) ? "left" : "right";
      const expected = side === "left" ? "positive" : "negative";
      const actual = part.transform.x > 0 ? "positive" : "negative";
      expect(`${part.id} -> ${actual}`).toBe(`${part.id} -> ${expected}`);
    }
  });

  it("places character-left parts at +x and character-right parts at -x", () => {
    for (const { part, sides } of driven) {
      const side = [...sides][0];
      const expected = side === "left" ? "positive" : "negative";
      const actual = part.transform.x > 0 ? "positive" : "negative";
      expect(`${part.id} (${side}) -> ${actual}`).toBe(
        `${part.id} (${side}) -> ${expected}`,
      );
    }
  });
});
