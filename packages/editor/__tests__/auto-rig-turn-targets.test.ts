import { describe, expect, it } from "vitest";
import { StandardParameter as P, type IkiModel } from "@ikijs/format";
import {
  RigPlanError,
  TurnTargetError,
  generateIkiFromLayerSet,
  type IrisStrand,
  type LayerInput,
  type TurnSolveReport,
  type TurnTargets,
} from "@ikijs/editor";
import { CANVAS, character } from "./helpers/character";
import {
  landedXAt,
  landedCentroidX,
  rig,
  renderedCues,
  X30,
} from "./helpers/head-rig";

const hero = rig();

describe("turn targets", () => {
  it("names a target that is not a finite number", () => {
    expect(() => rig({}, { farEyeRatio: Number.NaN })).toThrow(TurnTargetError);
    expect(() => rig({}, { farEyeRatio: Number.NaN })).toThrow(
      /turnTargets\.farEyeRatio/,
    );
  });

  it("fits a caller's eye shift by the turn's amount", () => {
    const base = hero.report!.achieved.eyeShift;
    for (const eyeShift of [0.5 * base, 0.8 * base]) {
      const { report } = rig({}, { eyeShift });
      expect(report!.clamped).toEqual([]);
      expect(report!.achieved.eyeShift).toBeCloseTo(eyeShift, 3);
    }
  });

  it("takes a signed shift as its magnitude, the sign measure_turn_reference gives it", () => {
    const e = 0.8 * hero.report!.achieved.eyeShift;
    const plus = rig({}, { eyeShift: e });
    const minus = rig({}, { eyeShift: -e });
    expect(minus.model).toEqual(plus.model);
    expect(minus.report!.achieved.eyeShift).toBeCloseTo(e, 3);
    expect(rig({}, { noseShift: -0.3 }).model).toEqual(
      rig({}, { noseShift: 0.3 }).model,
    );
    expect(() => rig({}, { eyeShift: -1.2 })).toThrow(
      /turnTargets\.eyeShift -1\.2 is outside \[-1, 1\]/,
    );
  });

  it("leaves rigPlan.turn.amount out when a caller's eye shift fits the turn", () => {
    const e = 0.8 * hero.report!.achieved.eyeShift;
    const { layers, options } = character();
    const styled = generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      turnTargets: { ...options.turnTargets, eyeShift: e },
      rigPlan: { turn: { amount: 0.5 } },
    });
    expect(styled).toEqual(rig({}, { eyeShift: e }).model);
  });

  it("clamps an eye shift past the art's room: the far iris stays off the strand", () => {
    const { report } = rig({}, { eyeShift: 0.9 });
    expect(report!.clamped).toContain("eyeShift");
    expect(report!.achieved.eyeShift).toBeLessThan(0.9);
    for (const side of ["left", "right"] as const) {
      expect(report!.strandOverlap?.[side]?.held ?? true).toBe(true);
    }
    // Where the strand gives way (a fringe over the eyes), the chin still
    // stays over the neck it slides across (the neck's half-width: 96).
    const { model, report: r } = rig({ fringe: true }, { eyeShift: 0.9 });
    expect(r!.clamped).toContain("eyeShift");
    expect(
      Math.abs(landedXAt(model, "face", 0.5, -190, X30(30)) - 0.5),
    ).toBeLessThanOrEqual(96.5);
  });

  it("refuses a far-eye ratio no surface renders", () => {
    expect(() => rig({}, { farEyeRatio: 1.4 })).toThrow(
      /turnTargets\.farEyeRatio.*attainable/,
    );
  });

  it("holds the silhouette of a head with no hair when asked to", () => {
    const { report } = rig({ hair: false }, { silhouetteRatio: 1 });
    expect(report!.achieved.silhouetteRatio).toBeCloseTo(1, 3);
  });

  it("fits a caller's silhouette ratio, and refuses one past the shell's reach", () => {
    const { model, report } = rig({}, { silhouetteRatio: 1.05 });
    expect(report!.achieved.silhouetteRatio).toBeCloseTo(1.05, 2);
    expect(renderedCues(model, -30).silhouetteRatio).toBeCloseTo(1.05, 2);
    expect(() => rig({}, { silhouetteRatio: 1.45 })).toThrow(
      /turnTargets\.silhouetteRatio.*attainable/,
    );
  });

  it("fits a caller's nose and mouth shifts, and refuses ones out of reach", () => {
    const { model } = rig({}, { noseShift: 0.3 });
    const nose =
      landedXAt(model, "nose", -0.5, -43.5, { [P.AngleX]: 30 }) - -0.5;
    expect(nose / 262).toBeCloseTo(0.3, 2);
    expect(() => rig({}, { mouthShift: 0.02 })).toThrow(
      /turnTargets\.mouthShift.*unreachable/,
    );
  });

  it("refuses a head half-width no wider than the face plate", () => {
    const { layers } = character({ hair: false });
    expect(() =>
      generateIkiFromLayerSet(layers, CANVAS, {
        turnTargets: { headHalfWidth: 150 },
      }),
    ).toThrow(/turnTargets\.headHalfWidth/);
  });

  it("solves no turn without a nose, and leaves the targets inert", () => {
    const { layers, options } = character({ nose: false });
    let called = false;
    const model = generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      turnTargets: { ...options.turnTargets, eyeShift: Number.NaN },
      onTurnSolved: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
    // The face still turns, on the profile.
    expect(landedCentroidX(model, "mouth", { [P.AngleX]: 30 })).toBeGreaterThan(
      landedCentroidX(model, "mouth"),
    );
  });

  it("builds a nose-less rig the same with or without the measured turn options", () => {
    const { layers, options } = character({ nose: false });
    expect(generateIkiFromLayerSet(layers, CANVAS, options)).toEqual(
      generateIkiFromLayerSet(layers, CANVAS),
    );
  });

  it("tunes a character from the profile with its rig plan", () => {
    const { layers, options } = character();
    const m = generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      rigPlan: {
        turn: { amount: 0.5 },
        hair: { follow: 1, sway: 2 },
        eyes: { blink: 0.4 },
      },
    });
    const shift = (model: IkiModel, id: string, x: number, y: number) =>
      landedXAt(model, id, x, y, X30(30)) - x;
    expect(
      shift(m, "face", 0.5, 20) / shift(hero.model, "face", 0.5, 20),
    ).toBeCloseTo(0.5, 2);
    expect(shift(m, "hair_front", 0, 250)).toBeCloseTo(
      shift(m, "face", 0, 250),
      0,
    );
    const hairEnd = (model: IkiModel) =>
      landedXAt(model, "hair_back", 0, -470, { [P.HairBackSway]: 20 });
    expect(hairEnd(m) / hairEnd(hero.model)).toBeCloseTo(2, 1);
    expect(() =>
      generateIkiFromLayerSet(layers, CANVAS, {
        rigPlan: { turn: { amount: -1 } },
      }),
    ).toThrow(/rigPlan\.turn\.amount -1 is outside/);
    // No turn, no foreshortening.
    let still: TurnSolveReport | undefined;
    generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      rigPlan: { turn: { amount: 0 } },
      onTurnSolved: (r) => {
        still = r;
      },
    });
    expect(still!.achieved.farEyeRatio).toBeCloseTo(1, 3);
  });

  it("refuses a malformed layer or turn option", () => {
    const { layers, options } = character();
    const face = layers.find((l) => l.role === "face")!;
    const short = layers.map((l) =>
      l === face ? { ...l, rowHalfWidths: face.rowHalfWidths!.slice(1) } : l,
    );
    expect(() => generateIkiFromLayerSet(short, CANVAS, options)).toThrow(
      /rowHalfWidths/,
    );
    const jaw = layers.map((l) => (l === face ? { ...l, jawRows: [5, 6] } : l));
    expect(() => generateIkiFromLayerSet(jaw, CANVAS, options)).toThrow(
      /jawRows/,
    );
    // hair_back's crop spans columns 110..890 over 980 rows.
    const withRuns = (rowRuns: number[][]) => () =>
      generateIkiFromLayerSet(
        layers.map((l) => (l.role === "hair_back" ? { ...l, rowRuns } : l)),
        CANVAS,
        options,
      );
    const runs = (row: number[]) => Array.from({ length: 980 }, () => row);
    expect(withRuns(runs([110, 400, 600, 890]))).not.toThrow();
    expect(withRuns(runs([200, 300]).slice(1))).toThrow(
      /"hair_back\.png": rowRuns must have one entry per crop row \(980\)/,
    );
    expect(withRuns(runs([200, 300, 400]))).toThrow(
      /"hair_back\.png": rowRuns\[0\] \[200,300,400\] is not/,
    );
    expect(withRuns(runs([200, 300, 300, 400]))).toThrow(
      /"hair_back\.png": rowRuns\[0\] \[200,300,300,400\] is not/,
    );
    expect(withRuns(runs([100, 300]))).toThrow(
      /"hair_back\.png": rowRuns\[0\] \[100,300\] is not/,
    );
    expect(withRuns(runs([200, 891]))).toThrow(
      /"hair_back\.png": rowRuns\[0\] \[200,891\] is not/,
    );
    const swapped = {
      left: options.headEdges!.right,
      right: options.headEdges!.left,
    };
    expect(() =>
      generateIkiFromLayerSet(layers, CANVAS, {
        ...options,
        headEdges: swapped,
      }),
    ).toThrow(TurnTargetError);
    expect(() =>
      generateIkiFromLayerSet(layers, CANVAS, {
        ...options,
        strandEdges: { left: null as never },
      }),
    ).toThrow(TurnTargetError);
    const bald = character({ hair: false }).layers;
    expect(() =>
      generateIkiFromLayerSet(bald, CANVAS, {
        strandEdges: options.strandEdges,
      }),
    ).toThrow(/hair_front/);
  });

  it("validates the strand edges it is given", () => {
    const { layers, options } = character();
    const withLeft = (edit: Partial<IrisStrand>) => () =>
      generateIkiFromLayerSet(layers, CANVAS, {
        ...options,
        strandEdges: { left: { ...options.strandEdges!.left!, ...edit } },
      });
    expect(withLeft({ irisOuter: -50 })).toThrow(TurnTargetError);
    // An iris span of no width would divide the far-eye ratio by zero.
    expect(withLeft({ irisOuter: -100, irisInner: -100 })).toThrow(
      /strandEdges\.left\.irisOuter -100 is not strictly outward/,
    );
    // A run reaching the other iris's centre (x 106) is a fringe: null.
    expect(withLeft({ runFace: 110 })).toThrow(/strandEdges\.left\.runFace/);
    expect(withLeft({ y: 200 })).toThrow(/strandEdges\.left\.y/);
    // The span on the iris's row need not straddle its crop's centre (−105).
    expect(withLeft({ irisOuter: -140, irisInner: -110 })).not.toThrow();
  });

  it("refuses a rigPlan or turnTargets that is not a plain object, or names a field it has not", () => {
    const { layers, options } = character();
    const withOptions = (o: object) => () =>
      generateIkiFromLayerSet(layers, CANVAS, { ...options, ...o });
    expect(withOptions({ rigPlan: { turn: { amuont: 2 } } })).toThrow(
      /rigPlan\.turn\.amuont is not one of amount, featureLead/,
    );
    expect(withOptions({ rigPlan: "abc" })).toThrow(
      /rigPlan must be a plain object/,
    );
    expect(withOptions({ style: { turn: 1 } })).toThrow(
      /options\.style was removed.*rigPlan\.turn\.amount/,
    );
    expect(withOptions({ style: { turn: 1 } })).toThrow(RigPlanError);
    expect(
      withOptions({ turnTargets: { ...options.turnTargets, eyeshift: 0.1 } }),
    ).toThrow(/turnTargets\.eyeshift is not one of eyeShift/);
    expect(withOptions({ turnTargets: [0.2] })).toThrow(TurnTargetError);
  });

  it("names a misspelt turnTargets field on a set without a nose too, where the targets are inert", () => {
    const { layers, options } = character({ nose: false });
    expect(() =>
      generateIkiFromLayerSet(layers, CANVAS, {
        ...options,
        turnTargets: { ...options.turnTargets, eyeshift: 0.1 } as TurnTargets,
      }),
    ).toThrow(/turnTargets\.eyeshift is not one of eyeShift/);
  });

  it("refuses a layer measured off another canvas, off it, or cropped off its bbox", () => {
    const { layers, options } = character();
    const role = (r: string) => layers.find((l) => l.role === r)!;
    const edited = (r: string, edit: Partial<LayerInput>) => () =>
      generateIkiFromLayerSet(
        layers.map((l) => (l.role === r ? { ...l, ...edit } : l)),
        CANVAS,
        options,
      );
    expect(edited("face", { bbox: { ...role("face").bbox, x: 700 } })).toThrow(
      /layer "face\.png" has a bbox outside its 1000x1000 canvas/,
    );
    expect(edited("face", { canvasW: 800 })).toThrow(
      /"face\.png" was measured on a 800x1000 canvas/,
    );
    expect(edited("face", { cropW: 400 })).toThrow(
      /"face\.png": crop 400x560 is not its bbox 401x560/,
    );
    expect(edited("nose", { denseCore: { x: 0, y: 0, w: 10, h: 10 } })).toThrow(
      /"nose\.png": denseCore is not a box inside its crop/,
    );
    const gen = (ls: LayerInput[]) => () =>
      generateIkiFromLayerSet(ls, CANVAS, options);
    expect(gen([...layers, { ...role("face") }])).toThrow(
      /role "face" appears twice/,
    );
    expect(
      gen([...layers, { ...role("nose"), role: "tail", fileName: "tail.png" }]),
    ).toThrow(/unknown role "tail"/);
  });

  it("refuses a face too small to mesh, naming it", () => {
    const at = (role: string, x: number, y: number, w: number, h: number) => ({
      role,
      fileName: `${role}.png`,
      canvasW: CANVAS.width,
      canvasH: CANVAS.height,
      bbox: { x, y, w, h },
      cropW: w,
      cropH: h,
    });
    const set = (w: number) => [
      at("face", 488, 488, w, 24),
      at("eye_R", 492, 494, 4, 3),
      at("eye_L", 500, 494, 4, 3),
      at("mouth", 496, 504, 4, 2),
    ];
    expect(() => generateIkiFromLayerSet(set(16), CANVAS)).toThrow(
      /"face\.png": the face is 16x24 px; the face plate needs at least 24 px/,
    );
    expect(() => generateIkiFromLayerSet(set(24), CANVAS)).not.toThrow();
  });
});
