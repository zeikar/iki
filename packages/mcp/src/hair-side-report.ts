/**
 * The text lines `auto_rig_from_layers` prints the turn solve's report-only
 * `hairSide` numbers as, after the `PHYSICS` lines. An agent reads them; none
 * refuses the rig.
 */

import type { HairSideRoom, TurnSolveReport } from "@ikijs/editor";

/** A px figure to one decimal with its sign always shown, `+0.0` included, as
 *  the `SWEEP` lines' `signed` does; a negative that rounds to zero is `+0.0`
 *  too, never `-0.0`. */
function signedPx(px: number): string {
  const s = px.toFixed(1);
  if (s === "-0.0") return "+0.0";
  return s.startsWith("-") ? s : `+${s}`;
}

/**
 * `hairSide` as text lines, none when it is absent (a set with no side lock,
 * whose result text stays as it was). Per side lock, the screen-left one
 * first and labelled by its ROLE — `hair_side_R` hangs on the screen left —
 * one line per metric the report holds: `HAIRSIDE cover <role>`, `HAIRSIDE
 * tail <role>`; for a lock with neither, `HAIRSIDE <role>: no cover or tail
 * row`; for a lock with no `rowRuns`, `HAIRSIDE <role>: unavailable — <why>`.
 * Poses read as the parameter setting that reproduces them; px are model px,
 * and the cover's row is given in model space and as model px from the
 * top of the model's `canvas`, as a `FOLD` line gives its rest point.
 */
export function formatHairSideReport(
  hairSide: TurnSolveReport["hairSide"],
  canvas: { width: number; height: number },
): string[] {
  if (hairSide === undefined) return [];
  return [hairSide.left, hairSide.right].flatMap((room) =>
    room === undefined ? [] : roomLines(room, canvas),
  );
}

function roomLines(
  room: HairSideRoom,
  canvas: { width: number; height: number },
): string[] {
  const { role, cover, tail, unavailable } = room;
  if (unavailable !== undefined) {
    return [`HAIRSIDE ${role}: unavailable — ${unavailable}`];
  }
  const lines: string[] = [];
  if (cover !== undefined) {
    // A model row's centre is half a px off the integer row it lies on.
    const row = Math.floor(canvas.height / 2 - cover.y);
    lines.push(
      `HAIRSIDE cover ${role}: the lock's outer edge ${signedPx(cover.px)} model px outside the head's edge ` +
        `at ParamAngleX=${cover.deg}, ${signedPx(cover.rest)} at rest (least over the rows it covers at rest, at model y ${cover.y.toFixed(1)}, row ${row} model px from the top; ` +
        `negative: the turn bares cheek the lock hides at rest)`,
    );
  }
  if (tail !== undefined) {
    const lash =
      tail.lashToLock === undefined
        ? ""
        : ` / lash ${signedPx(tail.lashToLock)} model px`;
    lines.push(
      `HAIRSIDE tail ${role}: eye ${signedPx(tail.eyeToLock)} model px${lash} from the lock's face-side edge ` +
        `at ParamAngleX=${tail.deg} (negative: under the lock, intended), ` +
        `corner ${signedPx(tail.eyeToPlate)} model px from the head's edge (positive: inside it; negative: past it)`,
    );
  }
  if (lines.length === 0) lines.push(`HAIRSIDE ${role}: no cover or tail row`);
  return lines;
}
