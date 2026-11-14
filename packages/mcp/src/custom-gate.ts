/**
 * The per-part gate for custom parts, reported by `auto_rig_from_layers` and
 * blocking the character loop's candidate: each custom part measured over a
 * pose set for whether it folds, stays tied where it hangs from its anchor,
 * keeps the art it hides hidden, and (rigid parts) does not bend.
 *
 * Every landing is the engine's own `landParts`, through `probe.ts`'s rest
 * triangles, so the numbers are what the player draws. Lengths are in face
 * widths (the `face` part's width), so nothing is tied to one canvas; the
 * values are experiment C's gate over twin's 402 px face. Frame: canvas px,
 * origin top-left, x right, y down.
 */

import { partIdsOfRole, rigidResidual } from "@ikijs/editor";
import {
  checkFolds,
  foldPoses,
  landParts,
  occlusionAmount,
  type FoldPose,
} from "@ikijs/engine";
import { StandardParameter, type IkiModel } from "@ikijs/format";
import { foldPose } from "./fold-report";
import {
  landLocated,
  locate,
  locatePoints,
  restMesh,
  type Located,
  toCanvas,
  type PaintRuns,
  type ProbePoint,
  type RestMesh,
} from "./probe";

/** A custom part as the gate reads it. */
export interface CustomGatePart {
  id: string;
  /** The role the part is fixed against; its first part is the anchor. */
  anchor: string;
  /** Where the part meets the anchor, canvas px. */
  tie: [number, number];
  rigid?: boolean;
  /** The roles of the entry's `occlusion.by`, when it declares one. Their
   *  paint gives the gate the cover it excuses a reading under; without it a
   *  declared occlusion excuses nothing. */
  occludedBy?: string[];
}

export interface CustomGateOptions {
  /** Replaces the default pose set (`RIGID` still adds its stop midpoints). */
  poses?: FoldPose[];
}

/**
 * In face widths (squared for `EXPOSED`). Each is experiment C's gate v2 over
 * twin's 402 px face, the only evidence there is, as a share of that face:
 * `tie` 2 px, `slide` 40 px, `onAnchor` 6 px, `exposed` 150 px², `rigid` 1 px.
 * The fold limit is the engine's own collapse threshold, read from its report.
 */
export const CUSTOM_GATE_LIMITS = {
  tie: 0.005,
  slide: 0.1,
  onAnchor: 0.015,
  exposed: 0.0009,
  rigid: 0.0025,
} as const;

export type CustomGateLimits = typeof CUSTOM_GATE_LIMITS & { fold: number };

/** One measure's worst reading. `value` is in face widths (squared for an
 *  area), the limit's unit; null where the measure has no number (a tie off
 *  the mesh). */
interface CustomGateReadingBase {
  value: number | null;
  pose: string;
  limit: number;
  pass: boolean;
  reason?: string;
}

/** A length: `px` is the same worst value in canvas px. */
export interface CustomGateReading extends CustomGateReadingBase {
  px: number | null;
}

/** An area (`EXPOSED`): `px2` is the same worst value in canvas px². */
export interface CustomGateAreaReading extends CustomGateReadingBase {
  px2: number | null;
}

export interface CustomGateTip {
  param: string;
  /** The part's free end at the parameter's two ends, min then max. */
  ends: {
    value: number;
    /** Canvas px. */
    landed: ProbePoint | null;
    /** The same point with the part's warps removed (its deformer alone), canvas px. */
    bare: ProbePoint | null;
    /** Distance from `bare` to `landed`, canvas px. */
    fromBare: number | null;
  }[];
  /** Between the two landed positions, canvas px. */
  travel: number | null;
}

export interface CustomGatePartReport {
  id: string;
  anchor: string;
  folds: {
    ratio: number;
    pose: string;
    limit: number;
    pass: boolean;
    reason?: string;
  };
  tie: CustomGateReading;
  slide: {
    slide: CustomGateReading;
    onAnchor: CustomGateReading;
    /** How many poses of the set turn the head; 0 leaves both at 0. */
    turningPoses: number;
    pass: boolean;
  };
  exposed: {
    /** Pixels both layers paint within 0.15 face widths of the tie. */
    hiddenPx: number;
    /** Where the head does not turn: limited. */
    noTurn: CustomGateAreaReading;
    /** Where it turns: reported, no limit. */
    turning: { value: number; px2: number; pose: string } | null;
    pass: boolean;
  };
  rigid?: CustomGateReading;
  tip: CustomGateTip[];
  /** Only for a part that declares occlusion. Reported, never failing. */
  hidden?: CustomGateHidden;
  ok: boolean;
}

/** Where the amount leaves its rest value and first reaches 1, on one side of
 *  the key parameter's default; null where it never does. */
export interface CustomGateHiddenSide {
  leaves: number | null;
  full: number | null;
}

export interface CustomGateHidden {
  /** Every occluder part id the model names. */
  by: string[];
  /** Those whose paint gives the gate cover; the rest fade (or are roles not
   *  passed) and give none. */
  cover: string[];
  parameter: string;
  /** The parameter's default. */
  default: number;
  /** The amount with every parameter at its default. */
  atRest: number;
  below: CustomGateHiddenSide;
  above: CustomGateHiddenSide;
  /** Poses of the part's set that `TIE` and `SLIDE` left out, and how many of
   *  them turn the head. */
  leftOut: number;
  leftOutTurning: number;
  /** Poses that do not turn the head and that `TIE` read. */
  readNoTurn: number;
  poses: number;
}

