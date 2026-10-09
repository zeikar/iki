/**
 * `generateIkiFromLayerSet`: role layers in, a rigged `.iki` out.
 *
 * The rig's shape is a 2D head rig's usual one (`profile.ts`): a body warp
 * (`body.ts`) that breathes, follows the head's turn and tilt a little and
 * turns on BodyAngleX/Y/Z, its legs planted; a head deformer hung from it
 * that rolls about the chin and breathes; each arm hung from it too, as an
 * upper arm, a forearm and an elbow cap turning about the shoulder and the
 * elbow (`arms.ts`), and with a drawn pose forearm a switch that swaps it in
 * for the hanging one (`forearm-pose.ts`); one small warp grid per feature
 * (each eye, each brow, the nose, the mouth), translating and foreshortening
 * it by its own lead over the plate; and the plate, the hair and the blush
 * moved by per-vertex keyforms of their own — the plate as up to four
 * islands of one drawing: a head that slides, a neck that stays on the torso
 * and two ears that lag. Blink, gaze, brows, mouth, breath and
 * hair sway are part warps and bindings under those. The model also declares
 * the default expressions and the Nod, Shake and Tilt motions, and
 * with a pose forearm the Wave (`animations.ts`). The mouth has two paths,
 * chosen by the layers: `mouth` alone stretches, with `mouth_open` it
 * crossfades; the lip set folds open like the eyelid (`mouth.ts`).
 */

import {
  IKI_FORMAT_VERSION,
  StandardParameter as P,
  parseIkiModel,
  type IkiBinding,
  type IkiDeformer,
  type IkiMesh,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiPhysics,
  type IkiWarp,
  type IkiWarpDeformer,
} from "@ikijs/format";
import { defaultExpressions, defaultMotions } from "./animations";
import {
  ARM_RANGE,
  ELBOW_RANGE,
  armDeformers,
  armGeometry,
  armParts,
  type ArmGeometry,
  type ArmRole,
} from "./arms";
import {
  POSE_ANGLE_RANGE,
  POSE_OF_ARM,
  POSE_PARAMS,
  forearmPoseDeformer,
  forearmPosePart,
  type ForearmPoseRole,
} from "./forearm-pose";
import {
  BODY_WARP_ID,
  buildBodyWarp,
  headOwnBreath,
  headOwnRoll,
} from "./body";
import { checkHeadEdges, checkLayers, checkStrandEdges } from "./checks";
import { renderedLander, sideIrises, solveContext } from "./context";
import { buildHeadFrame, type HeadFrame } from "./head";
import { buildFaceMesh, type Region } from "./face-mesh";
import {
  bh,
  boxOfLayer,
  bw,
  cellsFor,
  cx,
  cy,
  columnMesh,
  gridMesh,
  roundTo,
  unionBoxes,
  type Box,
  type Cells,
} from "./layout";
import {
  isLipRole,
  roleOfPart,
  roleSpec,
  ROLE_TABLE,
  type Family,
  type RoleSpec,
} from "./roles";
import {
  buildMouthRig,
  isLipSet,
  mouthFoldWarp,
  mouthMesh,
  type MouthRig,
} from "./mouth";
import { bake, lattice, X_STOPS, Y_STOPS, type Lattice } from "./grid";
import {
  chinSlide,
  earField,
  familyField,
  hairFrontBends,
  neckField,
  type Field,
  type HairFrontGrid,
  type TurnModel,
} from "./fields";
import {
  buildTurn,
  checkedKeys,
  checkedNumber,
  fitTurn,
  resolveTurnTargets,
  TURN_TARGET_KEYS,
  turnReport,
  type ResolvedTargets,
  type TurnFit,
} from "./solve";
import {
  blinkFold,
  browBindings,
  browReach,
  gazeBindings,
  gazeReach,
  hairHangWeight,
  hairSway,
  lashFold,
  localWarp,
  motionReach,
  mouthForm,
  mouthOpenGrow,
  mouthWiden,
  SWAY_RANGE,
  tiltHang,
  type Reach,
} from "./drivers";
import {
  AMPLITUDE,
  STYLE_KNOBS,
  resolveStyle,
  type ResolvedStyle,
} from "./profile";
import { type GenerateOptions, type LayerInput } from "./types";

