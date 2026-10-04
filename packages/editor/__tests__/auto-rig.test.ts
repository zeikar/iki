import { describe, expect, it } from "vitest";
import {
  StandardParameter as P,
  parseIkiModel,
  type IkiModel,
} from "@ikijs/format";
import {
  DEFAULT_TURN_TARGETS,
  TurnTargetError,
  generateIkiFromLayerSet,
  parseLayerRoles,
  type IrisStrand,
  type LayerInput,
  type TurnSolveReport,
  type TurnTargets,
} from "@ikijs/editor";
import { buildHeadFrame, type HeadFrame } from "../src/auto-rig/head";
import { AMPLITUDE, NOD, ROLL_DEG, TURN } from "../src/auto-rig/profile";
import type { GenerateOptions } from "../src/auto-rig/types";
import { CANVAS, character, type CharacterOptions } from "./helpers/character";
import {
  landVertices,
  landedCentroidX,
  landedXAt,
  landedYAt,
  landerFor,
  type ParamValues,
} from "./helpers/render-oracle";

function rig(
  opts: CharacterOptions = {},
  targets: TurnTargets = {},
  {
    style,
    drop = () => false,
  }: {
    style?: GenerateOptions["style"];
    /** The roles whose `rowRuns` to leave out. */
    drop?: (role: string) => boolean;
  } = {},
): { model: IkiModel; report?: TurnSolveReport } {
  const { layers, options } = character(opts);
  let report: TurnSolveReport | undefined;
  const model = generateIkiFromLayerSet(
    layers.map((l) => (drop(l.role) ? { ...l, rowRuns: undefined } : l)),
    CANVAS,
    {
      ...options,
      style,
      turnTargets: { ...targets, ...options.turnTargets },
      onTurnSolved: (r) => {
        report = r;
      },
    },
  );
  return { model, report };
}

/** Every role's runs left out: the rig without them, today's hold. */
const ALL_RUNS = () => true;

const hero = rig();
const fullBack = rig({ fullBack: true });
const tuft = rig({ tuft: true });
const wideBack = rig({ wideBack: true });
const crownGap = rig({ crownGap: true });
const faceGap = rig({ faceGap: true });
const besideFaceGap = rig({ besideFaceGap: true });
const narrowCap = rig({ narrowCap: true });
const tightLock = rig({ tightLock: true });
const EYE_Y = 500 - 433.5;

/** The three cues `measure_turn_reference` reads, off where the render puts
 *  the iris edges and the head's outline: the outermost of the layers drawing
 *  it at the eye row (by default the bangs' at ±262 and the back hair's at
 *  ±230). */
function renderedCues(
  model: IkiModel,
  ax: number,
  heads: { role: string; left: number; right: number }[] = [
    { role: "hair_front", left: -262, right: 262 },
    { role: "hair_back", left: -230, right: 230 },
  ],
) {
  const p: ParamValues = { [P.AngleX]: ax };
  const iris = (id: string, a: number, b: number) => [
    landedXAt(model, id, a, EYE_Y, p),
    landedXAt(model, id, b, EYE_Y, p),
  ];
  const [l0, l1] = iris("iris_R", -142, -68);
  const [r0, r1] = iris("iris_L", 69, 143);
  const hl = Math.min(
    ...heads.map((h) => landedXAt(model, h.role, h.left, EYE_Y, p)),
  );
  const hr = Math.max(
    ...heads.map((h) => landedXAt(model, h.role, h.right, EYE_Y, p)),
  );
  const head = {
    left: Math.min(...heads.map((h) => h.left)),
    right: Math.max(...heads.map((h) => h.right)),
  };
  const half = (head.right - head.left) / 2;
  const pc = (l0 + l1 + r0 + r1) / 4;
  const pc0 = (-142 - 68 + 69 + 143) / 4;
  const far = ax < 0 ? (l1 - l0) / 74 : (r1 - r0) / 74;
  const near = ax < 0 ? (r1 - r0) / 74 : (l1 - l0) / 74;
  return {
    eyeShift:
      (pc - (hl + hr) / 2 - (pc0 - (head.left + head.right) / 2)) / half,
    farEyeRatio: far / near,
    silhouetteRatio: (hr - hl) / 2 / half,
  };
}

function signedAreas(v: Float32Array, indices: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    out.push(
      (v[b * 2] - v[a * 2]) * (v[c * 2 + 1] - v[a * 2 + 1]) -
        (v[c * 2] - v[a * 2]) * (v[b * 2 + 1] - v[a * 2 + 1]),
    );
  }
  return out;
}

/** Whether (x, y) lies in the triangle t of the landed vertices v. */
function inTriangle(v: Float32Array, t: number[], x: number, y: number) {
  const d = (a: number, b: number) =>
    (v[b * 2] - v[a * 2]) * (y - v[a * 2 + 1]) -
    (x - v[a * 2]) * (v[b * 2 + 1] - v[a * 2 + 1]);
  const s = [d(t[0], t[1]), d(t[1], t[2]), d(t[2], t[0])];
  return s.every((e) => e >= -1e-6) || s.every((e) => e <= 1e-6);
}

function triangles(indices: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < indices.length; i += 3)
    out.push([indices[i], indices[i + 1], indices[i + 2]]);
  return out;
}

/** Whether the face plate draws a point, at rest. */
function plateDraws(model: IkiModel): (x: number, y: number) => boolean {
  const v = landVertices(model, "face");
  const part = model.parts.find((p) => p.id === "face")!;
  const tris = triangles(part.mesh!.indices);
  return (x, y) => tris.some((t) => inTriangle(v, t, x, y));
}

/** Samples of the plate's still triangles at `pose` — the neck's, which the
 *  head slides over — above model y `above` that no moving triangle covers:
 *  a still copy of the plate showing beside the turned head. */
function exposedStill(model: IkiModel, pose: ParamValues, above: number) {
  const rest = landVertices(model, "face");
  const v = landVertices(model, "face", pose);
  const part = model.parts.find((p) => p.id === "face")!;
  const moved = (i: number) =>
    Math.hypot(v[i * 2] - rest[i * 2], v[i * 2 + 1] - rest[i * 2 + 1]) >= 0.5;
  const tris = triangles(part.mesh!.indices);
  const moving = tris.filter((t) => t.some(moved));
  const S = 6;
  let n = 0;
  for (const t of tris.filter((t) => !t.some(moved))) {
    for (let i = 0; i <= S; i++) {
      for (let j = 0; i + j <= S; j++) {
        const w = [i / S, j / S, (S - i - j) / S];
        const x = w.reduce((s, wk, k) => s + wk * v[t[k] * 2], 0);
        const y = w.reduce((s, wk, k) => s + wk * v[t[k] * 2 + 1], 0);
        if (y > above && !moving.some((m) => inTriangle(v, m, x, y))) n++;
      }
    }
  }
  return n;
}

describe("parseLayerRoles", () => {
  const base = ["face.png", "eye_L.png", "eye_R.png", "mouth.png"];

  it("names each layer's role by its file name, with or without an extension", () => {
    expect(
      parseLayerRoles(["face.png", "eye_L.PNG", "eye_R", "mouth.png"]),
    ).toEqual([
      { role: "face", fileName: "face.png" },
      { role: "eye_L", fileName: "eye_L.PNG" },
      { role: "eye_R", fileName: "eye_R" },
      { role: "mouth", fileName: "mouth.png" },
    ]);
  });

  it("normalises case and separators: Eye-L.png is eye_L, Brow_R.png brow_R", () => {
    const roles = parseLayerRoles([
      "Face.png",
      "Eye-L.png",
      "EYE R.png",
      "mouth.png",
      "Brow_R.png",
      "Hair-Front.png",
    ]).map((p) => p.role);
    expect(roles).toEqual([
      "face",
      "eye_L",
      "eye_R",
      "mouth",
      "brow_R",
      "hair_front",
    ]);
  });

  for (const [fileName, role] of [
    ["eyebrow_L.png", "brow_L"],
    ["eyebrow_R.png", "brow_R"],
    ["eye_white_L.png", "eye_L"],
    ["eye_white_R.png", "eye_R"],
  ]) {
    it(`reads the alias ${fileName} as ${role}`, () => {
      const files = [...base.filter((f) => f !== `${role}.png`), fileName];
      expect(
        parseLayerRoles(files).find((p) => p.fileName === fileName)?.role,
      ).toBe(role);
    });
  }

  it("refuses an unknown role, a role named twice, and a missing required role", () => {
    expect(() => parseLayerRoles([...base, "banana.png"])).toThrow(/banana/);
    expect(() => parseLayerRoles([...base, "Face.png"])).toThrow(/twice/);
    expect(() => parseLayerRoles(base.slice(1))).toThrow(/face/);
  });
});

