import { describe, expect, it } from "vitest";
import { IKI_FORMAT_VERSION, IkiFormatError } from "@iki/format";
import type { IkiModel, IkiPhysics, IkiPhysicsChain } from "@iki/format";
import {
  AddPhysicsRig,
  DeletePhysicsRig,
  EditorDocument,
  SetPhysicsRig,
} from "@iki/editor-core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal valid model: 3 declared params + one trivial quad part, no physics. */
function baseModel(): IkiModel {
  return {
    version: IKI_FORMAT_VERSION,
    name: "base",
    canvas: { width: 1000, height: 1000 },
    parameters: [
      { id: "ParamAngleX", min: -30, max: 30, default: 0 },
      { id: "ParamHairSwayX", min: -20, max: 20, default: 0 },
      { id: "ParamBlink", min: 0, max: 1, default: 0 },
    ],
    parts: [
      {
        id: "quad",
        color: [1, 1, 1, 1],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
      },
    ],
  };
}

/** A valid rig (AngleX → HairSwayX), with shallow overrides for convenience. */
function rig(over: Partial<IkiPhysics> = {}): IkiPhysics {
  return {
    id: "r1",
    input: { parameter: "ParamAngleX", weight: 1 },
    output: { parameter: "ParamHairSwayX", scale: -10 },
    mass: 1,
    stiffness: 80,
    damping: 10,
    ...over,
  };
}

// ── findPhysicsRig ──────────────────────────────────────────────────────────

describe("EditorDocument.findPhysicsRig", () => {
  it("resolves an existing rig", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig()));
    expect(doc.findPhysicsRig("r1").id).toBe("r1");
  });

  it("throws a path-qualified error on an unknown id", () => {
    const doc = new EditorDocument(baseModel());
    expect(() => doc.findPhysicsRig("nope")).toThrow(
      /physics: no physics rig with id "nope"/,
    );
  });
});

// ── AddPhysicsRig ─────────────────────────────────────────────────────────────

describe("AddPhysicsRig", () => {
  it("adds the first rig (absent → present); undo removes the key; redo re-adds", () => {
    const doc = new EditorDocument(baseModel());
    expect(doc.getModel().physics).toBeUndefined();

    doc.execute(new AddPhysicsRig(rig()));
    expect(doc.getModel().physics).toHaveLength(1);

    doc.undo();
    // Absent restored — not an empty array.
    expect(doc.getModel().physics).toBeUndefined();

    doc.redo();
    expect(doc.getModel().physics).toHaveLength(1);
    expect(doc.getModel().physics?.[0].id).toBe("r1");
  });

  it("adds a second rig and undo leaves the surviving first rig", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig({ id: "r1" })));
    doc.execute(
      new AddPhysicsRig(
        rig({
          id: "r2",
          input: { parameter: "ParamAngleX", weight: 1 },
          output: { parameter: "ParamBlink", scale: 1 },
        }),
      ),
    );
    expect(doc.getModel().physics).toHaveLength(2);

    doc.undo();
    expect(doc.getModel().physics).toHaveLength(1);
    expect(doc.getModel().physics?.[0].id).toBe("r1");
  });

  it("rejects a duplicate rig id and leaves the model unmutated", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig({ id: "r1" })));
    expect(() => doc.execute(new AddPhysicsRig(rig({ id: "r1" })))).toThrow(
      /physics: id "r1" collides with an existing physics rig id/,
    );
    expect(doc.getModel().physics).toHaveLength(1);
  });

  it("does not alias the caller's nested input/output after construction", () => {
    const doc = new EditorDocument(baseModel());
    const r = rig();
    const cmd = new AddPhysicsRig(r);
    // Mutating the caller's rig AFTER construction must not corrupt the command.
    r.input.weight = 999;
    r.output.scale = 999;
    doc.execute(cmd);
    expect(doc.getModel().physics?.[0].input.weight).toBe(1);
    expect(doc.getModel().physics?.[0].output.scale).toBe(-10);
  });
});

// ── DeletePhysicsRig ──────────────────────────────────────────────────────────

