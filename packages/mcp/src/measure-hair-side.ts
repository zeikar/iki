/**
 * The measure's side-lock checks. A front side lock hangs over the cheek's
 * edge beside the ear with its root hidden under the bangs; on the turn the
 * near lock follows the face plate inward and the far eye's outer tail slides
 * under the far one. Four ways a drawing or its placement breaks that, each
 * naming the free `layout` move, where one exists, before the billed
 * regenerate. A lock the rig refuses (no `hair_front`) is warned of alone.
 */

import {
  createLayerSetMeasurer,
  type LayerInput,
  type LayerSetMeasurer,
} from "@ikijs/editor";
import { measured } from "./measure-arms";
import type { LayerStats } from "./measure";

/** The lock roles, as the composer writes them from one `hair_side.png`:
 *  `hair_side_R` is the drawing as is, `hair_side_L` its mirror. */
const LOCK_ROLES = ["hair_side_R", "hair_side_L"] as const;
type LockRole = (typeof LOCK_ROLES)[number];

/** Rules 1 and 2: a stretch of the lock this wide past the bangs, or over
 *  the eye's corner, shows at rest; 1-2 px is antialiasing the neighbouring
 *  layer's edge hides. */
const VISIBLE_MIN_PX = 3;

/** Rule 3: how far the near lock leans inward at the turn's extreme, as a
 *  share of the head unit (the eye row to the chin): the default profile's
 *  face-plate slide at ±30 (`slide` in the auto-rig profile), at
 *  `rigPlan.turn.amount` 1 — a larger amount scales the lean. The near lock's
 *  body follows the plate. Restated, not imported: the measure reads layers,
 *  not the rig's internals. */
const LEAN_HH = 0.12;

/** Rule 4: a run of the lock's opaque columns that is a lock of its own, as a
 *  share of the layer's width; a smaller one is a wisp or a strand tip. */
const TWO_LOCKS_RUN = 0.25;
/** Rule 4: the gap between two such runs that makes them two locks, not one
 *  lock's parting. */
const TWO_LOCKS_GAP = 0.1;

type Runs = number[];

/** Does a row's run list (start, exclusive end, ...) hold column `x`? */
function covers(runs: Runs, x: number): boolean {
  for (let i = 0; i + 1 < runs.length; i += 2) {
    if (x >= runs[i] && x < runs[i + 1]) return true;
  }
  return false;
}

/** A layer's runs on canvas row `y`; none outside its crop. */
function runsAt(layer: LayerInput | undefined, y: number): Runs {
  return layer?.rowRuns?.[y - layer.bbox.y] ?? [];
}

/** The canvas rows of a layer's first and last row holding a run, or
 *  `undefined` with none. A run needs alpha 128 while `bbox` takes alpha 8
 *  and is grown a pixel each side, so its edge rows can hold no run, and a
 *  layer painted wholly under alpha 128 holds none at all. */
function opaqueRows(
  layer: LayerInput,
): { top: number; bottom: number } | undefined {
  const runs = layer.rowRuns ?? [];
  const top = runs.findIndex((r) => r.length > 0);
  if (top < 0) return undefined;
  let bottom = runs.length - 1;
  while (runs[bottom].length === 0) bottom--;
  return { top: layer.bbox.y + top, bottom: layer.bbox.y + bottom };
}

/**
 * Warn of a side lock the rig refuses or that would show badly: one without
 * the `hair_front` its root hides under, one whose root shows past the bangs
 * at rest, one over the eye white's outer corner at rest, one whose near-turn
 * lean bares columns nothing is painted behind, and a `hair_side.png` that
 * draws two locks. `layers` holds the measured, non-empty layers of `absDir`
 * by role.
 */