describe("generateIkiFromLayerSet: the model", () => {
  const { model } = hero;

  it("is a valid .iki whose parts are the roles, back to front", () => {
    expect(() => parseIkiModel(model)).not.toThrow();
    expect(model.parts.map((p) => p.id)).toEqual([
      "hair_back",
      "body",
      "face",
      "nose",
      "mouth",
      "mouth_open",
      "eye_L",
      "eye_R",
      "iris_L",
      "iris_R",
      "lash_L",
      "lash_R",
      "brow_L",
      "brow_R",
      "hair_front",
    ]);
    model.parts.forEach((p, i) => expect(p.order).toBe(i));
    expect(model.parts.find((p) => p.id === "iris_L")!.clip).toEqual({
      masks: ["eye_L"],
    });
  });

  it("rests exactly on the art", () => {
    const { layers } = character();
    // The open mouth rests invisible, shut along its top lip.
    for (const l of layers.filter((l) => l.role !== "mouth_open")) {
      const v = landVertices(model, l.role);
      const x0 = l.bbox.x - 500;
      const x1 = x0 + l.bbox.w;
      const y1 = 500 - l.bbox.y;
      const y0 = y1 - l.bbox.h;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < v.length; i += 2) {
        minX = Math.min(minX, v[i]);
        maxX = Math.max(maxX, v[i]);
        minY = Math.min(minY, v[i + 1]);
        maxY = Math.max(maxY, v[i + 1]);
      }
      expect([minX, maxX, minY, maxY], l.role).toEqual([
        expect.closeTo(x0, 2),
        expect.closeTo(x1, 2),
        expect.closeTo(y0, 2),
        expect.closeTo(y1, 2),
      ]);
    }
  });

  it("declares the standard parameters it drives, and hair sway physics with bangs", () => {
    const ids = model.parameters.map((p) => p.id);
    for (const id of [
      P.AngleX,
      P.AngleY,
      P.AngleZ,
      P.EyeOpenLeft,
      P.EyeOpenRight,
      P.EyeballX,
      P.EyeballY,
      P.MouthOpen,
      P.MouthForm,
      P.BrowLeftY,
      P.BrowLeftAngle,
      P.BrowRightY,
      P.BrowRightAngle,
      P.Breath,
      P.HairSwayX,
      P.HairSwayZ,
    ]) {
      expect(ids).toContain(id);
    }
    expect(
      model.physics?.map((r) => [r.input.parameter, r.output.parameter]),
    ).toEqual([
      [P.AngleX, P.HairSwayX],
      [P.AngleZ, P.HairSwayZ],
    ]);
    const bald = rig({ hair: false }).model;
    expect(bald.physics).toBeUndefined();
    expect(bald.parameters.map((p) => p.id)).not.toContain(P.HairSwayX);
  });

  it("is deterministic", () => {
    expect(rig().model).toEqual(model);
  });
});

