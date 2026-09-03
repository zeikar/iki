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

describe("editor sample: standard-parameter side convention", () => {
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