export async function hairSideWarnings(
  absDir: string,
  layers: Record<string, LayerStats>,
): Promise<string[]> {
  const present = LOCK_ROLES.filter((r) => layers[r] !== undefined);
  if (present.length === 0) return [];

  const warnings: string[] = [];
  if (layers.hair_front === undefined) {
    for (const role of present) {
      warnings.push(
        `${role}: needs hair_front — the rig refuses a lock without the bangs its root hides ` +
          `under. Remove hair_side.png and recompose (free), or draw hair_front.png. Billed.`,
      );
    }
    return warnings;
  }

  // One measurer reads every buffer at one size, and a buffer of another
  // shape but the same area would be read with the wrong stride.
  const ref = layers.hair_front;
  let mismatched = false;
  for (const r of [...present, "hair_back", "face"]) {
    const stats = layers[r];
    if (stats === undefined) continue;
    if (stats.canvasW !== ref.canvasW || stats.canvasH !== ref.canvasH) {
      mismatched = true;
      warnings.push(
        `${r}: its canvas ${stats.canvasW}x${stats.canvasH} differs from hair_front's ` +
          `${ref.canvasW}x${ref.canvasH} — auto_rig_from_layers refuses layers of different ` +
          `sizes; recompose them together.`,
      );
    }
  }
  if (mismatched) return warnings;

  const measurer: LayerSetMeasurer = createLayerSetMeasurer({
    width: ref.canvasW,
    height: ref.canvasH,
  });
  const read = (role: string) =>
    layers[role] === undefined ? undefined : measured(measurer, absDir, role);
  const front = await read("hair_front");
  const back = await read("hair_back");
  const face = await read("face");

  // Each lock's side comes from where it sits against the face's centre, not
  // from its name, so a swapped layout still reads the right edge.
  const axisX = face ? face.bbox.x + face.bbox.w / 2 : ref.canvasW / 2;

  const locks = new Map<LockRole, LayerInput>();
  for (const role of present) {
    const lock = await measured(measurer, absDir, role);
    locks.set(role, lock);
    const side = lock.bbox.x + lock.bbox.w / 2 < axisX ? -1 : 1;
    const eyeRole = (["eye_L", "eye_R"] as const).find(
      (r) =>
        layers[r] !== undefined && (layers[r].bboxCx < axisX ? -1 : 1) === side,
    );
    const eye = eyeRole === undefined ? undefined : layers[eyeRole];

    const root = rootWarning(role, lock, front);
    if (root !== undefined) warnings.push(root);
    if (eyeRole !== undefined && eye !== undefined) {
      const w = eyeCornerWarning(role, lock, side, eyeRole, eye);
      if (w !== undefined) warnings.push(w);
    }
    // The lean needs only an eye row, so the other eye's serves.
    const rowEye = eye ?? layers.eye_L ?? layers.eye_R;
    if (face !== undefined && rowEye !== undefined) {
      const w = leanWarning(role, lock, side, face, back, rowEye);
      if (w !== undefined) warnings.push(w);
    }
  }

  // The as-drawn copy: a mirror of two locks is two locks too, so one reading
  // is enough, and the composer's input is the one the message is about.
  if (drawsTwoLocks(locks.get("hair_side_R") ?? locks.get(present[0])!)) {
    warnings.push(
      `hair_side.png draws two locks — draw ONE lock, the screen-left one; the composer ` +
        `mirrors it into hair_side_L. Billed.`,
    );
  }
  return warnings;
}

/**
 * Rule 1. The lock's root hides under the bangs, so on its top row every run
 * of its columns must lie under `hair_front`'s runs on that row; a stretch of
 * `VISIBLE_MIN_PX` or more past them shows the root at rest. A jagged hem
 * makes "too low" and "too far out" hard to tell apart from the runs, so the
 * remedy names both free moves and leaves the pick to the preview.
 */
function rootWarning(
  role: LockRole,
  lock: LayerInput,
  front: LayerInput | undefined,
): string | undefined {
  const y = opaqueRows(lock)?.top;
  if (y === undefined) return undefined;
  const frontRuns = runsAt(front, y);
  const lockRuns = runsAt(lock, y);
  let shown = 0;
  for (let i = 0; i + 1 < lockRuns.length; i += 2) {
    // The run's columns past the bangs, in stretches: only a stretch of
    // VISIBLE_MIN_PX or more counts.
    let stretch = 0;
    for (let x = lockRuns[i]; x <= lockRuns[i + 1]; x++) {
      if (x < lockRuns[i + 1] && !covers(frontRuns, x)) {
        stretch++;
        continue;
      }
      if (stretch >= VISIBLE_MIN_PX) shown += stretch;
      stretch = 0;
    }
  }
  if (shown === 0) return undefined;
  return (
    `${role}: its top row (canvas y ${y}) shows past hair_front on ${shown} px — the root is ` +
    `visible at rest. Move it under the bangs — up (layout.${role}.cy) or toward the face ` +
    `(layout.${role}.cx) (free), or regenerate hair_side.png with a longer hidden root. Billed.`
  );
}

/**
 * Rule 2. The eye's outer tail may only slide under the lock on the turn, so
 * at rest the lock must not already cover the corner column of its side's eye
 * on the eye's centre row by `VISIBLE_MIN_PX` or more. The overlap is how far
 * the lock's run holding the corner reaches past it, toward the eye's centre;
 * moving the lock outward by that clears the corner.
 */