/** Mesh cells per role. The plate's head island carries the chin's lead and
 *  the jaw's narrowing; the hair only sways and hangs. */
const MESH_CELLS: Record<string, Cells> = {
  face: { px: 28, min: 4, max: 24 },
  // The front hair eases from riding the face to holding the outline.
  hair_front: { px: 32, min: 3, max: 24 },
  hair_back: { px: 56, min: 3, max: 18 },
};
const NECK_CELLS: Cells = { px: 20, min: 3, max: 12 };
const FEATURE_MESH_CELLS: Cells = { px: 14, min: 2, max: 12 };

type GridFamily = "eye_L" | "eye_R" | "brow_L" | "brow_R" | "nose" | "mouth";

/** Grid cells per feature: each only translates, foreshortens and tilts, so a
 *  few cells carry it; they mostly hold the room its own motions need. */
const GRID_CELLS: Record<GridFamily, Cells> = {
  eye_L: { px: 24, min: 2, max: 8 },
  eye_R: { px: 24, min: 2, max: 8 },
  brow_L: { px: 32, min: 2, max: 6 },
  brow_R: { px: 32, min: 2, max: 6 },
  nose: { px: 16, min: 2, max: 8 },
  mouth: { px: 16, min: 2, max: 8 },
};
const WARP_ID: Record<GridFamily, string> = {
  eye_L: "eyeWarp_L",
  eye_R: "eyeWarp_R",
  brow_L: "browWarp_L",
  brow_R: "browWarp_R",
  nose: "noseWarp",
  mouth: "mouthWarp",
};
const isGridFamily = (f: Family): f is GridFamily => f in WARP_ID;
/** An arm's spec: the `arm` family, whose roles `arms.ts` rigs. */
const isArm = (spec: RoleSpec): spec is RoleSpec & { role: ArmRole } =>
  spec.family === "arm";
/** A pose forearm's spec: the `forearm_pose` family, whose roles
 *  `forearm-pose.ts` rigs. */
const isPose = (spec: RoleSpec): spec is RoleSpec & { role: ForearmPoseRole } =>
  spec.family === "forearm_pose";
const GRID_PAD = 6;

type Grids = Map<Family, { lattice: Lattice; keyforms: number[][] }>;

