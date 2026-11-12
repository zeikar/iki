import { describe, expect, it } from "vitest";
import {
  StandardParameter as P,
  parseIkiModel,
  type IkiModel,
} from "@ikijs/format";
import {
  generateIkiFromLayerSet,
  parseLayerRoles,
  partIdsOfRole,
  type LayerInput,
} from "@ikijs/editor";
import { AMPLITUDE, ROLL_DEG } from "../src/auto-rig/profile";
import { ROLE_TABLE } from "../src/auto-rig/roles";
import { CANVAS, character } from "./helpers/character";
import {
  landVertices,
  landedXAt,
  landedCentroidX,
  rig,
  signedAreas,
  HH,
  withEars,
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
const sideLocks = rig({ sideLocks: true });

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
    expect(() => parseLayerRoles(base.slice(0, 3))).toThrow(
      /missing required role mouth \(or the lip set/,
    );
  });

  it("reads the side locks, and refuses one without the front hair, in the role parse and in the generator", () => {
    expect(
      parseLayerRoles([
        ...base,
        "hair_front.png",
        "hair_side_L.png",
        "Hair-Side-R.png",
      ]).map((p) => p.role),
    ).toEqual([
      ...base.map((f) => f.slice(0, -4)),
      "hair_front",
      "hair_side_L",
      "hair_side_R",
    ]);
    expect(() => parseLayerRoles([...base, "hair_side_R.png"])).toThrow(
      /hair_side_R needs a hair_front layer/,
    );
    // The bust's front hair relabelled as a lock: a lock and no front hair.
    const { layers, options } = character();
    expect(() =>
      generateIkiFromLayerSet(
        layers.map((l) =>
          l.role === "hair_front" ? { ...l, role: "hair_side_R" } : l,
        ),
        CANVAS,
        options,
      ),
    ).toThrow(/hair_side_R needs a hair_front layer/);
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

  it("names the parts each role layer becomes: one per role but an arm's two, and refuses an unknown role", () => {
    const roles = new Set(character().layers.map((l) => l.role));
    expect(model.parts.map((p) => p.id)).toEqual(
      ROLE_TABLE.filter((r) => roles.has(r.role)).flatMap((r) =>
        partIdsOfRole(r.role),
      ),
    );
    expect(partIdsOfRole("face")).toEqual(["face"]);
    expect(partIdsOfRole("arm_L")).toEqual(["elbow_L", "forearm_L", "arm_L"]);
    expect(() => partIdsOfRole("nope")).toThrow(/unknown role "nope"/);
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
      P.BodyAngleX,
      P.BodyAngleY,
      P.BodyAngleZ,
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
      P.HairBackSway,
      P.AmbientSway,
    ]) {
      expect(ids).toContain(id);
    }
    expect(model.parameters.find((p) => p.id === P.AmbientSway)).toEqual({
      id: P.AmbientSway,
      name: "Ambient Sway",
      min: -1,
      max: 1,
      default: 0,
    });
    // The turn and the tilt lag (a held one returns the hair to rest); the
    // idle's ambient sway is followed.
    const spring = { mass: 1, stiffness: 77, damping: 7 };
    expect(model.physics).toEqual([
      {
        id: "hairSway",
        inputs: [
          { parameter: P.AngleX, weight: 1, mode: "lag" },
          { parameter: P.AmbientSway, weight: 0.25 },
        ],
        output: { parameter: P.HairSwayX, scale: 14 },
        ...spring,
      },
      {
        id: "hairTilt",
        input: { parameter: P.AngleZ, weight: 1, mode: "lag" },
        output: { parameter: P.HairSwayZ, scale: 9 },
        ...spring,
      },
      // The back hair's one merged spring, slower than the front's: the ambient
      // is a lag input so the back idles a beat behind the front. The three
      // bounds (7 × 1, 7 × 0.4, 7 × 1.73) are held under 20 together by
      // hair-motion.test.ts on the real driver.
      {
        id: "hairBack",
        inputs: [
          { parameter: P.AngleX, weight: 1, mode: "lag" },
          { parameter: P.AngleZ, weight: 0.4, mode: "lag" },
          { parameter: P.AmbientSway, weight: 1.73, mode: "lag" },
        ],
        output: { parameter: P.HairBackSway, scale: 7 },
        mass: 1,
        stiffness: 32,
        damping: 4.5,
      },
    ]);
    // Front hair without a back layer: the two front springs only.
    const noBack = character();
    const frontOnly = generateIkiFromLayerSet(
      noBack.layers.filter((l) => l.role !== "hair_back"),
      CANVAS,
      {
        ...noBack.options,
        headEdges: {
          left: noBack.options.headEdges!.left.filter(
            (e) => e.role !== "hair_back",
          ),
          right: noBack.options.headEdges!.right.filter(
            (e) => e.role !== "hair_back",
          ),
        },
      },
    );
    expect(frontOnly.physics!.map((r) => r.id)).toEqual([
      "hairSway",
      "hairTilt",
    ]);
    expect(frontOnly.parameters.map((p) => p.id)).not.toContain(P.HairBackSway);
    const bald = rig({ hair: false }).model;
    expect(bald.physics).toBeUndefined();
    const baldIds = bald.parameters.map((p) => p.id);
    expect(baldIds).not.toContain(P.HairSwayX);
    expect(baldIds).not.toContain(P.HairBackSway);
    expect(baldIds).not.toContain(P.AmbientSway);
  });

  it("is deterministic", () => {
    expect(rig().model).toEqual(model);
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
      ["sideLocks", sideLocks.model, [...all, "hair_side_L", "hair_side_R"]],
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
                  [P.HairBackSway]: s,
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

  describe("the lower lash", () => {
    const { layers, options } = character();
    // The lower lid's line along the bottom of the white, in its frame.
    const lower = (side: "L" | "R"): LayerInput => {
      const eye = layers.find((l) => l.role === `eye_${side}`)!;
      return {
        ...eye,
        role: `lash_lower_${side}`,
        fileName: `lash_lower_${side}.png`,
        bbox: { ...eye.bbox, y: eye.bbox.y + 46, h: 20 },
        cropH: 20,
      };
    };
    const without = generateIkiFromLayerSet(layers, CANVAS, options);
    const model = generateIkiFromLayerSet(
      [...layers, lower("L"), lower("R")],
      CANVAS,
      options,
    );
    const minY = (v: Float32Array) => {
      let m = Infinity;
      for (let i = 1; i < v.length; i += 2) m = Math.min(m, v[i]);
      return m;
    };

    it("draws over the iris and under the lash, unclipped", () => {
      const ids = model.parts.map((p) => p.id);
      expect(
        ids.slice(ids.indexOf("iris_R") + 1, ids.indexOf("lash_L")),
      ).toEqual(["lash_lower_L", "lash_lower_R"]);
      expect(model.parts.find((p) => p.id === "lash_lower_L")!.clip).toBe(
        undefined,
      );
    });

    it("leaves every other part, deformer and parameter as it was", () => {
      const strip = (m: IkiModel) => ({
        ...m,
        parts: m.parts
          .filter((p) => !p.id.startsWith("lash_lower_"))
          .map(({ order: _order, ...p }) => p),
      });
      expect(strip(model)).toEqual(strip(without));
    });

    it("folds with the white onto its crease", () => {
      const shut = { [P.EyeOpenLeft]: 0 };
      const crease = landVertices(model, "eye_L", shut)[1];
      const v = landVertices(model, "lash_lower_L", shut);
      for (let i = 1; i < v.length; i += 2) expect(v[i]).toBeCloseTo(crease, 3);
      // Half shut, its bottom row stays on the white's.
      const half = { [P.EyeOpenLeft]: 0.5 };
      expect(minY(landVertices(model, "lash_lower_L", half))).toBeCloseTo(
        minY(landVertices(model, "eye_L", half)),
        3,
      );
      expect(landVertices(model, "lash_lower_R", shut)).toEqual(
        landVertices(model, "lash_lower_R"),
      );
    });
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
      const sway = {
        [id === "hair_front" ? P.HairSwayX : P.HairBackSway]: 20,
      };
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

  it("fades the blush on Cheek, faint at rest and as drawn at 1", () => {
    const { model: m } = rig({ extras: true });
    expect(m.parameters.find((p) => p.id === P.Cheek)).toEqual({
      id: P.Cheek,
      name: "Cheek",
      min: 0,
      max: 1,
      default: 0,
    });
    for (const id of ["blush_L", "blush_R"]) {
      expect(m.parts.find((p) => p.id === id)!.bindings).toEqual([
        {
          parameter: P.Cheek,
          channel: "opacity",
          from: AMPLITUDE.blushRest,
          to: 1,
        },
      ]);
    }
    // No blush, no Cheek.
    expect(model.parameters.some((p) => p.id === P.Cheek)).toBe(false);
  });

  it("breathes: the shoulders and the neck lift, the head a little less, the cut bottom still", () => {
    // Raw: the head's net lift is the body warp's carry of the chin and its
    // own breath together.
    const b = { [P.Breath]: 1 };
    const lift = (id: string, x: number, y: number) =>
      (oracle.landedYAt(model, id, x, y, b) -
        oracle.landedYAt(model, id, x, y)) /
      HH;
    expect(lift("face", 0, 250)).toBeCloseTo(AMPLITUDE.breathHead, 3);
    expect(lift("face", 0, -240)).toBeCloseTo(AMPLITUDE.breathBody, 3);
    // The torso's full band, and its bottom, cut by the canvas, planted.
    expect(lift("body", 0, -300)).toBeCloseTo(AMPLITUDE.breathBody, 3);
    expect(lift("body", 0, -500)).toBeCloseTo(0, 3);
  });
});
