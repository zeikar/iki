import { describe, expect, it } from "vitest";
import {
  parseIkiModel,
  type IkiDeformer,
  type IkiModel,
  type IkiPart,
} from "@ikijs/format";
import {
  checkNod,
  checkSweep,
  formatNodReport,
  formatSweepReport,
} from "../src/sweep-report";

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
  parameter = "ParamAngleX",
  deformer?: string,
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
    ...(warps.length > 0 ? { warps: [{ parameter, keyforms: warps }] } : {}),
    ...(deformer ? { deformer } : {}),
  };
}

/** Local-space offsets that move every vertex by `dx`. */
const shift = (dx: number) => [dx, 0, dx, 0, dx, 0, dx, 0];
/** Offsets that move the right-hand vertices by `dx`. */
const stretch = (dx: number) => RIGHT.flatMap((r) => [r * dx, 0]);
const NONE = shift(0);

function model(parts: IkiPart[], deformers: IkiDeformer[] = []): IkiModel {
  return parseIkiModel({
    version: 1,
    name: "t",
    canvas: { width: 400, height: 400 },
    parameters: [
      { id: "ParamAngleX", min: -30, max: 30, default: 0 },
      { id: "ParamAngleY", min: -30, max: 30, default: 0 },
    ],
    parts,
    ...(deformers.length > 0 ? { deformers } : {}),
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

// eye_R sits at (50, 20) and is 60 px square, so its box is x 20..80, y -10..50.
// Rest grid: 2 x 2 cells, row 0 the top, as the format wants.
const EYE_R_GRID = {
  cols: 2,
  rows: 2,
  points: [
    20, 50, 50, 50, 80, 50, 20, 20, 50, 20, 80, 20, 20, -10, 50, -10, 80, -10,
  ],
};
/** A warp2d deformer that moves its whole grid by `dx` px at the nine stops, filed j * 3 + i. */
function eyeRWarp(dx: number[]): IkiDeformer {
  return {
    kind: "warp",
    id: "w_R",
    grid: EYE_R_GRID,
    warp2d: {
      parameter: "ParamAngleX",
      parameterY: "ParamAngleY",
      valuesX: [-30, 0, 30],
      valuesY: [-30, 0, 30],
      keyforms2d: dx.map((d) => ({
        offsets: Array.from({ length: 18 }, (_, n) => (n % 2 === 0 ? d : 0)),
      })),
    },
  };
}
const S = 6;
// (AngleX -30, AngleY -30), (-30, 0), (-30, +30), then the 0 and +30 columns.
const MINT = eyeRWarp([2 * S, 0, 0, S, 0, 0, 0, 0, 0]);
const underMint = (id: string, x: number, size: number) =>
  part(id, x, 20, size, [], "ParamAngleX", "w_R");

describe("checkNod", () => {
  const eyes = (deformer: IkiDeformer, extra: IkiPart[] = []) =>
    model(
      [
        part("face", 0, 0, 200),
        part("eye_L", -50, 20, 60),
        underMint("eye_R", 50, 60),
        ...extra,
      ],
      [deformer],
    );
  const get = (m: IkiModel) => {
    const r = checkNod(m);
    if ("unavailable" in r) throw new Error(r.unavailable);
    return r;
  };

  it("(a) a far-eye patch at two of the three nod stops reads on the gap at that turn and at its corners", () => {
    const r = get(eyes(MINT));
    expect(r.unit).toBe("fw");
    expect(r.faceWidth).toBe(200);
    expect(r.nod.map((n) => n.id)).toEqual(["eyes"]);
    const { m30, zero, p30 } = r.nod[0].range;
    expect(m30).toBeCloseTo((2 * S) / 200, 4);
    expect(zero).toBeCloseTo(0, 6);
    expect(p30).toBeCloseTo(0, 6);
    const eyeL = r.corner.find((c) => c.id === "eye_L")!;
    expect(Math.max(...Object.values(eyeL.residual))).toBeCloseTo(0, 6);
    const eyeR = r.corner.find((c) => c.id === "eye_R")!;
    expect(eyeR.residual.mm).toBeCloseTo(S / 200, 4);
    expect(eyeR.residual.mp).toBeCloseTo(S / 200, 4);
    expect(eyeR.residual.pm).toBeCloseTo(0, 6);
    expect(eyeR.residual.pp).toBeCloseTo(0, 6);
  });

  it("(b) the same shift at all three nod stops of the turn is edge-consistent: every line reads 0", () => {
    const r = get(eyes(eyeRWarp([S, 0, 0, S, 0, 0, S, 0, 0])));
    expect(r.nod[0].range.m30).toBeCloseTo(0, 6);
    for (const c of r.corner) {
      expect(Math.max(...Object.values(c.residual))).toBeCloseTo(0, 6);
    }
  });

  it("(c) plain AngleX warps read 0 everywhere and add no iris or mouth entry", () => {
    const r = get(
      model([
        face(0.075),
        eye("eye_L", -50, -0.5, 0.5),
        eye("eye_R", 50, -0.5, 0.5),
      ]),
    );
    expect(r.nod.map((n) => n.id)).toEqual(["eyes"]);
    expect(r.nod[0].range).toEqual({ m30: 0, zero: 0, p30: 0 });
    expect(r.corner.map((c) => c.id)).toEqual(["eye_L", "eye_R"]);
    for (const c of r.corner) {
      expect(Math.max(...Object.values(c.residual))).toBeCloseTo(0, 6);
    }
  });

  it("(c) an iris pair under the patch reads the same gap range; a mouth that stretches on the nod reads a width range at every turn", () => {
    const irises = get(
      eyes(MINT, [underMint("iris_R", 50, 20), part("iris_L", -50, 20, 20)]),
    );
    expect(irises.nod.map((n) => n.id)).toEqual(["eyes", "irises"]);
    expect(irises.nod[1].range.m30).toBeCloseTo(irises.nod[0].range.m30, 6);

    const withMouth = get(
      eyes(MINT, [
        part(
          "mouth",
          0,
          -50,
          40,
          [
            { value: -30, offsets: stretch(0.5) },
            { value: 0, offsets: NONE },
            { value: 30, offsets: NONE },
          ],
          "ParamAngleY",
        ),
      ]),
    );
    const mouth = withMouth.nod.find((n) => n.id === "mouth")!;
    for (const w of Object.values(mouth.range)) {
      expect(w).toBeCloseTo(20 / 200, 4);
    }
  });

  it("(d) names the face, then the eye pair, when missing", () => {
    const noFace = checkNod(
      model([part("eye_L", -50, 20, 60), part("eye_R", 50, 20, 60)]),
    );
    expect("unavailable" in noFace && noFace.unavailable).toMatch(/face/);
    const noEyes = checkNod(model([face(0.075), part("eye_L", -50, 20, 60)]));
    expect("unavailable" in noEyes && noEyes.unavailable).toMatch(
      /eye_L and eye_R/,
    );
  });

  it("(e) formats a line per quantity and per landmark, or the unavailable line", () => {
    const lines = formatNodReport(get(eyes(MINT, [part("mouth", 0, -50, 40)])));
    expect(lines[0]).toBe(
      "SWEEP nod eyes: gap range X -30 0.060 / 0 0.000 / +30 0.000 fw",
    );
    expect(lines[1]).toBe(
      "SWEEP nod mouth: width range X -30 0.000 / 0 0.000 / +30 0.000 fw",
    );
    expect(lines[3]).toBe(
      "SWEEP corner eye_R: residual (-30,-30) 0.030 / (-30,+30) 0.030 / (+30,-30) 0.000 / (+30,+30) 0.000 fw",
    );
    expect(formatNodReport({ unavailable: "no face part" })).toEqual([
      "SWEEP nod: unavailable — no face part",
    ]);
  });
});
