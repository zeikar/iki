/**
 * The turn sweep's `SWEEP` lines: geometry, not pixels. A `ParamAngleX` ladder
 * from −30 to +30 in 1° steps, every other parameter at its default and no
 * physics, landed through the engine's `landParts` — the report reads the
 * rig, the frames show the rig plus the hair. Report-only, like `FOLD` and
 * `PHYSICS`: nothing here is a threshold that makes a finding.
 *
 * Landmarks are found by role (`eye_L`, `eye_R`, `nose`, against the `face`
 * plate) — mcp's knowledge, never the engine's. Every landed coordinate is
 * divided by the face part's own width, `describe_iki`'s `faceWidth` and the
 * unit a patch's `by` is in, before any number below is formed.
 */

import { landParts } from "@ikijs/engine";
import type { IkiModel } from "@ikijs/format";

export interface SweepLandmark {
  id: string;
  /** x(+30) − x(−30), face widths: a frozen rig reads 0, however smooth. */
  amplitude: number;
  /** The slope change of x through θ = 0, 0..1; null when both slopes are ~0. */
  xKink: number | null;
  /** The same for the landed width; null for a landmark without one, or when both slopes are ~0. */
  widthKink: number | null;
  /** How far the landmark has moved beyond the local face plate, at −30 and +30, face widths. */
  lead: { m30: number; p30: number };
  /** The largest second difference of x away from θ = 0, over the mean step; null when x never moves. */
  pop: number | null;
}

export type SweepReport =
  | {
      preset: "turn";
      unit: "fw";
      faceWidth: number;
      /** The face plate's own x(+30) − x(−30) at the eye row, face widths. */
      plateAmplitude: number;
      landmarks: SweepLandmark[];
    }
  | { preset: "turn"; unavailable: string };

const LADDER_MIN = -30;
const LADDER_MAX = 30;
/** The ladder index of θ = 0. */
const ZERO = -LADDER_MIN;
/** A ten-thousandth of the face width per degree: sub-pixel on the renders. */
const FLAT_SLOPE = 1e-4;
const PARTS = ["face", "eye_L", "eye_R", "nose"];

interface Box {
  x: number;
  width: number;
  y: number;
}

function box(pts: Float32Array, fw: number): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  return {
    x: (x0 + x1) / 2 / fw,
    width: (x1 - x0) / fw,
    y: (y0 + y1) / 2 / fw,
  };
}

/** Index of the face vertex nearest (x, y), all in face widths. */
function nearestVertex(face: Float32Array, fw: number, x: number, y: number) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < face.length; i += 2) {
    const d = (face[i] / fw - x) ** 2 + (face[i + 1] / fw - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i / 2;
    }
  }
  return best;
}

/** |s₊ − s₋| / max(|s₊|, |s₋|) of the slopes at θ = ∓5; null when both are flat. */
function kink(v: number[]): number | null {
  const sMinus = (v[ZERO] - v[ZERO - 5]) / 5;
  const sPlus = (v[ZERO + 5] - v[ZERO]) / 5;
  const big = Math.max(Math.abs(sMinus), Math.abs(sPlus));
  if (big < FLAT_SLOPE) return null;
  return Math.abs(sPlus - sMinus) / big;
}

/** Largest |second difference| over the 1° ladder, the steps touching θ = 0 excluded, over the mean |Δ|. */
function pop(v: number[]): number | null {
  let steps = 0;
  for (let i = 0; i + 1 < v.length; i++) steps += Math.abs(v[i + 1] - v[i]);
  const mean = steps / (v.length - 1);
  // Float32 landings of an unmoved part are bit-identical: exactly "never moves".
  if (mean < 1e-9) return null;
  let most = 0;
  for (let i = 1; i + 1 < v.length; i++) {
    if (Math.abs(i - ZERO) <= 1) continue;
    most = Math.max(most, Math.abs(v[i + 1] - 2 * v[i] + v[i - 1]));
  }
  return most / mean;
}

/** A pair gap or a width, face widths: the range along the nod at each turn. */
export interface NodRange {
  id: "eyes" | "irises" | "mouth";
  range: { m30: number; zero: number; p30: number };
}

