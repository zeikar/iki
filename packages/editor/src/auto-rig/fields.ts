/**
 * The head's motion as one displacement field per family, read off the
 * Live2D profile (`profile.ts`). A turn is parallax: the plate translates,
 * each feature leads it by its own amount (and the eyes foreshorten about
 * their own centres), the front hair rides it, the back hair drifts slightly
 * against it, and the neck under the jaw does not move. A nod is the same,
 * vertically. Every field is linear in each parameter on each side of rest,
 * so the keyforms at 0 and ±30 carry it exactly, and a turn and a nod add.
 */

import type { Family } from "./roles";
import { clamp, cx, cy, DEG, smoothstep, type Box } from "./layout";
import { outerEdge, runReach, type HeadFrame } from "./head";
import { NOD, TURN } from "./profile";

export type Field = (
  x: number,
  y: number,
  ax: number,
  ay: number,
) => [number, number];

type Side = { far: number; near: number };
type Nod = { up: number; down: number };

/** Everything the fields need, in px (turn amounts along the turn at ±30). */
export interface TurnModel {
  frame: HeadFrame;
  /** The plate's translation, and the chin's lead over it. */
  face: number;
  chinLead: number;
  /** The plate's width at full turn, eye/cheek rows and jaw. */
  widthUpper: number;
  widthJaw: number;
  eye: Side;
  /** Each eye's width at full turn (far, near). */
  eyeScale: Side;
  brow: Side;
  nose: number;
  mouth: number;
  mouthWidth: number;
  /** The mouth's and the nose's tilts, as a share of the profile's. */
  tilt: number;
  hairFront: number;
  /** The front hair over the far eye: at least as far as that eye's outer
   *  corner goes, so the lock over it keeps it no deeper than drawn. */
  hairFar: number;
  /** The front hair's outer edge — the head's outline where it draws it. */
  hairOuter: number;
  hairBack: number;
  /** The hair layers' width at full turn, about the axis (the silhouette). */
  shellScale: number;
  /** Landmarks: each eye white's and brow's box, the nose's landmark and
   *  bridge top, the mouth drawings' centre. */
  boxes: Partial<Record<"eye_L" | "eye_R" | "brow_L" | "brow_R", Box>>;
  noseAt?: { x: number; y: number };
  noseTopY?: number;
  mouthAt: { x: number; y: number };
  /** The front hair's top edge, model y. */
  hairTop: number;
  /** The front hair's mesh grid. The render interpolates linearly between
   *  its vertices, so its outer edge's ride is bounded per vertex row. */
  hairFrontGrid?: HairFrontGrid;
}

/** The front hair's mesh grid, model coords: its vertex columns left to
 *  right (even columns plus those where its follow bends), and its vertex
 *  rows top to bottom, evenly spaced. */
export interface HairFrontGrid {
  xs: number[];
  ys: number[];
}

/** The nose's tip swings to the far side about its bridge top by this much
 *  at a full turn: it stands further proud than its bridge. */
export const NOSE_TILT_DEG = 6;

/** Screen-down hh at ±30 → model dy (y up), px. */
function nodDy(v: Nod, ay: number, hh: number): number {
  const up = Math.max(0, ay) / 30;
  const down = Math.max(0, -ay) / 30;
  return -(up * v.up + down * v.down) * hh;
}

/** Rotate (px, py) about (ox, oy) by `a` radians, CCW; the displacement. */
function spin(
  x: number,
  y: number,
  ox: number,
  oy: number,
  a: number,
): [number, number] {
  if (a === 0) return [0, 0];
  const px = x - ox;
  const py = y - oy;
  return [
    px * Math.cos(a) - py * Math.sin(a) - px,
    px * Math.sin(a) + py * Math.cos(a) - py,
  ];
}

/** The head's own plate: a translation, the chin leading it, the width
 *  changing a few percent (a little more at the jaw). */
export function faceField(m: TurnModel): Field {
  const f = m.frame;
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    const chin = smoothstep(f.mouthY, f.chinY, y);
    const width =
      m.widthUpper +
      (m.widthJaw - m.widthUpper) * smoothstep(f.cheekY, f.jawY, y);
    // Without hair the plate is the silhouette, and the silhouette's own
    // width change is its.
    const shell = f.hairShell ? 0 : m.shellScale - 1;
    const dx =
      s * a * (m.face + m.chinLead * chin) +
      a * (width - 1 + shell) * (x - f.axisX);
    const t = Math.min(
      1,
      Math.max(0, (f.face.y1 - y) / Math.max(1, f.face.y1 - f.chinY)),
    );
    const v = {
      up: NOD.faceTop.up + (NOD.chin.up - NOD.faceTop.up) * t,
      down: NOD.faceTop.down + (NOD.chin.down - NOD.faceTop.down) * t,
    };
    return [dx, nodDy(v, ay, f.hh)];
  };
}

