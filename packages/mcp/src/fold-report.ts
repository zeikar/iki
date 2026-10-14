/**
 * The fold check `auto_rig_from_layers` and `render_poses` report: the
 * engine's `checkFolds` with the auto-rig's by-design closures set apart, and
 * the text lines both tools print it as.
 */

import { SHUT_BY } from "@ikijs/editor";
import {
  checkFolds,
  foldPoses,
  type FoldHit,
  type FoldPose,
  type FoldReport,
  type FoldTarget,
} from "@ikijs/engine";
import type { IkiModel } from "@ikijs/format";

/**
 * `checkFolds` over `foldPoses(model)` then one pose per `extraValues` set,
 * appended as given (a set equal to a default pose is checked twice), with
 * the auto-rig's by-design closures (`SHUT_BY`) kept out of `worst`.
 */
export function checkModelFolds(
  model: IkiModel,
  extraValues: Record<string, number>[] = [],
): FoldReport {
  // An undeclared parameter reads 0 from the store, which is no closure.
  const declared = new Set(model.parameters.map((p) => p.id));
  return checkFolds(model, {
    poses: [...foldPoses(model), ...extraValues.map(foldPose)],
    // The effective value, not the pose's overrides: the auto-rig's mouth
    // rests shut at its default, so `rest` and the other parameters' singles
    // are shut-mouth poses too.
    expected: (target, _pose, value) => {
      if (target.kind !== "part") return false;
      const shutBy = SHUT_BY.get(target.id);
      return (
        shutBy !== undefined && declared.has(shutBy) && value(shutBy) === 0
      );
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

/**
 * `values` named by the `FoldPose.name` contract, as the engine names its own
 * poses (its helper is not exported): sorted `id=value` pairs joined by one
 * space, `rest` when empty. Never a caller's PNG name, so a `FOLD` line keeps
 * settings a host can reproduce.
 */
export function foldPose(values: Record<string, number>): FoldPose {
  const ids = Object.keys(values).sort();
  const name =
    ids.length === 0
      ? "rest"
      : ids.map((id) => `${id}=${values[id]}`).join(" ");
  return { name, values };
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
