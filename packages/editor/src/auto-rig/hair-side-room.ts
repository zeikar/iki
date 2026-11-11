/**
 * What the far side lock leaves of the turn's room, as numbers only: how far
 * it keeps covering the head's edge it covers at rest (the cheek, under any
 * ear), and where the far eye's (and lash's)
 * outer tail sits against it. Nothing here bounds the turn; the numbers are
 * for a later slice to design bounds from.
 */

import type { TurnModel } from "./fields";
import { outerEdge, runReach } from "./head";
import { cy, type Box } from "./layout";
import { farStops, type Lander, type SolveContext } from "./solve";
import type { HairSideRoom } from "./types";

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** `round3` for the signed numbers: a `-0` would break a later `toEqual(0)`
 *  or `Object.is` snapshot. */
const signed = (v: number) => round3(v) + 0;

/** Where the head's own outline lands on row `y` at `ax`: `headHalfAt`, the
 *  plate's edge with any ear replaced by the head's edge beneath it, so a lock
 *  beside an ear measures against the cheek, not the ear. */
function headEdge(
  ctx: SolveContext,
  land: Lander,
  y: number,
  side: -1 | 1,
  ax: number,
): number {
  const { frame } = ctx;
  return land("face", frame.axisX + side * frame.headHalfAt(y), y, ax);
}

const LOCKS = ["hair_side_L", "hair_side_R"] as const;

/** Each lock's room, keyed by the side it lies on (`left` = −x), measured at
 *  that side's far stops with the given lander. `undefined` with no lock. */
export function hairSideRoom(
  ctx: SolveContext,
  land: Lander,
  boxes: TurnModel["boxes"],
): { left?: HairSideRoom; right?: HairSideRoom } | undefined {
  const out: { left?: HairSideRoom; right?: HairSideRoom } = {};
  for (const role of LOCKS) {
    const box = boxes[role];
    if (box === undefined) continue;
    const side = (box.x0 + box.x1) / 2 < ctx.frame.axisX ? -1 : 1;
    const key = side < 0 ? "left" : "right";
    // Two locks on one side: the first role in the table keeps the side.
    if (out[key] !== undefined) continue;
    out[key] = lockRoom(ctx, land, boxes, role, box, side);
  }
  return out.left || out.right ? out : undefined;
}

function lockRoom(
  ctx: SolveContext,
  land: Lander,
  boxes: TurnModel["boxes"],
  role: (typeof LOCKS)[number],
  box: Box,
  side: -1 | 1,
): HairSideRoom {
  const { frame } = ctx;
  if (frame.hairRuns(role, box.y1 - 0.5) === undefined) {
    return { role, unavailable: "no rowRuns" };
  }
  const room: HairSideRoom = { role };
  const stops = farStops(side);

  // The lock's outer edge against the head's, on each of its pixel rows on
  // the plate that carries a run and where, at rest, it covers that edge: the
  // rows where it lies inside the head by design (its root, beside an ear)
  // have no edge to keep covering. At rest every part lands where it is
  // drawn, so the rest cover is read off the geometry.
  let cover: HairSideRoom["cover"];
  for (let i = 0; i < Math.ceil(box.y1 - box.y0); i++) {
    const y = box.y1 - i - 0.5;
    if (y < frame.face.y0 || y > frame.face.y1) continue;
    const outer = outerEdge(frame.hairRuns(role, y) ?? [], frame.axisX, side);
    if (outer === undefined) continue;
    const rest = side * (outer - frame.axisX) - frame.headHalfAt(y);
    if (rest < 0) continue;
    for (const ax of stops) {
      const px =
        side * (land(role, outer, y, ax) - headEdge(ctx, land, y, side, ax));
      if (cover === undefined || px < cover.px)
        cover = { deg: ax, px, y, rest };
    }
  }
  if (cover !== undefined) {
    room.cover = {
      deg: cover.deg,
      px: signed(cover.px),
      y: round3(cover.y),
      rest: signed(cover.rest),
    };
  }

  // The far eye's outer corner against the lock's face-side edge on the
  // eye's centre row.
  const eye = side < 0 ? ctx.eyeBoxes.left : ctx.eyeBoxes.right;
  const eyeRole = (side < 0 ? ctx.left : ctx.right).role.replace(
    /^iris_/,
    "eye_",
  );
  const y = cy(eye);
  const runs = frame.hairRuns(role, y) ?? [];
  const outer = outerEdge(runs, frame.axisX, side);
  if (outer === undefined) return room;
  const inner = outer - side * runReach(runs, outer, side).inward;
  const lashRole = eyeRole.replace(/^eye_/, "lash_");
  const lash = boxes[lashRole as "lash_L" | "lash_R"];
  let tail: HairSideRoom["tail"];
  for (const ax of stops) {
    const lock = land(role, inner, y, ax);
    const corner = land(eyeRole, side < 0 ? eye.x0 : eye.x1, y, ax);
    const eyeToLock = side * (lock - corner);
    if (tail !== undefined && eyeToLock >= tail.eyeToLock) continue;
    tail = {
      deg: ax,
      eyeToLock,
      eyeToPlate: side * (headEdge(ctx, land, y, side, ax) - corner),
    };
    if (lash !== undefined) {
      const tip = land(lashRole, side < 0 ? lash.x0 : lash.x1, y, ax);
      tail.lashToLock = side * (lock - tip);
    }
  }
  if (tail !== undefined) {
    room.tail = {
      deg: tail.deg,
      eyeToLock: signed(tail.eyeToLock),
      ...(tail.lashToLock !== undefined && {
        lashToLock: signed(tail.lashToLock),
      }),
      eyeToPlate: signed(tail.eyeToPlate),
    };
  }
  return room;
}
