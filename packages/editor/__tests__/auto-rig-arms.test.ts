import { describe, expect, it } from "vitest";
import type { Affine } from "@ikijs/engine";
import {
  StandardParameter as P,
  parseIkiModel,
  type IkiMesh,
  type IkiModel,
} from "@ikijs/format";
import {
  LayerGeometryError,
  generateIkiFromLayerSet,
  partIdsOfRole,
  type LayerInput,
} from "@ikijs/editor";
import {
  ARM_IDS,
  ARM_PARAMS,
  CAP_SEGMENTS,
  ELBOW_AT,
  armDeformers,
  armGeometry,
  armParts,
  type ArmRole,
} from "../src/auto-rig/arms";
import { BODY_WARP_ID } from "../src/auto-rig/body";
import { buildHeadFrame } from "../src/auto-rig/head";
import {
  bh,
  boxOfLayer,
  bw,
  cx,
  cy,
  meshPoints,
  roundTo,
} from "../src/auto-rig/layout";
import { AMPLITUDE, BODY } from "../src/auto-rig/profile";
import { ROLE_TABLE } from "../src/auto-rig/roles";
import {
  ARM_L_BOX,
  ARM_R_BOX,
  ARM_RADIUS,
  fullBody,
} from "./helpers/full-body";
import * as oracle from "./helpers/render-oracle";

const { layers, options, canvas } = fullBody({ arms: true });
const layerOf = (role: string): LayerInput =>
  layers.find((l) => l.role === role)!;
/** The body's axis, model x: the arms' sides are read against it. */
const AXIS = cx(boxOfLayer(layerOf("body")));
/** Model x of canvas column `col`, and model y of canvas row `row`'s centre. */
const colX = (col: number) => col - canvas.width / 2;
const rowY = (row: number) => canvas.height / 2 - (row + 0.5);

const span = (vs: number[]): [number, number] => [
  Math.min(...vs),
  Math.max(...vs),
];
const ysOf = (mesh: IkiMesh) => mesh.vertices.filter((_, i) => i % 2 === 1);