/**
 * The ears the plate paints: on the head, but behind the face, so they lag
 * its slide, and nod with it. The far one lags most, a little under the
 * cheek. The near one's root — what lies inside the head's own outline,
 * tucked under it — moves as the head moves it there, and the ear eases
 * evenly out to its own lag at its widest reach: it widens a little rather
 * than sliding out from under the head, so its tucked strip never shows.
 */
export function earField(m: TurnModel): Field {
  const f = m.frame;
  const ears = f.ears;
  if (ears === undefined) return () => [0, 0];
  const face = faceField(m);
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    const dy = face(x, y, 0, ay)[1];
    if (sideOf(m, x, s) === "far") return [s * a * TURN.earFar * m.face, dy];
    const d = Math.abs(x - f.axisX);
    const attach = ears.attachAt(y);
    if (d <= attach) return [face(x, y, ax, 0)[0], dy];
    const root = face(f.axisX + Math.sign(x - f.axisX) * attach, y, ax, 0)[0];
    const rim = s * a * TURN.earNear * m.face;
    const t = Math.min(1, (d - attach) / Math.max(1, ears.outer - attach));
    return [root + (rim - root) * t, dy];
  };
}

/** How far the chin slides at a full turn, px. */
export function chinSlide(m: TurnModel): number {
  const f = m.frame;
  return Math.abs(faceField(m)(f.axisX, f.chinY, 30, 0)[0]);
}

/** How far the shade under the chin may slide across the neck, as a share of
 *  the neck's half-width: its outline stays put, and the drawing between them
 *  keeps more than half its width. */
const NECK_SHADE_MAX = 0.45;
/** How far down from the chin's cut the shade still slides whole, as a share
 *  of the neck below it. */
const NECK_SHADE_FULL = 0.2;

/**
 * The neck the plate paints: still, its outline and its base on the
 * shoulders — but the shade the chin casts on it slides sideways with the
 * chin, most under the chin and not at all at the base, across and not over
 * its outline. (A nod needs none: looking down, the chin covers the shade;
 * looking up, it uncovers more of it, in the hidden top's shade.)
 */
export function neckField(m: TurnModel): Field {
  const f = m.frame;
  const nk = f.neck;
  if (nk === undefined) return () => [0, 0];
  const face = faceField(m);
  const full = chinSlide(m);
  const share = Math.min(1, (NECK_SHADE_MAX * nk.waist) / Math.max(1e-6, full));
  // By row only: from a little under the chin up it slides whole, fading to
  // nothing at the neck's base — the jaw's V and the neck's rows under it
  // make narrow cells, which a weight changing across them would fold.
  const bottom = f.face.y0;
  const tip = f.cutAt(f.axisX);
  const top = tip - NECK_SHADE_FULL * (tip - bottom);
  return (x, y, ax) => {
    const wy = Math.min(
      1,
      Math.max(0, (y - bottom) / Math.max(1, top - bottom)),
    );
    const wx = Math.max(0, 1 - Math.abs(x - f.axisX) / nk.waist);
    return [share * face(f.axisX, f.chinY, ax, 0)[0] * wx * wy, 0];
  };
}

function sideOf(m: TurnModel, x: number, s: number): "far" | "near" {
  return s * (x - m.frame.axisX) > 0 ? "far" : "near";
}

function eyeField(m: TurnModel, box: Box): Field {
  const xe = cx(box);
  const ye = cy(box);
  const hh = m.frame.hh;
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    const side = sideOf(m, xe, s);
    const dx = s * a * m.eye[side] + a * (m.eyeScale[side] - 1) * (x - xe);
    const up = Math.max(0, ay) / 30;
    const down = Math.max(0, -ay) / 30;
    const squash =
      up * (NOD.eyeHeight.up - 1) + down * (NOD.eyeHeight.down - 1);
    return [dx, nodDy(NOD.eye, ay, hh) + squash * (y - ye)];
  };
}

function browField(m: TurnModel, box: Box): Field {
  const xb = cx(box);
  return (_x, _y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    return [s * a * m.brow[sideOf(m, xb, s)], nodDy(NOD.brow, ay, m.frame.hh)];
  };
}

function noseField(m: TurnModel): Field {
  const at = m.noseAt!;
  const top = m.noseTopY ?? at.y;
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    // The tip swings toward the far side: a CCW turn of a point below the
    // bridge top moves it toward +x.
    const [tx, ty] = spin(
      x,
      y,
      at.x,
      top,
      s * a * m.tilt * NOSE_TILT_DEG * DEG,
    );
    return [s * a * m.nose + tx, nodDy(NOD.nose, ay, m.frame.hh) + ty];
  };
}