export function generateIkiFromLayerSet(
  layers: LayerInput[],
  canvas: { width: number; height: number },
  options: GenerateOptions = {},
): IkiModel {
  checkLayers(layers, canvas);
  const byRole = new Map(layers.map((l) => [l.role, l]));
  const has = (role: string) => byRole.has(role);
  const box = (role: string) => boxOfLayer(byRole.get(role)!);
  const hasNose = has("nose");
  const plateHalf = byRole.get("face")!.cropW / 2;

  checkHeadEdges(options.headEdges, byRole);
  checkStrandEdges(
    options.strandEdges,
    sideIrises(byRole),
    has("hair_front") ? box("hair_front") : undefined,
  );
  checkedKeys("style", options.style, STYLE_KNOBS);
  const style = resolveStyle(options.style, (name, v, lo, hi) =>
    checkedNumber(name, v, lo, hi),
  );

  // Without a nose there is no turn to fit: the face turns on the profile,
  // inside its own outline. Every turn option — the cues, the measured head,
  // its edges and strands — is then inert; the edges and strands are still
  // checked against the layers, and the cues' object for a misspelt field.
  checkedKeys("turnTargets", options.turnTargets, TURN_TARGET_KEYS);
  const targets: ResolvedTargets = hasNose
    ? resolveTurnTargets(options.turnTargets, plateHalf)
    : { given: new Set() };
  const turnOptions: GenerateOptions = hasNose ? options : {};
  const frameOptions = {
    headHalfWidth: targets.headHalfWidth,
    headEdges:
      targets.headHalfWidth !== undefined ? options.headEdges : undefined,
  };
  const solveFrame = buildHeadFrame(layers, frameOptions);

  // --- the turn ---
  const ctx = solveContext(solveFrame, byRole, turnOptions, hasNose);
  const boxes: TurnModel["boxes"] = Object.fromEntries(
    (["eye_L", "eye_R", "brow_L", "brow_R"] as const)
      .filter(has)
      .map((r) => [r, box(r)]),
  );
  const landmarks: Pick<
    TurnModel,
    "boxes" | "noseAt" | "noseTopY" | "mouthAt" | "hairTop" | "hairFrontGrid"
  > = {
    boxes,
    noseAt: ctx.noseAt,
    noseTopY: ctx.noseBox?.y1,
    mouthAt: ctx.mouthAt,
    hairTop: has("hair_front") ? box("hair_front").y1 : solveFrame.face.y1,
    // The field reads the grid the mesh is built on (the rebuilt frame below
    // differs only in the jaw's cut, which the grid does not read).
    hairFrontGrid: has("hair_front")
      ? hairFrontGrid(box("hair_front"), solveFrame, boxes)
      : undefined,
  };
  const build = (q: Parameters<typeof buildTurn>[2]) =>
    buildTurn(solveFrame, landmarks, q);
  // Without a nose there are no targets, but the art's room still bounds
  // the profile's turn.
  const fit: TurnFit = fitTurn(ctx, targets, style, build);

  // The jaw's cut takes the chin's shade only as far as the solved turn
  // keeps it inside the neck, so the frame is rebuilt with the chin's slide;
  // the two differ only in the cut, which the solve does not read.
  const frame = buildHeadFrame(layers, {
    ...frameOptions,
    chinSlide: chinSlide(fit.model),
  });
  const turn: TurnModel = { ...fit.model, frame };

  // --- the body warp the head and the arms hang from ---
  // An arm implies a body (`checkLayers`); its side is read off the body's
  // axis, and its shoulder is a pivot the body warp's band A must hold.
  const arms = new Map<ArmRole, ArmGeometry>();
  for (const spec of ROLE_TABLE) {
    const layer = byRole.get(spec.role);
    if (layer === undefined || !isArm(spec)) continue;
    arms.set(spec.role, armGeometry(layer, cx(box("body"))));
  }
  const bodyWarp = has("body")
    ? buildBodyWarp({
        body: byRole.get("body")!,
        chin: { x: frame.axisX, y: frame.chinY },
        hh: frame.hh,
        pivots: [...arms.values()].map((g) => g.shoulder),
      })
    : undefined;

  // --- parts, with the warps and bindings that are not the turn's ---
  const lips = isLipSet(byRole) ? buildMouthRig(byRole) : undefined;
  const parts: IkiPart[] = [];
  const reach = new Map<string, Reach>();
  let regionOf: Region[] = [];
  let headStart = 0;
  for (const spec of ROLE_TABLE) {
    const layer = byRole.get(spec.role);
    if (layer === undefined) continue;
    if (isArm(spec)) {
      // Three parts cut from the one crop, on the arm's two deformers; with a
      // pose forearm, the forearm and the cap swap out for it.
      const pose = POSE_OF_ARM[spec.role];
      parts.push(
        ...armParts(
          spec.role,
          layer,
          arms.get(spec.role)!,
          parts.length,
          has(pose) ? POSE_PARAMS[pose].pose : undefined,
        ),
      );
      continue;
    }
    if (isPose(spec)) {
      parts.push(forearmPosePart(spec.role, layer, parts.length));
      continue;
    }
    const built = buildPart(
      spec,
      boxOfLayer(layer),
      parts.length,
      frame,
      byRole,
      style,
      landmarks.hairFrontGrid,
      lips,
    );
    if (built.region !== undefined) {
      regionOf = built.region;
      headStart = built.headStart;
    }
    reach.set(spec.role, built.reach);
    parts.push(built.part);
  }

  // --- the features' grids ---
  const grids: Grids = new Map();
  for (const family of Object.keys(WARP_ID) as GridFamily[]) {
    const members = parts.filter(
      (p) => roleSpec(roleOfPart(p.id)).family === family,
    );
    if (members.length === 0) continue;
    const area = unionBoxes(
      members.map((p) => {
        const r = reach.get(p.id)!;
        const b = box(p.id);
        return {
          x0: b.x0 - r.left - GRID_PAD,
          x1: b.x1 + r.right + GRID_PAD,
          y0: b.y0 - r.bottom - GRID_PAD,
          y1: b.y1 + r.top + GRID_PAD,
        };
      }),
    );
    const cells = GRID_CELLS[family];
    const l = lattice(area, cells.px, cells.min, cells.max);
    grids.set(family, {
      lattice: l,
      keyforms: bake(l, familyField(turn, family)),
    });
  }

  // --- the plate, the blush and the hair: their own turn keyforms ---
  for (const part of parts) {
    const family = roleSpec(roleOfPart(part.id)).family;
    if (isGridFamily(family)) {
      part.deformer = WARP_ID[family];
      continue;
    }
    if (family === "body") {
      // Its mesh is cut on the body warp's lattice lines (`bodyMesh`), and
      // the warp is its whole motion.
      part.deformer = BODY_WARP_ID;
      part.mesh = bodyWarp!.mesh;
      continue;
    }
    // `armParts` and `forearmPosePart` hung each on its own deformer.
    if (family === "arm" || family === "forearm_pose") continue;
    part.deformer = "headDeformer";
    if (part.mesh === undefined) continue;
    const own = familyField(turn, family);
    const fieldOf: (i: number) => Field =
      part.id === "face" ? plateFields(turn, regionOf, own) : () => own;
    part.warps = [
      ...turnWarps(part.mesh, box(part.id), fieldOf),
      ...(part.warps ?? []),
    ];
  }

  const parameters = declareParameters(new Set(byRole.keys()));
  const model: IkiModel = {
    version: IKI_FORMAT_VERSION,
    name: "auto-rigged",
    canvas: { width: canvas.width, height: canvas.height },
    parameters,
    parts,
    deformers: deformers(frame, grids, bodyWarp?.deformer, arms, byRole),
    ...(has("hair_front") ? { physics: hairPhysics() } : {}),
    expressions: defaultExpressions(new Set(parameters.map((p) => p.id))),
    motions: defaultMotions(new Set(parameters.map((p) => p.id))),
  };

  // Reported only for a model that validates.
  const valid = parseIkiModel(model);
  if (hasNose && options.onTurnSolved) {
    options.onTurnSolved(
      turnReport(
        ctx,
        fit,
        renderedLander(turn, parts, grids, new Map([["face", headStart]])),
      ),
    );
  }
  return valid;
}

