/**
 * Turning the profile into this character's turn, fitting any cue a caller
 * measured, keeping the features inside the art's room, and reporting what
 * the rig then renders.
 *
 * With no target the turn is the profile's (times the style's knobs). A given
 * cue is fitted by the one knob it reads: eyeShift by the turn's amount,
 * farEyeRatio by the eyes' foreshortening, silhouetteRatio by the hair's
 * width, noseShift and mouthShift by those features' own shift. The room the
 * art leaves — the far eye inside the plate's outline, the far iris clear of
 * the bangs' side strand, the nose and mouth inside the plate, the far ear's
 * slide under the head — caps the turn (or that feature, or the plate's
 * narrowing) and says so in `clamped`.
 */

import type { HeadFrame } from "./head";
import { cy, type Box } from "./layout";
import { roleSpec, type Family } from "./roles";
import {
  chinSlide,
  familyField,
  farEarCovered,
  type TurnModel,
} from "./fields";
import { TURN, type ResolvedStyle } from "./profile";
import {
  TurnTargetError,
  type IrisStrand,
  type StrandOverlap,
  type TurnSolveReport,
  type TurnTargets,
} from "./types";

// --- targets ----------------------------------------------------------------

export type ResolvedTargets = Partial<Record<keyof TurnTargets, number>> & {
  /** The fields the caller passed. */
  given: Set<keyof TurnTargets>;
};

const RANGES: Record<keyof TurnTargets, [number, number, boolean]> = {
  // [lo, hi, lo exclusive]
  eyeShift: [-1, 1, false],
  farEyeRatio: [0, 1.5, true],
  silhouetteRatio: [0.5, 1.5, false],
  noseShift: [-1, 1, false],
  mouthShift: [-1, 1, false],
  headHalfWidth: [0, Infinity, true],
};

/** Every field `TurnTargets` has: a caller's names only these. */
export const TURN_TARGET_KEYS = Object.keys(RANGES) as (keyof TurnTargets)[];

/** The shifts are magnitudes: `measure_turn_reference` signs them by the
 *  reference's turn direction, and the rig turns both ways. */
const SHIFTS: ReadonlySet<keyof TurnTargets> = new Set([
  "eyeShift",
  "noseShift",
  "mouthShift",
]);

export function checkedNumber(
  name: string,
  v: unknown,
  lo: number,
  hi: number,
  open = false,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TurnTargetError(
      `${name} must be a finite number, got ${String(v)}`,
    );
  }
  if ((open ? v <= lo : v < lo) || v > hi) {
    throw new TurnTargetError(
      `${name} ${v} is outside ${open ? "(" : "["}${lo}, ${hi}]`,
    );
  }
  return v;
}

/** An options object a caller passed: absent, or a plain object naming only
 *  the fields it has — a misspelt one would otherwise do nothing. */
export function checkedKeys(
  name: string,
  v: unknown,
  known: readonly string[],
): void {
  if (v === undefined) return;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new TurnTargetError(`${name} must be a plain object`);
  }
  for (const key of Object.keys(v)) {
    if (!known.includes(key)) {
      throw new TurnTargetError(
        `${name}.${key} is not one of ${known.join(", ")}`,
      );
    }
  }
}

export function resolveTurnTargets(
  tt: TurnTargets | undefined,
  plateHalf: number,
): ResolvedTargets {
  const out: ResolvedTargets = { given: new Set() };
  for (const key of TURN_TARGET_KEYS) {
    const v: unknown = tt?.[key];
    if (v === undefined) continue;
    const [lo, hi, open] = RANGES[key];
    const checked = checkedNumber(`turnTargets.${key}`, v, lo, hi, open);
    out[key] = SHIFTS.has(key) ? Math.abs(checked) : checked;
    if (key !== "headHalfWidth") out.given.add(key);
  }
  if (out.headHalfWidth !== undefined && out.headHalfWidth <= plateHalf) {
    throw new TurnTargetError(
      `turnTargets.headHalfWidth ${out.headHalfWidth} is not wider than the face plate (half-width ${plateHalf}): the silhouette would sit inside the face`,
    );
  }
  return out;
}

// --- cue geometry -----------------------------------------------------------

export interface IrisRow {
  role: string;
  /** Painted x-span on the iris's centre row, model. */
  lo: number;
  hi: number;
  y: number;
}