describe("DeletePhysicsRig", () => {
  it("deletes the last rig (key removed); undo restores it at its index; redo removes again", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig()));

    doc.execute(new DeletePhysicsRig("r1"));
    expect(doc.getModel().physics).toBeUndefined();

    doc.undo();
    expect(doc.getModel().physics).toHaveLength(1);
    expect(doc.getModel().physics?.[0].id).toBe("r1");

    doc.redo();
    expect(doc.getModel().physics).toBeUndefined();
  });

  it("restores a non-last rig at its original index on undo", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig({ id: "r1" })));
    doc.execute(
      new AddPhysicsRig(
        rig({
          id: "r2",
          input: { parameter: "ParamAngleX", weight: 1 },
          output: { parameter: "ParamBlink", scale: 1 },
        }),
      ),
    );
    doc.execute(new DeletePhysicsRig("r1"));
    expect(doc.getModel().physics?.map((r) => r.id)).toEqual(["r2"]);

    doc.undo();
    expect(doc.getModel().physics?.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("throws on an unknown rig id", () => {
    const doc = new EditorDocument(baseModel());
    expect(() => doc.execute(new DeletePhysicsRig("nope"))).toThrow(
      /physics: no physics rig with id "nope"/,
    );
  });
});

// ── SetPhysicsRig ─────────────────────────────────────────────────────────────

describe("SetPhysicsRig", () => {
  it("edits a field; undo restores the prior rig; redo re-applies", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig({ stiffness: 80 })));

    doc.execute(new SetPhysicsRig("r1", rig({ stiffness: 120 })));
    expect(doc.getModel().physics?.[0].stiffness).toBe(120);

    doc.undo();
    expect(doc.getModel().physics?.[0].stiffness).toBe(80);

    doc.redo();
    expect(doc.getModel().physics?.[0].stiffness).toBe(120);
  });

  it("captures the ORIGINAL prior value once (redo does not re-capture)", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig({ stiffness: 80 })));
    const cmd = new SetPhysicsRig("r1", rig({ stiffness: 120 }));
    doc.execute(cmd);
    doc.undo();
    doc.redo(); // re-apply
    doc.undo(); // must restore the ORIGINAL 80, not the post-apply 120
    expect(doc.getModel().physics?.[0].stiffness).toBe(80);
  });

  it("forbids rename (rig.id !== rigId) before mutating", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig({ id: "r1" })));
    expect(() =>
      doc.execute(new SetPhysicsRig("r1", rig({ id: "renamed" }))),
    ).toThrow(/cannot change rig id to "renamed" \(rename unsupported\)/);
    expect(doc.getModel().physics?.[0].id).toBe("r1");
  });

  it("does not alias the caller's nested input/output after construction", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig()));
    const patch = rig({ stiffness: 120 });
    const cmd = new SetPhysicsRig("r1", patch);
    patch.input.weight = 999;
    patch.output.scale = 999;
    doc.execute(cmd);
    expect(doc.getModel().physics?.[0].input.weight).toBe(1);
    expect(doc.getModel().physics?.[0].output.scale).toBe(-10);
  });
});

// ── Representative validation-through-command ─────────────────────────────────
// The exhaustive parsePhysics matrix lives in @iki/format tests; here we only
// prove the commands route through validation and rewrite the failing path.

describe("validation surfaced through the commands", () => {
  it("rejects a scalar failure (mass <= 0) and names the rig id", () => {
    const doc = new EditorDocument(baseModel());
    let err: unknown;
    try {
      doc.execute(new AddPhysicsRig(rig({ id: "r1", mass: 0 })));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IkiFormatError);
    expect((err as Error).message).toMatch(/physics\."r1"/);
    expect(doc.getModel().physics).toBeUndefined();
  });

  it("rejects an undeclared input parameter and names the rig id", () => {
    const doc = new EditorDocument(baseModel());
    expect(() =>
      doc.execute(
        new AddPhysicsRig(
          rig({ id: "r1", input: { parameter: "Nope", weight: 1 } }),
        ),
      ),
    ).toThrow(/physics\."r1"\.input\.parameter "Nope" is not a declared/);
  });

  it("rewrites a cross-rig failure to the FAILING rig, not the edited rig", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig({ id: "a" }))); // out ParamHairSwayX
    doc.execute(
      new AddPhysicsRig(
        rig({
          id: "b",
          input: { parameter: "ParamAngleX", weight: 1 },
          output: { parameter: "ParamBlink", scale: 1 },
        }),
      ),
    );
    // Edit rig "a" so its output collides with rig "b"'s output → the validator
    // fails at index 1 (rig "b"), which the rewrite must name — not target "a".
    let err: unknown;
    try {
      doc.execute(
        new SetPhysicsRig(
          "a",
          rig({ id: "a", output: { parameter: "ParamBlink", scale: -10 } }),
        ),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IkiFormatError);
    expect((err as Error).message).toMatch(/physics\."b"\.output/);
    // Model unchanged — rig "a" still outputs ParamHairSwayX.
    expect(doc.findPhysicsRig("a").output.parameter).toBe("ParamHairSwayX");
  });

  it("ignores unrelated in-flight part NaN when validating a physics edit", () => {
    const doc = new EditorDocument(baseModel());
    // Corrupt an unrelated part's width directly in the live model.
    doc.getModel().parts[0].width = NaN;
    // A valid physics add still succeeds — the synthetic candidate uses a
    // trivial part and never reads the real (NaN) part numerics.
    expect(() => doc.execute(new AddPhysicsRig(rig()))).not.toThrow();
    expect(doc.getModel().physics).toHaveLength(1);
  });
});

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("physics round-trips through serialize()", () => {
  it("preserves model.physics across export", () => {
    const doc = new EditorDocument(baseModel());
    doc.execute(new AddPhysicsRig(rig()));
    const parsed = JSON.parse(doc.serialize()) as IkiModel;
    expect(parsed.physics).toEqual([rig()]);
  });
});