/** A part's own turn and nod keyforms off its vertices' fields — split into
 *  AngleX and AngleY, which add as the fields do. */
function turnWarps(
  mesh: IkiMesh,
  b: Box,
  fieldOf: (i: number) => Field,
): IkiWarp[] {
  return [
    localWarp(P.AngleX, mesh, b, X_STOPS, ([x, y], v, i) =>
      v === 0 ? [0, 0] : [fieldOf(i)(x, y, v, 0)[0], 0],
    ),
    localWarp(P.AngleY, mesh, b, Y_STOPS, ([x, y], v, i) =>
      v === 0 ? [0, 0] : [0, fieldOf(i)(x, y, 0, v)[1]],
    ),
  ];
}

/** The plate's islands each on their own motion: the head on the plate's
 *  field, the ears lagging it, the neck still but for the shade under the
 *  chin. */
function plateFields(
  turn: TurnModel,
  region: Region[],
  head: Field,
): (i: number) => Field {
  const ear = earField(turn);
  const neck = neckField(turn);
  return (i) =>
    region[i] === "ear" ? ear : region[i] === "neck" ? neck : head;
}

// --- parts ----------------------------------------------------------------------

function buildPart(
  spec: RoleSpec,
  b: Box,
  order: number,
  frame: HeadFrame,
  byRole: Map<string, LayerInput>,
  style: ResolvedStyle,
  frontGrid: HairFrontGrid | undefined,
  lips: MouthRig | undefined,
): { part: IkiPart; reach: Reach; region?: Region[]; headStart: number } {
  const box = (role: string) => boxOfLayer(byRole.get(role)!);
  const part: IkiPart = {
    id: spec.role,
    color: [1, 1, 1, 1],
    width: bw(b),
    height: bh(b),
    transform: { x: cx(b), y: cy(b) },
    order,
  };
  const pivot: [number, number] = [frame.axisX, frame.chinY];
  const warps: IkiWarp[] = [];
  const bindings: IkiBinding[] = [];
  let extra: [number, number] = [0, 0];
  let mesh: IkiMesh | undefined;
  let knotXs: number[] | undefined;
  let region: Region[] | undefined;
  let headStart = 0;
  if (spec.role === "face") {
    const px = Math.min(MESH_CELLS.face.px, (2 * frame.wMax) / 14);
    const fm = buildFaceMesh(frame, b, { ...MESH_CELLS.face, px }, NECK_CELLS);
    mesh = fm.mesh;
    region = fm.region;
    headStart = fm.headStart;
  } else if (spec.role === "hair_front") {
    mesh = columnMesh(b, frontGrid!);
  } else if (lips !== undefined && isLipRole(spec.role)) {
    ({ mesh, xs: knotXs } = mouthMesh(b, lips.knots));
  } else if (spec.family !== "body") {
    const cells = MESH_CELLS[spec.role] ?? FEATURE_MESH_CELLS;
    // No coarser than a fraction of the head, whatever its size.
    const px = Math.min(cells.px, meshScale(spec.role, frame));
    mesh = gridMesh(
      cellsFor(bw(b), px, cells.min, cells.max),
      cellsFor(bh(b), px, cells.min, cells.max),
    );
  }
  if (mesh !== undefined) part.mesh = mesh;
  const side = spec.role.endsWith("_L") ? "L" : "R";
  const eyeOpen = side === "L" ? P.EyeOpenLeft : P.EyeOpenRight;
  const hh = frame.hh;
  switch (spec.role) {
    case "face":
      if (region?.some((r) => r === "neck")) {
        const isNeck = region.map((r) => r === "neck");
        // The neck stays on the shoulders through the roll, undoing the
        // head's own roll only, and rises with them on a breath (the head
        // rises less).
        warps.push(
          tiltHang(
            mesh!,
            b,
            pivot,
            (_y, i) => (isNeck[i] ? 1 : 0),
            headOwnRoll(byRole.has("body")),
          ),
          localWarp(P.Breath, mesh!, b, [0, 1], (_p, v, i) =>
            v === 1 && isNeck[i]
              ? [0, (AMPLITUDE.breathBody - AMPLITUDE.breathHead) * hh]
              : [0, 0],
          ),
        );
      }
      break;
    case "eye_L":
    case "eye_R":
      warps.push(blinkFold(eyeOpen, mesh!, b, style.blink));
      break;
    case "lash_lower_L":
    case "lash_lower_R":
      warps.push(blinkFold(eyeOpen, mesh!, b, style.blink, box(`eye_${side}`)));
      break;
    case "lash_L":
    case "lash_R":
      warps.push(lashFold(eyeOpen, mesh!, b, box(`eye_${side}`), style.blink));
      break;
    case "iris_L":
    case "iris_R":
    case "pupil_L":
    case "pupil_R":
    case "highlight_L":
    case "highlight_R": {
      // A highlight is a reflection: it travels half as far.
      const share = spec.role.startsWith("highlight") ? 0.5 : 1;
      const iris = byRole.get(`iris_${side}`);
      const irisW =
        iris !== undefined ? iris.cropW : 0.46 * bw(box(`eye_${side}`));
      bindings.push(...gazeBindings(irisW, share));
      extra = gazeReach(irisW, share);
      part.clip = { masks: [`eye_${side}`] };
      break;
    }
    case "brow_L":
    case "brow_R": {
      const r = browReach(hh);
      bindings.push(...browBindings(side, r));
      extra = [0.15 * bw(b), r + 0.15 * bw(b)];
      break;
    }
    case "mouth":
      warps.push(mouthForm(mesh!, b));
      if (byRole.has("mouth_open")) {
        warps.push(mouthWiden(mesh!, b));
        // Two multiplying fades: the closed lips are gone by the time the
        // open drawing is half grown.
        bindings.push(
          { parameter: P.MouthOpen, channel: "opacity", from: 1, to: 0 },
          { parameter: P.MouthOpen, channel: "opacity", from: 1, to: 0 },
        );
        extra = [(AMPLITUDE.mouthOpenWidth - 1) * (bw(b) / 2), 0];
      } else {
        // One drawing only: stretch it open downward from its top lip, to
        // the profile's open height, and wider.
        const grow = Math.max(
          0,
          (AMPLITUDE.mouthOpenHeight * bw(b)) / bh(b) - 1,
        );
        bindings.push(
          {
            parameter: P.MouthOpen,
            channel: "scaleY",
            from: 0,
            to: roundTo(grow, 0.01),
          },
          {
            parameter: P.MouthOpen,
            channel: "scaleX",
            from: 0,
            to: roundTo(AMPLITUDE.mouthOpenWidth - 1, 0.01),
          },
          {
            parameter: P.MouthOpen,
            channel: "translateY",
            from: 0,
            to: -roundTo((grow * bh(b)) / 2, 0.01),
          },
        );
        extra = [(AMPLITUDE.mouthOpenWidth - 1) * (bw(b) / 2), grow * bh(b)];
      }
      break;
    case "mouth_open":
      warps.push(mouthForm(mesh!, b), mouthOpenGrow(mesh!, b));
      bindings.push({
        parameter: P.MouthOpen,
        channel: "opacity",
        from: 0,
        to: 1,
      });
      extra = [(AMPLITUDE.mouthOpenWidth - 1) * (bw(b) / 2), 0];
      break;
    case "mouth_inner":
    case "lip_lower":
    case "lip_upper":
      // Every travel is a warp, so `extra` stays 0 and `motionReach` sees it.
      warps.push(
        mouthFoldWarp(spec.role, mesh!, knotXs!, b, lips!.opening),
        mouthForm(mesh!, b, lips!.frame),
        mouthWiden(mesh!, b, lips!.frame),
      );
      break;
    case "blush_L":
    case "blush_R":
      bindings.push({
        parameter: P.Cheek,
        channel: "opacity",
        from: AMPLITUDE.blushRest,
        to: 1,
      });
      break;
    case "hair_front":
    case "hair_back":
      if (byRole.has("hair_front")) {
        const amp = style.sway * AMPLITUDE.sway * hh;
        warps.push(
          hairSway(P.HairSwayX, mesh!, b, amp),
          hairSway(P.HairSwayZ, mesh!, b, amp),
        );
      }
      warps.push(tiltHang(mesh!, b, pivot, hairHangWeight(frame.chinY, b.y0)));
      break;
  }
  if (warps.length > 0) part.warps = warps;
  if (bindings.length > 0) part.bindings = bindings;
  return {
    part,
    reach: motionReach(part.warps, mesh, b, extra),
    region,
    headStart,
  };
}