function eyeCornerWarning(
  role: LockRole,
  lock: LayerInput,
  side: -1 | 1,
  eyeRole: string,
  eye: LayerStats,
): string | undefined {
  const row = Math.floor(eye.bboxCy);
  const corner = side < 0 ? eye.marginLeft : eye.marginLeft + eye.w - 1;
  const runs = runsAt(lock, row);
  let overlap = 0;
  for (let i = 0; i + 1 < runs.length; i += 2) {
    if (corner < runs[i] || corner >= runs[i + 1]) continue;
    overlap = side < 0 ? runs[i + 1] - corner : corner - runs[i] + 1;
  }
  if (overlap < VISIBLE_MIN_PX) return undefined;
  return (
    `${role}: covers ${eyeRole}'s outer corner at rest (canvas x ${corner}, y ${row}) by ` +
    `${overlap} px — the eye's outer tail may only slide under it on the turn. Move ` +
    `layout.${role}.cx ${overlap} px ${side < 0 ? "left" : "right"}, outward (free), or regenerate it narrower. Billed.`
  );
}

/**
 * Rule 3. The face plate slides toward the far side, the side the head turns
 * toward. Turned away from a lock's side, that lock is the near one: its body
 * follows the plate, moving INWARD by about `LEAN_HH` of the head unit (the
 * eye row to the chin), and baring a strip that wide just inside its rest
 * outer edge. Behind that strip `hair_back` or the face (which carries the
 * ear) must be painted. The face's last opaque row stands for the chin; a
 * painted neck only widens the strip. Only the root blend's lower part leans
 * fully; the full width on every lock row from its top to the face's last row
 * is the conservative reading. Below that row the plate is the neck and is
 * not checked.
 */
function leanWarning(
  role: LockRole,
  lock: LayerInput,
  side: -1 | 1,
  face: LayerInput,
  back: LayerInput | undefined,
  eye: LayerStats,
): string | undefined {
  const faceRows = opaqueRows(face);
  const lockRows = opaqueRows(lock);
  if (faceRows === undefined || lockRows === undefined) return undefined;
  const faceBottom = faceRows.bottom;
  const lean = Math.round(LEAN_HH * (faceBottom - Math.floor(eye.bboxCy)));
  if (lean < 1) return undefined;

  const bare = new Set<number>();
  const rows = new Set<number>();
  for (let y = lockRows.top; y <= Math.min(lockRows.bottom, faceBottom); y++) {
    const runs = runsAt(lock, y);
    if (runs.length === 0) continue;
    // The outermost run only: its outer end is the lock's edge on this row,
    // and a lock narrower than the lean vacates only its own width.
    const from = side < 0 ? runs[0] : runs[runs.length - 2];
    const to = side < 0 ? runs[1] : runs[runs.length - 1];
    const start = side < 0 ? from : Math.max(from, to - lean);
    const end = side < 0 ? Math.min(to, from + lean) : to;
    const faceRuns = runsAt(face, y);
    const backRuns = runsAt(back, y);
    for (let x = start; x < end; x++) {
      if (covers(faceRuns, x) || covers(backRuns, x)) continue;
      bare.add(x);
      rows.add(y);
    }
  }
  if (bare.size === 0) return undefined;
  const cols = [...bare].sort((a, b) => a - b);
  const ys = [...rows].sort((a, b) => a - b);
  const where =
    `leaves bare pixels spanning columns ${cols[0]}–${cols[cols.length - 1]}, ` +
    `rows ${ys[0]}–${ys[ys.length - 1]}`;
  const lead = `${role}: when the head turns away from it the lock leans inward about ${lean} px and ${where}, where`;
  if (back === undefined) {
    // No layout move clears this: the strip is measured from the lock's own
    // edge, so it moves with the lock, and rows above the face are bare
    // whatever the lock's cx.
    return `${lead} the face is not painted — draw hair_back.png behind the locks. Billed.`;
  }
  return (
    `${lead} neither hair_back nor the face is painted — widen hair_back there ` +
    `(layout.hair_back.w) (free), or regenerate it fuller behind the locks. Billed.`
  );
}

/**
 * Rule 4. The opaque column projection of one lock is one run; two runs each
 * `TWO_LOCKS_RUN` of its width or more, apart by `TWO_LOCKS_GAP` of it, are
 * two locks drawn on one sheet.
 */
function drawsTwoLocks(lock: LayerInput): boolean {
  const w = lock.bbox.w;
  const col = new Array<boolean>(w).fill(false);
  for (const runs of lock.rowRuns ?? []) {
    for (let i = 0; i + 1 < runs.length; i += 2) {
      for (let x = runs[i]; x < runs[i + 1]; x++) col[x - lock.bbox.x] = true;
    }
  }
  const big: [number, number][] = [];
  let start = -1;
  for (let x = 0; x <= w; x++) {
    if (x < w && col[x]) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start >= TWO_LOCKS_RUN * w) big.push([start, x]);
      start = -1;
    }
  }
  for (let i = 1; i < big.length; i++) {
    if (big[i][0] - big[i - 1][1] >= TWO_LOCKS_GAP * w) return true;
  }
  return false;
}
