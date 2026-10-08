import { describe, expect, it } from "vitest";
import type { Affine } from "@ikijs/engine";
import { StandardParameter as P } from "@ikijs/format";
import {
  generateIkiFromLayerSet,
  parseLayerRoles,
  partIdsOfRole,
  type LayerInput,
} from "@ikijs/editor";
import {
  ARM_IDS,
  ELBOW_RANGE,
  armGeometry,
  endPivot,
  type ArmRole,
} from "../src/auto-rig/arms";
import {
  POSE_ANGLE_RANGE,
  POSE_IDS,
  POSE_PARAMS,
  forearmPoseGeometry,
  type ForearmPoseRole,
} from "../src/auto-rig/forearm-pose";
import { boxOfLayer, cx } from "../src/auto-rig/layout";
import {
  ARM_RADIUS,
  POSE_L_BOX,
  POSE_R_BOX,
  fullBody,
} from "./helpers/full-body";
import * as oracle from "./helpers/render-oracle";

const withPoses = fullBody({ arms: true, poses: true });
const layerOf = (role: string): LayerInput =>
  withPoses.layers.find((l) => l.role === role)!;
const AXIS = cx(boxOfLayer(layerOf("body")));
const rowY = (row: number) => withPoses.canvas.height / 2 - (row + 0.5);

const apply = (w: Affine, p: { x: number; y: number }) => ({
  x: w[0] * p.x + w[2] * p.y + w[4],
  y: w[1] * p.x + w[3] * p.y + w[5],
});

describe("forearm-pose.ts: geometry", () => {
  it("puts the pivot ARM_RADIUS above the last painted row, at the run centre", () => {
    const g = forearmPoseGeometry(layerOf("forearm_pose_R"));
    const box = POSE_R_BOX;
    const last = box.y + box.h - 1;
    expect(g.radius).toBe(ARM_RADIUS);
    expect(g.pivot.x).toBe(box.x + box.w / 2 - withPoses.canvas.width / 2);
    expect(g.pivot.y).toBeCloseTo(rowY(last - ARM_RADIUS), 2);
    expect(g.top).toBeCloseTo(rowY(box.y), 2);
  });

  it("lands the pivot on the arm's elbow", () => {
    for (const side of ["L", "R"] as const) {
      const pose = forearmPoseGeometry(layerOf(`forearm_pose_${side}`));
      const arm = armGeometry(layerOf(`arm_${side}`), AXIS);
      expect(pose.pivot.x).toBeCloseTo(arm.elbow.x, 2);
      expect(pose.pivot.y).toBeCloseTo(arm.elbow.y, 2);
    }
  });

  it("endPivot(top) is the arm's shoulder and its radius", () => {
    const arm = layerOf("arm_R");
    const g = armGeometry(arm, AXIS);
    const top = endPivot(arm, "top");
    expect(top.point).toEqual(g.shoulder);
    expect(top.radius).toBe(g.shoulderRadius);
  });

  it("reads a slanted crop's pivot on the bottom rows' centre", () => {
    const pose = layerOf("forearm_pose_R");
    const bottom = pose.bbox.y + pose.bbox.h;
    // Every 4 rows up from the bottom, the runs shift 1 px toward +x.
    const shifted: LayerInput = {
      ...pose,
      rowRuns: pose.rowRuns!.map(([s, e], k) => {
        const d = Math.floor((bottom - (pose.bbox.y + k) - 1) / 4);
        return [s + d, e + d];
      }),
    };
    const { point, radius } = endPivot(shifted, "bottom");
    const flat = endPivot(pose, "bottom");
    expect(radius).toBe(flat.radius);
    const k = Math.round(pose.bbox.h - 1 - ARM_RADIUS);
    const [s, e] = shifted.rowRuns![k];
    expect(point.x).toBe((s + e) / 2 - pose.canvasW / 2);
  });
});