export interface CustomGateReport {
  ok: boolean;
  faceWidth: number;
  limits: CustomGateLimits;
  poses: number;
  parts: CustomGatePartReport[];
  /** `<part> <LINE>` per limited line that failed, or `gate error: <message>`. */
  failed: string[];
}

/** The engine's collapse threshold, which it states on every fold report. */
function foldLimit(model: IkiModel): number {
  return checkFolds(model, { poses: [] }).thresholds.collapse;
}

/** The report for a gate that threw: failed, naming the error, no parts. */
export function failedCustomGate(
  model: IkiModel,
  error: unknown,
): CustomGateReport {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    faceWidth: model.parts.find((p) => p.id === "face")?.width ?? 0,
    limits: { ...CUSTOM_GATE_LIMITS, fold: foldLimit(model) },
    poses: 0,
    parts: [],
    failed: [`gate error: ${message}`],
  };
}

function readingOf(
  faceWidth: number,
  amount: number | null,
  dimension: 1,
  pose: string,
  limit: number,
  reason: string,
): CustomGateReading;
function readingOf(
  faceWidth: number,
  amount: number | null,
  dimension: 2,
  pose: string,
  limit: number,
  reason: string,
): CustomGateAreaReading;
/** The one place a worst value in px (px² for an area) becomes face widths. */
function readingOf(
  faceWidth: number,
  amount: number | null,
  dimension: 1 | 2,
  pose: string,
  limit: number,
  reason: string,
): CustomGateReading | CustomGateAreaReading {
  const value = amount === null ? null : amount / faceWidth ** dimension;
  const pass = value !== null && value <= limit;
  return {
    value,
    ...(dimension === 1 ? { px: amount } : { px2: amount }),
    pose,
    limit,
    pass,
    ...(pass ? {} : { reason }),
  } as CustomGateReading | CustomGateAreaReading;
}

/** Experiment C's sampling, for a 402 px face. */
const TWIN_FACE = 402;
const RING_PX = 5;
const RING_DIAGONAL_PX = 4;
const SAMPLE_REACH_PX = 80;
const SAMPLE_STEP_PX = 4;
const TIP_INSET_PX = 6;
/** Of the face width: the neighbourhood of the tie where hidden art is read. */
const EXPOSED_REACH = 0.15;

const runsAt = (paint: PaintRuns, y: number): [number, number][] =>
  paint.rows[y - paint.y0] ?? [];

/** Whether the pixel holding canvas point (x, y) is opaque in `paint`. */
function paintedAt(paint: PaintRuns, x: number, y: number): boolean {
  const px = Math.floor(x);
  return runsAt(paint, Math.floor(y)).some(([a, b]) => px >= a && px < b);
}

/** Most cells a grid has along one side, whatever the extent it covers. */
const GRID_CELLS = 64;

/**
 * The triangles of a posed mesh bucketed by cell, to find the one over a
 * point, over `bounds` (the box of the points to be looked up) alone: a bake
 * is only checked to be finite, so the mesh itself may be arbitrarily large and
 * must not set the number of bins.
 */
function triangleGrid(
  posed: Float64Array,
  indices: number[],
  bounds: { x0: number; y0: number; x1: number; y1: number },
) {
  const cell = Math.max(
    16,
    (bounds.x1 - bounds.x0) / GRID_CELLS,
    (bounds.y1 - bounds.y0) / GRID_CELLS,
  );
  const cols = Math.floor((bounds.x1 - bounds.x0) / cell) + 1;
  const rows = Math.floor((bounds.y1 - bounds.y0) / cell) + 1;
  const bins = new Map<number, number[]>();
  for (let t = 0; t < indices.length / 3; t++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      x0 = Math.min(x0, posed[v * 2]);
      x1 = Math.max(x1, posed[v * 2]);
      y0 = Math.min(y0, posed[v * 2 + 1]);
      y1 = Math.max(y1, posed[v * 2 + 1]);
    }
    if (x1 < bounds.x0 || x0 > bounds.x1 || y1 < bounds.y0 || y0 > bounds.y1) {
      continue;
    }
    const cx0 = Math.max(0, Math.floor((x0 - bounds.x0) / cell));
    const cx1 = Math.min(cols - 1, Math.floor((x1 - bounds.x0) / cell));
    const cy0 = Math.max(0, Math.floor((y0 - bounds.y0) / cell));
    const cy1 = Math.min(rows - 1, Math.floor((y1 - bounds.y0) / cell));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cx + cy * cols;
        const bin = bins.get(k);
        if (bin) bin.push(t);
        else bins.set(k, [t]);
      }
    }
  }
  return (x: number, y: number): number[] =>
    x < bounds.x0 || y < bounds.y0 || x > bounds.x1 || y > bounds.y1
      ? []
      : (bins.get(
          Math.floor((x - bounds.x0) / cell) +
            Math.floor((y - bounds.y0) / cell) * cols,
        ) ?? []);
}

