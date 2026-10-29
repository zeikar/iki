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
import type { IkiModel } from "@ikijs/format";
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

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The 2D warp deformers that differ between two models: id → the
 *  `[ParamAngleX, ParamAngleY]` cells that do. Any other deformer difference
 *  (grid, 1D warps, a deformer present in one only) lands as `"other"`. */
function differingCells(a: IkiModel, b: IkiModel) {
  const out: Record<string, ([number, number] | "other")[]> = {};
  const byId = (m: IkiModel) =>
    new Map((m.deformers ?? []).map((d) => [d.id, d]));
  const B = byId(b);
  for (const [id, da] of byId(a)) {
    const db = B.get(id);
    const cells: ([number, number] | "other")[] = [];
    if (da.kind !== "warp" || db?.kind !== "warp" || da.warp2d === undefined) {
      if (!same(da, db)) cells.push("other");
    } else {
      const { warp2d: w } = da;
      if (
        !same(da.grid, db.grid) ||
        !same(da.warps, db.warps) ||
        !same({ ...w, keyforms2d: 0 }, { ...db.warp2d, keyforms2d: 0 })
      ) {
        cells.push("other");
      }
      w.keyforms2d.forEach((k, n) => {
        if (!same(k, db.warp2d?.keyforms2d[n])) {
          cells.push([
            w.valuesX[n % w.valuesX.length],
            w.valuesY[Math.floor(n / w.valuesX.length)],
          ]);
        }
      });
    }
    if (cells.length > 0) out[id] = cells;
  }
  return out;
}

const partsExcept = (m: IkiModel, ...ids: string[]) =>
  m.parts.filter((p) => !ids.includes(p.id));

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

  it("turn.noseLead moves the nose on the turn stops and nothing else", () => {
    const base = rig();
    const lead = rig({}, { turn: { noseLead: 2 } });
    const diff = differingCells(base.model, lead.model);
    expect(Object.keys(diff)).toEqual(["noseWarp"]);
    for (const cell of diff.noseWarp) {
      expect(cell).not.toBe("other");
      expect((cell as [number, number])[0]).not.toBe(0);
    }
    expect(lead.model.parts).toEqual(base.model.parts);
    expect(lead.turn!.depths.nose).toBeGreaterThan(base.turn!.depths.nose);
    const clamp = lead.plan.clamped.find((c) => c.field === "turn.noseLead");
    if (clamp === undefined) {
      expect(lead.plan.effective["turn.noseLead"]).toBeCloseTo(2, 9);
    } else {
      expect(clamp.bound).toBeLessThan(2);
      expect(lead.plan.effective["turn.noseLead"]).toBeCloseTo(clamp.bound, 9);
    }
  });

  it("turn.eyeForeshorten reshapes the eyes on the turn stops and spares the nod", () => {
    const base = rig();
    const fore = rig({}, { turn: { eyeForeshorten: 1.5 } });
    const diff = differingCells(base.model, fore.model);
    expect(Object.keys(diff).sort()).toEqual(["eyeWarp_L", "eyeWarp_R"]);
    for (const cells of Object.values(diff)) {
      for (const cell of cells) {
        expect(cell).not.toBe("other");
        expect((cell as [number, number])[0]).not.toBe(0);
      }
    }
    const only = (m: IkiModel) => partsExcept(m, "hair_front");
    expect(only(fore.model)).toEqual(only(base.model));
    const hairY = (m: IkiModel) =>
      m.parts
        .find((p) => p.id === "hair_front")
        ?.warps?.find((w) => w.parameter === "ParamAngleY");
    expect(hairY(fore.model)).toEqual(hairY(base.model));
    expect(fore.turn!.achieved.farEyeRatio).toBeLessThan(
      base.turn!.achieved.farEyeRatio,
    );
    expect(fore.plan.effective["turn.eyeForeshorten"]).toBe(1.5);
  });

  it("lets a given farEyeRatio or noseShift own its field", () => {
    const { turn } = rig();
    const farEyeRatio = turn!.achieved.farEyeRatio;
    const a = rig({}, { turn: { eyeForeshorten: 0.5 } }, { farEyeRatio });
    const b = rig({}, { turn: { eyeForeshorten: 1.5 } }, { farEyeRatio });
    expect(a.model).toEqual(b.model);
    expect(a.plan.overriddenBy["turn.eyeForeshorten"]).toBe(
      "turnTargets.farEyeRatio",
    );
    const noseShift = 0.8 * (turn!.depths.nose * 0.5);
    const c = rig({}, { turn: { noseLead: 0.5 } }, { noseShift });
    const d = rig({}, { turn: { noseLead: 2 } }, { noseShift });
    expect(c.model).toEqual(d.model);
    expect(c.plan.overriddenBy["turn.noseLead"]).toBe("turnTargets.noseShift");
  });

  it("refuses the product rule and the range of the new fields", () => {
    const run = (rigPlan: unknown) => () =>
      rig({}, rigPlan as GenerateOptions["rigPlan"]);
    expect(run({ turn: { amount: 3, eyeForeshorten: 2 } })).toThrow(
      /amount × eyeForeshorten must stay ≤ 4/,
    );
    expect(run({ turn: { eyeForeshorten: 2.5 } })).toThrow(/outside \[0, 2\]/);
  });

  it("echoes a clamped amount with the foreshortening still at its requested value", () => {
    for (const eyeForeshorten of [undefined, 1.5]) {
      const r = rig(
        {},
        {
          turn: {
            amount: eyeForeshorten === undefined ? 3 : 2.5,
            eyeForeshorten,
          },
        },
      );
      expect(r.turn!.clamped).toContain("eyeShift");
      expect(r.plan.clamped.map((c) => c.field)).toContain("turn.amount");
      expect(r.plan.effective["turn.eyeForeshorten"]).toBe(eyeForeshorten ?? 1);
    }
    const { turn } = rig();
    const both = rig(
      {},
      {},
      {
        eyeShift: 0.8 * turn!.achieved.eyeShift,
        farEyeRatio: turn!.achieved.farEyeRatio,
      },
    );
    const v = both.plan.effective["turn.eyeForeshorten"];
    expect(Number.isFinite(v)).toBe(true);
    expect(both.plan.overriddenBy).toMatchObject({
      "turn.amount": "turnTargets.eyeShift",
      "turn.eyeForeshorten": "turnTargets.farEyeRatio",
    });
  });

  it("echoes finite values when a zero turn divides by zero", () => {
    const a = rig({}, { turn: { amount: 0, noseLead: 2 } });
    expect(a.plan.effective["turn.noseLead"]).toBe(2);
    const b = rig({}, { turn: { amount: 0 } }, { noseShift: 0 });
    expect(b.plan.effective["turn.noseLead"]).toBe(1);
    const c = rig(
      {},
      { turn: { amount: 0, eyeForeshorten: 1.5 } },
      { farEyeRatio: 1 },
    );
    expect(c.plan.effective["turn.eyeForeshorten"]).toBe(1.5);
    for (const r of [a, b, c]) {
      for (const v of Object.values(r.plan.effective)) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("keeps a consistent catalog", () => {
    expect(RIG_PLAN_FIELDS).toHaveLength(8);
    expect(
      RIG_PLAN_FIELDS.filter((f) => f.provisional).map((f) => f.path),
    ).toEqual(["turn.eyeForeshorten", "turn.noseLead"]);
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
