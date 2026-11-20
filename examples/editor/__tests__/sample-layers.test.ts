import { describe, expect, it } from "vitest";
import { parseLayerRoles } from "@ikijs/editor";
import { SAMPLE_LAYER_NAMES } from "../src/sample-layers";

describe("the sample layer set", () => {
  // The glob in sample-layers.ts matches nothing, silently, if the corpus
  // character it points at is moved or renamed.
  it("is a layer set the auto-rig takes: every name a role, the required ones present", () => {
    expect(SAMPLE_LAYER_NAMES.length).toBeGreaterThan(0);
    // Throws on an unknown or doubled role, a missing required one, or a
    // mouth set it cannot rig.
    expect(() => parseLayerRoles([...SAMPLE_LAYER_NAMES])).not.toThrow();
  });
});
