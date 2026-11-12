import { describe, expect, it } from "vitest";
import { StandardParameter as P } from "@ikijs/format";
import {
  DEFAULT_TURN_TARGETS,
  generateIkiFromLayerSet,
  type TurnSolveReport,
} from "@ikijs/editor";
import { BODY, NOD, ROLL_DEG, TURN } from "../src/auto-rig/profile";
import { CANVAS, character } from "./helpers/character";
import { type ParamValues } from "./helpers/render-oracle";
import {
  landVertices,
  landedXAt,
  landedYAt,
  landedCentroidX,
  rig,
  EYE_Y,
  renderedCues,
  signedAreas,
  HH,
  X30,
} from "./helpers/head-rig";
import * as oracle from "./helpers/render-oracle";

const hero = rig();
const fullBack = rig({ fullBack: true });
const tuft = rig({ tuft: true });
const wideBack = rig({ wideBack: true });
const crownGap = rig({ crownGap: true });
const faceGap = rig({ faceGap: true });
const besideFaceGap = rig({ besideFaceGap: true });
const narrowCap = rig({ narrowCap: true });
const tightLock = rig({ tightLock: true });

describe("the head turn", () => {
  const { model, report } = hero;

  it("renders the profile by default and reports what renders", () => {
    expect(report).toBeDefined();
    expect(report!.clamped).toEqual([]);
    expect(report!.holdBase).toBe(262);
    // The far eye narrows to TURN.eyeFarScale and the near one widens to
    // TURN.eyeNearScale.
    expect(report!.achieved.farEyeRatio).toBeCloseTo(
      DEFAULT_TURN_TARGETS.farEyeRatio,
      2,
    );
    for (const ax of [-30, 30]) {
      const cues = renderedCues(model, ax);
      expect(Math.sign(cues.eyeShift)).toBe(Math.sign(ax));
      expect(Math.abs(cues.eyeShift)).toBeCloseTo(report!.achieved.eyeShift, 2);
      expect(cues.farEyeRatio).toBeCloseTo(report!.achieved.farEyeRatio, 2);
      expect(cues.silhouetteRatio).toBeCloseTo(
        report!.achieved.silhouetteRatio,
        2,
      );
    }
  });

  it("translates the plate rather than reshaping it, the chin leading", () => {
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      const at = (x: number, y: number) =>
        landedXAt(model, "face", x, y, X30(ax)) - x;
      // The cheek edges on the widest row move together, TURN.face, and the
      // plate keeps its width (TURN.widthUpper) ...
      const [l, r] = [at(-195, 20), at(195, 20)];
      expect((s * (l + r)) / 2 / HH).toBeCloseTo(TURN.face, 2);
      expect(1 + (r - l) / 390).toBeCloseTo(TURN.widthUpper, 2);
      // ... down the jaw too (TURN.widthJaw).
      const [jl, jr] = [at(-85, -130), at(85, -130)];
      expect(1 + (jr - jl) / 170).toBeCloseTo(TURN.widthJaw, 2);
      // The chin tip leads the plate by TURN.chinLead.
      expect((s * at(0.5, -190)) / HH).toBeCloseTo(
        TURN.face + TURN.chinLead,
        2,
      );
    }
  });

  it("keeps the neck's outline and base on the torso while the chin, and its shade, slide over it", () => {
    const face = model.parts.find((p) => p.id === "face")!;
    const rest = landVertices(model, "face");
    // The neck's outline (its half-width is 78 below the jaw) and its base.
    const still: number[] = [];
    for (let i = 0; i < rest.length / 2; i++) {
      const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
      if (y < -205 && (Math.abs(x - 0.5) >= 78 || y < -255)) still.push(i);
    }
    expect(still.length).toBeGreaterThan(6);
    // On the head's turn and nod it holds where it is, relative to the head.
    for (const pose of [
      X30(-30),
      X30(30),
      { [P.AngleY]: -30 },
      { [P.AngleY]: 30 },
    ]) {
      const v = landVertices(model, "face", pose);
      for (const i of still) {
        expect(v[i * 2], JSON.stringify(pose)).toBeCloseTo(rest[i * 2], 0);
        expect(v[i * 2 + 1], JSON.stringify(pose)).toBeCloseTo(
          rest[i * 2 + 1],
          0,
        );
      }
    }
    // On a roll it undoes the head's own roll and rides the torso, which
    // follows the tilt about the hips: it lands where the body warp puts it.
    // With the turn too, the torso narrows on the turn's follow (x moves by
    // −narrow·followX·(x − the body's centre)) while the head, and the neck
    // with it, rides the chin's cell rigidly, moving every x as the chin's:
    // the neck lands narrow·followX·(x − the chin's x) further out than the
    // torso under it, sideways only.
    const chinX = (
      model.deformers!.find((d) => d.id === "headDeformer") as {
        pivot: { x: number };
      }
    ).pivot.x;
    for (const [pose, narrows] of [
      [{ [P.AngleZ]: -30 }, false],
      [{ [P.AngleZ]: 30 }, false],
      [{ [P.AngleX]: 30, [P.AngleY]: -30, [P.AngleZ]: 30 }, true],
    ] as const) {
      const v = oracle.landVertices(model, "face", pose);
      for (const i of still) {
        const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
        const torso = oracle.warpPointAt(model, "bodyWarp", x, y, pose);
        const gap = narrows ? BODY.narrow * BODY.followX * (x - chinX) : 0;
        const label = `${JSON.stringify(pose)} vertex ${i}`;
        expect(Math.abs(v[i * 2] - torso.x - gap), label).toBeLessThan(0.1);
        expect(Math.abs(v[i * 2 + 1] - torso.y), label).toBeLessThan(0.1);
      }
    }
    // Under the chin the shade slides with it, most of the way.
    for (const ax of [-30, 30]) {
      const chin = landedXAt(model, "face", 0.5, -190, X30(ax)) - 0.5;
      const shade = landedXAt(model, "face", 0.5, -205, X30(ax)) - 0.5;
      expect(Math.sign(shade)).toBe(Math.sign(ax));
      expect(shade / chin).toBeGreaterThan(0.5);
      expect(shade / chin).toBeLessThan(1);
    }
    // The neck is drawn first, so the head slides over it.
    const turned = landVertices(model, "face", X30(30));
    for (const i of face.mesh!.indices.slice(0, 3)) {
      expect(Math.abs(turned[i * 2] - rest[i * 2])).toBeLessThan(40);
    }
    const last = face.mesh!.indices.slice(-3);
    expect(last.some((i) => Math.abs(turned[i * 2] - rest[i * 2]) > 10)).toBe(
      true,
    );
  });

  it("leads the plate with the features, by the profile's parallax", () => {
    const shift = (id: string, ax: number) =>
      (Math.sign(ax) *
        (landedCentroidX(model, id, X30(ax)) - landedCentroidX(model, id))) /
      HH;
    for (const ax of [-30, 30]) {
      const [far, near] = ax < 0 ? ["eye_R", "eye_L"] : ["eye_L", "eye_R"];
      expect(shift(far, ax)).toBeCloseTo(TURN.eyeFar, 2);
      expect(shift(near, ax)).toBeCloseTo(TURN.eyeNear, 2);
      const [bf, bn] = ax < 0 ? ["brow_R", "brow_L"] : ["brow_L", "brow_R"];
      expect(shift(bf, ax)).toBeCloseTo(TURN.browFar, 2);
      expect(shift(bn, ax)).toBeCloseTo(TURN.browNear, 2);
      expect(shift("mouth", ax)).toBeCloseTo(TURN.mouth, 1);
      expect(shift("nose", ax)).toBeGreaterThan(TURN.nose - 0.02);
    }
    expect(report!.depths.eye).toBeLessThan(report!.depths.nose);
    expect(report!.depths.mouth).toBeLessThan(report!.depths.nose);
  });

  it("foreshortens the eyes mildly, about their own centres", () => {
    const width = (id: string, x0: number, x1: number, ax: number) =>
      (landedXAt(model, id, x1, EYE_Y, X30(ax)) -
        landedXAt(model, id, x0, EYE_Y, X30(ax))) /
      (x1 - x0);
    // eye_R rests at x −170…−40, eye_L at 41…171.
    expect(width("eye_R", -160, -50, -30)).toBeCloseTo(TURN.eyeFarScale, 2);
    expect(width("eye_L", 51, 161, -30)).toBeCloseTo(TURN.eyeNearScale, 2);
    expect(width("eye_L", 51, 161, 30)).toBeCloseTo(TURN.eyeFarScale, 2);
  });

  it("keeps the mouth's width and holds it level", () => {
    const at = (x: number, ax: number) => ({
      x: landedXAt(model, "mouth", x, -100.5, X30(ax)),
      y: landedYAt(model, "mouth", x, -100.5, X30(ax)),
    });
    for (const ax of [-30, 30]) {
      const a = at(-30, ax);
      const b = at(30, ax);
      expect(Math.hypot(b.x - a.x, b.y - a.y) / 60).toBeCloseTo(
        TURN.mouthWidth,
        2,
      );
      const tilt = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      // Turning toward +x the far corner is +x's: it rises (CCW) by
      // TURN.mouthTiltDeg, which holds the mouth level.
      expect(tilt * Math.sign(ax)).toBeCloseTo(TURN.mouthTiltDeg, 0);
    }
  });

  it("leads the turn with the nose, tilting its tip to the far side", () => {
    // The dense core's top centre and its tip, model space.
    const top = { x: -0.5, y: -12 };
    const tip = { x: -0.5, y: -75 };
    for (const ax of [-30, 30]) {
      const p = X30(ax);
      const dx =
        landedXAt(model, "nose", tip.x, tip.y, p) -
        landedXAt(model, "nose", top.x, top.y, p);
      const dy =
        landedYAt(model, "nose", tip.x, tip.y, p) -
        landedYAt(model, "nose", top.x, top.y, p);
      const tilt = (Math.atan2(dx, -dy) * 180) / Math.PI;
      expect(tilt * Math.sign(ax)).toBeCloseTo(6, 0);
    }
  });

  it("rides the front hair on the face, holds the outline it draws, and keeps the back hair behind", () => {
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      const p = X30(ax);
      const shift = (x: number, y: number) =>
        (s * (landedXAt(model, "hair_front", x, y, p) - x)) / HH;
      // Over the face — the fringe, and a lock beside the jaw — it rides
      // TURN.hairFollow × the plate's TURN.face.
      expect(shift(0, 250)).toBeCloseTo(TURN.hairFollow * TURN.face, 2);
      expect(shift(-150, -300)).toBeCloseTo(TURN.hairFollow * TURN.face, 2);
      // The outline it draws at the eye row holds.
      expect(Math.abs(shift(-261, EYE_Y))).toBeLessThan(0.005);
      expect(Math.abs(shift(260, EYE_Y))).toBeLessThan(0.005);
      // The crown rides with the cap.
      expect(shift(0, 490)).toBeCloseTo(TURN.hairFollow * TURN.face, 2);
      const rest = landVertices(model, "hair_back");
      const turned = landVertices(model, "hair_back", p);
      for (let i = 0; i < rest.length; i += 2) {
        expect((s * (turned[i] - rest[i])) / HH).toBeCloseTo(TURN.hairBack, 3);
        expect(turned[i + 1]).toBeCloseTo(rest[i + 1], 3);
      }
    }
  });

  it("keeps the lock over the far eye's corner as far over it as it is drawn", () => {
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      // The far eye's outer corner, at the eye row.
      const corner = s < 0 ? -170 : 171;
      const eye = s < 0 ? "eye_R" : "eye_L";
      const eyeMoved = landedXAt(model, eye, corner, 67, X30(ax)) - corner;
      const hairMoved =
        landedXAt(model, "hair_front", corner, 67, X30(ax)) - corner;
      expect(s * hairMoved).toBeGreaterThanOrEqual(s * eyeMoved - 0.5);
    }
  });

  it("nods by the profile: the forehead drops further than the chin", () => {
    const down = { [P.AngleY]: -30 };
    const up = { [P.AngleY]: 30 };
    const dy = (id: string, x: number, y: number, pose: ParamValues) =>
      (landedYAt(model, id, x, y, pose) - y) / HH;
    // Screen-down is −y here.
    expect(dy("face", 0, 290, down)).toBeCloseTo(-NOD.faceTop.down, 1);
    expect(dy("face", 0.5, -190, down)).toBeCloseTo(-NOD.chin.down, 2);
    expect(dy("face", 0.5, -190, up)).toBeCloseTo(-NOD.chin.up, 2);
    expect(dy("iris_L", 106, EYE_Y, down)).toBeCloseTo(-NOD.eye.down, 2);
  });

  it("rolls the head by the profile's roll about the chin", () => {
    for (const z of [-30, 30]) {
      const pose = { [P.AngleZ]: z };
      const l = {
        x: landedXAt(model, "iris_R", -105, EYE_Y, pose),
        y: landedYAt(model, "iris_R", -105, EYE_Y, pose),
      };
      const r = {
        x: landedXAt(model, "iris_L", 106, EYE_Y, pose),
        y: landedYAt(model, "iris_L", 106, EYE_Y, pose),
      };
      const roll = (Math.atan2(r.y - l.y, r.x - l.x) * 180) / Math.PI;
      // AngleZ is clockwise-positive; ±30 rolls the head ROLL_DEG.
      expect(roll).toBeCloseTo((-z / 30) * ROLL_DEG, 1);
      // The chin is the pivot.
      expect(landedXAt(model, "face", 0.5, -192, pose)).toBeCloseTo(0.5, 0);
    }
  });

  it("reports what renders when the face plate is the silhouette", () => {
    const { model, report } = rig({ hair: false });
    // The plate's painted half-width on the eye row (see helpers/character).
    const w = 110 + 88 * Math.sin((233 / 560 / 0.5) * (Math.PI / 2));
    const head = { role: "face", left: 0.5 - w, right: 0.5 + w };
    for (const ax of [-30, 30]) {
      const cues = renderedCues(model, ax, [head]);
      expect(Math.abs(cues.eyeShift)).toBeCloseTo(report!.achieved.eyeShift, 2);
      expect(cues.silhouetteRatio).toBeCloseTo(
        report!.achieved.silhouetteRatio,
        2,
      );
    }
  });

  it("reads the eyes' whole slide against an outline that holds, less against one that rides", () => {
    // Side locks drawing the outline hold it by default, as a fringe short
    // of the outline leaves the back hair to; let them ride and the cue reads
    // the slide against them.
    const { report: short } = rig({ shortFringe: true });
    expect(short!.clamped).toEqual([]);
    expect(short!.achieved.eyeShift).toBeGreaterThan(0.2);
    expect(report!.achieved.eyeShift).toBeGreaterThan(0.18);
    const { layers, options } = character();
    let riding: TurnSolveReport | undefined;
    generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      rigPlan: { hair: { outlineFollow: 1.1 } },
      onTurnSolved: (r) => {
        riding = r;
      },
    });
    expect(riding!.achieved.eyeShift).toBeLessThan(0.15);
  });

  it("keeps the far iris from sliding under the bangs' side strand", () => {
    expect(report!.strandOverlap).toBeUndefined();
    const p = X30(-30);
    const iris = landedXAt(model, "iris_R", -142, EYE_Y, p);
    const strand = landedXAt(model, "hair_front", -153, EYE_Y, p);
    expect(iris).toBeGreaterThan(strand);
  });

  it("reports a fringe spanning the face as covering the irises, not held", () => {
    const { report: r } = rig({ fringe: true });
    for (const side of ["left", "right"] as const) {
      const o = r!.strandOverlap?.[side];
      expect(o?.held, side).toBe(false);
      expect(o!.restPx).toBeCloseTo(74, 0);
      expect(o!.px).toBeGreaterThan(0);
      expect(o!.hh).toBeCloseTo(o!.px / 262, 12);
    }
  });

  it("folds or tears nothing at any pose combination", () => {
    const poses: ParamValues[] = [];
    for (const x of [-30, -22.5, -15, 0, 15, 30])
      for (const y of [-30, 0, 30])
        for (const z of [-30, 0, 30])
          poses.push({ [P.AngleX]: x, [P.AngleY]: y, [P.AngleZ]: z });
    poses.push(
      {
        [P.AngleX]: 30,
        [P.AngleY]: 30,
        [P.AngleZ]: 30,
        [P.HairSwayX]: 20,
        [P.HairSwayZ]: 20,
        [P.HairBackSway]: 20,
      },
      {
        [P.AngleX]: -30,
        [P.AngleY]: -30,
        [P.AngleZ]: -30,
        [P.HairSwayX]: -20,
        [P.HairSwayZ]: -20,
        [P.HairBackSway]: -20,
      },
      {
        [P.AngleX]: -30,
        [P.EyeballX]: -1,
        [P.EyeballY]: 1,
        [P.MouthOpen]: 1,
        [P.MouthForm]: 1,
      },
    );
    // The bangs riding the back hair (fullBack) bend their locks further;
    // their cap's top slides on the nod, the whole way (fullBack) or bound
    // by the columns beside a tuft (tuft); their crown rides the turn whole
    // (wideBack) or holds over a gap's rows (crownGap, faceGap,
    // besideFaceGap); their cap follows less over a back hair reaching
    // little past it (narrowCap); their locks beside the eyes barely backed
    // keep today's motion (tightLock).
    for (const [name, m] of [
      ["default", model],
      ["fullBack", fullBack.model],
      ["tuft", tuft.model],
      ["wideBack", wideBack.model],
      ["crownGap", crownGap.model],
      ["faceGap", faceGap.model],
      ["besideFaceGap", besideFaceGap.model],
      ["narrowCap", narrowCap.model],
      ["tightLock", tightLock.model],
    ] as const) {
      for (const part of m.parts) {
        if (!part.mesh) continue;
        const rest = signedAreas(landVertices(m, part.id), part.mesh.indices);
        for (const pose of poses) {
          const areas = signedAreas(
            landVertices(m, part.id, pose),
            part.mesh.indices,
          );
          areas.forEach((a, i) => {
            // Same winding as at rest; a fold would flip it.
            if (Math.sign(a) !== Math.sign(rest[i])) {
              expect(
                Math.abs(a),
                `${name} ${part.id} ${JSON.stringify(pose)}`,
              ).toBeLessThan(1e-6);
            }
          });
        }
      }
    }
  });
});
