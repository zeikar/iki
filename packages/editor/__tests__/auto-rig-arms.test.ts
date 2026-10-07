import { describe, expect, it } from "vitest";
import { StandardParameter as P, type IkiMesh } from "@ikijs/format";
import { LayerGeometryError, type LayerInput } from "@ikijs/editor";
import {
  CAP_SEGMENTS,
  ELBOW_AT,
  armDeformers,
  armGeometry,
  armParts,
  type ArmRole,
} from "../src/auto-rig/arms";
import { BODY_WARP_ID } from "../src/auto-rig/body";
import {
  bh,
  boxOfLayer,
  bw,
  cx,
  cy,
  meshPoints,
  roundTo,
} from "../src/auto-rig/layout";
import {
  ARM_L_BOX,
  ARM_R_BOX,
  ARM_RADIUS,
  fullBody,
} from "./helpers/full-body";

const { layers, canvas } = fullBody({ arms: true });
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
