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
import { cx, cy, DEG, smoothstep, type Box } from "./layout";
import type { HeadFrame } from "./head";
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

/** The ears the plate paints: on the head, but behind the face, so they lag
 *  its slide — the far one a little under the cheek, the near one coming
 *  out from behind it — and nod with it. */
export function earField(m: TurnModel): Field {
  const face = faceField(m);
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    const share = sideOf(m, x, s) === "far" ? TURN.earFar : TURN.earNear;
    return [s * a * share * m.face, face(x, y, 0, ay)[1]];
  };
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
  const full = Math.abs(face(f.axisX, f.chinY, 30, 0)[0]);
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
 * the lock easing between. Its crown, above the face plate's top, is the top
 * of the head and eases to the back hair's motion toward its top, so the
 * head's top outline holds while the fringe slides under it.
 */
function hairFrontField(m: TurnModel): Field {
  const f = m.frame;
  const back = hairField(m, m.hairBack, NOD.hairBack);
  const top = f.face.y1;
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
  return (x, y, ax, ay) => {
    const s = Math.sign(ax);
    const a = Math.abs(ax) / 30;
    // Toward the turn: from the near side's follow to the far eye's across
    // the face (on the eye's rows), then out to the outline's.
    const u = s * (x - f.axisX);
    const across = Math.min(1, Math.max(0, (u + inner) / (2 * inner)));
    const band = 1 - smoothstep(eyeH / 2, 1.5 * eyeH, Math.abs(y - eyeY));
    const core = m.hairFront + (m.hairFar - m.hairFront) * across * band;
    const out = Math.min(
      1,
      Math.max(
        0,
        (Math.abs(x - f.axisX) - inner) /
          ((x < f.axisX ? left : right) - inner),
      ),
    );
    const follow = core + (m.hairOuter - core) * out;
    const rx = s * a * follow + a * (m.shellScale - 1) * (x - f.axisX);
    const ry = nodDy(NOD.hairFront, ay, f.hh);
    const [bx, by] = back(x, y, ax, ay);
    const w = 1 - smoothstep(top, Math.max(top + 1, m.hairTop), y);
    return [bx + w * (rx - bx), by + w * (ry - by)];
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