function mouthField(m: TurnModel): Field {
  const c = m.mouthAt;
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    // Narrower about its centre, then the far corner up: a CCW turn lifts
    // the +x corner, which is the far one turning toward +x.
    const wx = c.x + (x - c.x) * (1 + a * (m.mouthWidth - 1));
    const [tx, ty] = spin(
      wx,
      y,
      c.x,
      c.y,
      s * a * m.tilt * TURN.mouthTiltDeg * DEG,
    );
    return [
      s * a * m.mouth + wx - x + tx,
      nodDy(NOD.mouth, ay, m.frame.hh) + ty,
    ];
  };
}

function hairField(m: TurnModel, shift: number, nod: Nod): Field {
  const f = m.frame;
  return (x, _y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    return [
      s * a * shift + a * (m.shellScale - 1) * (x - f.axisX),
      nodDy(nod, ay, f.hh),
    ];
  };
}

/**
 * Where the front hair's follow bends, as offsets from the axis: it rides the
 * face whole out to the eyes' outer corners (`inner`), then eases evenly to
 * the outline's own follow at the outline on each side (`left`, `right`) —
 * spread over all of that width, since on the far side the lock is squeezed
 * by as much as the face out-turns the outline. The hair's mesh has columns
 * here, so it carries the bends exactly.
 */
export function hairFrontBends(
  frame: HeadFrame,
  boxes: TurnModel["boxes"],
): { inner: number; left: number; right: number } {
  const f = frame;
  const eyes = [boxes.eye_L, boxes.eye_R].filter(
    (e): e is Box => e !== undefined,
  );
  const inner = Math.max(
    1,
    Math.min(
      f.paintedHalfAt(f.eyeY),
      ...eyes.map((e) => Math.max(f.axisX - e.x0, e.x1 - f.axisX)),
    ),
  );
  return {
    inner,
    left: Math.max(inner + 1, f.axisX - f.shellLeft),
    right: Math.max(inner + 1, f.shellRight - f.axisX),
  };
}

/**
 * The front hair: over the face its bangs and the inner parts of its side
 * locks ride the face (and over the far eye, as far as that eye's corner
 * goes); out at the head's outline its outer edge follows only as far as
 * `hairOuter` — on a Live2D model the outline is the back hair's, and holds —
 * the lock easing between. On a row where the back hair paints behind that
 * edge at every turn and nod angle, the edge rides further, up to the face's
 * follow (`outerRide`). Its crown, above the face plate's top, is the top of
 * the head: on the turn it rides with the cap as far as back hair is painted
 * behind its edges and gaps at every turn and nod angle, never baring the
 * face, and no row further than the one under it (`crownRide`); elsewhere it
 * eases toward its top to the back hair's motion, so the head's top outline
 * holds while the fringe slides under it. On the nod it eases to its cap
 * top's — one slide for the whole cap (`capSlide`), so the cap moves with the
 * face rather than its bangs stretching from a pinned top.
 */
function hairFrontField(m: TurnModel): Field {
  const f = m.frame;
  const back = hairField(m, m.hairBack, NOD.hairBack);
  const cap = { up: NOD.hairFrontTop.up, down: capSlide(m) };
  // The rows the far eye's own lead reaches: its box, easing out over one
  // eye height above and below (the lock bends there, not over its length).
  const eyes = [m.boxes.eye_L, m.boxes.eye_R].filter(
    (e): e is Box => e !== undefined,
  );
  const { inner, left, right } = hairFrontBends(f, m.boxes);
  const eyeY =
    eyes.length > 0
      ? eyes.reduce((t, e) => t + cy(e), 0) / eyes.length
      : f.eyeY;
  const eyeH =
    eyes.length > 0
      ? eyes.reduce((t, e) => t + (e.y1 - e.y0), 0) / eyes.length
      : 1;
  // Turning toward s: from the near side's follow to the far eye's across
  // the face (on the eye's rows) ...
  const coreAt = (x: number, y: number, s: number) => {
    const u = s * (x - f.axisX);
    const across = Math.min(1, Math.max(0, (u + inner) / (2 * inner)));
    const band = 1 - smoothstep(eyeH / 2, 1.5 * eyeH, Math.abs(y - eyeY));
    return m.hairFront + (m.hairFar - m.hairFront) * across * band;
  };
  // ... then out to the outline's.
  const followAt = (x: number, y: number, s: number) => {
    const core = coreAt(x, y, s);
    const out = Math.min(
      1,
      Math.max(
        0,
        (Math.abs(x - f.axisX) - inner) /
          ((x < f.axisX ? left : right) - inner),
      ),
    );
    return core + (m.hairOuter - core) * out;
  };
  const ride = outerRide(m, inner, coreAt, followAt);
  const followOf = (x: number, y: number, s: number) =>
    followAt(x, y, s) + (ride === undefined ? 0 : ride(x, y, s));
  // The front hair's own motion against the back hair's, along the turn.
  const drift = Math.abs(m.hairBack);
  const crown = crownRide(m, cap, (x, y, s) => followOf(x, y, s) + drift);
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    const rx =
      s * a * followOf(x, y, s) + a * (m.shellScale - 1) * (x - f.axisX);
    const ry = nodDy(NOD.hairFront, ay, f.hh);
    const bx = back(x, y, ax, ay)[0];
    const by = nodDy(cap, ay, f.hh);
    const w = crownBlend(m, y);
    const wx = crown === undefined ? w : w + crown(y, s);
    return [bx + wx * (rx - bx), by + w * (ry - by)];
  };
}

