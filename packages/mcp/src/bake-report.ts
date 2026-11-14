/**
 * What `auto_rig_from_layers` checks of `bakes` before it writes the rig: each
 * baked custom part landed through the engine's own `landParts` at every stop
 * and at the parameter's range ends where it holds the outermost stop, against
 * the displacement the generator was asked for. The generator solves its
 * offsets in closed form, so this is the check that the closed form and the
 * player agree on the written model.
 */

import type { BakeReport } from "@ikijs/editor";
import { landParts } from "@ikijs/engine";
import type { IkiModel } from "@ikijs/format";
import { AutoRigInputError } from "./limits";

/** A bake that lands this far from what it was asked for is refused. */
const BAKE_TOLERANCE_PX = 0.1;

/** One baked part on one parameter, as the engine lands it. */
export interface BakeCheck {
  part: string;
  param: string;
  vertices: number;
  /** The stops written, ascending (rest, implicit, is not among them). */
  stops: number[];
  /** The largest gap, over the part's vertices and the stops, between the
   *  displacement the bake asked for and the engine's, in canvas px. */
  errorPx: number;
}

/** What a `BAKE ERROR` ends with: the input was valid, so the fault is not the caller's. */
const BUG =
  "the rig and the engine disagree; report this as a bug in the packages";

/**
 * Land every `reports` entry on `model` and measure the gap. The reference is
 * the part landed at rest (no parameter set); a stop's displacement is the
 * landing with `param` alone at the stop, less that. The wanted displacement
 * is in canvas px with y down; the landing is in model space, which is canvas
 * px centred on the canvas with y up, so only y changes sign.
 *
 * Throws `AutoRigInputError`, each message starting `BAKE ERROR`: for a part
 * the bake moves at rest by `BAKE_TOLERANCE_PX` or more (`<part> at rest`), and
 * for the first stop or range end that is off by as much (`<part> <param>=<value>`).
 */
export function checkBakes(
  model: IkiModel,
  reports: BakeReport[],
): BakeCheck[] {
  // The part with its bake warps removed is where it was placed. A shift the
  // rest keyform and every stop carry alike would pass the stop checks below.
  const restOf = new Map<string, Float32Array>();
  for (const id of new Set(reports.map((r) => r.part))) {
    const rest = landParts(model, {}, [id]).get(id)!;
    const bare = landParts(
      {
        ...model,
        parts: model.parts.map((p) =>
          p.id === id ? { ...p, warps: undefined } : p,
        ),
      },
      {},
      [id],
    ).get(id)!;
    let restGap = 0;
    for (let i = 0; i < rest.length; i++) {
      restGap = Math.max(restGap, Math.abs(rest[i] - bare[i]));
    }
    if (restGap >= BAKE_TOLERANCE_PX) {
      throw new AutoRigInputError(
        `BAKE ERROR ${id} at rest: the part moved ${restGap.toFixed(3)} px, where the bake must leave it (limit ${BAKE_TOLERANCE_PX} px); ${BUG}`,
      );
    }
    restOf.set(id, rest);
  }
  return reports.map((r) => {
    const rest = restOf.get(r.part)!;
    let errorPx = 0;
    const asked = [
      ...r.stops.map((value, s) => ({ value, wanted: r.wanted[s] })),
      ...r.ends,
    ];
    asked.forEach(({ value, wanted }) => {
      const posed = landParts(model, { [r.param]: value }, [r.part]).get(
        r.part,
      )!;
      let worst = 0;
      let worstVertex = 0;
      for (let v = 0; v < r.vertexCount; v++) {
        const gap = Math.hypot(
          posed[v * 2] - rest[v * 2] - wanted[v * 2],
          -(posed[v * 2 + 1] - rest[v * 2 + 1]) - wanted[v * 2 + 1],
        );
        if (gap > worst) {
          worst = gap;
          worstVertex = v;
        }
      }
      if (worst >= BAKE_TOLERANCE_PX) {
        throw new AutoRigInputError(
          `BAKE ERROR ${r.part} ${r.param}=${value}: vertex ${worstVertex} lands ${worst.toFixed(3)} px from the displacement the bake asked for (limit ${BAKE_TOLERANCE_PX} px); ${BUG}`,
        );
      }
      errorPx = Math.max(errorPx, worst);
    });
    return {
      part: r.part,
      param: r.param,
      vertices: r.vertexCount,
      stops: r.stops,
      errorPx,
    };
  });
}
