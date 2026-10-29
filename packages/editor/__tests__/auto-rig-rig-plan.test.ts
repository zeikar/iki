import { describe, expect, it } from "vitest";
import {
  RIG_PLAN_FIELDS,
  generateIkiFromLayerSet,
  type GenerateOptions,
  type RigPlanReport,
  type TurnSolveReport,
  type TurnTargets,
} from "@ikijs/editor";
import { resolveRigPlan } from "../src/auto-rig/rig-plan";
import { CANVAS, character, type CharacterOptions } from "./helpers/character";

function rig(
  opts: CharacterOptions = {},
  rigPlan?: GenerateOptions["rigPlan"],
  targets: TurnTargets = {},
) {
  const { layers, options } = character(opts);
  let plan: RigPlanReport | undefined;
  let turn: TurnSolveReport | undefined;
  const model = generateIkiFromLayerSet(layers, CANVAS, {
    ...options,
    ...(rigPlan === undefined ? {} : { rigPlan }),
    turnTargets: { ...targets, ...options.turnTargets },
    onRigPlanResolved: (r) => {
      plan = r;
    },
    onTurnSolved: (r) => {
      turn = r;
    },
  });
  return { model, plan: plan!, turn };
}

const defaults = () => {
  const out: Record<string, Record<string, number>> = {};
  for (const f of RIG_PLAN_FIELDS) {
    (out[f.group] ??= {})[f.key] = f.default;
  }
  return out;
};

describe("rigPlan", () => {
  it("rigs the same model from no plan, an empty plan and every default written out", () => {
    const none = rig().model;
    expect(rig({}, {}).model).toEqual(none);
    expect(rig({}, defaults()).model).toEqual(none);
  });

  it("echoes what the rig built with", () => {
    const { plan, turn } = rig();
    expect(plan.requested).toEqual({});
    expect(Object.keys(plan.effective).sort()).toEqual(
      RIG_PLAN_FIELDS.map((f) => f.path).sort(),
    );
    const clamp = plan.clamped.find((c) => c.field === "turn.amount");
    for (const f of RIG_PLAN_FIELDS) {
      if (f.path === "turn.amount" && clamp !== undefined) {
        expect(plan.effective[f.path]).toBe(clamp.bound);
        expect(turn!.clamped).toContain("eyeShift");
      } else {
        expect(plan.effective[f.path]).toBe(f.default);
      }
    }
    expect(plan.overriddenBy).toEqual({});
  });

  it("lets a given eyeShift own turn.amount", () => {
    const { turn } = rig();
    const eyeShift = 0.8 * turn!.achieved.eyeShift;
    const a = rig({}, { turn: { amount: 0.5 } }, { eyeShift });
    const b = rig({}, { turn: { amount: 2 } }, { eyeShift });
    expect(a.model).toEqual(b.model);
    expect(a.plan.overriddenBy["turn.amount"]).toBe("turnTargets.eyeShift");
    expect(a.plan.clamped).toEqual([]);
    expect(a.plan.effective["turn.amount"]).toBeCloseTo(
      b.plan.effective["turn.amount"],
      9,
    );
  });

  it("echoes on a set without a nose, where the turn targets are inert", () => {
    const { plan } = rig({ nose: false }, {}, { eyeShift: 0.2 });
    expect(plan.requested).toEqual({});
    expect(plan.effective["turn.amount"]).toBe(1);
    expect(plan.overriddenBy).toEqual({});
  });

  it("refuses a bad plan with the field's path", () => {
    const run = (rigPlan: unknown) => () =>
      rig({}, rigPlan as GenerateOptions["rigPlan"]);
    expect(run({ turn: { amount: 4 } })).toThrow(
      /rigPlan\.turn\.amount 4 is outside \[0, 3\] \(recommended 0\.7–1\.3\)/,
    );
    expect(run({ eyes: { blink: Number.NaN } })).toThrow(
      /rigPlan\.eyes\.blink must be a finite number/,
    );
    expect(run({ hairs: {} })).toThrow(
      /rigPlan\.hairs is not one of turn, hair, eyes/,
    );
    expect(run({ turn: [] })).toThrow(/rigPlan\.turn must be a plain object/);
  });

  it("keeps a consistent catalog", () => {
    const paths = RIG_PLAN_FIELDS.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const f of RIG_PLAN_FIELDS) {
      expect(f.path).toBe(`${f.group}.${f.key}`);
      expect(f.default).toBeGreaterThanOrEqual(f.range[0]);
      expect(f.default).toBeLessThanOrEqual(f.range[1]);
      expect(f.recommended[0]).toBeGreaterThanOrEqual(f.range[0]);
      expect(f.recommended[1]).toBeLessThanOrEqual(f.range[1]);
      expect(f.step).toBeGreaterThan(0);
    }
    const resolved = resolveRigPlan({}) as unknown as Record<
      string,
      Record<string, number>
    >;
    for (const f of RIG_PLAN_FIELDS) {
      expect(resolved[f.group][f.key], f.path).toBe(f.default);
    }
  });
});