export interface SolveContext {
  frame: HeadFrame;
  /** The iris (or, without irises, the eye) on the −x and the +x side. */
  left: IrisRow;
  right: IrisRow;
  /** Every role drawing the silhouette at the eye row, per side (boundary x). */
  candidates: {
    left: { role: string; x: number }[];
    right: { role: string; x: number }[];
  };
  /** Half that silhouette's rest span: what a render of the rig measures the
   *  head as, and so what every shift cue is a fraction of. */
  restHalf: number;
  strand?: { left?: IrisStrand; right?: IrisStrand };
  hasHairFront: boolean;
  /** The eye whites on the −x and the +x side. */
  eyeBoxes: { left: Box; right: Box };
  noseAt?: { x: number; y: number };
  noseBox?: Box;
  mouthAt: { x: number; y: number };
  mouthBox: Box;
}

/** Landed x of a rest point on a role's part, at (AngleX `ax`, AngleY 0). */
export type Lander = (role: string, x: number, y: number, ax: number) => number;

/** Lands through the family fields themselves: what the fit iterates on. */
export function analyticLander(m: TurnModel): Lander {
  const cache = new Map<Family, ReturnType<typeof familyField>>();
  return (role, x, y, ax) => {
    const family = roleSpec(role).family;
    let f = cache.get(family);
    if (f === undefined) {
      f = familyField(m, family);
      cache.set(family, f);
    }
    return x + f(x, y, ax, 0)[0];
  };
}

interface Cues {
  eyeShift: number;
  farEyeRatio: number;
  silhouetteRatio: number;
}

/** The three cues `measure_turn_reference` reads, for a turn of `ax`. */
function cuesAt(ctx: SolveContext, land: Lander, ax: number): Cues {
  const { left: L, right: R } = ctx;
  const l0 = land(L.role, L.lo, L.y, ax);
  const l1 = land(L.role, L.hi, L.y, ax);
  const r0 = land(R.role, R.lo, R.y, ax);
  const r1 = land(R.role, R.hi, R.y, ax);
  const wl = l1 - l0;
  const wr = r1 - r0;
  const wl0 = L.hi - L.lo;
  const wr0 = R.hi - R.lo;
  const ratio = ax < 0 ? wl / wr / (wl0 / wr0) : wr / wl / (wr0 / wl0);
  const pc0 = (L.lo + L.hi + R.lo + R.hi) / 4;
  const pc = (l0 + l1 + r0 + r1) / 4;
  const y = ctx.frame.eyeY;
  const hl0 = Math.min(...ctx.candidates.left.map((c) => c.x));
  const hr0 = Math.max(...ctx.candidates.right.map((c) => c.x));
  const hl = Math.min(
    ...ctx.candidates.left.map((c) => land(c.role, c.x, y, ax)),
  );
  const hr = Math.max(
    ...ctx.candidates.right.map((c) => land(c.role, c.x, y, ax)),
  );
  const half0 = ctx.restHalf;
  return {
    eyeShift: (pc - (hl + hr) / 2 - (pc0 - (hl0 + hr0) / 2)) / half0,
    farEyeRatio: ratio,
    silhouetteRatio: (hr - hl) / 2 / half0,
  };
}

/** Both turn directions, as magnitudes. */
export function meanCues(ctx: SolveContext, land: Lander): Cues {
  const a = cuesAt(ctx, land, -30);
  const b = cuesAt(ctx, land, 30);
  return {
    eyeShift: (Math.abs(a.eyeShift) + Math.abs(b.eyeShift)) / 2,
    farEyeRatio: (a.farEyeRatio + b.farEyeRatio) / 2,
    silhouetteRatio: (a.silhouetteRatio + b.silhouetteRatio) / 2,
  };
}

// --- strand coverage ----------------------------------------------------------

/** How much of a far iris's painted row the bangs' run covers, px. */
function coverage(
  strand: IrisStrand,
  side: -1 | 1,
  ctx: SolveContext,
  land: Lander,
  ax: number,
): number {
  const iris = side < 0 ? ctx.left : ctx.right;
  const a = land(iris.role, strand.irisOuter, strand.y, ax);
  const b = land(iris.role, strand.irisInner, strand.y, ax);
  const ro = land("hair_front", strand.runOuter, strand.y, ax);
  let lo: number;
  let hi: number;
  if (strand.runFace === null) {
    // A fringe spanning the face runs on inward without end.
    lo = side < 0 ? ro : -Infinity;
    hi = side < 0 ? Infinity : ro;
  } else {
    const rf = land("hair_front", strand.runFace, strand.y, ax);
    lo = Math.min(ro, rf);
    hi = Math.max(ro, rf);
  }
  return Math.max(
    0,
    Math.min(hi, Math.max(a, b)) - Math.max(lo, Math.min(a, b)),
  );
}