/** The fixture's profile unit: eye row 67 → chin −192.6. */
const HH = 67 + 192.625;
const X30 = (ax: number) => ({ [P.AngleX]: ax });

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

  it("keeps the neck's outline and base still while the chin, and its shade, slide over it", () => {
    const face = model.parts.find((p) => p.id === "face")!;
    const rest = landVertices(model, "face");
    // The neck's outline (its half-width is 78 below the jaw) and its base.
    const still: number[] = [];
    for (let i = 0; i < rest.length / 2; i++) {
      const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
      if (y < -205 && (Math.abs(x - 0.5) >= 78 || y < -255)) still.push(i);
    }
    expect(still.length).toBeGreaterThan(6);
    for (const pose of [
      X30(-30),
      X30(30),
      { [P.AngleY]: -30 },
      { [P.AngleY]: 30 },
      { [P.AngleZ]: -30 },
      { [P.AngleZ]: 30 },
      { [P.AngleX]: 30, [P.AngleY]: -30, [P.AngleZ]: 30 },
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
      // The crown eases to the back hair's slight counter-motion.
      expect(shift(0, 490)).toBeCloseTo(TURN.hairBack, 2);
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

  describe("with back hair painted behind the bangs' outer edge", () => {
    const { model: full } = fullBack;
    /** The same set without its runs: today's hold. */
    const today = rig({ fullBack: true }, {}, { drop: ALL_RUNS }).model;
    /** Model y of canvas row k's centre. */
    const rowY = (k: number) => 500 - k - 0.5;
    const DRIFT = -TURN.hairBack * HH;
    /** The face's follow at the edge below the eye band, hh at ±30. */
    const CORE = TURN.hairFollow * TURN.face;
    const edge = (
      m: IkiModel,
      role: string,
      x: number,
      y: number,
      ax: number,
    ) => landedXAt(m, role, x, y, X30(ax));
    /** How far the front hair's rest point moves along the turn, hh. */
    const shift = (m: IkiModel, x: number, y: number, ax: number) =>
      (Math.sign(ax) * (edge(m, "hair_front", x, y, ax) - x)) / HH;
    /** The `character(opts)` layer of a role. */
    const layerOf = (opts: CharacterOptions, role: string) =>
      character(opts).layers.find((l) => l.role === role)!;
    /** Canvas row of the cap's last vertex row: the last of the front hair's
     *  vertex rows that pairs, with the row above it, to form a cell whose
     *  rows both lie at least 1.5 eye heights above the eye row — read off
     *  the eye boxes and the front hair's mesh. */
    const capBottom = (m: IkiModel) => {
      const part = (id: string) => m.parts.find((p) => p.id === id)!;
      const eyes = [part("eye_L"), part("eye_R")];
      const eyeY = (eyes[0].transform.y + eyes[1].transform.y) / 2;
      const eyeH = (eyes[0].height + eyes[1].height) / 2;
      const front = part("hair_front");
      const v = front.mesh!.vertices;
      const ys = [...new Set(v.filter((_, i) => i % 2 === 1))]
        .map((u) => front.transform.y + u * front.height)
        .sort((a, b) => b - a);
      let last = -1;
      for (let r = 1; r < ys.length; r++)
        if (ys[r] >= eyeY + 1.5 * eyeH) last = r;
      return Math.round(500 - ys[last]);
    };
    /**
     * The back hair's rest point under a landed point at `pose`, as a canvas
     * column and row. Above the chin the back hair lands affinely at every
     * turn, nod and roll — its turn and shell terms linear in x, its nod
     * uniform, the roll a rotation about the chin, its hang weight 0, sway at
     * rest — so three of its rest points on the cap's rows fix the map, and
     * its inverse reads any landed point back.
     */
    const backRest = (m: IkiModel, pose: ParamValues) => {
      const rest = [
        [-200, rowY(50)],
        [200, rowY(50)],
        [0, rowY(250)],
      ];
      const land = landerFor(m, "hair_back", pose);
      const [p0, p1, p2] = rest.map(([x, y]) => {
        const p = land(x, y);
        return [p.x, p.y];
      });
      const u = [p1[0] - p0[0], p1[1] - p0[1]];
      const v = [p2[0] - p0[0], p2[1] - p0[1]];
      const det = u[0] * v[1] - v[0] * u[1];
      return (x: number, y: number) => {
        const [dx, dy] = [x - p0[0], y - p0[1]];
        const a = (dx * v[1] - v[0] * dy) / det;
        const b = (u[0] * dy - dx * u[1]) / det;
        const at = (i: 0 | 1) =>
          rest[0][i] +
          a * (rest[1][i] - rest[0][i]) +
          b * (rest[2][i] - rest[0][i]);
        return { col: at(0) + 500, row: Math.floor(500 - at(1)) };
      };
    };
    /** How far the pixel just inside a boundary at canvas column `c` on
     *  `side` would have to move to lie in one of the back hair's runs on
     *  canvas row `row`: 0 where it does; undefined off the back hair's
     *  crop, where there is no back hair to step past. */
    const stepPast = (
      back: LayerInput,
      row: number,
      c: number,
      side: number,
    ) => {
      const runs = back.rowRuns![row - back.bbox.y];
      if (runs === undefined) return undefined;
      const px = side > 0 ? c - 1 : c;
      let step = Infinity;
      for (let i = 0; i < runs.length; i += 2)
        step = Math.min(step, Math.max(0, runs[i] - px, px + 1 - runs[i + 1]));
      return step;
    };
    /** Where on the back hair the front's outermost pixel on canvas row `k`,
     *  its boundary at canvas column `ce`, lands (`front` lands the bangs at
     *  the pose `toBack` reads), and its step past the back hair there. */
    const landedOnBack = (
      back: LayerInput,
      front: ReturnType<typeof landerFor>,
      toBack: ReturnType<typeof backRest>,
      k: number,
      ce: number,
      side: number,
    ) => {
      const p = front(ce - 500, rowY(k));
      const at = toBack(p.x, p.y);
      return { ...at, step: stepPast(back, at.row, at.col, side) };
    };
    /** The back hair's outer end on the canvas row a landed boundary sits
     *  over, less where it lands, on `side`: how far inside it the boundary
     *  lies; undefined off the back hair's crop. */
    const insideRun = (
      back: LayerInput,
      at: { row: number; col: number },
      side: number,
    ) => {
      const runs = back.rowRuns![at.row - back.bbox.y];
      if (runs === undefined) return undefined;
      return side > 0 ? runs[runs.length - 1] - at.col : at.col - runs[0];
    };
    /** Whether the back hair paints canvas columns [c0, c1) on row k. */
    const backPaints = (
      back: LayerInput,
      k: number,
      c0: number,
      c1: number,
    ) => {
      const runs = back.rowRuns![k - back.bbox.y] ?? [];
      for (let i = 0; i < runs.length; i += 2)
        if (runs[i] <= c0 && c1 <= runs[i + 1]) return true;
      return false;
    };
    /** The keyforms round each offset to 1e-4 of its part's width (0.07 px
     *  on the bangs, 0.08 px on the back hair): a landed step may read up to
     *  both past the nod's. */
    const ROUNDING = 0.15;

    it("rides the edge with the face where the back reaches past it and far inside it", () => {
      // Under the eyes, the back solid to ±310 over every row the edge passes
      // over on the nod (42 px down to 23 px up, one mesh row either side):
      // 48 px past the edge less the 3.1 px drift, and far inside it, both
      // more than the face's 31.2 px follow, so both edges may ride it whole.
      // The mesh carries the ride's kink at the edge between two columns, so
      // the edge lands a little short of it (today's hold is 0.041 hh).
      const y = rowY(530);
      for (const ax of [-30, 30]) {
        const s = Math.sign(ax);
        for (const x of [-262, 262]) {
          const ride = (s * (edge(full, "hair_front", x, y, ax) - x)) / HH;
          expect(ride, `x ${x}, AngleX ${ax}`).toBeLessThanOrEqual(CORE + 1e-3);
          expect(ride, `x ${x}, AngleX ${ax}`).toBeGreaterThan(0.9 * CORE);
        }
      }
    });

    it("holds the edge as today where the back hair is not behind it", () => {
      const rows = {
        // The back's outer end 5 px inside the bangs' edge.
        temple: rowY(270),
        // A sliver outside the edge, nothing until 8 px inside it.
        gap: rowY(680),
      };
      for (const [name, y] of Object.entries(rows)) {
        for (const ax of [-30, -15, 15, 30]) {
          for (const x of [-262, 262]) {
            expect(
              edge(full, "hair_front", x, y, ax),
              `${name}, x ${x}, AngleX ${ax}`,
            ).toBe(edge(today, "hair_front", x, y, ax));
          }
        }
      }
    });

    it("rides the far edge only over the back's run past it, not out to a stroke beyond a gap", () => {
      // The back solid from inside the edge to 20 px past it (±282), then
      // 30 px empty, then a 4 px stroke, over every row the edge passes over
      // on the nod.
      const y = rowY(830);
      for (const ax of [-30, -22.5, -15, 15, 22.5, 30]) {
        const s = Math.sign(ax);
        const a = Math.abs(ax) / 30;
        const far = edge(full, "hair_front", 262 * s, y, ax);
        const runEnd = edge(full, "hair_back", 282 * s, y, ax);
        // At most the keyforms' rounding (1e-4 of a part's width) past it.
        expect(s * (far - runEnd), `AngleX ${ax}`).toBeLessThan(0.1);
        expect(s * (far - 262 * s), `AngleX ${ax}`).toBeCloseTo(
          a * (20 - DRIFT),
          0,
        );
        // The near edge, over the run's 544 px inside it, rides the face's
        // follow — short of it by the mesh's columns, as above.
        const near =
          (s * (edge(full, "hair_front", -262 * s, y, ax) + 262 * s)) / HH;
        expect(near, `AngleX ${ax}`).toBeLessThanOrEqual(a * CORE + 1e-3);
        expect(near, `AngleX ${ax}`).toBeGreaterThan(0.9 * a * CORE);
      }
    });

    it("keeps the far edge over the back hair when a narrower shell is fitted", () => {
      const { model, report } = rig(
        { fullBack: true },
        { silhouetteRatio: 0.95 },
      );
      expect(report!.achieved.silhouetteRatio).toBeCloseTo(0.95, 2);
      for (const y of [EYE_Y, rowY(560)]) {
        for (const ax of [-30, 30]) {
          const s = Math.sign(ax);
          const back = edge(model, "hair_back", 310 * s, y, ax);
          // The shell is narrower than at rest ...
          expect(s * back).toBeLessThan(310 - DRIFT);
          // ... and the far edge stays inside it.
          expect(
            s * (edge(model, "hair_front", 262 * s, y, ax) - back),
            `y ${y}, AngleX ${ax}`,
          ).toBeLessThan(0);
        }
      }
    });

    /**
     * On every other bangs row from the bangs' top down to the cap's last
     * vertex row (the rows whose centres lie on or above it), on both sides,
     * at each [AngleX, AngleY, AngleZ] pose: the outermost pixel's step past
     * the back hair is at most its step at the nod alone (AngleX 0, the same
     * AngleY and AngleZ), never negative, so how far inside the edge sits
     * does not count; and on the rows `inside` names, the back hair paints
     * every pixel between the edge's own pixel and where it lands. A row
     * whose back hair at rest leaves the edge's own pixel bare is the outline
     * the front draws itself, which the bound leaves alone (fullBack's
     * temple band). Returns the edges checked and the rows' sides.
     */
    const expectCapBound = (
      name: string,
      opts: CharacterOptions,
      m: IkiModel,
      poses: number[][],
      inside: (k: number) => boolean = () => false,
    ) => {
      const front = layerOf(opts, "hair_front");
      const back = layerOf(opts, "hair_back");
      const edges: { k: number; side: number; ce: number }[] = [];
      const bottom = capBottom(m);
      let sides = 0;
      for (let k = front.bbox.y; k + 0.5 <= bottom; k += 2) {
        const runs = front.rowRuns![k - front.bbox.y];
        for (const side of [-1, 1]) {
          sides++;
          const ce = side > 0 ? runs[runs.length - 1] : runs[0];
          if (stepPast(back, k, ce, side) === 0) edges.push({ k, side, ce });
        }
      }
      const nods = new Map<string, number[]>();
      for (const [ax, ay, az] of poses) {
        const nod = { [P.AngleY]: ay, [P.AngleZ]: az };
        let base = nods.get(`${ay} ${az}`);
        if (base === undefined) {
          const toBack = backRest(m, nod);
          const land = landerFor(m, "hair_front", nod);
          base = edges.map(({ k, side, ce }) => {
            const { step } = landedOnBack(back, land, toBack, k, ce, side);
            // The nod alone keeps every edge over the back hair's crop, so
            // no step below is compared with none.
            expect(
              step,
              `${name}, row ${k}, side ${side}, AngleY ${ay}, AngleZ ${az}`,
            ).toBeDefined();
            return step!;
          });
          nods.set(`${ay} ${az}`, base);
        }
        const pose = { [P.AngleX]: ax, ...nod };
        const toBack = backRest(m, pose);
        const land = landerFor(m, "hair_front", pose);
        edges.forEach(({ k, side, ce }, i) => {
          const label = `${name}, row ${k}, side ${side}, AngleX ${ax}, AngleY ${ay}, AngleZ ${az}`;
          const at = landedOnBack(back, land, toBack, k, ce, side);
          expect(at.step ?? Infinity, label).toBeLessThanOrEqual(
            base[i] + ROUNDING,
          );
          if (!inside(k)) return;
          // From the edge's own pixel to where it lands (going out), or
          // across the strip it leaves (coming in), less the rounding.
          const cb = at.col;
          const [c0, c1] =
            side > 0
              ? [Math.min(ce - 1, cb + 0.1), Math.max(ce, cb - 0.1)]
              : [Math.min(ce, cb + 0.1), Math.max(ce + 1, cb - 0.1)];
          expect(
            backPaints(back, at.row, Math.floor(c0), Math.ceil(c1)),
            label,
          ).toBe(true);
        });
      }
      return { edges: edges.length, sides };
    };

    it("keeps every cap edge no further outside the back hair than the nod alone puts it", () => {
      // The bangs nod further than the back hair, so a row's edge lands over
      // the back's rows under it looking down, over it looking up. The crown
      // rides over a back hair backing it to the plate (wideBack), but for
      // its top rows, which rise above the back hair's top looking up; where
      // the rows under the crown pass over the unbacked temple (fullBack),
      // they and the crown above them move with the back hair.
      const poses = [
        [-30, -30],
        [-30, 30],
        [30, -30],
        [30, 30],
        [-15, -15],
        [-15, 15],
        [15, -15],
        [15, 15],
      ].map(([ax, ay]) => [ax, ay, 0]);
      for (const [name, opts, m] of [
        ["fullBack", { fullBack: true }, full],
        ["wideBack", { wideBack: true }, wideBack.model],
      ] as const) {
        const { edges } = expectCapBound(name, opts, m, poses);
        expect(edges, name).toBeGreaterThan(0);
      }
    });

    it("never turns the cap's outer edge further outside the back hair than the nod alone puts it, following less where the back hair reaches less", () => {
      // The bangs' dome lies inside the eyes' outer corners, over a back-hair
      // dome only 45 px wider down to row 179: looking up, a row's edge meets
      // back rows that reach about 37 px past it, more than the bangs' motion
      // against the back hair at the profile's follow (34 px), less than at
      // hairFollow 2 (65 px). The nod alone keeps every edge inside.
      const opts = { narrowCap: true };
      const poses: number[][] = [];
      for (const ax of [-30, -15, 15, 30])
        for (const ay of [-30, -15, 0, 15, 30])
          for (const az of [-30, 0, 30]) poses.push([ax, ay, az]);
      for (const style of [
        {},
        { hairFollow: 2 },
        { hairFollow: 2, turn: 1.25 },
      ]) {
        const { model: m } = rig(opts, {}, { style });
        expect(capBottom(m)).toBe(330);
        const { edges, sides } = expectCapBound(
          `narrowCap ${JSON.stringify(style)}`,
          opts,
          m,
          poses,
          (k) => k < 210,
        );
        // Every row's edge is backed at rest.
        expect(edges).toBe(sides);
      }
    });

    it("blends the cap's crown toward the back hair only as far as its back hair asks", () => {
      // On the crown the bound is the blend alone, and just enough: looking
      // up and turned, the dome's far edge lands within a pixel or so of its
      // back run's outer end, and the crown still turns — less far than
      // without runs, further than the back hair. At the profile's own follow
      // this back hair leaves the dome room, so nothing binds: the crown rides
      // with the cap, no less far than without runs, still inside its back
      // run.
      const opts = { narrowCap: true };
      const back = layerOf(opts, "hair_back");
      const front = layerOf(opts, "hair_front");
      for (const style of [
        {},
        { hairFollow: 2 },
        { hairFollow: 2, turn: 1.25 },
      ]) {
        const { model: m } = rig(opts, {}, { style });
        const held = rig(opts, {}, { style, drop: ALL_RUNS }).model;
        const turn = style.turn ?? 1;
        const binds = style.hairFollow !== undefined;
        for (const ax of [-30, 30]) {
          const label = `${JSON.stringify(style)}, AngleX ${ax}`;
          // A dome row's bangs at the axis (canvas row 130).
          const y = 370;
          expect(shift(m, 0, y, ax), label).toBeGreaterThan(
            TURN.hairBack * turn + 0.01,
          );
          if (binds)
            expect(shift(m, 0, y, ax), label).toBeLessThan(
              shift(held, 0, y, ax) - 0.005,
            );
          else
            expect(shift(m, 0, y, ax), label).toBeGreaterThan(
              shift(held, 0, y, ax) - 0.005,
            );
          const pose = { [P.AngleX]: ax, [P.AngleY]: 30 };
          const toBack = backRest(m, pose);
          const land = landerFor(m, "hair_front", pose);
          const side = Math.sign(ax);
          let tightest = Infinity;
          for (let k = front.bbox.y; k < 210; k += 2) {
            const runs = front.rowRuns![k - front.bbox.y];
            const ce = side > 0 ? runs[runs.length - 1] : runs[0];
            const at = landedOnBack(back, land, toBack, k, ce, side);
            const inside = insideRun(back, at, side);
            expect(inside, `${label}, row ${k}`).toBeDefined();
            tightest = Math.min(tightest, inside!);
          }
          expect(tightest, label).toBeGreaterThan(-ROUNDING);
          if (binds) expect(tightest, label).toBeLessThan(1.5);
        }
      }
    });

    it("cuts a cap row under the plate's top out toward its edge, keeping the axis's follow and three quarters of each cell", () => {
      // At hairFollow 2 the temple's edges outrun the solid band's back hair
      // under them looking down (48 px past them): their rows give up a cut
      // that grows out from the axis's cell, and blend not at all. Inside
      // the eyes' outer corners today's follow is the same in every column,
      // so a cell's width at a full turn is its rest width there.
      const opts = { narrowCap: true };
      const style = { hairFollow: 2 };
      const { model: m } = rig(opts, {}, { style });
      const held = rig(opts, {}, { style, drop: ALL_RUNS }).model;
      const part = m.parts.find((p) => p.id === "hair_front")!;
      const columns = new Set(part.mesh!.vertices.filter((_, i) => i % 2 === 0))
        .size;
      const rest = landVertices(m, "hair_front");
      for (const ax of [-30, 30]) {
        const turned = landVertices(m, "hair_front", X30(ax));
        let narrowest = Infinity;
        for (const k of [290, 330]) {
          const label = `row ${k}, AngleX ${ax}`;
          expect(
            Math.abs(shift(m, 0, 500 - k, ax) - shift(held, 0, 500 - k, ax)),
            label,
          ).toBeLessThan(0.002);
          for (let i = 0; i + 1 < rest.length / 2; i++) {
            const [x0, x1] = [rest[i * 2], rest[(i + 1) * 2]];
            if (i % columns === columns - 1) continue;
            if (Math.round(500 - rest[i * 2 + 1]) !== k) continue;
            if (Math.abs(x0) > 170 || Math.abs(x1) > 170) continue;
            const width = (turned[(i + 1) * 2] - turned[i * 2]) / (x1 - x0);
            expect(width, `${label}, cell at x ${x0}`).toBeGreaterThan(
              0.75 - 1e-3,
            );
            narrowest = Math.min(narrowest, width);
          }
        }
        // The cut narrows the far side's cells: it acts here.
        expect(narrowest, `AngleX ${ax}`).toBeLessThan(0.99);
      }
    });

    it("leaves the rows beside the eyes as today, however little back hair is behind them", () => {
      // Below the cap the front hair keeps today's motion: at the eye row
      // each lock's outer edge (±200) has back hair only 2 px past it.
      const held = rig({ tightLock: true }, {}, { drop: ALL_RUNS }).model;
      for (const ax of [-30, -15, 15, 30]) {
        // The far lock's outer edge: column 701 turning toward +x, 300
        // toward −x.
        const x = (ax > 0 ? 701 : 300) - 500;
        expect(
          edge(tightLock.model, "hair_front", x, EYE_Y, ax),
          `AngleX ${ax}`,
        ).toBe(edge(held, "hair_front", x, EYE_Y, ax));
      }
    });

    it("rides the crown whole with the cap, but for its top rows, which rise above the back hair looking up", () => {
      // The back hair reaches 58 px past the bangs' edges on every crown and
      // temple row: the crown moves with the fringe, one cap. But it starts
      // only 10 px above the bangs' top, which rise further than that over
      // it looking up: the crown's top rows move with the back hair.
      for (const ax of [-30, -15, 15, 30]) {
        const a = Math.abs(ax) / 30;
        for (const y of [250, 400]) {
          expect(
            shift(wideBack.model, 0, y, ax),
            `y ${y}, AngleX ${ax}`,
          ).toBeCloseTo(a * CORE, 2);
        }
        expect(shift(wideBack.model, 0, 489, ax), `AngleX ${ax}`).toBeCloseTo(
          TURN.hairBack * a,
          2,
        );
      }
    });

    it("holds the crown to the back hair where the rows under it pass over the unbacked temple on the nod, no row further than the one under it", () => {
      // The temple band's back hair ends 5 px inside the bangs' edges, and
      // the crown rows just above it pass over it on the nod: the nod alone
      // shows their edges outside the back hair, so they move with it on the
      // turn, and so does the crown above them.
      for (const ax of [-30, -15, 15, 30]) {
        const a = Math.abs(ax) / 30;
        const ys = [300, 320, 340, 360, 380, 400, 420, 440, 460, 480, 489];
        for (let k = 1; k < ys.length; k++) {
          expect(
            shift(full, 0, ys[k], ax),
            `y ${ys[k]}, AngleX ${ax}`,
          ).toBeLessThanOrEqual(shift(full, 0, ys[k - 1], ax) + 1e-9);
        }
        for (const y of ys) {
          expect(
            Math.abs(shift(full, 0, y, ax) - TURN.hairBack * a),
            `y ${y}, AngleX ${ax}`,
          ).toBeLessThan(0.002);
        }
      }
    });

    it("holds the crown to the back hair over a tuft, and as today over a parting and a gap over the face", () => {
      // A tuft: the back hair's top 40 px under the bangs' beside it, so the
      // rows under these points pass over its narrower back rows looking up:
      // they move with the back hair. A parting: a gap in the bangs over a
      // hole in the back hair, held below the crown's top rows (which move
      // with the back hair, as wideBack's do) where wideBack's crown rides.
      // A gap just under the plate's top, over solid back hair: back hair
      // alone would let it ride, but the face lies in front of it. With the
      // face's runs left out, its crop stands in.
      const faceless = (opts: CharacterOptions) =>
        rig(opts, {}, { drop: (role) => role === "face" }).model;
      for (const [label, rigged] of [
        ["tuft", tuft.model],
        ["tuft, the face's runs left out", faceless({ tuft: true })],
      ] as const) {
        for (const ax of [-30, -15, 15, 30]) {
          const a = Math.abs(ax) / 30;
          for (const [x, y] of [
            [0, 489],
            [-150, 450],
            [150, 450],
            [-190, 400],
            [190, 400],
          ]) {
            expect(
              shift(rigged, x, y, ax),
              `${label}, (${x}, ${y}), AngleX ${ax}`,
            ).toBeCloseTo(TURN.hairBack * a, 2);
          }
        }
      }
      const across = (y: number) => [-100, 0, 100].map((x) => [x, y] as const);
      // The parting's row lands within a hundredth of a pixel of where the
      // rig without runs lands it; the gap over the face, exactly there.
      for (const [name, opts, m, points, exact] of [
        ["crownGap", { crownGap: true }, crownGap.model, across(410), false],
        ["faceGap", { faceGap: true }, faceGap.model, across(rowY(205)), true],
      ] as const) {
        const held = rig(opts, {}, { drop: ALL_RUNS }).model;
        for (const [label, rigged] of [
          [name, m],
          [`${name}, the face's runs left out`, faceless(opts)],
        ] as const) {
          for (const ax of [-30, -15, 15, 30]) {
            for (const [x, y] of points) {
              const landed = expect(
                edge(rigged, "hair_front", x, y, ax),
                `${label}, (${x}, ${y}), AngleX ${ax}`,
              );
              const want = edge(held, "hair_front", x, y, ax);
              if (exact) landed.toBe(want);
              else landed.toBeCloseTo(want, 2);
            }
          }
        }
      }
    });

    it("holds the crown over a gap just above the plate's top, through the nod", () => {
      // Looking down, the bangs on rows 197–199 drop as far as the face's top,
      // the gap just above it: the crown row whose window reaches the gap
      // holds, the face's runs read or its crop standing in.
      const opts = { plateTopGap: true };
      const held = rig(opts, {}, { drop: ALL_RUNS }).model;
      for (const [label, drop] of [
        ["runs", () => false],
        ["the face's runs left out", (role: string) => role === "face"],
      ] as const) {
        const { model: m } = rig(opts, {}, { drop });
        for (const ax of [-30, -15, 15, 30]) {
          for (const x of [-100, 0, 100]) {
            expect(
              edge(m, "hair_front", x, rowY(198), ax),
              `${label}, x ${x}, AngleX ${ax}`,
            ).toBe(edge(held, "hair_front", x, rowY(198), ax));
          }
        }
      }
    });

    describe("over a gap beside the face", () => {
      // A 6 px gap in the bangs 9 px outside the face's runs, on rows just
      // under the plate's top, over solid back hair. Its crown rows hold only
      // in the turns where the face and the gap meet at the same angle.
      const opts = { besideFaceGap: true };
      /** Whether the crown holds over the gap: its points there land where
       *  the same rig without runs lands them. */
      const expectHeld = (m: IkiModel, held: IkiModel, ax: number) => {
        for (const x of [120, 135, 145]) {
          expect(
            edge(m, "hair_front", x, rowY(205), ax),
            `x ${x}, AngleX ${ax}`,
          ).toBe(edge(held, "hair_front", x, rowY(205), ax));
        }
      };

      it("holds as the face slides under it, and rides as the face turns away", () => {
        const held = rig(opts, {}, { drop: ALL_RUNS }).model;
        // Turning toward +x the face's slide carries it under the gap
        // partway through the turn.
        for (const ax of [15, 30]) expectHeld(besideFaceGap.model, held, ax);
        // Turning toward −x the face turns away faster than the gap's left
        // end follows it: the two never meet, so the crown rides whole (but
        // for its top rows, which rise above the back hair looking up).
        expect(shift(besideFaceGap.model, 0, 400, -30)).toBeCloseTo(CORE, 2);
      });

      it("holds when the front hair barely moves and only the face's turn meets the gap", () => {
        const style = { hairFollow: 0 };
        const m = rig(opts, {}, { style }).model;
        const held = rig(opts, {}, { style, drop: ALL_RUNS }).model;
        for (const ax of [15, 30]) expectHeld(m, held, ax);
      });

      it("holds when a narrower shell pulls the gap in under a face it keeps pace with", () => {
        // Turning toward −x the front hair keeps pace with the face; the
        // shell term pulls the gap's left end 20 px in, and it meets the face
        // late in the turn.
        const style = { hairFollow: 1 };
        const targets = { silhouetteRatio: 0.85 };
        const { model: m, report } = rig(opts, targets, { style });
        expect(report!.achieved.silhouetteRatio).toBeCloseTo(0.85, 2);
        const held = rig(opts, targets, { style, drop: ALL_RUNS }).model;
        for (const ax of [-15, -30]) expectHeld(m, held, ax);
      });

      it("rides when the front hair keeps pace with the face and no shell term brings them together", () => {
        const m = rig(opts, {}, { style: { hairFollow: 1 } }).model;
        expect(shift(m, 0, 400, -30)).toBeCloseTo(TURN.face, 2);
      });
    });
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

  describe("the hair on the nod", () => {
    /** How far a rest point drops on screen at AngleY `ay`, hh. */
    const drop = (m: IkiModel, id: string, x: number, y: number, ay: number) =>
      (y - landedYAt(m, id, x, y, { [P.AngleY]: ay })) / HH;

    it("nods the bangs and the back hair by the profile, whatever the crown", () => {
      for (const [name, m] of [
        ["default", model],
        ["fullBack", fullBack.model],
        ["tuft", tuft.model],
      ] as const) {
        expect(drop(m, "hair_front", 0, 150, -30), name).toBeCloseTo(
          NOD.hairFront.down,
          2,
        );
        expect(drop(m, "hair_front", 0, 150, 30), name).toBeCloseTo(
          NOD.hairFront.up,
          2,
        );
        expect(drop(m, "hair_back", -350, -300, -30), name).toBeCloseTo(
          NOD.hairBack.down,
          2,
        );
        expect(drop(m, "hair_back", -350, -300, 30), name).toBeCloseTo(
          NOD.hairBack.up,
          2,
        );
      }
    });

    it("slides the cap's top with the face over a back hair drawn up past it, today's without runs", () => {
      // Just under the bangs' top (490): looking down, the profile's cap top
      // over a back hair painted above it in every column, the back hair's
      // own nod with no runs to tell; looking up, the cap top's either way.
      for (const [name, m, down] of [
        ["fullBack", fullBack.model, NOD.hairFrontTop.down],
        ["default", model, NOD.hairBack.down],
      ] as const) {
        expect(drop(m, "hair_front", 0, 489, -30), name).toBeCloseTo(down, 2);
        expect(drop(m, "hair_front", 0, 489, 30), name).toBeCloseTo(
          NOD.hairFrontTop.up,
          2,
        );
      }
    });

    /**
     * Per crown column of the `character(opts)` set rigged as `m` — its top
     * above the plate's (row 200) — how many more of the rows the back hair
     * leaves empty at its own nod its top bares at AngleY −30, landed through
     * the mesh, than the same set without runs bares. A row is bared when its
     * centre lies between the top's rest and landed edges, and the back hair
     * fills it when its own pixel there, its nod further up, is opaque.
     */
    const crownLosses = (opts: CharacterOptions, m: IkiModel) => {
      const { layers, options } = character(opts);
      const today = generateIkiFromLayerSet(
        layers.map((l) => ({ ...l, rowRuns: undefined })),
        CANVAS,
        options,
      );
      const front = layers.find((l) => l.role === "hair_front")!;
      const back = layers.find((l) => l.role === "hair_back")!;
      const inRuns = (runs: number[], c: number) => {
        for (let k = 0; k < runs.length; k += 2)
          if (runs[k] <= c && c + 1 <= runs[k + 1]) return true;
        return false;
      };
      const down = { [P.AngleY]: -30 };
      const backNod = 400 - landedYAt(m, "hair_back", 0, 400, down);
      const bared = (
        rigged: IkiModel,
        c: number,
        top: number,
        slack: number,
      ) => {
        const y = 500 - top;
        const s = y - landedYAt(rigged, "hair_front", c + 0.5 - 500, y, down);
        let n = 0;
        for (let i = 0; i + 0.5 < s + slack; i++) {
          const row = Math.floor(top + i + 0.5 - backNod) - back.bbox.y;
          if (!inRuns(back.rowRuns![row], c)) n++;
        }
        return n;
      };
      // The keyforms round each offset to 1e-4 of the part's height: read
      // each drop through that rounding the way that cannot fail the bound
      // on it alone.
      const round = 1e-4 * front.bbox.h;
      const losses = new Map<number, number>();
      for (let c = front.bbox.x; c < front.bbox.x + front.bbox.w; c++) {
        const r = front.rowRuns!.findIndex((runs) => inRuns(runs, c));
        if (r < 0 || front.bbox.y + r >= 200) continue;
        const top = front.bbox.y + r;
        losses.set(c, bared(m, c, top, -round) - bared(today, c, top, round));
      }
      return losses;
    };

    /** Each column loses at most 0.01 hh; and when the bound holds the
     *  slide (`tight`), the worst loses all the whole rows that leaves: the
     *  slide is the largest the bound allows. */
    const expectBound = (losses: Map<number, number>, tight: boolean) => {
      for (const [c, loss] of losses) {
        expect(loss, `column ${c}`).toBeLessThanOrEqual(0.01 * HH);
      }
      if (tight) {
        expect(Math.max(...losses.values())).toBe(Math.floor(0.01 * HH));
      }
    };

    it("slides the whole cap's top as far as its least-covered crown column allows", () => {
      const m = tuft.model;
      // The columns beside the tuft, their back hair's top 40 px under the
      // bangs', let the top slide about 0.01 hh past today's, the back
      // hair's own nod (as many whole rows as that leaves), and the tuft
      // does not lift it: the axis column slides as they do.
      const d = drop(m, "hair_front", 0, 489, -30);
      expect(d).toBeCloseTo(NOD.hairBack.down + 0.01, 2);
      for (const x of [-100, 100]) {
        expect(drop(m, "hair_front", x, 489, -30), `x ${x}`).toBeCloseTo(d, 4);
      }
      const losses = crownLosses({ tuft: true }, m);
      // Every column of the bangs' dome, ±262 about the axis, tops out above
      // the plate.
      expect(losses.size).toBe(2 * 262);
      expectBound(losses, true);
    });

    it("holds the whole cap's top near the back hair's nod over a parting dip", () => {
      // A back hair over the whole crown but for a 4 px dip at the axis: the
      // dip alone, bared by the back hair's own nod, binds the one slide.
      const { model: m } = rig({ dip: true });
      const d = drop(m, "hair_front", 0, 489, -30);
      expect(d).toBeCloseTo(NOD.hairBack.down + 0.01, 2);
      expect(drop(m, "hair_front", -200, 489, -30)).toBeCloseTo(d, 4);
      expectBound(crownLosses({ dip: true }, m), true);
    });

    it("slides the cap's top the whole way past a dip the bangs' own nod mostly bares", () => {
      // The same 4 px dip on the dome's shoulder, where each column's top
      // sits lower, and the crown there takes enough of the bangs' nod to
      // bare all but two rows of it at the back hair's own slide: within
      // the 0.01 hh budget, so it holds nothing.
      const { model: m } = rig({ shoulderDip: true });
      expect(drop(m, "hair_front", 0, 489, -30)).toBeCloseTo(
        NOD.hairFrontTop.down,
        2,
      );
      expectBound(crownLosses({ shoulderDip: true }, m), false);
    });
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
      style: { outlineFollow: 1.1 },
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
      },
      {
        [P.AngleX]: -30,
        [P.AngleY]: -30,
        [P.AngleZ]: -30,
        [P.HairSwayX]: -20,
        [P.HairSwayZ]: -20,
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

describe("the jaw cut", () => {
  /** The fixture's face with a measured jaw stroke: a V from where the jaw
   *  meets the neck (canvas row 648, 78 px either side of the axis) down to
   *  the chin at row 692. */
  function jawed(edit: (rows: number[]) => void = () => {}) {
    const { layers, options } = character();
    const face = layers.find((l) => l.role === "face")!;
    const rows = Array.from({ length: face.bbox.w }, (_, i) => {
      const d = Math.abs(face.bbox.x + i + 0.5 - 500.5);
      return d <= 78 ? Math.round(692 - (d / 78) * 44) : -1;
    });
    edit(rows);
    return {
      layers: layers.map((l) => (l === face ? { ...l, jawRows: rows } : l)),
      options,
    };
  }
  function withJaw(edit: (rows: number[]) => void = () => {}) {
    const { layers, options } = jawed(edit);
    return generateIkiFromLayerSet(layers, CANVAS, options);
  }
  /** The stroke's lower boundary, model y, at offset d from the axis. */
  const jawStroke = (d: number) => 500 - (Math.round(692 - (d / 78) * 44) + 1);
  const frameOf = (layers: LayerInput[], options: GenerateOptions) =>
    buildHeadFrame(layers, {
      headHalfWidth: 262,
      headEdges: options.headEdges,
    });

  /** How many samples of the plate a turn of `ax` lands past the neck's
   *  outline from inside it, of those lying more than `depth` px under the
   *  jaw's stroke at rest. */
  function pastOutline(
    m: IkiModel,
    frame: HeadFrame,
    stroke: (d: number) => number,
    depth: number,
    ax: number,
  ): number {
    const { axisX } = frame;
    const waist = frame.neck!.waist;
    const rest = landVertices(m, "face");
    const v = landVertices(m, "face", X30(ax));
    const tris = triangles(m.parts.find((p) => p.id === "face")!.mesh!.indices);
    const S = 6;
    let past = 0;
    for (const t of tris) {
      for (let i = 0; i <= S; i++) {
        for (let j = 0; i + j <= S; j++) {
          const w = [i / S, j / S, (S - i - j) / S];
          const at = (p: Float32Array, k: number) =>
            w.reduce((s, wk, n) => s + wk * p[t[n] * 2 + k], 0);
          const d = Math.abs(at(rest, 0) - axisX);
          if (d >= waist || at(rest, 1) >= stroke(d) - depth) continue;
          if (Math.abs(at(v, 0) - axisX) > waist) past++;
        }
      }
    }
    return past;
  }
  const pivotY = (m: IkiModel) =>
    (
      m.deformers!.find((d) => d.id === "headDeformer") as {
        pivot: { y: number };
      }
    ).pivot.y;

  it("pivots the roll on the measured chin, and shrugs off a stray mark", () => {
    const m = withJaw();
    expect(pivotY(m)).toBeCloseTo(500 - 693, 0);
    // One column meeting a collar line far below the jaw is not the chin.
    const stray = withJaw((rows) => {
      rows[200] = 745;
    });
    // (Without that column the chin reads off its neighbour, a pixel up.)
    expect(Math.abs(pivotY(stray) - pivotY(m))).toBeLessThanOrEqual(1);
  });

  it("carries the chin's shade with the head under the chin only, thinning it to nothing short of the neck's outline by the chin's slide", () => {
    const { layers, options } = jawed();
    const frame = frameOf(layers, options);
    const stroke = jawStroke;
    // Under the chin the cut runs a band's depth below the jaw's stroke...
    expect(stroke(0) - frame.cutAt(0.5)).toBeGreaterThan(10);
    // ...and at the neck's outline (its waist, 78) right under it, so the
    // head carries none of the neck's own outline off with it.
    const waist = frame.neck!.waist;
    expect(
      Math.abs(stroke(waist - 1) - frame.cutAt(0.5 - (waist - 1))),
    ).toBeLessThan(2.5);
    // Given a chin's slide at a full turn (51 px, where the fixture's fringe
    // margin has thinned), the band still runs deep under the chin, but the
    // cut draws its end that slide and 2 px short of the outline: past there,
    // only the fringe margin (thinned there to under 1.4 px) and the cut's low
    // filter over three columns of the V (about 1.7 px) lie under the stroke.
    // The profile's own slide is checked end to end below.
    const slide = 51;
    const turned = buildHeadFrame(layers, {
      headHalfWidth: 262,
      headEdges: options.headEdges,
      chinSlide: slide,
    });
    const { axisX } = turned;
    expect(stroke(0) - turned.cutAt(axisX)).toBeGreaterThan(10);
    for (let d = waist - slide - 2; d < waist; d++) {
      for (const x of [axisX - d, axisX + d]) {
        expect(stroke(d) - turned.cutAt(x), `x ${x}`).toBeLessThan(3.5);
      }
    }
  });

  it("keeps the chin's shade inside the neck through the turn", () => {
    const { layers, options } = jawed();
    const m = generateIkiFromLayerSet(layers, CANVAS, options);
    const frame = frameOf(layers, options);
    // The drawing more than 4 px under the stroke (its fringe margin and the
    // cut's low filter on the V, about 3 px, lie within that) lands inside
    // the neck.
    for (const ax of [-30, -15, 15, 30]) {
      expect(pastOutline(m, frame, jawStroke, 4, ax), `AngleX ${ax}`).toBe(0);
    }
  });

  it("keeps the chin's shade inside a slim neck, which leaves the band little room or none", () => {
    for (const waist of [54, 56, 58, 60, 64]) {
      // The fixture's neck narrowed to `waist`, its jaw stroke a V from the
      // chin (canvas row 692) up to where the jaw meets the neck's sides.
      const { layers, options } = character();
      const face = layers.find((l) => l.role === "face")!;
      const h = face.bbox.h;
      const prof = face.rowHalfWidths!.map((w, r) => {
        const t = r / h;
        if (t < 0.5 || r >= h - 4) return w;
        const v = t < 0.8 ? 198 - (198 - waist) * ((t - 0.5) / 0.3) : waist;
        return Math.round(v * 2) / 2;
      });
      const half = waist + 0.15 * (198 - waist);
      const top = face.bbox.y + prof.findIndex((w, r) => r > 100 && w <= half);
      const row = (d: number) => Math.round(692 - (d / half) * (692 - top));
      const rows = Array.from({ length: face.bbox.w }, (_, i) => {
        const d = Math.abs(face.bbox.x + i + 0.5 - 500.5);
        return d <= half ? row(d) : -1;
      });
      const slim = layers.map((l) =>
        l === face ? { ...l, rowHalfWidths: prof, jawRows: rows } : l,
      );
      const m = generateIkiFromLayerSet(slim, CANVAS, options);
      const frame = frameOf(slim, options);
      expect(frame.neck!.waist).toBe(waist);
      // Past the stroke's fringe (2 px) and the cut's low filter over three
      // columns of this steeper V (and a quarter pixel for the stroke's
      // rounded rows), nothing lands past the outline.
      const depth = 2 + (3 * (692 - top)) / half + 0.25;
      const stroke = (d: number) => 500 - (row(d) + 1);
      for (const ax of [-30, -15, 15, 30]) {
        expect(
          pastOutline(m, frame, stroke, depth, ax),
          `waist ${waist}, AngleX ${ax}`,
        ).toBe(0);
      }
    }
  });

  it("keeps the neck's texture on the drawing: a collar as wide as the plate, a neck stub", () => {
    const { layers, options } = character();
    const face = layers.find((l) => l.role === "face")!;
    // The neck flares to nearly the plate's width at its cut edge.
    const flared = layers.map((l) =>
      l === face
        ? {
            ...l,
            rowHalfWidths: face.rowHalfWidths!.map((w, r) =>
              r >= face.bbox.h - 30 ? 190 : w,
            ),
          }
        : l,
    );
    const m = generateIkiFromLayerSet(flared, CANVAS, options);
    // Beside the jaw the collar's columns carry the collar alone: nothing
    // of the still neck shows above what a sliding chin uncovers (its hidden
    // top, AMPLITUDE.hiddenNeck over the jaw's corners) — no still copy of
    // the cheek beside the turned head.
    const frame = buildHeadFrame(flared, {
      headHalfWidth: 262,
      headEdges: options.headEdges,
    });
    const above = frame.neck!.topY + AMPLITUDE.hiddenNeck * frame.hh;
    for (const ax of [-30, 30]) {
      expect(exposedStill(m, X30(ax), above), `AngleX ${ax}`).toBe(0);
    }
    // The collar is still drawn out to its flare (canvas rows 730…759).
    const draws = plateDraws(m);
    for (const y of [-258, -245, -232]) {
      for (let x = -188.5; x <= 190; x += 3) {
        expect(draws(x, y), `(${x}, ${y})`).toBe(true);
      }
    }
    // A jaw stroke measured right at the bottom of a short neck.
    expect(() =>
      withJaw((rows) => {
        for (let i = 0; i < rows.length; i++) if (rows[i] >= 0) rows[i] = 757;
      }),
    ).not.toThrow();
  });
});

/** The fixture's face narrowed by 25 px but for rows 170…260 of its crop,
 *  which step out to its drawn width: ears. The frame is built as the
 *  generator builds it. */
function withEars(opts: CharacterOptions = {}, targets: TurnTargets = {}) {
  const { layers, options } = character(opts);
  const face = layers.find((l) => l.role === "face")!;
  const rows = face.rowHalfWidths!.map((w, r) =>
    r >= 170 && r <= 260 ? w : Math.max(10, w - 25),
  );
  const eared = layers.map((l) =>
    l === face ? { ...l, rowHalfWidths: rows } : l,
  );
  const turnTargets = { ...options.turnTargets, ...targets };
  let report: TurnSolveReport | undefined;
  const m = generateIkiFromLayerSet(eared, CANVAS, {
    ...options,
    turnTargets,
    onTurnSolved: (r) => {
      report = r;
    },
  });
  return {
    m,
    report: report!,
    frame: buildHeadFrame(eared, {
      headHalfWidth: turnTargets.headHalfWidth,
      headEdges:
        turnTargets.headHalfWidth !== undefined ? options.headEdges : undefined,
    }),
  };
}

describe("the ears", () => {
  /** The silhouette ratio a head without hair fits at a shellScale of
   *  `shell`: its plate's width at full turn, scaled. */
  const shellRatio = (shell: number) => shell * TURN.widthUpper;

  /** The plate without its head island (its largest): what the other
   *  islands draw, the ears' roots under the head included — the head's
   *  edge strays past the line under an ear between its columns. */
  function withoutHead(model: IkiModel): IkiModel {
    const part = model.parts.find((p) => p.id === "face")!;
    const tris = triangles(part.mesh!.indices);
    const root = Array.from(
      { length: part.mesh!.vertices.length / 2 },
      (_, i) => i,
    );
    const find = (i: number): number =>
      root[i] === i ? i : (root[i] = find(root[i]));
    for (const [a, b, c] of tris) {
      root[find(b)] = find(a);
      root[find(c)] = find(a);
    }
    const size = new Map<number, number>();
    for (const [a] of tris) size.set(find(a), (size.get(find(a)) ?? 0) + 1);
    const head = [...size].reduce((p, q) => (q[1] > p[1] ? q : p))[0];
    const indices = tris.filter(([a]) => find(a) !== head).flat();
    return {
      ...model,
      parts: model.parts.map((p) =>
        p === part ? { ...p, mesh: { ...p.mesh!, indices } } : p,
      ),
    };
  }

  it("lags the ears behind the face — the far one most — with no seam at rest", () => {
    const { m, frame } = withEars();
    // On crop row 215 (model y 500 − 200 − 215): the far ear at its outer
    // rim, the near one at its widest reach, where each lag is whole.
    const ear = (x: number, ax: number) =>
      landedXAt(m, "face", x, 85, X30(ax)) - x;
    const face = (ax: number) => landedXAt(m, "face", 0.5, 85, X30(ax)) - 0.5;
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      const far = frame.axisX + s * (frame.ears!.outer - 0.5);
      const near = frame.axisX - s * frame.ears!.outer;
      expect(ear(far, ax) / face(ax)).toBeCloseTo(TURN.earFar, 2);
      expect(ear(near, ax) / face(ax)).toBeCloseTo(TURN.earNear, 1);
    }
    // At rest every island lies where it is drawn.
    const v = landVertices(m, "face");
    const part = m.parts.find((p) => p.id === "face")!;
    for (let i = 0; i < v.length / 2; i++) {
      expect(v[i * 2]).toBeCloseTo(
        part.transform.x + part.mesh!.vertices[i * 2] * part.width,
        3,
      );
    }
  });

  it("moves the near ear's root, tucked under the head, as the head moves it", () => {
    const { m, frame } = withEars();
    const ears = frame.ears!;
    const rest = landVertices(m, "face");
    for (const ax of [-30, 30]) {
      const pose = X30(ax);
      const v = landVertices(m, "face", pose);
      let tucked = 0;
      for (let i = 0; i < rest.length / 2; i++) {
        const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
        const u = x - frame.axisX;
        // On the ear band, inside the head's own outline, on the near side.
        if (y < ears.bottom || y > ears.top) continue;
        if (Math.abs(u) >= ears.attachAt(y) - 1) continue;
        if (Math.sign(ax) * u > 0) continue;
        // The head island is drawn last, so this reads how it moves there.
        const head = landedXAt(m, "face", x, y, pose);
        expect(
          Math.abs(v[i * 2] - head),
          `(${x}, ${y}) at AngleX ${ax}`,
        ).toBeLessThan(0.5);
        // The ear island's own inner column, EAR_TUCK (0.08 hh) inside the
        // line — not only the head's vertices over it.
        const tuck = ears.attachAt(y) - 0.08 * frame.hh;
        if (Math.abs(Math.abs(u) - tuck) < 0.05) tucked++;
      }
      expect(tucked).toBeGreaterThan(0);
    }
  });

  it("narrows the far ear to the profile's width at a full turn", () => {
    const { m, frame } = withEars();
    const ears = frame.ears!;
    // On row 85, from just outside the head's own outline to just inside the
    // ear's outer rim — read off the ear's island, which the head's edge
    // covers a few px past that line here.
    const ear = withoutHead(m);
    const d0 = ears.attachAt(85) + 2;
    const d1 = ears.outer - 2;
    const half = (1 + TURN.earFarScale) / 2;
    for (const [ax, width] of [
      [-30, TURN.earFarScale],
      [-15, half],
      [15, half],
      [30, TURN.earFarScale],
    ]) {
      const s = Math.sign(ax);
      const at = (d: number) =>
        landedXAt(ear, "face", frame.axisX + s * d, 85, X30(ax));
      const span = (s * (at(d1) - at(d0))) / (d1 - d0);
      expect(Math.abs(span - width), `AngleX ${ax}: ${span}`).toBeLessThan(
        0.01,
      );
    }
  });

  it("keeps the far ear's tucked strip under the head", () => {
    // Without hair at silhouetteRatio 0.9 the plate narrows, so the head
    // moves barely past the ear's outer edge on the line under it: the root
    // is held there, short of the ear's full narrowing.
    for (const { m, frame } of [
      withEars(),
      withEars({ hair: false }, { silhouetteRatio: 0.9 }),
    ]) {
      const ears = frame.ears!;
      const ear = withoutHead(m);
      const rest = landVertices(m, "face");
      for (const ax of [-30, 30]) {
        const s = Math.sign(ax);
        const pose = X30(ax);
        const v = landVertices(m, "face", pose);
        let tucked = 0;
        for (let i = 0; i < rest.length / 2; i++) {
          const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
          const u = x - frame.axisX;
          // On the ear island's rows — it runs 2 px past the band either way,
          // its end rows here at y 36 and 135 — inside the head's own
          // outline, on the far side.
          if (y < ears.bottom - 2 || y > ears.top + 2) continue;
          if (Math.abs(u) >= ears.attachAt(y) - 1) continue;
          if (s * u <= 0) continue;
          // Where the head island's own point on that outline lands.
          const edge = landedXAt(
            m,
            "face",
            frame.axisX + s * ears.attachAt(y),
            y,
            pose,
          );
          expect(
            s * (v[i * 2] - edge),
            `(${x}, ${y}) at AngleX ${ax}`,
          ).toBeLessThanOrEqual(1e-3);
          // The ear island's own inner column, EAR_TUCK (0.08 hh) inside the
          // line — not only the head's vertices there.
          const tuck = ears.attachAt(y) - 0.08 * frame.hh;
          if (Math.abs(Math.abs(u) - tuck) < 0.05) tucked++;
        }
        expect(tucked).toBeGreaterThan(0);
        // The ear's own point on the line goes no further than the head's.
        for (let y = ears.bottom - 2; y <= ears.top + 2; y += 5) {
          const at = frame.axisX + s * ears.attachAt(y);
          expect(
            s *
              (landedXAt(ear, "face", at, y, pose) -
                landedXAt(m, "face", at, y, pose)),
            `row ${y} at AngleX ${ax}`,
          ).toBeLessThanOrEqual(0.1);
        }
      }
    }
  });

  it("moves the far ear's tucked strip no further than the head over it", () => {
    // Without hair at a shellScale of 0.94 the plate narrows on the turn
    // slower than the far ear does, while the head still moves well past
    // the ear's outer edge on the line under it; at 0.8 (the narrowest) the
    // solve limits the narrowing to where the head there still moves as far
    // as that edge.
    for (const { m, frame } of [
      withEars(),
      withEars({ hair: false }, { silhouetteRatio: shellRatio(0.94) }),
      withEars({ hair: false }, { silhouetteRatio: shellRatio(0.8) }),
    ]) {
      const ears = frame.ears!;
      const ear = withoutHead(m);
      const tuck = 0.08 * frame.hh;
      // The keyforms round each offset to 1e-4 of the plate's box.
      const eps = 1e-4 * m.parts.find((p) => p.id === "face")!.width;
      const rest = landVertices(m, "face");
      for (const ax of [-30, -15, 15, 30]) {
        const s = Math.sign(ax);
        const pose = X30(ax);
        const v = landVertices(m, "face", pose);
        for (let i = 0; i < rest.length / 2; i++) {
          const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
          const u = x - frame.axisX;
          // On the ear island's rows, inside the head's own outline, on the
          // far side; the head island is drawn last, so the read is its.
          if (y < ears.bottom - 2 || y > ears.top + 2) continue;
          if (Math.abs(u) >= ears.attachAt(y) - 1) continue;
          if (s * u <= 0) continue;
          expect(
            s * (v[i * 2] - landedXAt(m, "face", x, y, pose)),
            `(${x}, ${y}) at AngleX ${ax}`,
          ).toBeLessThanOrEqual(eps);
        }
        // The ear island's own point at its inner end on row 85.
        const at = frame.axisX + s * (ears.attachAt(85) - tuck);
        expect(
          s *
            (landedXAt(ear, "face", at, 85, pose) -
              landedXAt(m, "face", at, 85, pose)),
          `row 85 at AngleX ${ax}`,
        ).toBeLessThanOrEqual(eps);
      }
    }
  });

  it("narrows a fitted silhouette only as far as the head still covers the far ear's slide", () => {
    // Without hair at a shellScale of 0.8 the plate would narrow so much
    // that on the line under the ear the head moved less than the ear's
    // outer edge: the solve stops short, and says so.
    const { m, frame, report } = withEars(
      { hair: false },
      { silhouetteRatio: shellRatio(0.8) },
    );
    expect(report.clamped).toContain("silhouetteRatio");
    expect(report.achieved.silhouetteRatio).toBeGreaterThan(
      shellRatio(0.8) + 0.01,
    );
    const ears = frame.ears!;
    const ear = withoutHead(m);
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      // The outer edge keeps its TURN.earFar of the plate's slide (row 85).
      const far = frame.axisX + s * (ears.outer - 0.5);
      const rim = landedXAt(m, "face", far, 85, X30(ax)) - far;
      const plate = landedXAt(m, "face", 0.5, 85, X30(ax)) - 0.5;
      expect(rim / plate, `AngleX ${ax}`).toBeCloseTo(TURN.earFar, 2);
      // ... and the ear narrows, to no less than TURN.earFarScale, and never
      // widens.
      for (let y = ears.bottom; y <= ears.top; y += 5) {
        const d0 = ears.attachAt(y) + 2;
        const d1 = ears.outer - 2;
        const at = (d: number) =>
          landedXAt(ear, "face", frame.axisX + s * d, y, X30(ax));
        const span = (s * (at(d1) - at(d0))) / (d1 - d0);
        const label = `row ${y} at AngleX ${ax}: ${span}`;
        expect(span, label).toBeLessThanOrEqual(1 + 1e-3);
        expect(span, label).toBeGreaterThanOrEqual(TURN.earFarScale - 0.01);
      }
    }
    // Where the head already covers it, the fit is the caller's.
    const covered = withEars(
      { hair: false },
      { silhouetteRatio: shellRatio(0.94) },
    );
    expect(covered.report.clamped).not.toContain("silhouetteRatio");
    expect(covered.report.achieved.silhouetteRatio).toBeCloseTo(
      shellRatio(0.94),
      2,
    );
  });
});

describe("extreme combined poses", () => {
  it("squeezes no face or hair triangle below 40 % when turn, nod, tilt and sway meet", () => {
    const S = [-30, -15, 0, 15, 30];
    const all = ["face", "hair_front", "hair_back"];
    for (const [name, model, ids] of [
      ["default", hero.model, all],
      ["fullBack", fullBack.model, all],
      ["tuft", tuft.model, all],
      ["wideBack", wideBack.model, all],
      ["crownGap", crownGap.model, all],
      ["faceGap", faceGap.model, all],
      ["besideFaceGap", besideFaceGap.model, all],
      ["narrowCap", narrowCap.model, all],
      ["tightLock", tightLock.model, all],
      ["withEars", withEars().m, ["face"]],
    ] as const) {
      for (const id of ids) {
        const part = model.parts.find((p) => p.id === id)!;
        const rest = signedAreas(landVertices(model, id), part.mesh!.indices);
        let worst = Infinity;
        for (const x of S)
          for (const y of S)
            for (const z of S)
              for (const s of [-20, 0, 20]) {
                const pose = {
                  [P.AngleX]: x,
                  [P.AngleY]: y,
                  [P.AngleZ]: z,
                  [P.HairSwayX]: s,
                };
                const areas = signedAreas(
                  landVertices(model, id, pose),
                  part.mesh!.indices,
                );
                areas.forEach((a, i) => (worst = Math.min(worst, a / rest[i])));
              }
        expect(worst, `${name} ${id}`).toBeGreaterThan(0.4);
      }
    }
  });
});

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

  it("leaves style.turn out when a caller's eye shift fits the turn", () => {
    const e = 0.8 * hero.report!.achieved.eyeShift;
    const { layers, options } = character();
    const styled = generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      turnTargets: { ...options.turnTargets, eyeShift: e },
      style: { turn: 0.5 },
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

  it("tunes a character from the profile with its style knobs", () => {
    const { layers, options } = character();
    const m = generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      style: { turn: 0.5, hairFollow: 1, sway: 2, blink: 0.4 },
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
      landedXAt(model, "hair_back", 0, -470, { [P.HairSwayX]: 20 });
    expect(hairEnd(m) / hairEnd(hero.model)).toBeCloseTo(2, 1);
    expect(() =>
      generateIkiFromLayerSet(layers, CANVAS, { style: { turn: -1 } }),
    ).toThrow(/style\.turn/);
    // No turn, no foreshortening.
    let still: TurnSolveReport | undefined;
    generateIkiFromLayerSet(layers, CANVAS, {
      ...options,
      style: { turn: 0 },
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

  it("refuses a style or turnTargets that is not a plain object, or names a field it has not", () => {
    const { layers, options } = character();
    const withOptions = (o: object) => () =>
      generateIkiFromLayerSet(layers, CANVAS, { ...options, ...o });
    expect(withOptions({ style: { tunr: 2 } })).toThrow(
      /style\.tunr is not one of turn, featureLead/,
    );
    expect(withOptions({ style: "abc" })).toThrow(
      /style must be a plain object/,
    );
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

describe("the other drivers", () => {
  const { model } = hero;

  it("folds the eye white shut onto a crease, the lash coming down over it", () => {
    const shut = { [P.EyeOpenLeft]: 0 };
    const v = landVertices(model, "eye_L", shut);
    const ys = new Set<number>();
    for (let i = 1; i < v.length; i += 2) ys.add(Math.round(v[i] * 100) / 100);
    expect(ys.size).toBe(1);
    const crease = [...ys][0];
    // The upper lid comes down AMPLITUDE.blink of the eye's height (it rests
    // at y 100, 66 px tall).
    expect(crease).toBeCloseTo(100 - AMPLITUDE.blink * 66, 1);
    const lash = landVertices(model, "lash_L", shut);
    let lashBottom = Infinity;
    for (let i = 1; i < lash.length; i += 2)
      lashBottom = Math.min(lashBottom, lash[i]);
    expect(lashBottom).toBeLessThanOrEqual(crease);
    // The right eye stays open: each eye is its own parameter.
    const right = landVertices(model, "eye_R", shut);
    expect(right).toEqual(landVertices(model, "eye_R"));
  });

  it("hangs the long hair back on a tilt, the same both ways", () => {
    const hair = model.parts.find((p) => p.id === "hair_back")!;
    const bottom = hair.transform.y - hair.height / 2 + 5;
    const pivot = model.deformers!.find((d) => d.id === "headDeformer")!;
    const { x: px, y: py } = (pivot as { pivot: { x: number; y: number } })
      .pivot;
    for (const z of [-30, 30]) {
      for (const x of [-350, 350]) {
        // Where the head's roll alone (ROLL_DEG at ±30) would take the
        // point.
        const a = (-z / 30) * ROLL_DEG * (Math.PI / 180);
        const rigid = px + (x - px) * Math.cos(a) - (bottom - py) * Math.sin(a);
        const landed = landedXAt(model, "hair_back", x, bottom, {
          [P.AngleZ]: z,
        });
        const hang = (rigid - landed) / (rigid - x);
        expect(hang, `x ${x}, AngleZ ${z}`).toBeGreaterThan(0.2);
        expect(hang, `x ${x}, AngleZ ${z}`).toBeLessThan(0.45);
      }
    }
  });

  it("rolls a fringe that ends above the chin with the head, unhung", () => {
    const { model: m } = rig({ shortFringe: true });
    const pivot = m.deformers!.find((d) => d.id === "headDeformer") as {
      pivot: { x: number; y: number };
    };
    const a = (-ROLL_DEG * Math.PI) / 180;
    const [x, y] = [0, 200];
    const rigid =
      pivot.pivot.x +
      (x - pivot.pivot.x) * Math.cos(a) -
      (y - pivot.pivot.y) * Math.sin(a);
    expect(landedXAt(m, "hair_front", x, y, { [P.AngleZ]: 30 })).toBeCloseTo(
      rigid,
      0,
    );
  });

  it("swings the hair's ends on the sway parameters, roots pinned", () => {
    for (const id of ["hair_front", "hair_back"]) {
      const top = model.parts.find((p) => p.id === id)!;
      const rootY = top.transform.y + top.height / 2;
      const endY = top.transform.y - top.height / 2;
      const sway = { [P.HairSwayX]: 20 };
      expect(landedXAt(model, id, top.transform.x, rootY, sway)).toBeCloseTo(
        top.transform.x,
        3,
      );
      // The profile's tip travel at full sway: AMPLITUDE.sway.
      expect(
        (landedXAt(model, id, top.transform.x, endY, sway) - top.transform.x) /
          HH,
      ).toBeCloseTo(AMPLITUDE.sway, 2);
    }
  });

  it("cross-fades the mouth drawings on MouthOpen", () => {
    const mouth = model.parts.find((p) => p.id === "mouth")!;
    const open = model.parts.find((p) => p.id === "mouth_open")!;
    expect(mouth.bindings?.filter((b) => b.channel === "opacity")).toHaveLength(
      2,
    );
    expect(open.bindings?.find((b) => b.channel === "opacity")).toMatchObject({
      parameter: P.MouthOpen,
      from: 0,
      to: 1,
    });
  });

  it("rigs pupils and highlights with the iris, and blush on the face", () => {
    const { model: m } = rig({ extras: true });
    const part = (id: string) => m.parts.find((p) => p.id === id)!;
    expect(part("pupil_L").clip).toEqual({ masks: ["eye_L"] });
    expect(part("highlight_R").clip).toEqual({ masks: ["eye_R"] });
    expect(part("blush_L").deformer).toBe(part("face").deformer);
    const glance = { [P.EyeballX]: 1 };
    const moved = (id: string) =>
      landedCentroidX(m, id, glance) - landedCentroidX(m, id);
    expect(moved("pupil_L")).toBeCloseTo(moved("iris_L"), 3);
    // Travel is written rounded to 0.1 px.
    expect(moved("highlight_L")).toBeCloseTo(moved("iris_L") / 2, 1);
  });

  it("breathes: the shoulders and the neck lift, the head a little less", () => {
    const b = { [P.Breath]: 1 };
    const lift = (id: string, x: number, y: number) =>
      (landedYAt(model, id, x, y, b) - landedYAt(model, id, x, y)) / HH;
    expect(lift("face", 0, 250)).toBeCloseTo(AMPLITUDE.breathHead, 3);
    expect(lift("body", 0, -400)).toBeCloseTo(AMPLITUDE.breathBody, 3);
    expect(lift("face", 0, -240)).toBeCloseTo(AMPLITUDE.breathBody, 3);
  });
});
