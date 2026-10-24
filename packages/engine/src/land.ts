import type {
  IkiDeformer,
  IkiModel,
  IkiPart,
  IkiWarpDeformer,
} from "@ikijs/format";
import { type Affine, multiply, rotate, scale, translate } from "./affine";
import {
  type ResolvedDeformers,
  type ResolvedTransform,
  evaluateTransform,
} from "./deform";
import type { ParameterStore } from "./parameter-store";
import { applyWarps } from "./warp";
import { applyWarpToChild, transformGridPoints } from "./warp-grid";

/**
 * The model's deformers with every binding and keyform removed: the rig no
 * parameter moves. Its matrix worlds place a rest location, and a part's
 * baseline, in model space.
 */
export function staticDeformers(model: IkiModel): IkiDeformer[] {
  return (model.deformers ?? []).map((d) =>
    d.kind === "warp"
      ? { ...d, warps: undefined, warp2d: undefined }
      : { ...d, bindings: undefined },
  );
}

/** A part's placement as `player.ts` drawPart builds it: translate · rotate · scale(size). */
export function placement(part: IkiPart, t: ResolvedTransform): Affine {
  return multiply(
    multiply(translate(t.x, t.y), rotate(t.rotation)),
    scale(part.width * t.scaleX, part.height * t.scaleY),
  );
}

/** A part's points set up to land at any pose, and their baseline. */
export interface LandedPart {
  part: IkiPart;
  /** The warp deformer it hangs from, which lands it instead of a matrix. */
  warpDeformer?: IkiWarpDeformer;
  /** The points as the renderer holds them: part-local, float32. */
  vertices: Float32Array;
  /** Per-pose scratch: the points after the part's keyforms, then where they land. */
  local: Float32Array;
  landed: Float32Array;
  /**
   * The baseline's points: `vertices` on the STATIC chain, model space — for
   * folds, the authored mesh. Not the rendered rest pose, which is `landPart`
   * at a resting store.
   */
  restPoints: Float64Array;
}

/**
 * A part's landing, its baseline set once: `vertices` (its mesh's, or any
 * part-local points) through the part's base transform and the static world
 * it hangs from — its matrix deformer's, or its warp's PARENT's (identity at
 * a root). The grid never enters it, so a vertex the grid pins to its edge is
 * measured, not cancelled.
 */
export function landedPart(
  part: IkiPart,
  vertices: number[],
  deformers: IkiDeformer[],
  worlds: Map<string, Affine>,
  store: ParameterStore,
): LandedPart {
  // Found as drawPart finds it: a part hung from a warp is that warp's child.
  const warpDeformer = deformers.find(
    (d): d is IkiWarpDeformer => d.kind === "warp" && d.id === part.deformer,
  );
  const frame = warpDeformer ? warpDeformer.parent : part.deformer;
  const placed = placement(
    part,
    evaluateTransform(part.transform, undefined, store),
  );
  // Float64: a triangle authored degenerate stays exactly so, under folds'
  // `tiny`.
  const restPoints = transformGridPoints(
    vertices,
    frame === undefined ? placed : multiply(worlds.get(frame)!, placed),
    new Float64Array(vertices.length),
  );
  return {
    part,
    warpDeformer,
    vertices: Float32Array.from(vertices),
    local: new Float32Array(vertices.length),
    landed: new Float32Array(vertices.length),
    restPoints,
  };
}

/**
 * Where `landing`'s part lands at a pose, model space, by drawPart's three
 * branches: a warp child bound to its RAW rest grid and sampled on the
 * resolved one, a matrix child through its deformer's world, a free part by
 * its placement alone. `resolved` is the live rig at `store`'s pose, not the
 * static chain's worlds.
 */
export function landPart(
  landing: LandedPart,
  store: ParameterStore,
  { worlds, grids }: ResolvedDeformers,
): Float32Array {
  const { part, warpDeformer, local, landed } = landing;
  applyWarps(landing.vertices, part.warps, store, local);
  const placed = placement(
    part,
    evaluateTransform(part.transform, part.bindings, store),
  );
  if (warpDeformer) {
    const grid = grids.get(warpDeformer.id)!;
    applyWarpToChild(local, placed, warpDeformer.grid, grid, landed);
  } else if (part.deformer !== undefined) {
    const world = worlds.get(part.deformer)!;
    transformGridPoints(local, multiply(world, placed), landed);
  } else {
    transformGridPoints(local, placed, landed);
  }
  return landed;
}