describe("arms.ts: geometry", () => {
  // The capsule's straight span is its crop's full width, so the shoulder's
  // and the elbow's rows are centred on the crop.
  const shoulderRow = ARM_RADIUS;
  const lastRow = ARM_R_BOX.h - 1;
  const elbowRow = Math.round(shoulderRow + ELBOW_AT * (lastRow - shoulderRow));

  it("puts arm_R's shoulder r_u under its first row and its elbow ELBOW_AT on to its last, turning CW", () => {
    const g = armGeometry(layerOf("arm_R"), AXIS);
    const mid = colX(ARM_R_BOX.x + ARM_R_BOX.w / 2);
    expect(mid).toBe(-250);
    expect(g.shoulderRadius).toBe(ARM_RADIUS);
    expect(g.shoulder).toEqual({
      x: mid,
      y: rowY(ARM_R_BOX.y + shoulderRow),
    });
    expect(g.elbow).toEqual({ x: mid, y: rowY(ARM_R_BOX.y + elbowRow) });
    // Half the run + 1 would reach 1 px past the crop's sides.
    expect(g.capRadius).toBe(ARM_RADIUS);
    expect(g.side).toBe(-1);
  });

  it("mirrors it on arm_L, which turns CCW", () => {
    const r = armGeometry(layerOf("arm_R"), AXIS);
    const l = armGeometry(layerOf("arm_L"), AXIS);
    expect(colX(ARM_L_BOX.x + ARM_L_BOX.w / 2)).toBe(
      2 * AXIS - colX(ARM_R_BOX.x + ARM_R_BOX.w / 2),
    );
    expect(l).toEqual({
      shoulder: { x: 2 * AXIS - r.shoulder.x, y: r.shoulder.y },
      shoulderRadius: r.shoulderRadius,
      elbow: { x: 2 * AXIS - r.elbow.x, y: r.elbow.y },
      capRadius: r.capRadius,
      side: 1,
    });
  });

  it("reads each row's widest run, first or last, not the crop", () => {
    // A 2 px gap splits every row that reaches it, leaving the arm an 89 px
    // run on the straight span and a 9 px sliver: right of the sliver, then
    // left of it.
    const arm = layerOf("arm_R");
    const [x0, x1] = [ARM_R_BOX.x, ARM_R_BOX.x + ARM_R_BOX.w];
    for (const [gap, wide] of [
      [x0 + 9, [x0 + 11, x1]],
      [x1 - 11, [x0, x1 - 11]],
    ] as const) {
      const split: LayerInput = {
        ...arm,
        rowRuns: arm.rowRuns!.map(([s, e]) =>
          s < gap && gap + 2 < e ? [s, gap, gap + 2, e] : [s, e],
        ),
      };
      const g = armGeometry(split, AXIS);
      const ru = (wide[1] - wide[0]) / 2;
      const mid = colX((wide[0] + wide[1]) / 2);
      const ks = ru; // the first painted row is the crop's first
      const ke = Math.round(ks + ELBOW_AT * (lastRow - ks));
      expect(g.shoulderRadius).toBe(ru);
      expect(g.shoulder).toEqual({ x: mid, y: rowY(ARM_R_BOX.y + ks) });
      expect(g.elbow).toEqual({ x: mid, y: rowY(ARM_R_BOX.y + ke) });
      // Half the run + 1, clamped by the crop's edge on the run's far side.
      expect(g.capRadius).toBe(
        Math.min(ru + 1, mid - colX(x0), colX(x1) - mid),
      );
      expect(g.capRadius).toBe(ru);
    }
  });

  it("reads the first and the last painted rows, not the crop's", () => {
    // The crop takes alpha the runs do not, so its edge rows can be blank.
    const arm = layerOf("arm_R");
    const [top, bottom] = [2, 6];
    const blank: LayerInput = {
      ...arm,
      rowRuns: arm.rowRuns!.map((runs, k) =>
        k < top || k >= ARM_R_BOX.h - bottom ? [] : runs,
      ),
    };
    const g = armGeometry(blank, AXIS);
    const [first, last] = [top, ARM_R_BOX.h - 1 - bottom];
    const ks = first + ARM_RADIUS;
    const ke = Math.round(ks + ELBOW_AT * (last - ks));
    expect([ks, ke]).toEqual([52, 321]);
    expect(g.shoulder).toEqual({ x: -250, y: rowY(ARM_R_BOX.y + ks) });
    expect(g.elbow).toEqual({ x: -250, y: rowY(ARM_R_BOX.y + ke) });
  });

  it("falls back to the crop without runs: the shoulder half its width under its top", () => {
    // Wider than the capsule, so the crop's reading differs from the runs'.
    const arm = layerOf("arm_R");
    const bbox = { ...arm.bbox, w: 120 };
    const g = armGeometry(
      { ...arm, bbox, cropW: bbox.w, rowRuns: undefined },
      AXIS,
    );
    const mid = colX(bbox.x + bbox.w / 2);
    const ke = Math.round(60 + ELBOW_AT * (lastRow - 60));
    expect(g.shoulderRadius).toBe(60);
    expect(g.shoulder).toEqual({ x: mid, y: rowY(bbox.y + 60) });
    expect(g.elbow).toEqual({ x: mid, y: rowY(bbox.y + ke) });
    expect(g.capRadius).toBe(60);
    expect(g.side).toBe(-1);
  });

  it("refuses an arm too short for its width to hang an elbow under the shoulder", () => {
    // 100 px wide and 50 tall: the shoulder would sit 50 px down, under the
    // last row.
    const arm = layerOf("arm_R");
    const bbox = { ...arm.bbox, h: 50 };
    const stub = { ...arm, bbox, cropH: bbox.h, rowRuns: undefined };
    expect(() => armGeometry(stub, AXIS)).toThrow(LayerGeometryError);
    expect(() => armGeometry(stub, AXIS)).toThrow(
      /^auto-rig: layer "arm_R\.png": the arm is too short for its width to place a shoulder above an elbow/,
    );
  });
});