/** Whether each of `points` lies over a painted rest point of `mesh`, posed as
 *  `posed`: the triangle holding the point gives the rest point it came from. */
function paintedUnder(
  posed: Float64Array,
  mesh: RestMesh,
  paint: PaintRuns,
  points: ProbePoint[],
): boolean[] {
  if (points.length === 0) return [];
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of points) {
    bounds.x0 = Math.min(bounds.x0, x);
    bounds.y0 = Math.min(bounds.y0, y);
    bounds.x1 = Math.max(bounds.x1, x);
    bounds.y1 = Math.max(bounds.y1, y);
  }
  const find = triangleGrid(posed, mesh.indices, bounds);
  return points.map(([x, y]) => {
    for (const t of find(x, y)) {
      const tri: [number, number, number] = [
        mesh.indices[t * 3],
        mesh.indices[t * 3 + 1],
        mesh.indices[t * 3 + 2],
      ];
      const w = locate(posed, tri, x, y);
      if (!w) continue;
      let rx = 0;
      let ry = 0;
      for (let k = 0; k < 3; k++) {
        rx += w[k] * mesh.rest[tri[k] * 2];
        ry += w[k] * mesh.rest[tri[k] * 2 + 1];
      }
      return paintedAt(paint, rx, ry);
    }
    return false;
  });
}

/** One side of `from` along an occlusion's stops: where the amount leaves its
 *  value at `from`, and where it first reaches 1. The amount is linear between
 *  stops, so both are stops (or `from` itself). */
function hiddenSide(
  occlusion: { stops: { value: number; amount: number }[] },
  from: number,
  direction: 1 | -1,
): CustomGateHiddenSide {
  const at = (v: number) => occlusionAmount(occlusion, v);
  const rest = at(from);
  const marks = occlusion.stops
    .map((s) => s.value)
    .filter((v) => (v - from) * direction > 0)
    .sort((a, b) => (a - b) * direction);
  const run = [from, ...marks];
  let leaves: number | null = null;
  let full: number | null = rest === 1 ? from : null;
  for (let i = 0; i + 1 < run.length; i++) {
    if (leaves === null && at(run[i + 1]) !== rest) leaves = run[i];
    if (full === null && at(run[i + 1]) === 1) full = run[i + 1];
  }
  return { leaves, full };
}

/** The poses the gate reads for one part: the engine's fold poses, each of the
 *  part's own stops alone, and every combination of two baked parameters'
 *  stops. `baked` also carries the stops of the part's occlusion on its key
 *  parameter (the interior ones too: the part's warps are piecewise linear and add,
 *  so a pair's sum can be worst at a stop between the ends). */
function posesOf(
  model: IkiModel,
  baked: Map<string, number[]>,
  base: FoldPose[],
): FoldPose[] {
  const byName = new Map(base.map((p) => [p.name, p]));
  const add = (values: Record<string, number>) => {
    const pose = foldPose(values);
    if (!byName.has(pose.name)) byName.set(pose.name, pose);
  };
  const defaults = new Map(model.parameters.map((p) => [p.id, p.default]));
  for (const [param, stops] of baked) {
    for (const v of stops) if (v !== defaults.get(param)) add({ [param]: v });
  }
  const params = [...baked.keys()];
  for (let i = 0; i < params.length; i++) {
    for (let j = i + 1; j < params.length; j++) {
      for (const a of baked.get(params[i])!) {
        if (a === defaults.get(params[i])) continue;
        for (const b of baked.get(params[j])!) {
          if (b === defaults.get(params[j])) continue;
          add({ [params[i]]: a, [params[j]]: b });
        }
      }
    }
  }
  return [...byName.values()];
}

/** The part's free end: the centre of the widest run on its painted row
 *  farthest from the tie, inset toward the tie. */
function freeEnd(
  paint: PaintRuns,
  tie: [number, number],
  inset: number,
): ProbePoint | null {
  if (paint.rows.length === 0) return null;
  const [top, bottom] = [paint.y0, paint.y0 + paint.rows.length - 1];
  const y = Math.abs(bottom - tie[1]) > Math.abs(top - tie[1]) ? bottom : top;
  const runs = runsAt(paint, y);
  if (runs.length === 0) return null;
  const widest = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  return [(widest[0] + widest[1]) / 2, y > tie[1] ? y - inset : y + inset];
}

/**
 * Measure every custom part of `model`. `paints` holds the opaque runs of each
 * anchor role's layer and of each custom layer, by id. Throws `Error` on an
 * inconsistent call (a part, anchor or paint the model or `paints` lacks):
 * `auto_rig_from_layers` has validated those by then.
 */
