import { describe, expect, it } from "vitest";
import { parseIkiModel, type IkiModel, type IkiPart } from "@ikijs/format";
import { checkSweep, formatSweepReport } from "../src/sweep-report";

const QUAD = [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5];
// Vertex order: bottom-left, bottom-right, top-left, top-right.
const RIGHT = [0, 1, 0, 1];

/** A 4-vertex quad part; the format refuses `warps` on a part without a mesh. */
function part(
  id: string,
  x: number,
  y: number,
  size: number,
  warps: { value: number; offsets: number[] }[] = [],
): IkiPart {
  return {
    id,
    color: [1, 1, 1, 1],
    width: size,
    height: size,
    transform: { x, y },
    order: 0,
    mesh: {
      vertices: QUAD,
      uvs: [0, 0, 1, 0, 0, 1, 1, 1],
      indices: [0, 1, 2, 1, 3, 2],
    },
    ...(warps.length > 0
      ? { warps: [{ parameter: "ParamAngleX", keyforms: warps }] }
      : {}),
  };
}

/** Local-space offsets that move every vertex by `dx`. */
const shift = (dx: number) => [dx, 0, dx, 0, dx, 0, dx, 0];
/** Offsets that move the right-hand vertices by `dx`. */
const stretch = (dx: number) => RIGHT.flatMap((r) => [r * dx, 0]);
const NONE = shift(0);

function model(parts: IkiPart[]): IkiModel {
  return parseIkiModel({
    version: 1,
    name: "t",
    canvas: { width: 400, height: 400 },
    parameters: [{ id: "ParamAngleX", min: -30, max: 30, default: 0 }],
    parts,
  });
}

const face = (dx: number) =>
  part("face", 0, 0, 200, [
    { value: -30, offsets: shift(-dx) },
    { value: 0, offsets: NONE },
    { value: 30, offsets: shift(dx) },
  ]);
// 60 px eyes: a local 0.5 is 30 px, 0.15 of a 200 px face.
const eye = (id: string, x: number, minus: number, plus: number) =>
  part(id, x, 20, 60, [
    { value: -30, offsets: shift(minus) },
    { value: 0, offsets: NONE },
    { value: 30, offsets: shift(plus) },
  ]);