describe("arms.ts: meshes", () => {
  const arm = layerOf("arm_L");
  const b = boxOfLayer(arm);
  const g = armGeometry(arm, AXIS);
  const [upper, fore] = armParts("arm_L", arm, g, 7);
  // Vertices are written to 1e-5 of the box, so each lands within half that
  // of its width and of its height: under 1e-5 of the height (7e-3 px here)
  // from where it was meant.
  const tol = 1e-5 * bh(b);

  it("cuts both parts from the crop's box, the forearm over the upper arm", () => {
    for (const p of [upper, fore]) {
      expect(p.color).toEqual([1, 1, 1, 1]);
      expect([p.width, p.height]).toEqual([bw(b), bh(b)]);
      expect(p.transform).toEqual({ x: cx(b), y: cy(b) });
      // The host points both at the crop's rect (`partIdsOfRole`).
      expect(p.texture).toBeUndefined();
    }
    expect([upper.id, upper.deformer, upper.order]).toEqual([
      "arm_L",
      "armDeformer_L",
      7,
    ]);
    expect([fore.id, fore.deformer, fore.order]).toEqual([
      "forearm_L",
      "forearmDeformer_L",
      8,
    ]);
  });

  it("splits the crop at the seam: the upper arm above it, the forearm's band below", () => {
    const seam = roundTo((g.elbow.y - cy(b)) / bh(b), 1e-5);
    expect(span(ysOf(upper.mesh!))).toEqual([seam, 0.5]);
    expect(span(ysOf(fore.mesh!).slice(0, 4))).toEqual([-0.5, seam]);
    expect(Math.abs(cy(b) + seam * bh(b) - g.elbow.y)).toBeLessThanOrEqual(tol);
    expect(upper.mesh!.indices).toEqual([2, 3, 0, 0, 3, 1]);
  });

  it("caps the elbow with a fan over the half-disc above the seam", () => {
    const vs = meshPoints(fore.mesh!, b);
    // The band's four, the centre, and the arc's CAP_SEGMENTS + 1.
    expect(vs).toHaveLength(4 + 1 + CAP_SEGMENTS + 1);
    const [centre, ...arc] = vs.slice(4);
    expect(
      Math.hypot(centre[0] - g.elbow.x, centre[1] - g.elbow.y),
    ).toBeLessThanOrEqual(tol);
    arc.forEach(([x, y], i) => {
      expect(
        Math.abs(Math.hypot(x - g.elbow.x, y - g.elbow.y) - g.capRadius),
      ).toBeLessThanOrEqual(tol);
      // Evenly from angle 0 round to π: the half-disc above the seam.
      const a = (Math.PI * i) / CAP_SEGMENTS;
      expect(
        Math.hypot(
          x - (g.elbow.x + g.capRadius * Math.cos(a)),
          y - (g.elbow.y + g.capRadius * Math.sin(a)),
        ),
      ).toBeLessThanOrEqual(tol);
    });
    expect(fore.mesh!.indices).toEqual([
      2,
      3,
      0,
      0,
      3,
      1,
      ...Array.from({ length: CAP_SEGMENTS }, (_, i) => [
        4,
        5 + i,
        6 + i,
      ]).flat(),
    ]);
  });

  it("maps every UV to its vertex, and the two meshes together span the box", () => {
    for (const mesh of [upper.mesh!, fore.mesh!]) {
      const { vertices, uvs } = mesh;
      expect(uvs).toHaveLength(vertices.length);
      for (let i = 0; i < vertices.length; i += 2) {
        expect(Math.abs(uvs[i] - (vertices[i] + 0.5))).toBeLessThan(1e-9);
        expect(Math.abs(uvs[i + 1] - (0.5 - vertices[i + 1]))).toBeLessThan(
          1e-9,
        );
      }
    }
    const all = [...meshPoints(upper.mesh!, b), ...meshPoints(fore.mesh!, b)];
    expect(span(all.map(([x]) => x))).toEqual([b.x0, b.x1]);
    expect(span(all.map(([, y]) => y))).toEqual([b.y0, b.y1]);
  });
});