/** The side's far stops: the −x iris is the far one when turning toward −x. */
const farStops = (side: -1 | 1) => (side < 0 ? [-15, -30] : [15, 30]);

export function strandOverlaps(
  ctx: SolveContext,
  land: Lander,
  holdBase: number,
): { left?: StrandOverlap; right?: StrandOverlap } | undefined {
  const out: { left?: StrandOverlap; right?: StrandOverlap } = {};
  for (const [key, side] of [
    ["left", -1],
    ["right", 1],
  ] as const) {
    const strand = ctx.strand?.[key];
    if (strand === undefined) continue;
    const restPx = coverage(strand, side, ctx, land, 0);
    let px = 0;
    let deg = farStops(side)[1];
    for (const ax of farStops(side)) {
      const c = coverage(strand, side, ctx, land, ax);
      if (c > px) {
        px = c;
        deg = ax;
      }
    }
    if (px <= 0) continue;
    out[key] = {
      deg,
      px: round3(px),
      hh: round3(px) / holdBase,
      restPx: round3(restPx),
      // A fringe spanning the face has no side to hold the iris clear of.
      held: strand.runFace !== null && px <= restPx + STRAND_SLACK,
    };
  }
  return out.left || out.right ? out : undefined;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Sub-pixel slack in "no deeper under the strand than painted". */
const STRAND_SLACK = 0.5;

// --- the fit ----------------------------------------------------------------

/** The knobs the fit turns (see `buildTurn`). */
export interface TurnParams {
  /** The whole turn's amount (1 = the profile). */
  turn: number;
  /** The features' lead over the plate (1 = the profile). */
  lead: number;
  /** The front hair's share of the plate's turn. */
  follow: number;
  /** Its outer edge's share (the head's outline where it draws it). */
  outline: number;
  /** The eyes' foreshortening per unit of turn (1 = the profile's, at the
   *  profile's turn). */
  fore: number;
  /** The hair's width at full turn (the silhouette). */
  shell: number;
  /** A nose or mouth shift fitted or capped on its own, px. */
  nose?: number;
  mouth?: number;
}

export type Build = (p: TurnParams) => TurnModel;

export interface TurnFit {
  model: TurnModel;
  clamped: (keyof TurnTargets)[];
}

function bisect(
  f: (v: number) => number,
  lo: number,
  hi: number,
  it = 50,
): number {
  // f(lo) and f(hi) bracket 0 with f increasing.
  for (let i = 0; i < it; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The largest v in [0, hi] with ok(v), ok being true at 0 and monotone. */
function largestOk(ok: (v: number) => boolean, hi: number): number {
  if (ok(hi)) return hi;
  let lo = 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const fmt = (v: number) => v.toFixed(5);

/** The most the turn and the foreshortening may be scaled while fitting. */
const TURN_MAX = 3;
const FORE_RANGE: [number, number] = [-1, 4];
const SHELL_RANGE: [number, number] = [0.8, 1.2];

export function fitTurn(
  ctx: SolveContext,
  targets: ResolvedTargets,
  style: ResolvedStyle,
  build: Build,
): TurnFit {
  const clamped: (keyof TurnTargets)[] = [];
  // A given eyeShift fits the turn's amount, so the style's own amount has
  // no say: the fit starts from the profile, the eyes' foreshortening with it.
  const styleTurn = targets.eyeShift === undefined ? style.turn : 1;
  const p: TurnParams = {
    turn: styleTurn,
    lead: style.featureLead,
    follow: style.hairFollow,
    outline: style.outlineFollow,
    fore: 1,
    shell: 1,
  };
  const cues = (q: TurnParams) => meanCues(ctx, analyticLander(build(q)));

  // The turn's amount (eyeShift) and the eyes' foreshortening
  // (farEyeRatio): each cue leans a little on the other knob, so a few
  // rounds. The foreshortening is fitted as its product with the turn — the
  // eyes' own width change — so a small turn can still ask for it.
  let short = false;
  const fitTurnAmount = () => {
    if (targets.eyeShift === undefined) return;
    const e = targets.eyeShift;
    const g = p.fore * p.turn;
    const at = (turn: number) =>
      cues({ ...p, turn, fore: g / Math.max(turn, 1e-9) }).eyeShift;
    short = at(TURN_MAX) < e;
    const turn = short ? TURN_MAX : bisect((t) => at(t) - e, 1e-6, TURN_MAX);
    p.fore = g / turn;
    p.turn = turn;
  };
  const fitFore = () => {
    if (targets.farEyeRatio === undefined) return;
    const r = targets.farEyeRatio;
    const at = (g: number) =>
      cues({ ...p, fore: g / Math.max(p.turn, 1e-9) }).farEyeRatio;
    const hi = at(FORE_RANGE[0]);
    const lo = at(FORE_RANGE[1]);
    if (r > hi + 1e-9 || r < lo - 1e-9) {
      throw new TurnTargetError(
        `turnTargets.farEyeRatio ${r} is unreachable on this layer set: attainable ${fmt(lo)}…${fmt(hi)}`,
      );
    }
    p.fore =
      bisect((g) => r - at(g), FORE_RANGE[0], FORE_RANGE[1]) /
      Math.max(p.turn, 1e-9);
  };
  for (let i = 0; i < 3; i++) {
    fitTurnAmount();
    fitFore();
  }
  // The room: the far eye stays inside the plate, the chin over the neck it
  // slides across, and — best effort — the far iris clear of its strand. A
  // strand that leaves less than half the profile's own turn is left to
  // overlap (reported), not obeyed.
  const g = p.fore * p.turn;
  const withTurn = (turn: number) =>
    build({ ...p, turn, fore: g / Math.max(turn, 1e-9) });
  const plateTurn = largestOk(
    (turn) =>
      eyesInPlate(ctx, withTurn(turn)) && chinOverNeck(ctx, withTurn(turn)),
    p.turn,
  );
  const strandTurn = largestOk(
    (turn) => strandHeld(ctx, withTurn(turn)),
    p.turn,
  );
  let turn = Math.min(p.turn, plateTurn);
  if (strandTurn >= 0.5 * Math.min(p.turn, styleTurn))
    turn = Math.min(turn, strandTurn);
  if (turn < p.turn - 1e-6 || short) {
    p.fore = g / Math.max(turn, 1e-9);
    p.turn = turn;
    clamped.push("eyeShift");
  }
  fitFore();

  // The hair's width at full turn.
  if (targets.silhouetteRatio !== undefined) {
    const s = targets.silhouetteRatio;
    const at = (shell: number) => cues({ ...p, shell }).silhouetteRatio;
    const lo = at(SHELL_RANGE[0]);
    const hi = at(SHELL_RANGE[1]);
    if (s < lo - 1e-9 || s > hi + 1e-9) {
      throw new TurnTargetError(
        `turnTargets.silhouetteRatio ${s} is unreachable on this layer set: attainable ${fmt(lo)}…${fmt(hi)}`,
      );
    }
    p.shell = bisect((k) => at(k) - s, SHELL_RANGE[0], SHELL_RANGE[1]);
  }
  // ... narrowing the plate (without hair) only as far as the head still
  // covers the far ear's slide on the line under it: its outer edge keeps
  // its lag, and its tucked strip stays under the head. A wider shell moves
  // that line further, so the least that covers it is found by halving.
  const covered = (shell: number) => farEarCovered(build({ ...p, shell }));
  if (!covered(p.shell) && covered(Math.max(1, p.shell))) {
    let lo = p.shell;
    let hi = Math.max(1, p.shell);
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (covered(mid)) hi = mid;
      else lo = mid;
    }
    p.shell = hi;
    clamped.push("silhouetteRatio");
  }

  // The nose and the mouth: each its own shift, inside the plate — as the
  // eye shift, a fraction of the head a render spans at the eye row.
  const hb = ctx.restHalf;
  const feature = (
    key: "noseShift" | "mouthShift",
    family: "nose" | "mouth",
    at: { x: number; y: number },
    box: Box,
  ) => {
    const base = build(p);
    const own = family === "nose" ? base.nose : base.mouth;
    const withPx = (px: number) => build({ ...p, [family]: px });
    const shiftOf = (px: number) => {
      const f = familyField(withPx(px), family);
      return (
        (Math.abs(f(at.x, at.y, -30, 0)[0]) +
          Math.abs(f(at.x, at.y, 30, 0)[0])) /
        2 /
        hb
      );
    };
    // No slower than the plate under it, no further than its room.
    const floorPx = base.face;
    const ceilPx = largestOk(
      (px) => px <= floorPx || featureInPlate(ctx, withPx(px), family, box),
      Math.max(own, floorPx) * 3,
    );
    const asked = targets[key];
    if (asked !== undefined) {
      const lo = shiftOf(floorPx);
      const hi = shiftOf(Math.max(floorPx, ceilPx));
      if (asked < lo - 1e-6 || asked > hi + 1e-6) {
        throw new TurnTargetError(
          `turnTargets.${key} ${asked} is unreachable on this layer set: attainable ${fmt(lo)}…${fmt(hi)}`,
        );
      }
      p[family] = bisect(
        (px) => shiftOf(px) - asked,
        floorPx,
        Math.max(floorPx, ceilPx),
      );
    } else if (own > ceilPx) {
      p[family] = Math.max(floorPx, ceilPx);
      clamped.push(key);
    }
  };
  if (ctx.noseAt && ctx.noseBox) {
    feature("mouthShift", "mouth", ctx.mouthAt, ctx.mouthBox);
    feature("noseShift", "nose", ctx.noseAt, ctx.noseBox);
  }
  return { model: build(p), clamped };
}

// --- room -------------------------------------------------------------------

/** A feature's far edge stays this fraction of its row's half-width inside
 *  the plate's own far edge (the eyes: a pixel). */
const FEATURE_ROOM = 0.05;
const EYE_ROOM = 1;

function plateEdge(
  ctx: SolveContext,
  land: Lander,
  y: number,
  side: -1 | 1,
  ax: number,
): number {
  const w = ctx.frame.paintedHalfAt(y);
  return land("face", ctx.frame.axisX + side * w, y, ax);
}

/** The far eye's far corner stays inside the plate's outline on its row —
 *  unless a side strand frames that eye: the strand covers the outline
 *  there, and the iris's own bound against it is what shows. */
function eyesInPlate(ctx: SolveContext, m: TurnModel): boolean {
  const land = analyticLander(m);
  for (const [side, box, role, key] of [
    [-1, ctx.eyeBoxes.left, ctx.left.role, "left"],
    [1, ctx.eyeBoxes.right, ctx.right.role, "right"],
  ] as const) {
    const strand = ctx.strand?.[key];
    if (strand !== undefined && strand.runFace !== null) continue;
    const eyeRole = role.replace(/^iris_/, "eye_");
    const y = cy(box);
    const ax = 30 * side;
    const corner = land(eyeRole, side < 0 ? box.x0 : box.x1, y, ax);
    const edge = plateEdge(ctx, land, y, side, ax);
    const restIn =
      side *
      (ctx.frame.axisX +
        side * ctx.frame.paintedHalfAt(y) -
        (side < 0 ? box.x0 : box.x1));
    // An eye painted past the plate's outline may not go further past it.
    if (side * (edge - corner) < Math.min(EYE_ROOM, restIn)) return false;
  }
  return true;
}

/** The chin stays over the neck it slides across: past the neck's own
 *  width, the neck's hidden top would come out from under the jaw. */
function chinOverNeck(ctx: SolveContext, m: TurnModel): boolean {
  const { frame } = ctx;
  if (frame.neck === undefined) return true;
  return chinSlide(m) <= frame.neck.half;
}

/** The far iris goes no deeper under its bangs' strand than it is painted. */
function strandHeld(ctx: SolveContext, m: TurnModel): boolean {
  const land = analyticLander(m);
  for (const [key, side] of [
    ["left", -1],
    ["right", 1],
  ] as const) {
    const strand = ctx.strand?.[key];
    if (strand === undefined || strand.runFace === null) continue;
    const rest = coverage(strand, side, ctx, land, 0);
    for (const ax of farStops(side)) {
      if (coverage(strand, side, ctx, land, ax) > rest + STRAND_SLACK)
        return false;
    }
  }
  return true;
}

/** A nose or mouth stays on the plate: its far edge keeps FEATURE_ROOM of its
 *  row's half-width inside the plate's own far edge. */
function featureInPlate(
  ctx: SolveContext,
  m: TurnModel,
  family: "nose" | "mouth",
  box: Box,
): boolean {
  const land = analyticLander(m);
  const y = cy(box);
  const w = ctx.frame.paintedHalfAt(y);
  for (const side of [-1, 1] as const) {
    const ax = 30 * side;
    const far = land(family, side < 0 ? box.x0 : box.x1, y, ax);
    const edge = plateEdge(ctx, land, y, side, ax);
    if (side * (edge - far) < FEATURE_ROOM * w) return false;
  }
  return true;
}

// --- the report ---------------------------------------------------------------

export function turnReport(
  ctx: SolveContext,
  fit: TurnFit,
  rendered: Lander,
): TurnSolveReport {
  const { frame } = ctx;
  const m = fit.model;
  const hb = frame.holdBase;
  const achieved = meanCues(ctx, rendered);
  // A shift at ±30 as the depth a rotation would need for it.
  const depth = (px: number) => px / Math.sin(Math.PI / 6);
  const eye = depth((m.eye.far + m.eye.near) / 2);
  const plate = depth(m.face);
  const w = frame.paintedHalfAt(frame.eyeY);
  const report: TurnSolveReport = {
    radius: round3((w * w) / (2 * Math.max(1e-3, eye - plate))),
    holdBase: hb,
    depths: {
      eye: round4(eye / hb),
      nose: round4(depth(m.nose) / hb),
      mouth: round4(depth(m.mouth) / hb),
    },
    achieved: {
      eyeShift: round4(achieved.eyeShift),
      farEyeRatio: round4(achieved.farEyeRatio),
      silhouetteRatio: round4(achieved.silhouetteRatio),
    },
    clamped: fit.clamped,
  };
  const overlap = strandOverlaps(ctx, rendered, hb);
  if (overlap !== undefined) report.strandOverlap = overlap;
  return report;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** The turn model the knobs give: the profile, in this head's px. */
export function buildTurn(
  frame: HeadFrame,
  landmarks: Pick<
    TurnModel,
    "boxes" | "noseAt" | "noseTopY" | "mouthAt" | "hairTop" | "hairFrontGrid"
  >,
  q: TurnParams,
): TurnModel {
  const hh = frame.hh;
  const A = q.turn;
  const face = A * hh * TURN.face;
  const lead = (v: number) => face + A * q.lead * hh * (v - TURN.face);
  // How far the far eye's outer corner goes: its shift, less its own
  // narrowing about its centre.
  const eyes = [landmarks.boxes.eye_L, landmarks.boxes.eye_R].filter(
    (e): e is NonNullable<typeof e> => e !== undefined,
  );
  const eyeHalf =
    eyes.reduce((sum, e) => sum + (e.x1 - e.x0) / 2, 0) /
    Math.max(1, eyes.length);
  const farScale = 1 + q.fore * A * (TURN.eyeFarScale - 1);
  const farCorner = lead(TURN.eyeFar) - (1 - farScale) * eyeHalf;
  return {
    frame,
    face,
    chinLead: A * q.lead * hh * TURN.chinLead,
    widthUpper: 1 + A * (TURN.widthUpper - 1),
    widthJaw: 1 + A * (TURN.widthJaw - 1),
    eye: { far: lead(TURN.eyeFar), near: lead(TURN.eyeNear) },
    // The eyes foreshorten as much as the head turns.
    eyeScale: {
      far: 1 + q.fore * A * (TURN.eyeFarScale - 1),
      near: 1 + q.fore * A * (TURN.eyeNearScale - 1),
    },
    brow: { far: lead(TURN.browFar), near: lead(TURN.browNear) },
    nose: q.nose ?? lead(TURN.nose),
    mouth: q.mouth ?? lead(TURN.mouth),
    mouthWidth: 1 + A * (TURN.mouthWidth - 1),
    tilt: A,
    hairFront: q.follow * face,
    hairFar: Math.max(q.follow * face, farCorner),
    hairOuter: q.outline * face,
    hairBack: A * hh * TURN.hairBack,
    shellScale: q.shell,
    earFarScale: 1 + A * (TURN.earFarScale - 1),
    ...landmarks,
  };
}