/** The additivity residual of a landmark at the four corners; first letter AngleX, second AngleY. */
export interface CornerResidual {
  id: string;
  residual: { mm: number; mp: number; pm: number; pp: number };
}

export type NodReport =
  | {
      unit: "fw";
      faceWidth: number;
      nod: NodRange[];
      corner: CornerResidual[];
    }
  | { unavailable: string };

const NOD_TURNS = [-30, 0, 30];
const NOD_PARTS = [
  "face",
  "eye_L",
  "eye_R",
  "iris_L",
  "iris_R",
  "nose",
  "lip_upper",
  "mouth",
];
/** The ladder indices of AngleY −30, 0 and +30. */
const NOD_ENDS = [0, -LADDER_MIN, LADDER_MAX - LADDER_MIN];

/**
 * The nod at three turns: `ParamAngleY` −30 … +30 in 1° steps at `ParamAngleX`
 * −30, 0 and +30, no physics. `nod` is how far a pair gap (or the mouth's
 * width) moves along each ladder; `corner` is the AngleX × AngleY additivity
 * residual per landmark, the rest term included, so a rig whose parts add the
 * turn and the nod reads 0. Both are read against each other and against the
 * corpus's zeros, never against a bound.
 */
export function checkNod(model: IkiModel): NodReport {
  const face = model.parts.find((p) => p.id === "face");
  if (!face) return { unavailable: "no face part" };
  const hasEyes = ["eye_L", "eye_R"].every((id) =>
    model.parts.some((p) => p.id === id),
  );
  if (!hasEyes) return { unavailable: "no eye_L and eye_R parts" };
  const fw = face.width;
  const ladders = NOD_TURNS.map((x) =>
    Array.from({ length: LADDER_MAX - LADDER_MIN + 1 }, (_, i) =>
      landParts(
        model,
        { ParamAngleX: x, ParamAngleY: LADDER_MIN + i },
        NOD_PARTS,
      ),
    ),
  );
  const has = (id: string) => ladders[0][0].has(id);
  const boxes = (id: string) =>
    ladders.map((ladder) => ladder.map((l) => box(l.get(id)!, fw)));
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
  const ranges = (values: (b: number, i: number) => number) => {
    const [m30, zero, p30] = NOD_TURNS.map((_, b) =>
      spread(
        Array.from({ length: LADDER_MAX - LADDER_MIN + 1 }, (_, i) =>
          values(b, i),
        ),
      ),
    );
    return { m30, zero, p30 };
  };

  const gap = (l: string, r: string): NodRange["range"] => {
    const bl = boxes(l);
    const br = boxes(r);
    return ranges((b, i) => br[b][i].x - bl[b][i].x);
  };
  const nod: NodRange[] = [{ id: "eyes", range: gap("eye_L", "eye_R") }];
  if (has("iris_L") && has("iris_R")) {
    nod.push({ id: "irises", range: gap("iris_L", "iris_R") });
  }
  const mouthId = has("lip_upper")
    ? "lip_upper"
    : has("mouth")
      ? "mouth"
      : null;
  if (mouthId) {
    const bm = boxes(mouthId);
    nod.push({ id: "mouth", range: ranges((b, i) => bm[b][i].width) });
  }

  const corner = ["eye_L", "eye_R", "nose"]
    .filter(has)
    .map((id): CornerResidual => {
      const b = boxes(id);
      // The ladder of turn t, the pose at AngleY index j.
      const at = (t: number, j: number) => b[t][NOD_ENDS[j]];
      const residual = (t: number, j: number) => {
        const r = (axis: "x" | "y") =>
          at(t, j)[axis] - at(t, 1)[axis] - at(1, j)[axis] + at(1, 1)[axis];
        return Math.max(Math.abs(r("x")), Math.abs(r("y")));
      };
      return {
        id,
        residual: {
          mm: residual(0, 0),
          mp: residual(0, 2),
          pm: residual(2, 0),
          pp: residual(2, 2),
        },
      };
    });
  return { unit: "fw", faceWidth: fw, nod, corner };
}