describe("arms.ts: deformers", () => {
  const rig = (role: ArmRole) => {
    const g = armGeometry(layerOf(role), AXIS);
    return { g, deformers: armDeformers(role, g) };
  };

  it("hangs the arm from the body warp at the shoulder, and the forearm from the arm at the elbow", () => {
    for (const [role, s] of [
      ["arm_L", "L"],
      ["arm_R", "R"],
    ] as const) {
      const {
        g,
        deformers: [arm, fore],
      } = rig(role);
      expect([arm.id, arm.parent, arm.pivot]).toEqual([
        `armDeformer_${s}`,
        BODY_WARP_ID,
        g.shoulder,
      ]);
      expect([fore.id, fore.parent, fore.pivot]).toEqual([
        `forearmDeformer_${s}`,
        `armDeformer_${s}`,
        g.elbow,
      ]);
    }
  });

  it("turns each 1:1 in degrees, + outward: CCW on arm_L at +x, CW on arm_R", () => {
    const binding = (parameter: string, from: number, to: number) => [
      { parameter, channel: "rotate", from, to },
    ];
    const [armL, foreL] = rig("arm_L").deformers;
    expect(armL.bindings).toEqual(binding(P.ArmLeft, -30, 150));
    expect(foreL.bindings).toEqual(binding(P.ElbowLeft, -30, 150));
    const [armR, foreR] = rig("arm_R").deformers;
    expect(armR.bindings).toEqual(binding(P.ArmRight, 30, -150));
    expect(foreR.bindings).toEqual(binding(P.ElbowRight, 30, -150));
  });
});

type Point = { x: number; y: number };

/** An affine's image of p. */
const apply = (w: Affine, p: Point): Point => ({
  x: w[0] * p.x + w[2] * p.y + w[4],
  y: w[1] * p.x + w[3] * p.y + w[5],
});

/** p rotated `deg` (CCW-positive) about `about`. */
function rotated(p: Point, about: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const [dx, dy] = [p.x - about.x, p.y - about.y];
  return {
    x: about.x + dx * Math.cos(r) - dy * Math.sin(r),
    y: about.y + dx * Math.sin(r) + dy * Math.cos(r),
  };
}

const mid = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function expectAt(actual: Point, expected: Point, tol: number, label = "") {
  expect(Math.abs(actual.x - expected.x), `${label} x`).toBeLessThanOrEqual(
    tol,
  );
  expect(Math.abs(actual.y - expected.y), `${label} y`).toBeLessThanOrEqual(
    tol,
  );
}

/** Whether (x, y) lies in the triangle t of the landed vertices v. */
function inTriangle(v: Float32Array, t: number[], x: number, y: number) {
  const d = (a: number, b: number) =>
    (v[b * 2] - v[a * 2]) * (y - v[a * 2 + 1]) -
    (x - v[a * 2]) * (v[b * 2 + 1] - v[a * 2 + 1]);
  const s = [d(t[0], t[1]), d(t[1], t[2]), d(t[2], t[0])];
  return s.every((e) => e >= -1e-6) || s.every((e) => e <= 1e-6);
}