/** The front hair's mesh grid over its box `b`: even cells no coarser than a
 *  fraction of the head, plus columns where its follow bends, so the mesh
 *  carries the bends exactly. */
function hairFrontGrid(
  b: Box,
  frame: HeadFrame,
  boxes: TurnModel["boxes"],
): HairFrontGrid {
  const cells = MESH_CELLS.hair_front;
  const px = Math.min(cells.px, meshScale("hair_front", frame));
  const cols = cellsFor(bw(b), px, cells.min, cells.max);
  const rows = cellsFor(bh(b), px, cells.min, cells.max);
  const { inner, left, right } = hairFrontBends(frame, boxes);
  const step = bw(b) / cols;
  const xs = Array.from({ length: cols + 1 }, (_, c) => b.x0 + c * step);
  for (const x of [
    frame.axisX - left,
    frame.axisX - inner,
    frame.axisX + inner,
    frame.axisX + right,
  ]) {
    if (x <= b.x0 + 0.25 || x >= b.x1 - 0.25) continue;
    const near = xs.findIndex((v) => Math.abs(v - x) < 0.3 * step);
    if (near > 0 && near < xs.length - 1) xs[near] = x;
    else if (near < 0) xs.push(x);
  }
  xs.sort((p, q) => p - q);
  const ys = Array.from(
    { length: rows + 1 },
    (_, r) => b.y1 - (bh(b) * r) / rows,
  );
  return { xs, ys };
}

