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
