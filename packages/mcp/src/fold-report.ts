/**
 * The fold check `auto_rig_from_layers` and `render_poses` report: the
 * engine's `checkFolds` with the auto-rig's by-design closures set apart, and
 * the text lines both tools print it as.
 */

import { LIP_INSIDE_ROLES, LIP_ROLES } from "@ikijs/editor";
import {
  checkFolds,
  type FoldHit,
  type FoldReport,
  type FoldTarget,
} from "@ikijs/engine";
import { StandardParameter as P, type IkiModel } from "@ikijs/format";

/**
 * The parts the auto-rig flattens on purpose, each with the parameter that
 * shuts it at 0: an eye's sclera and lower lid as ITS OWN lid closes, and the
 * lip set with its tongue and teeth as the mouth shuts.
 */
const SHUT_BY = new Map<string, string>([
  ["eye_L", P.EyeOpenLeft],
  ["lash_lower_L", P.EyeOpenLeft],
  ["eye_R", P.EyeOpenRight],
  ["lash_lower_R", P.EyeOpenRight],
  ...[...LIP_ROLES, ...LIP_INSIDE_ROLES].map((id): [string, string] => [
    id,
    P.MouthOpen,
  ]),
]);

/** `checkFolds` over `foldPoses(model)`, the closures above kept out of `worst`. */
export function checkModelFolds(model: IkiModel): FoldReport {
  return checkFolds(model, {
    // The effective value, not the pose's overrides: the auto-rig's mouth
    // rests shut at its default, so `rest` and the other parameters' singles
    // are shut-mouth poses too.
    expected: (target, _pose, value) => {
      if (target.kind !== "part") return false;
      const shutBy = SHUT_BY.get(target.id);
      return shutBy !== undefined && value(shutBy) === 0;
    },
  });
}

/**
 * `report` as text lines: one `FOLD` line per offender, worst first, or
 * `FOLDS: none over N poses`; then, when a by-design closure folds, one
 * `FOLDS expected:` line naming each such part, its ratio and the parameter
 * that shuts it. A `FOLD` line gives its rest point in model space and in
 * model px from the top-left of the model's `canvas` — the layer PNGs' own
 * pixels, the frame `RenderPlan.mouth` is in, not a render's.
 */
export function formatFoldReport(
  report: FoldReport,
  canvas: { width: number; height: number },
): string[] {
  const lines =
    report.offenders.length === 0
      ? [`FOLDS: none over ${report.poses} poses`]
      : report.offenders.map((t) => offenderLine(t, t.worst!, canvas));

  // An expected hit that never came near folding is no closure to list.
  const closures = report.targets.flatMap((t) => {
    if (t.expected === undefined) return [];
    if (t.expected.ratio >= report.thresholds.collapse) return [];
    const shutBy = SHUT_BY.get(t.target.id);
    const at = shutBy === undefined ? "" : ` at ${shutBy}=0`;
    return [`${t.target.id} ${ratioText(t.expected.ratio)}${at}`];
  });
  if (closures.length > 0) {
    lines.push(
      `FOLDS expected: by-design closures, not findings — ${closures.join(", ")}`,
    );
  }
  return lines;
}

function offenderLine(
  t: FoldTarget,
  hit: FoldHit,
  canvas: { width: number; height: number },
): string {
  const where =
    "triangle" in hit.where
      ? `triangle ${hit.where.triangle}`
      : `cell (${hit.where.col},${hit.where.row})`;
  const { x, y } = hit.rest;
  return (
    `FOLD ${t.kind} ${t.target.kind} ${t.target.id} ${where} ratio ${ratioText(hit.ratio)} ` +
    `pose [${hit.pose.name}] rest at (${x.toFixed(1)}, ${y.toFixed(1)}) model space, ` +
    `(${(canvas.width / 2 + x).toFixed(0)}, ${(canvas.height / 2 - y).toFixed(0)}) model px from the top-left`
  );
}

/** Two decimals, or two significant figures under 0.01, so a flip a hair
 *  under 0 never reads `-0.00`. */
function ratioText(ratio: number): string {
  if (ratio === 0) return "0";
  return Math.abs(ratio) < 0.01 ? ratio.toExponential(1) : ratio.toFixed(2);
}