function meshScale(role: string, frame: HeadFrame): number {
  switch (role) {
    case "hair_front":
    case "hair_back":
      // It only sways and hangs: smooth bends a coarse mesh carries.
      return Math.max(2, (frame.shellRight - frame.shellLeft) / 9);
    default:
      return Infinity;
  }
}

// --- deformers, parameters, physics ---------------------------------------------

function deformers(
  frame: HeadFrame,
  grids: Grids,
  bodyWarp: IkiWarpDeformer | undefined,
  arms: Map<ArmRole, ArmGeometry>,
  byRole: Map<string, LayerInput>,
): IkiDeformer[] {
  const out: IkiDeformer[] = [];
  if (bodyWarp !== undefined) out.push(bodyWarp);
  for (const [role, g] of arms) out.push(...armDeformers(role, g));
  for (const [role, arm] of arms) {
    const pose = POSE_OF_ARM[role];
    if (byRole.has(pose)) out.push(forearmPoseDeformer(pose, arm));
  }
  // On a body, the head's roll and breath are its own, on top of what the
  // body warp already gives the chin (`headOwnRoll`, `headOwnBreath`).
  const hasBody = bodyWarp !== undefined;
  const roll = headOwnRoll(hasBody);
  out.push({
    id: "headDeformer",
    ...(hasBody ? { parent: BODY_WARP_ID } : {}),
    pivot: { x: roundTo(frame.axisX, 0.01), y: roundTo(frame.chinY, 0.01) },
    bindings: [
      // AngleZ is clockwise-positive (Live2D's); a rotation is CCW-positive.
      { parameter: P.AngleZ, channel: "rotate", from: roll, to: -roll },
      {
        parameter: P.Breath,
        channel: "translateY",
        from: 0,
        to: roundTo(headOwnBreath(hasBody) * frame.hh, 0.01),
      },
    ],
  });
  for (const [family, g] of grids) {
    out.push({
      kind: "warp",
      id: WARP_ID[family as GridFamily],
      parent: "headDeformer",
      grid: {
        cols: g.lattice.cols,
        rows: g.lattice.rows,
        points: g.lattice.points,
      },
      warp2d: {
        parameter: P.AngleX,
        parameterY: P.AngleY,
        valuesX: X_STOPS,
        valuesY: Y_STOPS,
        keyforms2d: g.keyforms.map((offsets) => ({ offsets })),
      },
    });
  }
  return out;
}

