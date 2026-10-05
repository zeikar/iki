import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIkiModel } from "@ikijs/format";
import { heroDemoAnimations } from "../src/demo-animations";

describe("playground hero demo animations", () => {
  it("is a valid .iki model once spread onto hero.iki", () => {
    const hero = JSON.parse(
      readFileSync(new URL("../public/hero.iki", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const model = parseIkiModel({ ...hero, ...heroDemoAnimations });
    expect(model.expressions?.map((e) => e.id)).toEqual([
      "smile",
      "laugh",
      "angry",
      "sad",
      "surprised",
    ]);
    expect(Object.keys(model.motions ?? {})).toEqual(["Nod", "Shake", "Tilt"]);
  });
});