/** The share of the front hair's own motion at model y, the rest its
 *  crown's (on the turn, before `crownRide`'s extra): all of it up to the
 *  face plate's top, none at the hair's top. */
function crownBlend(m: TurnModel, y: number): number {
  const top = m.frame.face.y1;
  return 1 - smoothstep(top, Math.max(top + 1, m.hairTop), y);
}

/** Where model y falls among the evenly spaced vertex rows `ys` (top to
 *  bottom), as the render interpolates between them: the row above it, `r`,
 *  and its share `t` of the way to the next. With `snap`, a vertex — whose y
 *  the mesh rounds to 1e-5 of its box — reads its own row alone. */
function gridRow(
  ys: number[],
  y: number,
  snap = false,
): { r: number; t: number } {
  const n = ys.length;
  let v = clamp(((ys[0] - y) / (ys[0] - ys[n - 1])) * (n - 1), 0, n - 1);
  if (snap && Math.abs(v - Math.round(v)) < 1e-3) v = Math.round(v);
  const r = Math.min(n - 2, Math.floor(v));
  return { r, t: v - r };
}

/** The crown's blend at each of the front hair's vertex rows `ys` (top to
 *  bottom), and between them as the render interpolates it. */
function renderedCrownBlend(
  m: TurnModel,
  ys: number[],
): { wr: number[]; blendAt: (y: number) => number } {
  const wr = ys.map((y) => crownBlend(m, y));
  return {
    wr,
    blendAt: (y) => {
      const { r, t } = gridRow(ys, y);
      return wr[r] + (wr[r + 1] - wr[r]) * t;
    },
  };
}

/** The most back-hair cover, hh, a crown column may lose at its top when the
 *  cap's top slides looking down, beyond what it loses at the back hair's
 *  own nod (the slide without runs): a pixel or two, so the slide opens no
 *  notch in the head's top. The rest of the samples' slide is the art's to
 *  earn, with a back hair drawn up past the front hair's top. */
const CAP_COVER_LOSS = 0.01;

/**
 * How far the front hair's cap top slides looking down, hh at −30: one value
 * for the whole cap, the largest up to `NOD.hairFrontTop.down` at which no
 * crown column loses more than `CAP_COVER_LOSS` of back-hair cover beyond
 * what it loses at the back hair's own nod (`least`). Without both hair
 * layers' runs it is that nod.
 *
 * A column's top, its first opaque row, drops by the crown's blend of the
 * bangs' nod and the slide there, read between the mesh's vertex rows as the
 * render interpolates it (in the crown the drop depends on the row alone, so
 * across vertex columns it adds nothing). The pixel rows whose centres it
 * uncovers show the back hair at its own posed place, its nod lower, or
 * nothing; the cost is how many more show nothing than at `least`. It never
 * falls as the slide grows, so bisection finds the largest.
 */