// ── Cross-rig collision with physicsChains ────────────────────────────────────
// Verifies that validatePhysicsCandidate includes the model's existing
// physicsChains (and deformers) so AddPhysicsRig / SetPhysicsRig REJECT a flat
// rig that collides with a chain id or a chain segment output.

/** Base model that also has a matrix deformer + one physicsChains chain. */
function baseModelWithChain(): IkiModel {
  // Needs: ParamAngleX (flat rig input), ParamHairSwayX (flat rig output),
  // ParamBlink (flat rig spare), ParamHairSeg0/ParamHairSeg1 (chain segment
  // outputs), ParamChainIn (spare for flat-rig collision tests).
  return {
    version: IKI_FORMAT_VERSION,
    name: "base-with-chain",
    canvas: { width: 1000, height: 1000 },
    parameters: [
      { id: "ParamAngleX", min: -30, max: 30, default: 0 },
      { id: "ParamHairSwayX", min: -20, max: 20, default: 0 },
      { id: "ParamBlink", min: 0, max: 1, default: 0 },
      { id: "ParamHairSeg0", min: -30, max: 30, default: 0 },
      { id: "ParamHairSeg1", min: -30, max: 30, default: 0 },
    ],
    parts: [
      {
        id: "quad",
        color: [1, 1, 1, 1],
        width: 100,
        height: 100,
        transform: { x: 0, y: 0 },
        order: 0,
      },
    ],
    deformers: [
      { kind: "matrix" as const, id: "hair_bone", pivot: { x: 0, y: 0 } },
    ],
    physicsChains: [
      {
        id: "chain1",
        anchorDeformer: "hair_bone",
        gravity: { angle: -90, strength: 9.8 },
        segments: [
          {
            output: { parameter: "ParamHairSeg0", scale: 1 },
            mass: 1,
            stiffness: 40,
            damping: 5,
          },
          {
            output: { parameter: "ParamHairSeg1", scale: 1 },
            mass: 1,
            stiffness: 40,
            damping: 5,
          },
        ],
      } satisfies IkiPhysicsChain,
    ],
  };
}

describe("AddPhysicsRig / SetPhysicsRig cross-chain collision checks", () => {
  it("AddPhysicsRig rejects a flat rig whose output collides with a chain segment output", () => {
    const doc = new EditorDocument(baseModelWithChain());
    // ParamHairSeg0 is already driven by chain1's first segment
    expect(() =>
      doc.execute(
        new AddPhysicsRig(
          rig({ id: "new", output: { parameter: "ParamHairSeg0", scale: 1 } }),
        ),
      ),
    ).toThrow(IkiFormatError);
    expect(doc.getModel().physics).toBeUndefined();
  });

  it("AddPhysicsRig rejects a flat rig whose id duplicates a chain id", () => {
    const doc = new EditorDocument(baseModelWithChain());
    // "chain1" is the id of the existing physicsChain
    expect(() => doc.execute(new AddPhysicsRig(rig({ id: "chain1" })))).toThrow(
      IkiFormatError,
    );
    expect(doc.getModel().physics).toBeUndefined();
  });

  it("SetPhysicsRig rejects an edit that makes the flat rig output collide with a chain segment output", () => {
    const doc = new EditorDocument(baseModelWithChain());
    // First add a valid flat rig
    doc.execute(new AddPhysicsRig(rig({ id: "r1" }))); // out: ParamHairSwayX
    // Now try to set it so its output collides with chain1's segment output
    expect(() =>
      doc.execute(
        new SetPhysicsRig(
          "r1",
          rig({ id: "r1", output: { parameter: "ParamHairSeg1", scale: -10 } }),
        ),
      ),
    ).toThrow(IkiFormatError);
    // Model unchanged — still outputs ParamHairSwayX
    expect(doc.findPhysicsRig("r1").output.parameter).toBe("ParamHairSwayX");
  });
});