/** Two springs, one per head axis the hair lags (a rig has one input). Each
 *  settles at a modest share of its range, so a held turn or tilt leaves the
 *  hair only a little swung. */
function hairPhysics(): IkiPhysics[] {
  return [
    {
      id: "hairSway",
      input: { parameter: P.AngleX, weight: 1 },
      output: { parameter: P.HairSwayX, scale: 5 },
      mass: 1,
      stiffness: 30,
      damping: 3,
    },
    {
      id: "hairTilt",
      input: { parameter: P.AngleZ, weight: 1 },
      output: { parameter: P.HairSwayZ, scale: 8 },
      mass: 1,
      stiffness: 25,
      damping: 2.5,
    },
  ];
}

function declareParameters(roles: Set<string>): IkiParameter[] {
  const out: IkiParameter[] = [];
  const add = (
    id: string,
    name: string,
    min: number,
    max: number,
    def: number,
  ) => out.push({ id, name, min, max, default: def });
  add(P.AngleX, "Head Angle", -30, 30, 0);
  add(P.AngleY, "Head Angle Y", -30, 30, 0);
  add(P.AngleZ, "Head Angle Z", -30, 30, 0);
  if (roles.has("body")) {
    add(P.BodyAngleX, "Body Angle X", -10, 10, 0);
    add(P.BodyAngleY, "Body Angle Y", -10, 10, 0);
    add(P.BodyAngleZ, "Body Angle Z", -10, 10, 0);
  }
  const addPose = (side: string, pose: string, angle: string) => {
    add(pose, `Arm Pose ${side}`, 0, 1, 0);
    add(angle, `Arm Pose Angle ${side}`, ...POSE_ANGLE_RANGE, 0);
  };
  const [armMin, armMax] = ARM_RANGE;
  const [elbowMin, elbowMax] = ELBOW_RANGE;
  if (roles.has("arm_L")) {
    add(P.ArmLeft, "Arm L", armMin, armMax, 0);
    add(P.ElbowLeft, "Elbow L", elbowMin, elbowMax, 0);
    if (roles.has("forearm_pose_L"))
      addPose("L", P.ArmPoseLeft, P.ArmPoseAngleLeft);
  }
  if (roles.has("arm_R")) {
    add(P.ArmRight, "Arm R", armMin, armMax, 0);
    add(P.ElbowRight, "Elbow R", elbowMin, elbowMax, 0);
    if (roles.has("forearm_pose_R"))
      addPose("R", P.ArmPoseRight, P.ArmPoseAngleRight);
  }
  add(P.EyeOpenLeft, "Eye L", 0, 1, 1);
  add(P.EyeOpenRight, "Eye R", 0, 1, 1);
  if ([...roles].some((r) => /^(iris|pupil|highlight)_/.test(r))) {
    add(P.EyeballX, "Gaze X", -1, 1, 0);
    add(P.EyeballY, "Gaze Y", -1, 1, 0);
  }
  add(P.MouthOpen, "Mouth Open", 0, 1, 0);
  add(P.MouthForm, "Mouth Form", -1, 1, 0);
  if (roles.has("brow_L")) {
    add(P.BrowLeftY, "Brow L Y", -1, 1, 0);
    add(P.BrowLeftAngle, "Brow L Angle", -1, 1, 0);
  }
  if (roles.has("brow_R")) {
    add(P.BrowRightY, "Brow R Y", -1, 1, 0);
    add(P.BrowRightAngle, "Brow R Angle", -1, 1, 0);
  }
  if (roles.has("blush_L") || roles.has("blush_R")) {
    add(P.Cheek, "Cheek", 0, 1, 0);
  }
  add(P.Breath, "Breath", 0, 1, 0);
  if (roles.has("hair_front")) {
    add(P.HairSwayX, "Hair Sway X", -SWAY_RANGE, SWAY_RANGE, 0);
    add(P.HairSwayZ, "Hair Sway Z", -SWAY_RANGE, SWAY_RANGE, 0);
  }
  return out;
}