export function checkSweep(model: IkiModel): SweepReport {
  const face = model.parts.find((p) => p.id === "face");
  if (!face) return { preset: "turn", unavailable: "no face part" };
  const hasEyes = ["eye_L", "eye_R"].every((id) =>
    model.parts.some((p) => p.id === id),
  );
  if (!hasEyes) {
    return { preset: "turn", unavailable: "no eye_L and eye_R parts" };
  }
  const fw = face.width;
  const ladder = Array.from({ length: LADDER_MAX - LADDER_MIN + 1 }, (_, i) =>
    landParts(model, { ParamAngleX: LADDER_MIN + i }, PARTS),
  );
  const at = (id: string, i: number) => ladder[i].get(id)!;
  const ids = ["eye_L", "eye_R", ...(ladder[0].has("nose") ? ["nose"] : [])];

  const landmarks = ids.map((id): SweepLandmark => {
    const boxes = ladder.map((_, i) => box(at(id, i), fw));
    const xs = boxes.map((b) => b.x);
    const plateIndex = nearestVertex(
      at("face", ZERO),
      fw,
      boxes[ZERO].x,
      boxes[ZERO].y,
    );
    const plate = ladder.map((_, i) => at("face", i)[plateIndex * 2] / fw);
    const lead = (i: number) => xs[i] - plate[i] - (xs[ZERO] - plate[ZERO]);
    return {
      id,
      amplitude: xs[xs.length - 1] - xs[0],
      xKink: kink(xs),
      widthKink: id === "nose" ? null : kink(boxes.map((b) => b.width)),
      lead: { m30: lead(0), p30: lead(xs.length - 1) },
      pop: pop(xs),
    };
  });

  const eyes = ["eye_L", "eye_R"].map((id) => box(at(id, ZERO), fw));
  const plateIndex = nearestVertex(
    at("face", ZERO),
    fw,
    (eyes[0].x + eyes[1].x) / 2,
    (eyes[0].y + eyes[1].y) / 2,
  );
  const plateX = (i: number) => at("face", i)[plateIndex * 2] / fw;
  return {
    preset: "turn",
    unit: "fw",
    faceWidth: fw,
    plateAmplitude: plateX(ladder.length - 1) - plateX(0),
    landmarks,
  };
}

const fw3 = (v: number) => {
  const s = v.toFixed(3);
  return s === "-0.000" ? "0.000" : s;
};
const signed = (v: number) => (fw3(v).startsWith("-") ? fw3(v) : `+${fw3(v)}`);
const two = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));

/** One `SWEEP` line per landmark and one for the plate, or the one `unavailable` line. */
export function formatSweepReport(report: SweepReport): string[] {
  if ("unavailable" in report) {
    return [`SWEEP: unavailable — ${report.unavailable}`];
  }
  return [
    ...report.landmarks.map(
      (l) =>
        `SWEEP turn ${l.id}: amplitude ${fw3(l.amplitude)} fw, x kink ${two(l.xKink)}, width kink ${two(l.widthKink)}, lead -30 ${signed(l.lead.m30)} fw / +30 ${signed(l.lead.p30)} fw, pop ${two(l.pop)}`,
    ),
    `SWEEP turn plate: amplitude ${fw3(report.plateAmplitude)} fw`,
  ];
}

/** The `SWEEP nod` and `SWEEP corner` lines, or the one `unavailable` line. */
export function formatNodReport(report: NodReport): string[] {
  if ("unavailable" in report) {
    return [`SWEEP nod: unavailable — ${report.unavailable}`];
  }
  return [
    ...report.nod.map(
      ({ id, range: r }) =>
        `SWEEP nod ${id}: ${id === "mouth" ? "width" : "gap"} range X -30 ${fw3(r.m30)} / 0 ${fw3(r.zero)} / +30 ${fw3(r.p30)} fw`,
    ),
    ...report.corner.map(
      ({ id, residual: r }) =>
        `SWEEP corner ${id}: residual (-30,-30) ${fw3(r.mm)} / (-30,+30) ${fw3(r.mp)} / (+30,-30) ${fw3(r.pm)} / (+30,+30) ${fw3(r.pp)} fw`,
    ),
  ];
}
