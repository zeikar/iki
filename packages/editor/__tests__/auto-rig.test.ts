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
import { AMPLITUDE } from "../src/auto-rig/profile";
import type { GenerateOptions } from "../src/auto-rig/types";
import { CANVAS, character, type CharacterOptions } from "./helpers/character";
import {
  landVertices,
  landedCentroidX,
  landedXAt,
  landedYAt,
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

/** The fixture's profile unit: 1.017 × (eye row 67 → chin −192.6). */
const HH = 1.017 * (67 + 192.625);
const X30 = (ax: number) => ({ [P.AngleX]: ax });

describe("the head turn", () => {
  const { model, report } = hero;

  it("renders the profile by default and reports what renders", () => {
    expect(report).toBeDefined();
    expect(report!.clamped).toEqual([]);
    expect(report!.holdBase).toBe(262);
    // The far eye narrows to 0.85 and the near one widens to 1.085.
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
      // The cheek edges on the widest row move together, about 0.12 hh.
      const [l, r] = [at(-195, 20), at(195, 20)];
      expect((s * (l + r)) / 2 / HH).toBeCloseTo(0.118, 2);
      expect(1 + (r - l) / 390).toBeGreaterThan(0.98);
      // The jaw narrows a little more (0.96).
      const [jl, jr] = [at(-85, -130), at(85, -130)];
      expect(1 + (jr - jl) / 170).toBeGreaterThan(0.95);
      expect(1 + (jr - jl) / 170).toBeLessThan(0.99);
      // The chin tip leads the plate: 0.194 hh.
      expect((s * at(0.5, -190)) / HH).toBeCloseTo(0.194, 2);
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
      expect(shift(far, ax)).toBeCloseTo(0.192, 2);
      expect(shift(near, ax)).toBeCloseTo(0.23, 2);
      const [bf, bn] = ax < 0 ? ["brow_R", "brow_L"] : ["brow_L", "brow_R"];
      expect(shift(bf, ax)).toBeCloseTo(0.213, 2);
      expect(shift(bn, ax)).toBeCloseTo(0.243, 2);
      expect(shift("mouth", ax)).toBeCloseTo(0.213, 1);
      expect(shift("nose", ax)).toBeGreaterThan(0.28);
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
    expect(width("eye_R", -160, -50, -30)).toBeCloseTo(0.85, 2);
    expect(width("eye_L", 51, 161, -30)).toBeCloseTo(1.085, 2);
    expect(width("eye_L", 51, 161, 30)).toBeCloseTo(0.85, 2);
  });

  it("narrows and tilts the mouth a little, far corner up", () => {
    const at = (x: number, ax: number) => ({
      x: landedXAt(model, "mouth", x, -100.5, X30(ax)),
      y: landedYAt(model, "mouth", x, -100.5, X30(ax)),
    });
    for (const ax of [-30, 30]) {
      const a = at(-30, ax);
      const b = at(30, ax);
      expect(Math.hypot(b.x - a.x, b.y - a.y) / 60).toBeCloseTo(0.975, 2);
      const tilt = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      // Turning toward +x the far corner is +x's, and it rises: CCW.
      expect(tilt * Math.sign(ax)).toBeCloseTo(4.4, 0);
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
      // 1.1 × the plate's 0.118 hh.
      expect(shift(0, 250)).toBeCloseTo(1.1 * 0.118, 2);
      expect(shift(-150, -300)).toBeCloseTo(1.1 * 0.118, 2);
      // The outline it draws at the eye row holds, as the samples' back
      // hair does.
      expect(Math.abs(shift(-261, EYE_Y))).toBeLessThan(0.005);
      expect(Math.abs(shift(260, EYE_Y))).toBeLessThan(0.005);
      // The crown eases to the back hair's slight counter-motion.
      expect(shift(0, 490)).toBeCloseTo(-0.027, 2);
      const rest = landVertices(model, "hair_back");
      const turned = landVertices(model, "hair_back", p);
      for (let i = 0; i < rest.length; i += 2) {
        expect((s * (turned[i] - rest[i])) / HH).toBeCloseTo(-0.027, 3);
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
    const DRIFT = 0.027 * HH;
    /** The face's follow at the edge below the eye band, hh at ±30. */
    const CORE = 1.1 * 0.118;
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

    it("rides the edge with the face where the back reaches past it and far inside it", () => {
      // Under the eyes, the back solid to ±310 over every row the edge passes
      // over on the nod (43 px down to 26 px up, one mesh row either side):
      // 48 px past the edge less the 7.1 px drift, and far inside it, both
      // more than the face's 34.3 px follow, so both edges may ride it whole.
      // The mesh carries the ride's kink at the edge between two columns, so
      // the edge lands a little short of it (today's hold is 0.045 hh).
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

    it("keeps every riding edge over the back hair when the turn and the nod meet", () => {
      // The bangs nod further than the back hair, so a row's edge lands over
      // the back's rows under it looking down, over it looking up: a row of
      // the solid band rides beside the gap under it or the temple over it.
      // The crown rides too, over a back hair backing it to the plate
      // (wideBack) or, short of the unbacked temple rows, part way (fullBack).
      for (const [name, opts, m, held] of [
        ["fullBack", { fullBack: true }, full, today],
        [
          "wideBack",
          { wideBack: true },
          wideBack.model,
          rig({ wideBack: true }, {}, { drop: ALL_RUNS }).model,
        ],
      ] as const) {
        const { layers } = character(opts);
        const front = layers.find((l) => l.role === "hair_front")!;
        const back = layers.find((l) => l.role === "hair_back")!;
        /** Whether the back hair paints canvas columns [c0, c1) on row k. */
        const backPaints = (k: number, c0: number, c1: number) => {
          const runs = back.rowRuns![k - back.bbox.y] ?? [];
          for (let i = 0; i < runs.length; i += 2)
            if (runs[i] <= c0 && c1 <= runs[i + 1]) return true;
          return false;
        };
        let riding = 0;
        for (const [ax, ay] of [
          [-30, -30],
          [-30, 30],
          [30, -30],
          [30, 30],
          [-15, -15],
          [-15, 15],
          [15, -15],
          [15, 15],
        ]) {
          const pose = { [P.AngleX]: ax, [P.AngleY]: ay };
          // The back hair nods whole and turns linearly in x: the rest x
          // under a landed x, and the rest row under a landed y.
          const bx0 = landedXAt(m, "hair_back", 0, 0, pose);
          const bx1 = landedXAt(m, "hair_back", 100, 0, pose);
          const backX = (x: number) => ((x - bx0) * 100) / (bx1 - bx0);
          const backDy = landedYAt(m, "hair_back", 0, 0, pose);
          // Every other pixel row of the bangs, each side's outermost pixel.
          for (let k = front.bbox.y; k < front.bbox.y + front.bbox.h; k += 2) {
            const runs = front.rowRuns![k - front.bbox.y];
            for (const side of [-1, 1]) {
              const ce = side > 0 ? runs[runs.length - 1] : runs[0];
              const x = ce - 500;
              const y = rowY(k);
              // The ride is the turn's: it rides where it lands past today's.
              if (
                Math.abs(
                  edge(m, "hair_front", x, y, ax) -
                    edge(held, "hair_front", x, y, ax),
                ) < 0.1
              )
                continue;
              riding++;
              const row = Math.floor(
                500 - (landedYAt(m, "hair_front", x, y, pose) - backDy),
              );
              const cb = backX(landedXAt(m, "hair_front", x, y, pose)) + 500;
              // From the edge's own pixel to where it lands (far, going out),
              // or across the strip it leaves (near, coming in), less the
              // keyforms' rounding.
              const [c0, c1] =
                side > 0
                  ? [Math.min(ce - 1, cb + 0.1), Math.max(ce, cb - 0.1)]
                  : [Math.min(ce, cb + 0.1), Math.max(ce + 1, cb - 0.1)];
              expect(
                backPaints(row, Math.floor(c0), Math.ceil(c1)),
                `${name}, row ${k}, side ${side}, AngleX ${ax}, AngleY ${ay}`,
              ).toBe(true);
            }
          }
        }
        expect(riding, name).toBeGreaterThan(0);
      }
    });

    it("rides the crown whole with the cap over back hair painted past its edges down to the plate", () => {
      // The back hair reaches 58 px past the bangs' edges on every crown and
      // temple row: the crown's top moves with the fringe, one cap.
      for (const ax of [-30, -15, 15, 30]) {
        const a = Math.abs(ax) / 30;
        for (const y of [250, 400, 489]) {
          expect(
            shift(wideBack.model, 0, y, ax),
            `y ${y}, AngleX ${ax}`,
          ).toBeCloseTo(a * CORE, 2);
        }
      }
    });

    it("rides the crown part way where the temple rows under it are unbacked, no row further than the one under it", () => {
      // The temple band's back hair ends 5 px inside the bangs' edges, and
      // the rows under the crown pass over it on the nod: they hold, and the
      // crown above them rides no further than they do.
      for (const ax of [-30, 30]) {
        const ys = [300, 320, 340, 360, 380, 400, 420, 440, 460, 480, 489];
        for (let k = 1; k < ys.length; k++) {
          expect(
            shift(full, 0, ys[k], ax),
            `y ${ys[k]}, AngleX ${ax}`,
          ).toBeLessThanOrEqual(shift(full, 0, ys[k - 1], ax) + 1e-9);
        }
        const top = shift(full, 0, 489, ax);
        const held = shift(today, 0, 489, ax);
        expect(held, `AngleX ${ax}`).toBeCloseTo(-0.027, 2);
        expect(top - held, `AngleX ${ax}`).toBeGreaterThanOrEqual(0.05);
        expect(top, `AngleX ${ax}`).toBeLessThan(0.9 * CORE);
      }
    });

    it("holds the crown as today over unbacked edges, a parting, and a gap over the face", () => {
      // A tuft: the back hair's top 40 px under the bangs' beside it. A
      // parting: a gap in the bangs over a hole in the back hair. A gap just
      // under the plate's top, over solid back hair: back hair alone would
      // let it ride, but the face lies in front of it. With the face's runs
      // left out, its crop stands in.
      const across = (y: number) => [-100, 0, 100].map((x) => [x, y] as const);
      for (const [name, opts, m, points] of [
        [
          "tuft",
          { tuft: true },
          tuft.model,
          [
            [0, 489],
            [-150, 450],
            [150, 450],
            [-190, 400],
            [190, 400],
          ],
        ],
        ["crownGap", { crownGap: true }, crownGap.model, across(rowY(45))],
        ["faceGap", { faceGap: true }, faceGap.model, across(rowY(205))],
      ] as const) {
        const held = rig(opts, {}, { drop: ALL_RUNS }).model;
        const faceless = rig(opts, {}, { drop: (role) => role === "face" });
        for (const [label, rigged] of [
          [name, m],
          [`${name}, the face's runs left out`, faceless.model],
        ] as const) {
          for (const ax of [-30, -15, 15, 30]) {
            for (const [x, y] of points) {
              expect(
                edge(rigged, "hair_front", x, y, ax),
                `${label}, (${x}, ${y}), AngleX ${ax}`,
              ).toBe(edge(held, "hair_front", x, y, ax));
            }
          }
        }
      }
    });

    it("holds the crown over a gap just above the plate's top that the nod carries over the face", () => {
      // Looking down, the bangs on rows 197–199 drop about 3 px further than
      // the face, over its top rows: the crown row whose window reaches the
      // gap holds, the face's runs read or its crop standing in.
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
        // end follows it: the two never meet, so the crown rides whole.
        expect(shift(besideFaceGap.model, 0, 489, -30)).toBeCloseTo(CORE, 2);
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
        expect(shift(m, 0, 489, -30)).toBeCloseTo(0.118, 2);
      });
    });
  });

  it("nods by the profile: the forehead drops further than the chin", () => {
    const down = { [P.AngleY]: -30 };
    const up = { [P.AngleY]: 30 };
    const dy = (id: string, x: number, y: number, pose: ParamValues) =>
      (landedYAt(model, id, x, y, pose) - y) / HH;
    // Screen-down is −y here.
    expect(dy("face", 0, 290, down)).toBeCloseTo(-0.17, 1);
    expect(dy("face", 0.5, -190, down)).toBeCloseTo(-0.109, 2);
    expect(dy("face", 0.5, -190, up)).toBeCloseTo(0.0875, 2);
    expect(dy("iris_L", 106, EYE_Y, down)).toBeCloseTo(-0.202, 2);
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
        expect(drop(m, "hair_front", 0, 150, -30), name).toBeCloseTo(0.189, 2);
        expect(drop(m, "hair_front", 0, 150, 30), name).toBeCloseTo(-0.11, 2);
        expect(drop(m, "hair_back", -350, -300, -30), name).toBeCloseTo(
          0.025,
          2,
        );
        expect(drop(m, "hair_back", -350, -300, 30), name).toBeCloseTo(
          -0.011,
          2,
        );
      }
    });

    it("slides the cap's top with the face over a back hair drawn up past it, today's without runs", () => {
      // Just under the bangs' top (490): looking down, the samples' 0.174
      // over a back hair painted above it in every column, the back hair's
      // own 0.025 with no runs to tell; looking up, 0.035 either way.
      for (const [name, m, down] of [
        ["fullBack", fullBack.model, 0.174],
        ["default", model, 0.025],
      ] as const) {
        expect(drop(m, "hair_front", 0, 489, -30), name).toBeCloseTo(down, 2);
        expect(drop(m, "hair_front", 0, 489, 30), name).toBeCloseTo(-0.035, 2);
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
      // bangs', let the top slide about 0.01 hh past today's 0.025 (as many
      // whole rows as that leaves), and the tuft does not lift it: the axis
      // column slides as they do.
      const d = drop(m, "hair_front", 0, 489, -30);
      expect(d).toBeCloseTo(0.025 + 0.01, 2);
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
      expect(d).toBeCloseTo(0.025 + 0.01, 2);
      expect(drop(m, "hair_front", -200, 489, -30)).toBeCloseTo(d, 4);
      expectBound(crownLosses({ dip: true }, m), true);
    });

    it("slides the cap's top the whole way past a dip the bangs' own nod mostly bares", () => {
      // The same 4 px dip on the dome's shoulder, where each column's top
      // sits lower, and the crown there takes enough of the bangs' nod to
      // bare all but two rows of it at the back hair's own slide: within
      // the 0.01 hh budget, so it holds nothing.
      const { model: m } = rig({ shoulderDip: true });
      expect(drop(m, "hair_front", 0, 489, -30)).toBeCloseTo(0.174, 2);
      expectBound(crownLosses({ shoulderDip: true }, m), false);
    });
  });

  it("rolls the head a third of AngleZ about the chin", () => {
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
      // AngleZ is clockwise-positive.
      expect(roll).toBeCloseTo(-z / 3, 1);
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
    // besideFaceGap).
    for (const [name, m] of [
      ["default", model],
      ["fullBack", fullBack.model],
      ["tuft", tuft.model],
      ["wideBack", wideBack.model],
      ["crownGap", crownGap.model],
      ["faceGap", faceGap.model],
      ["besideFaceGap", besideFaceGap.model],
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
    // Given the chin's slide at a full turn (51 px on the fixture), the band
    // still runs deep under the chin, but the cut draws its end that slide
    // and 2 px short of the outline: past there, only the fringe margin
    // (thinned there to under 1.4 px) and the cut's low filter over three
    // columns of the V (about 1.7 px) lie under the stroke.
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

describe("the ears", () => {
  /** The fixture's face narrowed by 25 px but for rows 170…260 of its
   *  crop, which step out to its drawn width: ears. */
  function withEars() {
    const { layers, options } = character();
    const face = layers.find((l) => l.role === "face")!;
    const rows = face.rowHalfWidths!.map((w, r) =>
      r >= 170 && r <= 260 ? w : Math.max(10, w - 25),
    );
    const eared = layers.map((l) =>
      l === face ? { ...l, rowHalfWidths: rows } : l,
    );
    return {
      m: generateIkiFromLayerSet(eared, CANVAS, options),
      frame: buildHeadFrame(eared, {
        headHalfWidth: 262,
        headEdges: options.headEdges,
      }),
    };
  }

  it("lags the ears behind the face — the far one most — with no seam at rest", () => {
    const { m, frame } = withEars();
    // On crop row 215 (model y 500 − 200 − 215): the far ear near its outer
    // rim, the near one at its widest reach, where its lag is whole.
    const ear = (x: number, ax: number) =>
      landedXAt(m, "face", x, 85, X30(ax)) - x;
    const face = (ax: number) => landedXAt(m, "face", 0.5, 85, X30(ax)) - 0.5;
    for (const ax of [-30, 30]) {
      const s = Math.sign(ax);
      const far = s < 0 ? -192 : 193;
      const near = frame.axisX - s * frame.ears!.outer;
      expect(ear(far, ax) / face(ax)).toBeCloseTo(0.44, 1);
      expect(ear(near, ax) / face(ax)).toBeCloseTo(0.87, 1);
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
});

describe("extreme combined poses", () => {
  it("squeezes no face or hair triangle below 40 % when turn, nod, tilt and sway meet", () => {
    const S = [-30, -15, 0, 15, 30];
    for (const [name, { model }] of [
      ["default", hero],
      ["fullBack", fullBack],
      ["tuft", tuft],
      ["wideBack", wideBack],
      ["crownGap", crownGap],
      ["faceGap", faceGap],
      ["besideFaceGap", besideFaceGap],
    ] as const) {
      for (const id of ["face", "hair_front", "hair_back"]) {
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
    // The upper lid comes down 0.58 of the eye's height (it rests at y 100,
    // 66 px tall).
    expect(crease).toBeCloseTo(100 - 0.58 * 66, 1);
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
        // Where the head's roll alone (a third of AngleZ) would take the
        // point.
        const a = (-z / 3) * (Math.PI / 180);
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
    const a = (-10 * Math.PI) / 180;
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
      // The profile's tip travel at full sway: 0.06 hh.
      expect(
        (landedXAt(model, id, top.transform.x, endY, sway) - top.transform.x) /
          HH,
      ).toBeCloseTo(0.06, 2);
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
    expect(lift("face", 0, 250)).toBeCloseTo(0.016, 3);
    expect(lift("body", 0, -400)).toBeCloseTo(0.025, 3);
    expect(lift("face", 0, -240)).toBeCloseTo(0.025, 3);
  });
});
