/**
 * The text lines `auto_rig_from_layers` and `render_poses` print the engine's
 * `checkPhysics` report as, after the fold report.
 */

import type { PhysicsReport, PhysicsTarget } from "@ikijs/engine";
import { foldPose } from "./fold-report";

/**
 * `report` as text lines: one `PHYSICS` line per target in the report's
 * order, or `PHYSICS: no rigs`. A line gives the target's kind, its rig (`id`,
 * or `id/segment [inputs]` for a chain segment), `input -> output`, the step's
 * setting with the output's peak, when, its final value and the largest part
 * move with what the output drives, then the idle's peak, when and move, and
 * ` — <why>` when the target is not `ok`.
 */
export function formatPhysicsReport(report: PhysicsReport): string[] {
  if (report.targets.length === 0) return ["PHYSICS: no rigs"];
  return report.targets.map(targetLine);
}

function targetLine(t: PhysicsTarget): string {
  const inputs = t.input.join(", ");
  const rig =
    t.rig.kind === "chain"
      ? `${t.rig.id}/${t.rig.segment} [${inputs}]`
      : `${t.rig.id} ${inputs}`;
  const drives =
    t.drives.length === 0 ? "" : ` (${t.drives.map((d) => d.id).join(", ")})`;
  const { step, idle } = t;
  return (
    `PHYSICS ${t.kind} ${rig} -> ${t.output}: ` +
    `step ${foldPose(step.values).name} peak ${step.peak.toFixed(2)} at ${step.at.toFixed(2)} s, ` +
    `final ${step.final.toFixed(2)}, moves ${pxText(step.displacementPx)} model px${drives}; ` +
    `idle peak ${idle.peak.toFixed(2)} at ${idle.at.toFixed(2)} s, ${pxText(idle.displacementPx)} model px` +
    (t.why === undefined ? "" : ` — ${t.why}`)
  );
}

/** One decimal, floored as the engine's frozen `why` is, so a frozen 0.96 px
 *  never reads `1.0` on its own line. */
function pxText(px: number): string {
  return (Math.floor(px * 10) / 10).toFixed(1);
}