function capSlide(m: TurnModel): number {
  const f = m.frame;
  const least = NOD.hairBack.down;
  const grid = m.hairFrontGrid;
  if (
    grid === undefined ||
    f.hairRuns("hair_front", grid.ys[0]) === undefined ||
    f.hairRuns("hair_back", grid.ys[0]) === undefined
  ) {
    return least;
  }
  const { xs, ys } = grid;
  const top = ys[0];
  const n = ys.length;
  const bangs = NOD.hairFront.down;
  const { wr, blendAt } = renderedCrownBlend(m, ys);
  // From the first vertex row whose blend is 1 down, the slide moves nothing.
  const flat = ys[wr.findIndex((w) => w >= 1)] ?? ys[n - 1];
  // Each pixel column's top, in pixel rows under the hair's top: the first
  // row above `flat` that paints it.
  const x0 = xs[0];
  const tops = new Float64Array(Math.round(xs[xs.length - 1] - x0)).fill(NaN);
  for (let i = 0; i < top - flat; i++) {
    const runs = f.hairRuns("hair_front", top - i - 0.5)!;
    for (let k = 0; k < runs.length; k += 2) {
      for (let px = runs[k]; px < runs[k + 1]; px++) {
        const j = Math.round(px - x0);
        if (Number.isNaN(tops[j])) tops[j] = i;
      }
    }
  }
  // The pixel rows under a column's top whose centres a drop of s px bares,
  // up to the most either nod, the bangs' or the cap top's, drops it.
  const hh = f.hh;
  const most = Math.ceil(Math.max(bangs, NOD.hairFrontTop.down) * hh);
  const bared = (s: number) => clamp(Math.ceil(s - 0.5), 0, most);
  const dropAt = (w: number, slide: number) =>
    (w * bangs + (1 - w) * slide) * hh;
  // Per crown column: its blend, how many of the first r rows under its top
  // the posed back hair leaves empty (`empty[r]`), and that at `least`.
  const backNod = NOD.hairBack.down * hh;
  const backRows = new Map<number, number[]>();
  const columns: { w: number; empty: Int32Array; base: number }[] = [];
  tops.forEach((i, j) => {
    if (Number.isNaN(i)) return;
    const w = blendAt(top - i);
    const empty = new Int32Array(most + 1);
    for (let r = 0; r < most; r++) {
      // The back hair's own pixel row behind that row's centre, its nod up.
      const at = Math.floor(i + r + 0.5 - backNod);
      let runs = backRows.get(at);
      if (runs === undefined) {
        runs = f.hairRuns("hair_back", top - at - 0.5)!;
        backRows.set(at, runs);
      }
      empty[r + 1] = empty[r] + (paints(runs, x0 + j) ? 0 : 1);
    }
    columns.push({ w, empty, base: empty[bared(dropAt(w, least))] });
  });
  const budget = CAP_COVER_LOSS * hh;
  const fits = (slide: number) =>
    columns.every((c) => c.empty[bared(dropAt(c.w, slide))] - c.base <= budget);
  let lo: number = least;
  let hi: number = NOD.hairFrontTop.down;
  if (fits(hi)) return hi;
  // `least` always fits (it costs nothing); 30 halvings leave the slide far
  // finer than a keyform's rounding.
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Whether `runs` (model x boundaries) paint the pixel column starting at
 *  model x `px`. */
function paints(runs: number[], px: number): boolean {
  for (let k = 0; k < runs.length; k += 2) {
    if (runs[k] <= px && px + 1 <= runs[k + 1]) return true;
  }
  return false;
}

type Follow = (x: number, y: number, s: number) => number;

/**
 * How much further than `followAt` the front hair's outer edge rides at
 * (x, y) turning toward s, where the back hair paints behind that edge at
 * every angle of the turn and the nod; `undefined` unless both hair layers
 * carry runs.
 *
 * On a pixel row, take the back hair's run holding the front's outermost
 * pixel on a side, on each back row the row passes over on the nod: `c_in`
 * the least it reaches inside the edge, `c_out` the least past it (both 0
 * where the back hair is transparent there on any of them). Both layers take
 * the shell's width term, and the back hair drifts against the turn by
 * |hairBack|. On the far side the edge goes out, and stays over that run's
 * outer end while its follow is at most shellScale·c_out − drift; on the
 * near side it comes in, and the strip it leaves is that run while its
 * follow is at most shellScale·c_in − drift. The full turn binds both, and
 * the face's follow caps them.
 *
 * The render interpolates linearly between the mesh's vertices, so each
 * vertex row takes the smallest allowance among the pixel rows within one
 * row interval either side, and the innermost of their edges: its ride is
 * what the allowance leaves over today's follow there, ramped from 0 at the
 * eyes' outer corners (`inner`) to 1 at that edge, and 1 beyond — a linear
 * interpolation of that concave ramp never exceeds it. A vertex row whose
 * edges nothing covers rides nothing more: today's hold.
 */
function outerRide(
  m: TurnModel,
  inner: number,
  coreAt: Follow,
  followAt: Follow,
): Follow | undefined {
  const f = m.frame;
  const ys = m.hairFrontGrid?.ys;
  if (ys === undefined) return undefined;
  const top = ys[0];
  // Both layers must carry runs: `hairRuns` answers undefined on every row
  // of a layer without them, so any row tells.
  if (
    f.hairRuns("hair_front", top) === undefined ||
    f.hairRuns("hair_back", top) === undefined
  ) {
    return undefined;
  }
  const drift = Math.abs(m.hairBack);
  const sides = [-1, 1] as const;
  // Per pixel row of the front hair's crop and side (−x, +x): the edge's
  // offset from the axis (NaN without one there), and the follow the back
  // hair allows it turning toward that side (far) and away from it (near).
  const n = ys.length;
  const count = Math.round(top - ys[n - 1]);
  // On the nod a front row passes over the back hair's rows: down by the
  // bangs' nod less the back hair's looking down, up by theirs looking up
  // (the crown, easing to the cap's smaller nod, passes over fewer). The
  // back's pixel rows, indexed as the front's from its top, from `j0`.
  const below = (NOD.hairFront.down - NOD.hairBack.down) * f.hh;
  const above = (NOD.hairBack.up - NOD.hairFront.up) * f.hh;
  const j0 = Math.floor(-above);
  const backRows = Array.from(
    { length: Math.ceil(count + below) - j0 },
    (_, j) => f.hairRuns("hair_back", top - (j + j0) - 0.5)!,
  );
  const offset = sides.map(() => new Float64Array(count).fill(NaN));
  const far = sides.map(() => new Float64Array(count));
  const near = sides.map(() => new Float64Array(count));
  for (let i = 0; i < count; i++) {
    const y = top - i - 0.5;
    const front = f.hairRuns("hair_front", y)!;
    sides.forEach((side, k) => {
      const edge = outerEdge(front, f.axisX, side);
      if (edge === undefined) return;
      // The least reach over every back row the row's span overlaps at some
      // nod: a turn and a nod add.
      let outward = Infinity;
      let inward = Infinity;
      for (let j = Math.floor(i - above); j < Math.ceil(i + 1 + below); j++) {
        const c = runReach(backRows[j - j0], edge, side);
        outward = Math.min(outward, c.outward);
        inward = Math.min(inward, c.inward);
      }
      offset[k][i] = side * (edge - f.axisX);
      far[k][i] = m.shellScale * outward - drift;
      near[k][i] = m.shellScale * inward - drift;
    });
  }
  // Per vertex row and side: the innermost edge in its window, and the ride
  // turning toward −x and toward +x.
  const end = new Float64Array(n * 2);
  const lift = new Float64Array(n * 4);
  for (let r = 0; r < n; r++) {
    // The pixel rows overlapping the cells either side of the vertex row.
    const i0 = Math.max(0, Math.floor(top - ys[Math.max(0, r - 1)]));
    const i1 = Math.min(count, Math.ceil(top - ys[Math.min(n - 1, r + 1)]));
    sides.forEach((side, k) => {
      let d = Infinity;
      let allowFar = Infinity;
      let allowNear = Infinity;
      for (let i = i0; i < i1; i++) {
        if (Number.isNaN(offset[k][i])) continue;
        d = Math.min(d, offset[k][i]);
        allowFar = Math.min(allowFar, far[k][i]);
        allowNear = Math.min(allowNear, near[k][i]);
      }
      end[r * 2 + k] = d;
      if (d === Infinity || d <= inner) return;
      const x = f.axisX + side * d;
      sides.forEach((s, j) => {
        const allow = Math.min(
          coreAt(x, ys[r], s),
          s === side ? allowFar : allowNear,
        );
        lift[(r * 2 + k) * 2 + j] = Math.max(0, allow - followAt(x, ys[r], s));
      });
    });
  }
  const rowRide = (r: number, k: number, j: number, d: number) => {
    const v = lift[(r * 2 + k) * 2 + j];
    return v === 0
      ? 0
      : v * Math.min(1, (d - inner) / (end[r * 2 + k] - inner));
  };
  return (x, y, s) => {
    const d = Math.abs(x - f.axisX);
    if (s === 0 || d <= inner) return 0;
    const k = x < f.axisX ? 0 : 1;
    const j = s < 0 ? 0 : 1;
    // Between vertex rows, as the render interpolates; a vertex reads its
    // own row's ride alone.
    const { r, t } = gridRow(ys, y, true);
    return rowRide(r, k, j, d) * (1 - t) + rowRide(r + 1, k, j, d) * t;
  };
}

/**
 * How much of the front hair's own motion the crown takes on the turn at
 * model y turning toward s, beyond `crownBlend`'s; `undefined` unless both
 * hair layers carry runs.
 *
 * Eased to the back hair's motion, the crown uncovers nothing new. Riding
 * further, each of its boundaries moves against the back hair, and must
 * uncover no background and no skin, at any angle of the turn and the nod.
 * On a pixel row, the far outer edge goes out, and must stay over the back's
 * run past it (`c_out`); every trailing boundary — a run's start turning
 * toward +x, its end toward −x: each gap's sides and the near outer edge —
 * leaves a strip the back's run inside it must fill (`c_in`). Each reach is
 * the least over the back rows the row passes over on its own nod (the
 * crown's rendered blend of the bangs' nod and the cap top's, less the back
 * hair's), and both layers take the shell's width term. The face lies in
 * front of the back hair: a trailing strip that meets a face run at the same
 * angle of the turn, on a face row it passes over on the nod relative to the
 * face, would bare skin, so nothing backs it.
 *
 * The render mixes vertex values with non-negative weights, so a boundary
 * moves against the back hair at most R × the rendered weight there, R the
 * largest motion against it (`relAt`) of the four vertices of its cell. Each
 * crown vertex row therefore takes the least allowance ÷ R − today's rendered
 * blend over the pixel rows within one row interval either side, between 0
 * and what brings it to the front hair's own motion: each boundary moves at
 * most today's motion plus its slack. An R of 0 bounds nothing. Then, up from
 * the plate's top, no row rides further than the one under it, so the cap's
 * outline does not shear.
 */
function crownRide(
  m: TurnModel,
  cap: Nod,
  relAt: Follow,
): ((y: number, s: number) => number) | undefined {
  const f = m.frame;
  const grid = m.hairFrontGrid;
  if (grid === undefined) return undefined;
  const { xs, ys } = grid;
  const top = ys[0];
  // Both layers must carry runs, as `outerRide` checks them.
  if (
    f.hairRuns("hair_front", top) === undefined ||
    f.hairRuns("hair_back", top) === undefined
  ) {
    return undefined;
  }
  const n = ys.length;
  const count = Math.round(top - ys[n - 1]);
  const hh = f.hh;
  const face = faceField(m);
  const { wr, blendAt } = renderedCrownBlend(m, ys);
  // The back hair's and the face's runs on pixel row j, indexed as the
  // front's from its top. Without the face's runs, its crop stands in.
  const backRows = new Map<number, number[]>();
  const backAt = (j: number) => {
    let runs = backRows.get(j);
    if (runs === undefined) {
      runs = f.hairRuns("hair_back", top - j - 0.5)!;
      backRows.set(j, runs);
    }
    return runs;
  };
  const faceAt = (j: number) => {
    const y = top - j - 0.5;
    return (
      f.faceRuns(y) ??
      (y > f.face.y0 && y < f.face.y1 ? [f.face.x0, f.face.x1] : [])
    );
  };
  // The pixel rows row i overlaps at rest and moved by each of `dys` (model
  // dy, y up), as [first, end).
  const passed = (i: number, dys: number[]) => [
    Math.floor(i - Math.max(0, ...dys)),
    Math.ceil(i + 1 - Math.min(0, ...dys)),
  ];
  // relAt at each vertex, per side.
  const rel = new Float64Array(n * xs.length * 2).fill(NaN);
  const relOf = (r: number, c: number, k: number) => {
    const at = (r * xs.length + c) * 2 + k;
    if (Number.isNaN(rel[at])) rel[at] = relAt(xs[c], ys[r], k === 0 ? -1 : 1);
    return rel[at];
  };
  const cellR = (x: number, y: number, k: number) => {
    let c = 0;
    while (c < xs.length - 2 && xs[c + 1] < x) c++;
    const { r } = gridRow(ys, y);
    return Math.max(
      relOf(r, c, k),
      relOf(r, c + 1, k),
      relOf(r + 1, c, k),
      relOf(r + 1, c + 1, k),
    );
  };
  /** Whether c0 + a·c1 > 0 for every pair at some angle a in (0, 1]. */
  const someAngle = (pairs: [number, number][]) => {
    let lo = 0;
    let hi = 1;
    for (const [c0, c1] of pairs) {
      if (c1 === 0) {
        if (c0 <= 0) return false;
      } else if (c1 > 0) lo = Math.max(lo, -c0 / c1);
      else hi = Math.min(hi, -c0 / c1);
    }
    return lo < hi;
  };
  // Per pixel row and side (−x, +x): the least allowance ÷ R over its
  // bounded boundaries, less today's rendered blend there.
  const slack = [-1, 1].map(() => new Float64Array(count).fill(NaN));
  const slackAt = (i: number, k: number) => {
    if (!Number.isNaN(slack[k][i])) return slack[k][i];
    const y = top - i - 0.5;
    const w = blendAt(y);
    const nod: Nod = {
      up: w * NOD.hairFront.up + (1 - w) * cap.up,
      down: w * NOD.hairFront.down + (1 - w) * cap.down,
    };
    const ays = [-30, 30];
    const [b0, b1] = passed(
      i,
      ays.map((ay) => nodDy(nod, ay, hh) - nodDy(NOD.hairBack, ay, hh)),
    );
    const band: number[][] = [];
    for (let j = b0; j < b1; j++) band.push(backAt(j));
    // The face's rows and runs the row passes over relative to the face on
    // the nod — from just above the plate's top too, looking down: the bangs
    // drop further than the face there.
    const faces: { y: number; runs: number[] }[] = [];
    const [f0, f1] = passed(
      i,
      ays.map((ay) => nodDy(nod, ay, hh) - face(f.axisX, y, 0, ay)[1]),
    );
    for (let j = f0; j < f1; j++)
      faces.push({ y: top - j - 0.5, runs: faceAt(j) });
    const front = f.hairRuns("hair_front", y)!;
    ([-1, 1] as const).forEach((s, side) => {
      let least = Infinity;
      const far = outerEdge(front, f.axisX, s);
      if (far !== undefined) {
        const R = cellR(far, y, side);
        const c = Math.min(...band.map((b) => runReach(b, far, s).outward));
        if (R > 0) least = Math.min(least, (m.shellScale * c) / R);
      }
      for (let t = s > 0 ? 0 : 1; t < front.length; t += 2) {
        const x = front[t];
        const R = cellR(x, y, side);
        if (R <= 0) continue;
        // A trailing boundary is its run's edge on the −s side; read as an
        // outer edge there, `inward` is how far the back's run reaches into
        // the strip it leaves.
        let c = Math.min(
          ...band.map((b) => runReach(b, x, s > 0 ? -1 : 1).inward),
        );
        // At angle a the strip lies between x moved by a × the front hair's
        // displacement at the least crown weight (the back hair's drift) and
        // at the most (the cell's largest follow), each with the shell term;
        // a face run between its ends moved by a × `faceField`'s at a full
        // turn. Every end moves linearly in a, so the angles at which the two
        // overlap are one interval.
        const sh = (m.shellScale - 1) * (x - f.axisX);
        const d0 = sh + s * m.hairBack;
        const d1 = d0 + s * R;
        const lo = Math.min(d0, d1);
        const hi = Math.max(d0, d1);
        const bares = faces.some(({ y: fy, runs }) => {
          for (let r = 0; r < runs.length; r += 2) {
            const e0 = runs[r];
            const e1 = runs[r + 1];
            const de0 = face(e0, fy, 30 * s, 0)[0];
            const de1 = face(e1, fy, 30 * s, 0)[0];
            if (
              someAngle([
                [e1 - x, de1 - lo],
                [x - e0, hi - de0],
              ])
            ) {
              return true;
            }
          }
          return false;
        });
        if (bares) c = 0;
        least = Math.min(least, (m.shellScale * c) / R);
      }
      slack[side][i] = least - w;
    });
    return slack[k][i];
  };
  // Per side, each crown vertex row's extra weight, then the monotone pass
  // up from the plate's top.
  const extra = [0, 1].map((k) => {
    const out = wr.slice();
    for (let r = 0; r < n; r++) {
      if (wr[r] >= 1) continue;
      const i0 = Math.max(0, Math.floor(top - ys[Math.max(0, r - 1)]));
      const i1 = Math.min(count, Math.ceil(top - ys[Math.min(n - 1, r + 1)]));
      let least = Infinity;
      for (let i = i0; i < i1; i++) least = Math.min(least, slackAt(i, k));
      out[r] = wr[r] + clamp(least, 0, 1 - wr[r]);
    }
    for (let r = n - 2; r >= 0; r--) {
      if (wr[r] < 1) out[r] = Math.max(wr[r], Math.min(out[r], out[r + 1]));
    }
    return out.map((v, r) => v - wr[r]);
  });
  return (y, s) => {
    if (s === 0) return 0;
    const e = extra[s < 0 ? 0 : 1];
    // Between vertex rows, as the render interpolates; a vertex reads its own
    // row's alone.
    const { r, t } = gridRow(ys, y, true);
    return e[r] * (1 - t) + e[r + 1] * t;
  };
}

/** The field a family moves by (AngleZ 0: the roll is the head deformer's). */
export function familyField(m: TurnModel, family: Family): Field {
  switch (family) {
    case "face":
      return faceField(m);
    case "eye_L":
    case "eye_R":
      return eyeField(m, m.boxes[family]!);
    case "brow_L":
    case "brow_R":
      return browField(m, m.boxes[family]!);
    case "nose":
      return noseField(m);
    case "mouth":
      return mouthField(m);
    case "hair_front":
      return hairFrontField(m);
    case "hair_back":
      return hairField(m, m.hairBack, NOD.hairBack);
    case "body":
      // The torso does not take part in the head's turn.
      return () => [0, 0];
  }
}