describe("the pose forearm on the full body", () => {
  const { layers, options, canvas } = withPoses;
  const model = generateIkiFromLayerSet(layers, canvas, options);
  const roles: ForearmPoseRole[] = ["forearm_pose_L", "forearm_pose_R"];
  const armOf = (r: ForearmPoseRole) => `arm_${r.slice(-1)}` as ArmRole;
  const part = (id: string) => model.parts.find((p) => p.id === id)!;

  it("ends the draw order on the two pose forearms, and parses", () => {
    expect(model.parts.map((p) => p.id).slice(-3)).toEqual([
      "hair_front",
      "forearm_pose_L",
      "forearm_pose_R",
    ]);
    expect(() => parseLayerRoles(layers.map((l) => l.fileName))).not.toThrow();
  });

  it("draws each as its crop's full-box quad, no mesh, no warps", () => {
    for (const role of roles) {
      const p = part(role);
      const box = role === "forearm_pose_L" ? POSE_L_BOX : POSE_R_BOX;
      expect(p.mesh).toBeUndefined();
      expect(p.warps).toBeUndefined();
      expect([p.width, p.height]).toEqual([box.w, box.h]);
      const b = boxOfLayer(layerOf(role));
      expect(p.transform).toEqual({
        x: (b.x0 + b.x1) / 2,
        y: (b.y0 + b.y1) / 2,
      });
      // At rest the implicit quad lands on the box.
      const v = oracle.landVertices(model, role);
      expect([v[0], v[1], v[6], v[7]]).toEqual([b.x0, b.y1, b.x1, b.y0]);
    }
  });

  it("hangs each from its arm's deformer at A's elbow", () => {
    for (const role of roles) {
      const d = model.deformers!.find((x) => x.id === POSE_IDS[role])!;
      expect(part(role).deformer).toBe(POSE_IDS[role]);
      expect(d.parent).toBe(ARM_IDS[armOf(role)].armDeformer);
      expect(d.pivot).toEqual(armGeometry(layerOf(armOf(role)), AXIS).elbow);
    }
    expect(partIdsOfRole("forearm_pose_L")).toEqual(["forearm_pose_L"]);
  });

  it("swaps with exclusive opacity bindings", () => {
    for (const role of roles) {
      const swap = [
        {
          parameter: POSE_PARAMS[role].pose,
          channel: "opacity",
          from: 1,
          to: 0,
        },
      ];
      const ids = ARM_IDS[armOf(role)];
      expect(part(ids.forearm).bindings).toEqual(swap);
      expect(part(ids.cap).bindings).toEqual(swap);
      expect(part(armOf(role)).bindings).toBeUndefined();
      expect(part(role).bindings).toEqual([{ ...swap[0], from: 0, to: 1 }]);
    }
  });

  it("rocks by -side x the value and ignores the elbow", () => {
    for (const role of roles) {
      const arm = armGeometry(layerOf(armOf(role)), AXIS);
      const pose = forearmPoseGeometry(layerOf(role));
      const max = POSE_ANGLE_RANGE[1];
      const rocked = oracle.deformerWorld(model, POSE_IDS[role], {
        [POSE_PARAMS[role].angle]: max,
      });
      const hand = apply(rocked, { x: pose.pivot.x, y: pose.top });
      // The pivot holds; the hand tips away from the body's axis.
      const p = apply(rocked, arm.elbow);
      expect(p.x).toBeCloseTo(arm.elbow.x, 3);
      expect(p.y).toBeCloseTo(arm.elbow.y, 3);
      expect(Math.sign(hand.x - pose.pivot.x)).toBe(arm.side);
      // ParamArmPoseAngle + and the matching turn: -side x max, CCW-positive.
      const deg = Math.atan2(rocked[1], rocked[0]) * (180 / Math.PI);
      expect(deg).toBeCloseTo(-arm.side * max, 3);

      const rest = oracle.deformerWorld(model, POSE_IDS[role]);
      const bent = oracle.deformerWorld(model, POSE_IDS[role], {
        [role === "forearm_pose_L" ? P.ElbowLeft : P.ElbowRight]:
          ELBOW_RANGE[1],
      });
      expect(Array.from(bent)).toEqual(Array.from(rest));
    }
  });

  it("declares the switch and the angle right after the elbow", () => {
    const ids = model.parameters.map((p) => p.id);
    for (const [side, elbow] of [
      ["L", P.ElbowLeft],
      ["R", P.ElbowRight],
    ] as const) {
      const at = ids.indexOf(elbow);
      expect(ids.slice(at + 1, at + 3)).toEqual([
        `ParamArmPose${side}`,
        `ParamArmPoseAngle${side}`,
      ]);
    }
    const byId = (id: string) => model.parameters.find((p) => p.id === id)!;
    expect(byId(P.ArmPoseLeft)).toMatchObject({ min: 0, max: 1, default: 0 });
    expect(byId(P.ArmPoseAngleRight)).toMatchObject({
      min: POSE_ANGLE_RANGE[0],
      max: POSE_ANGLE_RANGE[1],
      default: 0,
    });
  });

  it("keeps every opacity binding within 0..1", () => {
    for (const p of model.parts) {
      for (const b of p.bindings ?? []) {
        if (b.channel !== "opacity") continue;
        expect(Math.min(b.from, b.to)).toBeGreaterThanOrEqual(0);
        expect(Math.max(b.from, b.to)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("changes nothing without a pose forearm", () => {
    const bare = fullBody({ arms: true });
    const m = generateIkiFromLayerSet(bare.layers, bare.canvas, bare.options);
    const ids = m.parameters.map((p) => p.id);
    for (const id of [
      P.ArmPoseLeft,
      P.ArmPoseRight,
      P.ArmPoseAngleLeft,
      P.ArmPoseAngleRight,
    ]) {
      expect(ids).not.toContain(id);
    }
    expect(
      m.parts.some((p) =>
        p.bindings?.some(
          (b) => b.channel === "opacity" && /arm|elbow/.test(p.id),
        ),
      ),
    ).toBe(false);
    expect(m.deformers!.some((d) => d.id.startsWith("armPose"))).toBe(false);
  });

  it("refuses a pose forearm without its arm", () => {
    const noArm = layers.filter((l) => l.role !== "arm_L");
    expect(() => generateIkiFromLayerSet(noArm, canvas, options)).toThrow(
      /forearm_pose_L needs an arm_L layer/,
    );
    expect(() => parseLayerRoles(noArm.map((l) => l.fileName))).toThrow(
      /forearm_pose_L needs an arm_L layer/,
    );
  });
});