export function checkCustomGate(
  model: IkiModel,
  parts: CustomGatePart[],
  paints: ReadonlyMap<string, PaintRuns>,
  options: CustomGateOptions = {},
): CustomGateReport {
  const face = model.parts.find((p) => p.id === "face");
  if (face === undefined) throw new Error("custom gate: the model has no face");
  const faceWidth = face.width;
  const limits: CustomGateLimits = {
    ...CUSTOM_GATE_LIMITS,
    fold: foldLimit(model),
  };
  if (parts.length === 0) {
    return {
      ok: true,
      faceWidth,
      limits,
      poses: 0,
      parts: [],
      failed: [],
    };
  }
  const scale = faceWidth / TWIN_FACE;
  const px = (twin: number) => Math.max(1, Math.round(twin * scale));
  const cache = new Map<string, RestMesh>();
  const turnParam = model.parameters.find(
    (p) => p.id === StandardParameter.AngleX,
  );
  const turns = (pose: FoldPose) =>
    turnParam !== undefined &&
    (pose.values[StandardParameter.AngleX] ?? turnParam.default) !==
      turnParam.default;

  const bakedOf = (id: string): Map<string, number[]> => {
    const part = model.parts.find((p) => p.id === id)!;
    return new Map(
      (part.warps ?? []).map((w) => [
        w.parameter,
        w.keyforms.map((k) => k.value),
      ]),
    );
  };
  const base = options.poses ?? foldPoses(model);
  const poseSets = parts.map((part) => {
    if (!model.parts.some((p) => p.id === part.id)) {
      throw new Error(`custom gate: the model has no part "${part.id}"`);
    }
    if (options.poses) return options.poses;
    const sampledOf = bakedOf(part.id);
    const occ = model.parts.find((p) => p.id === part.id)!.occlusion;
    if (occ !== undefined) {
      // The amount is piecewise linear in its stops, so they are breakpoints
      // of what is drawn: sample them like the part's own bake stops.
      const at = sampledOf.get(occ.parameter) ?? [];
      sampledOf.set(occ.parameter, [
        ...new Set([...at, ...occ.stops.map((s) => s.value)]),
      ]);
    }
    return posesOf(model, sampledOf, base);
  });
  const all = new Map(poseSets.flat().map((p) => [p.name, p]));

  const reports = parts.map((part, n): CustomGatePartReport => {
    const poses = poseSets[n];
    // A role may yield several parts (an arm's elbow): the anchor is the one
    // whose rest mesh holds the tie, the first when none does. Only pixels on
    // its mesh count as hidden art below, the layer's paint being the whole role.
    const roleParts = partIdsOfRole(part.anchor).filter((id) =>
      model.parts.some((p) => p.id === id),
    );
    const anchorId =
      roleParts.find(
        (id) =>
          locatePoints(restMesh(model, cache, id), [part.tie])[0] !== null,
      ) ?? roleParts[0];
    // Each part's worst ratio is read over its own pose set only.
    const folds = checkFolds(model, { poses });
    const anchorPart = model.parts.find((p) => p.id === anchorId);
    if (anchorPart === undefined) {
      throw new Error(`custom gate: the model has no part "${anchorId}"`);
    }
    const ownPaint = paints.get(part.id);
    const anchorPaint = paints.get(part.anchor);
    if (ownPaint === undefined || anchorPaint === undefined) {
      throw new Error(
        `custom gate: no paint for "${ownPaint === undefined ? part.id : part.anchor}"`,
      );
    }
    const partMesh = restMesh(model, cache, part.id);
    const anchorMesh = restMesh(model, cache, anchorId);
    const length = (
      amount: number | null,
      pose: string,
      limit: number,
      reason: string,
    ) => readingOf(faceWidth, amount, 1, pose, limit, reason);

    // TIE: the ring around the tie, on both meshes at rest.
    const ring = (
      [
        [0, 0],
        [px(RING_PX), 0],
        [-px(RING_PX), 0],
        [0, px(RING_PX)],
        [0, -px(RING_PX)],
        [px(RING_DIAGONAL_PX), px(RING_DIAGONAL_PX)],
        [-px(RING_DIAGONAL_PX), px(RING_DIAGONAL_PX)],
        [px(RING_DIAGONAL_PX), -px(RING_DIAGONAL_PX)],
        [-px(RING_DIAGONAL_PX), -px(RING_DIAGONAL_PX)],
      ] as [number, number][]
    ).map(([dx, dy]): ProbePoint => [part.tie[0] + dx, part.tie[1] + dy]);
    const onPart = locatePoints(partMesh, ring);
    const onAnchor = locatePoints(anchorMesh, ring);
    const shared = ring.flatMap((_, i) =>
      onPart[i] && onAnchor[i] ? [i] : [],
    );

    // SLIDE: the anchor's paint around the tie, sampled.
    const reach = px(SAMPLE_REACH_PX);
    const step = px(SAMPLE_STEP_PX);
    const samples: ProbePoint[] = [];
    const cx = Math.round(part.tie[0]);
    const cy = Math.round(part.tie[1]);
    for (let y = cy - reach; y <= cy + reach; y += step) {
      const runs = runsAt(anchorPaint, y);
      for (let x = cx - reach; x <= cx + reach; x += step) {
        if (runs.some(([a, b]) => x >= a && x < b))
          samples.push([x + 0.5, y + 0.5]);
      }
    }
    const samplesOn = locatePoints(anchorMesh, samples).filter(
      (l): l is NonNullable<Located> => l !== null,
    );
    const [tieOnPart] = locatePoints(partMesh, [part.tie]);

    // EXPOSED: the pixels both layers paint near the tie; the lower part's art
    // the upper one hides at rest.
    const partIndex = model.parts.findIndex((p) => p.id === part.id);
    const anchorIndex = model.parts.indexOf(anchorPart);
    const ownPart = model.parts[partIndex];
    const partLower =
      ownPart.order < anchorPart.order ||
      (ownPart.order === anchorPart.order && partIndex < anchorIndex);
    const [lowerId, upperId] = partLower
      ? [part.id, anchorId]
      : [anchorId, part.id];
    const [lowerMesh, upperMesh] = [
      restMesh(model, cache, lowerId),
      restMesh(model, cache, upperId),
    ];
    const upperPaint = partLower ? anchorPaint : ownPaint;
    const exposedReach = Math.round(EXPOSED_REACH * faceWidth);
    const hidden: ProbePoint[] = [];
    for (
      let y = Math.floor(part.tie[1]) - exposedReach;
      y <= Math.ceil(part.tie[1]) + exposedReach;
      y++
    ) {
      for (const [a0, a1] of runsAt(ownPaint, y)) {
        for (const [b0, b1] of runsAt(anchorPaint, y)) {
          for (let x = Math.max(a0, b0); x < Math.min(a1, b1); x++) {
            if (
              Math.hypot(x + 0.5 - part.tie[0], y + 0.5 - part.tie[1]) <=
              exposedReach
            ) {
              hidden.push([x + 0.5, y + 0.5]);
            }
          }
        }
      }
    }
    const onAnchorMesh = locatePoints(anchorMesh, hidden);
    const hiddenOn = locatePoints(lowerMesh, hidden).filter(
      (l, i): l is NonNullable<Located> =>
        l !== null && onAnchorMesh[i] !== null,
    );

    // Cover: the occluders the player draws at full alpha in every pose, with
    // the paint they were drawn from. A fading one gives none, whatever the
    // player does with it (`mouth_open`, a blush and a pose forearm fade).
    const occlusion = ownPart.occlusion;
    const coverParts: { id: string; mesh: RestMesh; paint: PaintRuns }[] = [];
    if (occlusion !== undefined) {
      for (const role of part.occludedBy ?? []) {
        for (const id of partIdsOfRole(role)) {
          const o = model.parts.find((p) => p.id === id);
          if (o === undefined || !occlusion.by.includes(id)) continue;
          const steady =
            o.color[3] === 1 &&
            (o.transform.opacity ?? 1) >= 1 &&
            !(o.bindings ?? []).some((b) => b.channel === "opacity");
          if (!steady) continue;
          const paint = paints.get(role);
          if (paint === undefined) {
            throw new Error(`custom gate: no paint for "${role}"`);
          }
          coverParts.push({ id, mesh: restMesh(model, cache, id), paint });
        }
      }
    }
    const coverIds = new Set(coverParts.map((c) => c.id));
    const keyParam =
      occlusion === undefined
        ? undefined
        : model.parameters.find((p) => p.id === occlusion.parameter)!;
    // The key value as the player reads it: inside the parameter's range.
    const keyOf = (values: Record<string, number>): number =>
      Math.min(
        keyParam!.max,
        Math.max(keyParam!.min, values[keyParam!.id] ?? keyParam!.default),
      );
    // The values of the key parameter this part's poses sample (its bake
    // stops and its occlusion's stops, both in the pose set). A reading in
    // a stretch between two samples is bounded by the readings at its two
    // ends, and none is taken between them, so a pose is left out only when
    // nothing is drawn in either stretch it bounds: the amount is 1 from the
    // sample below to the sample above.
    const sampled =
      keyParam === undefined
        ? []
        : [
            ...new Set([
              keyParam.default,
              ...poses.map((p) => keyOf(p.values)),
            ]),
          ].sort((a, b) => a - b);
    const fullyHidden = (lo: number, hi: number): boolean =>
      occlusion!.stops.every(
        (st) => st.value <= lo || st.value >= hi || st.amount === 1,
      ) &&
      occlusionAmount(occlusion!, lo) === 1 &&
      occlusionAmount(occlusion!, hi) === 1;
    const hiddenAt = (v: number): boolean =>
      fullyHidden(
        sampled.filter((x) => x < v).at(-1) ?? v,
        sampled.find((x) => x > v) ?? v,
      );
    let leftOut = 0;
    let leftOutTurning = 0;
    let readNoTurn = 0;

    const stops = bakedOf(part.id);
    // Worst values, in px (px² for the exposed ones); `readingOf` converts.
    const worstOf = {
      tie: { v: -1, pose: "rest" },
      slide: { v: -1, pose: "rest" },
      onAnchor: { v: -1, pose: "rest" },
      exposed: { v: -1, pose: "rest" },
      exposedTurn: { v: -1, pose: "rest" },
      rigid: { v: -1, pose: "rest" },
    };
    const keep = (
      w: { v: number; pose: string },
      v: number,
      pose: string,
    ): void => {
      if (v > w.v) {
        w.v = v;
        w.pose = pose;
      }
    };
    let onAnchorNull: string | null = null;
    let turningPoses = 0;
    const rest = partMesh.rest;
    const restPoints: ProbePoint[] = [];
    for (let i = 0; i < rest.length; i += 2)
      restPoints.push([rest[i], rest[i + 1]]);

    const measureRigid = (pose: FoldPose, posed: Float64Array) => {
      const moved: ProbePoint[] = [];
      for (let i = 0; i < posed.length; i += 2)
        moved.push([posed[i], posed[i + 1]]);
      keep(worstOf.rigid, rigidResidual(restPoints, moved), pose.name);
    };

    for (const pose of poses) {
      // The player hides the part wholly over the stretch this pose stands
      // for; only then are the occluders landed, for the spots the readings
      // below ask about.
      const hiding = occlusion !== undefined && hiddenAt(keyOf(pose.values));
      const landed = landParts(model, pose.values, [
        ...new Set([
          part.id,
          anchorId,
          ...(hiding && coverIds.size > 0 ? coverIds : []),
        ]),
      ]);
      const partPosed = toCanvas(model, landed.get(part.id)!);
      const anchorPosed = toCanvas(model, landed.get(anchorId)!);
      const canvasOf = new Map<string, Float64Array>();
      const underCover = (points: ProbePoint[], skip?: string): boolean[] => {
        const covered = points.map(() => false);
        if (!hiding) return covered;
        for (const c of coverParts) {
          if (c.id === skip) continue;
          let posed = canvasOf.get(c.id);
          if (posed === undefined) {
            posed = toCanvas(model, landed.get(c.id)!);
            canvasOf.set(c.id, posed);
          }
          const under = paintedUnder(posed, c.mesh, c.paint, points);
          under.forEach((u, i) => {
            if (u) covered[i] = true;
          });
        }
        return covered;
      };
      const turning = turns(pose);

      // TIE and SLIDE measure the ring, so a pose where the player hides the
      // part and all of the ring is under cover has nothing to measure.
      const ringLands = onPart.map((l) =>
        l === null ? null : landLocated(partPosed, l)!,
      );
      const ringHidden =
        hiding &&
        ringLands.every((p) => p !== null) &&
        underCover(ringLands as ProbePoint[]).every(Boolean);
      if (ringHidden) {
        leftOut++;
        if (turning) leftOutTurning++;
      } else if (turning) turningPoses++;
      else readNoTurn++;

      let gap = 0;
      for (const i of shared) {
        const a = landLocated(partPosed, onPart[i])!;
        const b = landLocated(anchorPosed, onAnchor[i])!;
        // The part's displacement less the anchor's, both from the same rest
        // point: the rest point drops out.
        gap = Math.max(gap, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
      if (shared.length > 0 && !ringHidden) {
        keep(turning ? worstOf.slide : worstOf.tie, gap, pose.name);
      }

      if (turning && !ringHidden) {
        const at = landLocated(partPosed, tieOnPart);
        let nearest: number | null = null;
        if (at !== null) {
          for (const l of samplesOn) {
            const q = landLocated(anchorPosed, l)!;
            const d = Math.hypot(q[0] - at[0], q[1] - at[1]);
            if (nearest === null || d < nearest) nearest = d;
          }
        }
        if (nearest === null) onAnchorNull ??= pose.name;
        else keep(worstOf.onAnchor, nearest, pose.name);
      }

      if (hiddenOn.length > 0) {
        const lowerPosed = lowerId === part.id ? partPosed : anchorPosed;
        const upperPosed = upperId === part.id ? partPosed : anchorPosed;
        const lands = hiddenOn.map((l) => landLocated(lowerPosed, l)!);
        const underUpper = paintedUnder(
          upperPosed,
          upperMesh,
          upperPaint,
          lands,
        );
        // Hidden by declaration where an occluder covers the spot. The lower
        // part's own art is under its cover by construction.
        const underHider = coverIds.has(lowerId)
          ? lands.map(() => hiding)
          : underCover(lands, upperId);
        let showing = 0;
        lands.forEach((_, i) => {
          if (!underUpper[i] && !underHider[i]) showing++;
        });
        keep(
          turning ? worstOf.exposedTurn : worstOf.exposed,
          showing,
          pose.name,
        );
      }

      if (part.rigid) measureRigid(pose, partPosed);
    }

    if (part.rigid) {
      for (const [param, values] of stops) {
        const def = model.parameters.find((p) => p.id === param)!.default;
        const sorted = [...new Set([...values, def])].sort((a, b) => a - b);
        for (let i = 0; i + 1 < sorted.length; i++) {
          const mid = foldPose({ [param]: (sorted[i] + sorted[i + 1]) / 2 });
          const posed = landParts(model, mid.values, [part.id]).get(part.id)!;
          measureRigid(mid, toCanvas(model, posed));
        }
      }
    }

    const tieReading =
      shared.length === 0
        ? length(
            null,
            "rest",
            limits.tie,
            `no point of the ring around the tie lies on both ${part.id} and ${anchorId}`,
          )
        : length(
            Math.max(0, worstOf.tie.v),
            worstOf.tie.pose,
            limits.tie,
            "the tie comes apart",
          );
    const slideReading = length(
      Math.max(0, worstOf.slide.v),
      worstOf.slide.pose,
      limits.slide,
      "the tie slides too far",
    );
    const onAnchorReading =
      onAnchorNull !== null
        ? length(
            null,
            onAnchorNull,
            limits.onAnchor,
            `the tie lands off ${part.id}'s mesh, or no painted point of ${anchorId} near it is on its mesh`,
          )
        : length(
            Math.max(0, worstOf.onAnchor.v),
            worstOf.onAnchor.pose,
            limits.onAnchor,
            `the tie leaves ${anchorId}'s paint`,
          );
    const exposedReading = readingOf(
      faceWidth,
      Math.max(0, worstOf.exposed.v),
      2,
      worstOf.exposed.pose,
      limits.exposed,
      "hidden art shows",
    );
    const ratioHit = folds.targets.find(
      (t) => t.target.kind === "part" && t.target.id === part.id,
    )?.worst;
    const ratio = ratioHit?.ratio ?? 1;
    const foldsPass = ratio >= limits.fold;

    const rigidReading = part.rigid
      ? length(
          Math.max(0, worstOf.rigid.v),
          worstOf.rigid.pose,
          limits.rigid,
          "the part bends",
        )
      : undefined;

    // TIP: the free end at each baked parameter's ends. Reported, no limit.
    const tipAt = freeEnd(ownPaint, part.tie, px(TIP_INSET_PX));
    const [tipLoc] = tipAt === null ? [null] : locatePoints(partMesh, [tipAt]);
    const bareModel =
      stops.size === 0
        ? model
        : {
            ...model,
            parts: model.parts.map((p) =>
              p.id === part.id ? { ...p, warps: undefined } : p,
            ),
          };
    const tip = [...stops.keys()].map((param): CustomGateTip => {
      const def = model.parameters.find((p) => p.id === param)!;
      const ends = [def.min, def.max].map((value) => {
        const at = (m: IkiModel) =>
          landLocated(
            toCanvas(
              m,
              landParts(m, { [param]: value }, [part.id]).get(part.id)!,
            ),
            tipLoc ?? null,
          );
        const landed = at(model);
        const bare = at(bareModel);
        return {
          value,
          landed,
          bare,
          fromBare:
            landed && bare
              ? Math.hypot(landed[0] - bare[0], landed[1] - bare[1])
              : null,
        };
      });
      const [a, b] = ends;
      return {
        param,
        ends,
        travel:
          a.landed && b.landed
            ? Math.hypot(b.landed[0] - a.landed[0], b.landed[1] - a.landed[1])
            : null,
      };
    });

    const turningExposed =
      worstOf.exposedTurn.v < 0
        ? null
        : (({ value, px2, pose }) => ({ value: value!, px2: px2!, pose }))(
            readingOf(
              faceWidth,
              worstOf.exposedTurn.v,
              2,
              worstOf.exposedTurn.pose,
              Infinity,
              "",
            ),
          );
    const slidePass = slideReading.pass && onAnchorReading.pass;
    const ok =
      foldsPass &&
      tieReading.pass &&
      slidePass &&
      exposedReading.pass &&
      (rigidReading?.pass ?? true);
    return {
      id: part.id,
      anchor: part.anchor,
      folds: {
        ratio,
        pose: ratioHit?.pose.name ?? "rest",
        limit: limits.fold,
        pass: foldsPass,
        ...(foldsPass ? {} : { reason: ratio <= 0 ? "a flip" : "a collapse" }),
      },
      tie: tieReading,
      slide: {
        slide: slideReading,
        onAnchor: onAnchorReading,
        turningPoses,
        pass: slidePass,
      },
      exposed: {
        hiddenPx: hiddenOn.length,
        noTurn: exposedReading,
        turning: turningExposed,
        pass: exposedReading.pass,
      },
      ...(rigidReading === undefined ? {} : { rigid: rigidReading }),
      tip,
      ...(occlusion === undefined
        ? {}
        : {
            hidden: {
              by: occlusion.by,
              cover: [...coverIds],
              parameter: occlusion.parameter,
              default: keyParam!.default,
              atRest: occlusionAmount(occlusion, keyParam!.default),
              below: hiddenSide(occlusion, keyParam!.default, -1),
              above: hiddenSide(occlusion, keyParam!.default, 1),
              leftOut,
              leftOutTurning,
              readNoTurn,
              poses: poses.length,
            },
          }),
      ok,
    };
  });

  const failed = reports.flatMap((r) => [
    ...(r.folds.pass ? [] : [`${r.id} FOLDS`]),
    ...(r.tie.pass ? [] : [`${r.id} TIE`]),
    ...(r.slide.pass ? [] : [`${r.id} SLIDE`]),
    ...(r.exposed.pass ? [] : [`${r.id} EXPOSED`]),
    ...(r.rigid === undefined || r.rigid.pass ? [] : [`${r.id} RIGID`]),
  ]);
  return {
    ok: failed.length === 0,
    faceWidth,
    limits,
    poses: all.size,
    parts: reports,
    failed,
  };
}

const both = (faceWidth: number, px: number | null, digits = 4): string =>
  px === null
    ? "off the mesh"
    : `${px.toFixed(1)} px (${(px / faceWidth).toFixed(digits)} face widths)`;

/**
 * The gate as text: per part one `CUSTOM <id> <LINE>: …` line per measure
 * (value in px and face widths, the pose, `pass` or `FAIL: <reason>`), then
 * `CUSTOM GATE pass` or `CUSTOM GATE FAIL: <part LINE, …>`.
 */
export function formatCustomGate(report: CustomGateReport): string[] {
  const w = report.faceWidth;
  const verdict = (pass: boolean, reason?: string) =>
    pass ? "pass" : `FAIL: ${reason}`;
  /** A limit in face widths and in px. */
  const limit = (fw: number) => `${fw} face widths, ${(fw * w).toFixed(1)} px`;
  const lines: string[] = [];
  for (const r of report.parts) {
    const at = `CUSTOM ${r.id}`;
    lines.push(
      `${at} FOLDS: least triangle area ratio ${r.folds.ratio.toFixed(3)} at [${r.folds.pose}] (limit >= ${r.folds.limit})  ${verdict(r.folds.pass, r.folds.reason)}`,
    );
    const noTurnLeftOut =
      r.hidden !== undefined &&
      r.hidden.readNoTurn === 0 &&
      r.hidden.leftOut > r.hidden.leftOutTurning;
    lines.push(
      noTurnLeftOut
        ? `${at} TIE: every pose that does not turn the head is left out as hidden (see HIDDEN)  ${verdict(r.tie.pass, r.tie.reason)}`
        : `${at} TIE: at the tie and the ring around it, ${r.id} against ${r.anchor}, poses that do not turn the head: max ${both(w, r.tie.px)} at [${r.tie.pose}] (limit <= ${limit(r.tie.limit)})  ${verdict(r.tie.pass, r.tie.reason)}`,
    );
    const s = r.slide;
    lines.push(
      s.turningPoses === 0
        ? r.hidden !== undefined && r.hidden.leftOutTurning > 0
          ? `${at} SLIDE: every pose that turns the head is left out as hidden (see HIDDEN)  pass`
          : `${at} SLIDE: no pose turns the head  pass`
        : `${at} SLIDE: poses that turn the head, the same length: max ${both(w, s.slide.px)} at [${s.slide.pose}] (limit <= ${limit(s.slide.limit)}); the tie's distance to the nearest painted point of ${r.anchor} as landed: max ${both(w, s.onAnchor.px)} at [${s.onAnchor.pose}] (limit <= ${limit(s.onAnchor.limit)})  ${verdict(s.pass, s.slide.pass ? s.onAnchor.reason : s.slide.reason)}`,
    );
    const e = r.exposed;
    const turnText =
      e.turning === null
        ? "no pose turns the head"
        : `max ${e.turning.px2.toFixed(0)} px² (${e.turning.value.toFixed(5)} face widths²) at [${e.turning.pose}] (reported, no limit)`;
    lines.push(
      `${at} EXPOSED: ${e.hiddenPx} px of art both ${r.id} and ${r.anchor} paint near the tie, the lower one's hidden at rest; showing where the head does not turn: max ${(e.noTurn.px2 ?? 0).toFixed(0)} px² (${(e.noTurn.value ?? 0).toFixed(5)} face widths²) at [${e.noTurn.pose}] (limit <= ${e.noTurn.limit} face widths², ${(e.noTurn.limit * w * w).toFixed(0)} px²)  ${verdict(e.pass, e.noTurn.reason)}; where it turns: ${turnText}`,
    );
    if (r.hidden) {
      const h = r.hidden;
      const side = (name: string, s: CustomGateHiddenSide) =>
        h.atRest === 1
          ? `${name} ${h.default} the amount is 1 at rest and ${s.leaves === null ? "stays 1" : `leaves it at ${s.leaves}`}`
          : `${name} ${h.default} the amount ${s.leaves === null ? `never leaves ${h.atRest}` : `leaves ${h.atRest} at ${s.leaves}`} and ${s.full === null ? "never reaches 1" : `reaches 1 at ${s.full}`}`;
      lines.push(
        `${at} HIDDEN: hidden by ${h.by.join(",")} on ${h.parameter}, cover from ${h.cover.length === 0 ? "none of them" : h.cover.join(",")}${h.cover.length === h.by.length ? "" : " (the rest fade or are roles not passed, and give none)"}; amount ${h.atRest} at rest; ${side("below", h.below)}; ${side("above", h.above)}; left out of TIE and SLIDE: ${h.leftOut} of ${h.poses} poses (reported, no limit)`,
      );
    }
    if (r.rigid) {
      lines.push(
        `${at} RIGID: bend against rest: max ${both(w, r.rigid.px)} at [${r.rigid.pose}] (limit <= ${limit(r.rigid.limit)})  ${verdict(r.rigid.pass, r.rigid.reason)}`,
      );
    }
    for (const t of r.tip) {
      const ends = t.ends
        .map(
          (x) =>
            `${t.param}=${x.value} lands ${x.landed ? `(${x.landed.map((v) => v.toFixed(1)).join(", ")})` : "off the mesh"}, ${x.fromBare === null ? "-" : both(w, x.fromBare)} from where its deformer alone lands it`,
        )
        .join("; ");
      lines.push(
        `${at} TIP ${t.param}: free end ${ends}; travel end to end ${t.travel === null ? "-" : both(w, t.travel)} (reported, no limit)`,
      );
    }
  }
  lines.push(
    report.ok
      ? "CUSTOM GATE pass"
      : `CUSTOM GATE FAIL: ${report.failed.join(", ")}`,
  );
  return lines;
}
