import { describe, expect, it } from "vitest";
import {
  StandardParameter as P,
  type IkiExpression,
  type IkiModel,
} from "@ikijs/format";
import { generateIkiFromLayerSet, type LayerInput } from "@ikijs/editor";
import { defaultExpressions, defaultMotions } from "../src/auto-rig/animations";
import { REQUIRED_ROLES } from "../src/auto-rig/roles";
import { CANVAS, character, type CharacterOptions } from "./helpers/character";
import { fullBody } from "./helpers/full-body";

function rig(
  opts: CharacterOptions = {},
  keep: (l: LayerInput) => boolean = () => true,
): IkiModel {
  const { layers, options } = character(opts);
  return generateIkiFromLayerSet(layers.filter(keep), CANVAS, options);
}

const terms = (m: IkiModel) =>
  (m.expressions ?? []).flatMap((e) => e.parameters);

const ids = (m: IkiModel) => (m.expressions ?? []).map((e) => e.id);

const value = (e: IkiExpression, parameter: string) =>
  e.parameters.find((t) => t.parameter === parameter)!.value;

describe("the auto-rig's default expressions and motions", () => {
  const withBlush = rig({ extras: true });
  const hero = rig();

  it("declares six described expressions and the Nod, Shake and Tilt clips", () => {
    expect(ids(withBlush)).toEqual([
      "smile",
      "laugh",
      "angry",
      "sad",
      "surprised",
      "shy",
    ]);
    for (const e of withBlush.expressions!) {
      expect(e.description.trim()).not.toBe("");
    }
    const motions = withBlush.motions!;
    expect(Object.keys(motions)).toEqual(["Nod", "Shake", "Tilt"]);
    const curves = (group: string) =>
      motions[group].map((c) => c.curves.map((k) => k.parameter));
    expect(curves("Nod")).toEqual([[P.AngleY]]);
    expect(curves("Shake")).toEqual([[P.AngleX]]);
    expect(curves("Tilt")).toEqual([[P.AngleZ]]);
  });

  it("raises Cheek only on a character with a blush", () => {
    expect(terms(withBlush).some((t) => t.parameter === P.Cheek)).toBe(true);
    expect(terms(hero).some((t) => t.parameter === P.Cheek)).toBe(false);
  });

  it("declares an expression only where the face has what it shows", () => {
    // shy needs the blush, angry and sad the brows.
    expect(ids(hero)).toEqual(["smile", "laugh", "angry", "sad", "surprised"]);
    // The required roles alone, without the measured options naming others.
    const bare = generateIkiFromLayerSet(
      character().layers.filter((l) => REQUIRED_ROLES.includes(l.role)),
      CANVAS,
    );
    expect(ids(bare)).toEqual(["smile", "laugh", "surprised"]);
  });

  it("leaves out the brow terms on a character without brows", () => {
    const m = rig({ extras: true }, (l) => !l.role.startsWith("brow_"));
    expect(ids(m)).toEqual(["smile", "laugh", "surprised", "shy"]);
    expect(terms(m).filter((t) => t.parameter.startsWith("ParamBrow"))).toEqual(
      [],
    );
  });

  it("tilts the brows as a mirror pair: inner ends down in angry, up in sad", () => {
    const of = (id: string) => hero.expressions!.find((e) => e.id === id)!;
    const angry = of("angry");
    expect(value(angry, P.BrowLeftAngle)).toBeGreaterThan(0);
    expect(value(angry, P.BrowRightAngle)).toBe(-value(angry, P.BrowLeftAngle));
    const sad = of("sad");
    expect(value(sad, P.BrowLeftAngle)).toBeLessThan(0);
    expect(value(sad, P.BrowRightAngle)).toBe(-value(sad, P.BrowLeftAngle));
  });

  it("drops only the gaze term for a character without an iris", () => {
    const all = new Set(withBlush.parameters.map((p) => p.id));
    const full = defaultExpressions(all);
    expect(
      full.some((e) => e.parameters.some((t) => t.parameter === P.EyeballY)),
    ).toBe(true);
    all.delete(P.EyeballY);
    expect(defaultExpressions(all)).toEqual(
      full.map((e) => ({
        ...e,
        parameters: e.parameters.filter((t) => t.parameter !== P.EyeballY),
      })),
    );
  });
});

describe("the Wave motion", () => {
  const rigOf = (f: ReturnType<typeof fullBody>) =>
    generateIkiFromLayerSet(f.layers, f.canvas, f.options);
  const posed = rigOf(fullBody({ arms: true, poses: true }));

  it("is declared only with the pose forearm", () => {
    expect(Object.keys(rig().motions!)).toEqual(["Nod", "Shake", "Tilt"]);
    expect(Object.keys(rigOf(fullBody({ arms: true })).motions!)).toEqual([
      "Nod",
      "Shake",
      "Tilt",
    ]);
    expect(Object.keys(posed.motions!)).toEqual([
      "Nod",
      "Shake",
      "Tilt",
      "Wave",
    ]);
  });

  it("drops the Wave when one of its parameters is not declared", () => {
    const declared = new Set(posed.parameters.map((p) => p.id));
    expect(Object.keys(defaultMotions(declared))).toContain("Wave");
    for (const id of [P.ArmRight, P.ArmPoseRight, P.ArmPoseAngleRight]) {
      const without = new Set(declared);
      without.delete(id);
      expect(Object.keys(defaultMotions(without))).not.toContain("Wave");
    }
  });

  it("keys three curves back to rest, within range, fading as the switch ramps", () => {
    const [clip] = posed.motions!.Wave;
    expect(clip.curves.map((c) => c.parameter)).toEqual([
      P.ArmPoseRight,
      P.ArmRight,
      P.ArmPoseAngleRight,
    ]);
    const [sw, ...others] = clip.curves;
    expect(sw.interpolation).toBe("linear");
    for (const c of others) expect(c.interpolation).toBeUndefined();
    for (const c of clip.curves) {
      const param = posed.parameters.find((p) => p.id === c.parameter)!;
      expect(c.keys[0][1]).toBe(0);
      expect(c.keys.at(-1)![1]).toBe(0);
      for (const [, v] of c.keys) {
        expect(v).toBeGreaterThanOrEqual(param.min);
        expect(v).toBeLessThanOrEqual(param.max);
      }
    }
    expect(clip.fadeIn).toBe(sw.keys[1][0]);
    expect(clip.fadeOut).toBe(sw.keys[1][0]);
  });
});