describe("checkSweep", () => {
  it("(a) a linear rig: no kink, no pop, lead is the excess over the plate", () => {
    const r = checkSweep(
      model([
        face(0.075),
        eye("eye_L", -50, -0.5, 0.5),
        eye("eye_R", 50, -0.5, 0.5),
      ]),
    );
    if ("unavailable" in r) throw new Error(r.unavailable);
    expect(r.unit).toBe("fw");
    expect(r.faceWidth).toBe(200);
    expect(r.landmarks.map((l) => l.id)).toEqual(["eye_L", "eye_R"]);
    for (const l of r.landmarks) {
      expect(l.amplitude).toBeCloseTo(0.3, 4);
      expect(l.xKink).toBeCloseTo(0, 3);
      expect(l.pop).toBeCloseTo(0, 3);
      // The eye moves 30 px per side and the plate 15: 15 px over 200.
      expect(l.lead.m30).toBeCloseTo(-0.075, 4);
      expect(l.lead.p30).toBeCloseTo(0.075, 4);
    }
    expect(r.plateAmplitude).toBeCloseTo(0.15, 4);
  });

  it("(b) a +30 keyform twice the -30 one is a 0.5 x kink; a width that grows half as much, a 0.5 width kink", () => {
    const r = checkSweep(
      model([
        face(0.075),
        eye("eye_L", -50, -0.25, 0.5),
        part("eye_R", 50, 20, 60, [
          { value: -30, offsets: stretch(-0.1) },
          { value: 0, offsets: NONE },
          { value: 30, offsets: stretch(0.05) },
        ]),
      ]),
    );
    if ("unavailable" in r) throw new Error(r.unavailable);
    const [l, rr] = r.landmarks;
    expect(l.xKink).toBeCloseTo(0.5, 3);
    expect(l.widthKink).toBeNull();
    expect(rr.widthKink).toBeCloseTo(0.5, 3);
  });

  it("(c) a lone displaced keyform away from the centre is a pop, not a kink", () => {
    const line = (deg: number) => shift((0.5 * deg) / 30);
    const popped = part("eye_L", -50, 20, 60, [
      { value: -30, offsets: line(-30) },
      { value: -16, offsets: line(-16) },
      { value: -15, offsets: shift(-0.25 + 1) },
      { value: -14, offsets: line(-14) },
      { value: 0, offsets: NONE },
      { value: 30, offsets: line(30) },
    ]);
    const r = checkSweep(
      model([face(0.075), popped, eye("eye_R", 50, -0.5, 0.5)]),
    );
    if ("unavailable" in r) throw new Error(r.unavailable);
    expect(r.landmarks[0].pop).toBeGreaterThan(5);
    expect(r.landmarks[0].xKink).toBeCloseTo(0, 3);
    expect(r.landmarks[1].pop).toBeCloseTo(0, 3);
  });

  it("(d) a rig without warps is frozen: amplitude 0 and n/a everywhere", () => {
    const r = checkSweep(
      model([
        part("face", 0, 0, 200),
        part("eye_L", -50, 20, 60),
        part("eye_R", 50, 20, 60),
      ]),
    );
    if ("unavailable" in r) throw new Error(r.unavailable);
    for (const l of r.landmarks) {
      expect(l.amplitude).toBe(0);
      expect(l.xKink).toBeNull();
      expect(l.widthKink).toBeNull();
      expect(l.pop).toBeNull();
    }
    expect(formatSweepReport(r)[0]).toContain("x kink n/a, width kink n/a");
    expect(formatSweepReport(r)[0]).toContain("pop n/a");
  });

  it("(e) names what is missing, and lists the nose only when there is one", () => {
    const noFace = checkSweep(
      model([part("eye_L", -50, 20, 60), part("eye_R", 50, 20, 60)]),
    );
    expect("unavailable" in noFace && noFace.unavailable).toMatch(/face/);
    const noEyes = checkSweep(model([face(0.075), part("eye_L", -50, 20, 60)]));
    expect("unavailable" in noEyes && noEyes.unavailable).toMatch(
      /eye_L and eye_R/,
    );

    const withNose = checkSweep(
      model([
        face(0.075),
        eye("eye_L", -50, -0.5, 0.5),
        eye("eye_R", 50, -0.5, 0.5),
        part("nose", 0, -20, 20, [
          { value: -30, offsets: shift(-1) },
          { value: 0, offsets: NONE },
          { value: 30, offsets: shift(1) },
        ]),
      ]),
    );
    if ("unavailable" in withNose) throw new Error(withNose.unavailable);
    expect(withNose.landmarks.map((l) => l.id)).toEqual([
      "eye_L",
      "eye_R",
      "nose",
    ]);
    expect(withNose.landmarks[2].widthKink).toBeNull();
  });

  it("(f) formats one line per landmark, a plate line, or the unavailable line", () => {
    const r = checkSweep(
      model([
        face(0.075),
        eye("eye_L", -50, -0.5, 0.5),
        eye("eye_R", 50, -0.5, 0.5),
      ]),
    );
    const lines = formatSweepReport(r);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^SWEEP turn eye_L: amplitude 0\.300 fw, x kink 0\.00, width kink n\/a, lead -30 -0\.075 fw \/ \+30 \+0\.075 fw, pop 0\.00$/,
    );
    expect(lines[2]).toBe("SWEEP turn plate: amplitude 0.150 fw");
    expect(
      formatSweepReport({ preset: "turn", unavailable: "no face part" }),
    ).toEqual(["SWEEP: unavailable — no face part"]);
  });
});