describe("arms on the full body", () => {
  const model: IkiModel = generateIkiFromLayerSet(layers, canvas, options);
  const hh = buildHeadFrame(layers, {}).hh;
  const ARMS = ["arm_L", "arm_R"] as const;
  const geometry = (role: ArmRole) => armGeometry(layerOf(role), AXIS);
  /** A matrix deformer's world rotation, degrees, CCW-positive. */
  const rollOf = (id: string, params: oracle.ParamValues) => {
    const w = oracle.deformerWorld(model, id, params);
    return (Math.atan2(w[1], w[0]) * 180) / Math.PI;
  };
  /** The forearm quad's two bottom vertices (the band's third and fourth),
   *  landed. */
  const bottoms = (role: ArmRole, params: oracle.ParamValues = {}) => {
    const v = oracle.landVertices(model, ARM_IDS[role].forearm, params);
    return [
      { x: v[4], y: v[5] },
      { x: v[6], y: v[7] },
    ];
  };
  /** B, the forearm quad's bottom midpoint: under the affine deformers it
   *  lands at the midpoint of its two vertices' landings. */
  const bottomOf = (role: ArmRole, params: oracle.ParamValues = {}) => {
    const [a, b] = bottoms(role, params);
    return mid(a, b);
  };

  it("orders hair_back, body, the arms, then the head, and parses", () => {
    expect(model.parts.map((p) => p.id).slice(0, 7)).toEqual([
      "hair_back",
      "body",
      "arm_L",
      "forearm_L",
      "arm_R",
      "forearm_R",
      "face",
    ]);
    model.parts.forEach((p, i) => expect(p.order).toBe(i));
    expect(model.deformers!.map((d) => d.id).slice(0, 6)).toEqual([
      BODY_WARP_ID,
      "armDeformer_L",
      "forearmDeformer_L",
      "armDeformer_R",
      "forearmDeformer_R",
      "headDeformer",
    ]);
    expect(() => parseIkiModel(model)).not.toThrow();
    // Both shoulders lie inside the body warp's rest grid.
    const warp = model.deformers!.find((d) => d.id === BODY_WARP_ID)!;
    if (warp.kind !== "warp") throw new Error("bodyWarp is not a warp");
    const { cols, rows, points } = warp.grid;
    const xs = [points[0], points[cols * 2]];
    const ys = [points[1], points[rows * (cols + 1) * 2 + 1]];
    for (const role of ARMS) {
      const arm = model.deformers!.find(
        (d) => d.id === ARM_IDS[role].armDeformer,
      )!;
      if (arm.kind === "warp") throw new Error("the arm is not a matrix");
      expect(arm.pivot).toEqual(geometry(role).shoulder);
      expect(arm.pivot.x).toBeGreaterThan(xs[0]);
      expect(arm.pivot.x).toBeLessThan(xs[1]);
      expect(arm.pivot.y).toBeLessThan(ys[0]);
      expect(arm.pivot.y).toBeGreaterThan(ys[1]);
    }
  });

  it("declares Arm L / Elbow L and Arm R / Elbow R, −30..150, after the body angles", () => {
    const ids = model.parameters.map((p) => p.id);
    const z = ids.indexOf(P.BodyAngleZ);
    expect(ids.slice(z + 1, z + 5)).toEqual([
      P.ArmLeft,
      P.ElbowLeft,
      P.ArmRight,
      P.ElbowRight,
    ]);
    for (const [id, name] of [
      [P.ArmLeft, "Arm L"],
      [P.ElbowLeft, "Elbow L"],
      [P.ArmRight, "Arm R"],
      [P.ElbowRight, "Elbow R"],
    ]) {
      expect(model.parameters.find((p) => p.id === id)).toEqual({
        id,
        name,
        min: -30,
        max: 150,
        default: 0,
      });
    }
  });

  it("rests both arm parts on the art", () => {
    for (const role of ARMS) {
      const b = boxOfLayer(layerOf(role));
      const v = [
        ...oracle.landVertices(model, role),
        ...oracle.landVertices(model, ARM_IDS[role].forearm),
      ];
      const xs = span(v.filter((_, i) => i % 2 === 0));
      const ys = span(v.filter((_, i) => i % 2 === 1));
      expectAt({ x: xs[0], y: ys[0] }, { x: b.x0, y: b.y0 }, 0.5, role);
      expectAt({ x: xs[1], y: ys[1] }, { x: b.x1, y: b.y1 }, 0.5, role);
    }
  });

  it("rigs only the arm it is given: arm_R alone gets the R pair", () => {
    const right = generateIkiFromLayerSet(
      layers.filter((l) => l.role !== "arm_L"),
      canvas,
      options,
    );
    expect(() => parseIkiModel(right)).not.toThrow();
    const ids = right.parts.map((p) => p.id);
    expect(ids.slice(0, 5)).toEqual([
      "hair_back",
      "body",
      "arm_R",
      "forearm_R",
      "face",
    ]);
    expect(ids.filter((id) => /arm_/.test(id))).toEqual(["arm_R", "forearm_R"]);
    expect(
      right.deformers!.map((d) => d.id).filter((id) => /armDeformer_/.test(id)),
    ).toEqual(["armDeformer_R", "forearmDeformer_R"]);
    expect(
      right.parameters
        .map((p) => p.id)
        .filter((id) => /^Param(Arm|Elbow)/.test(id)),
    ).toEqual([P.ArmRight, P.ElbowRight]);
  });

  it("lists every part through partIdsOfRole", () => {
    const roles = new Set(layers.map((l) => l.role));
    expect(model.parts.map((p) => p.id)).toEqual(
      ROLE_TABLE.filter((r) => roles.has(r.role)).flatMap((r) =>
        partIdsOfRole(r.role),
      ),
    );
  });

  it("raises each arm outward about its shoulder", () => {
    for (const [role, deg] of [
      ["arm_L", 90],
      ["arm_R", -90],
    ] as const) {
      const g = geometry(role);
      const pose = { [ARM_PARAMS[role].arm]: 90 };
      const world = oracle.deformerWorld(
        model,
        ARM_IDS[role].armDeformer,
        pose,
      );
      expectAt(apply(world, g.shoulder), g.shoulder, 1e-3, role);
      const e = apply(world, g.elbow);
      expectAt(e, rotated(g.elbow, g.shoulder, deg), 1e-3, role);
      // Outward: away from the body's axis, on either side.
      expect(Math.sign(e.x - g.elbow.x)).toBe(g.side);
      // The forearm is carried rigidly.
      expect(
        Math.abs(dist(e, bottomOf(role, pose)) - dist(g.elbow, bottomOf(role))),
      ).toBeLessThan(0.01);
    }
  });

  it("bends the forearm about the elbow, the upper arm still", () => {
    for (const [role, deg] of [
      ["arm_L", 90],
      ["arm_R", -90],
    ] as const) {
      const g = geometry(role);
      const pose = { [ARM_PARAMS[role].elbow]: 90 };
      expect(oracle.landVertices(model, role, pose)).toEqual(
        oracle.landVertices(model, role),
      );
      const rest = bottoms(role);
      const posed = bottoms(role, pose);
      rest.forEach((r, i) =>
        expectAt(posed[i], rotated(r, g.elbow, deg), 1e-3, `${role} ${i}`),
      );
      expectAt(
        bottomOf(role, pose),
        rotated(bottomOf(role), g.elbow, deg),
        1e-3,
        role,
      );
    }
  });

  it("keeps the elbow covered at any bend", () => {
    const g = geometry("arm_L");
    const fore = model.parts.find((p) => p.id === "forearm_L")!;
    const idx = fore.mesh!.indices;
    const tris = Array.from({ length: idx.length / 3 }, (_, t) =>
      idx.slice(t * 3, t * 3 + 3),
    );
    const poses: oracle.ParamValues[] = [
      ...[0, 45, 90, 150].map((v) => ({ [P.ElbowLeft]: v })),
      { [P.ArmLeft]: 60, [P.ElbowLeft]: 120 },
    ];
    for (const pose of poses) {
      const v = oracle.landVertices(model, "forearm_L", pose);
      const e = apply(
        oracle.deformerWorld(model, "forearmDeformer_L", pose),
        g.elbow,
      );
      for (const k of [0.25, 0.5, 0.9]) {
        for (let i = 0; i < 24; i++) {
          // Half a step off the seam's line, which the band and the cap
          // share as an edge.
          const a = ((i + 0.5) * 2 * Math.PI) / 24;
          const x = e.x + k * g.capRadius * Math.cos(a);
          const y = e.y + k * g.capRadius * Math.sin(a);
          expect(
            tris.some((t) => inTriangle(v, t, x, y)),
            `${JSON.stringify(pose)} r ${k} #${i}`,
          ).toBe(true);
        }
      }
    }
  });

  it("rides the body: the arms lift on the breath and roll with BodyAngleZ, unsquashed", () => {
    for (const role of ARMS) {
      const g = geometry(role);
      const id = ARM_IDS[role].armDeformer;
      const shoulder = (params: oracle.ParamValues) =>
        apply(oracle.deformerWorld(model, id, params), g.shoulder);
      const breath = { [P.Breath]: 1 };
      const lift = AMPLITUDE.breathBody * hh;
      expectAt(
        shoulder(breath),
        { x: g.shoulder.x, y: g.shoulder.y + lift },
        0.02,
        role,
      );
      const b = bottomOf(role);
      expectAt(bottomOf(role, breath), { x: b.x, y: b.y + lift }, 0.02, role);

      expect(
        Math.abs(rollOf(id, { [P.BodyAngleZ]: 10 }) + BODY.rollDeg),
      ).toBeLessThan(0.05);
      const turn = { [P.BodyAngleX]: 10 };
      expect(Math.abs(rollOf(id, turn))).toBeLessThan(0.01);
      const length = (params: oracle.ParamValues) =>
        dist(shoulder(params), bottomOf(role, params));
      expect(Math.abs(length(turn) - length({}))).toBeLessThan(0.01);
    }
  });
});
