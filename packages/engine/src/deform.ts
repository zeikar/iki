import type {
  IkiBinding,
  IkiDeformer,
  IkiDeformerBinding,
  IkiDeformerTransform,
  IkiMatrixDeformer,
  IkiTransform,
  IkiWarpDeformer,
} from "@ikijs/format";
import { type Affine, multiply, rotate, scale, translate } from "./affine";
import type { ParameterStore } from "./parameter-store";
import {
  type ResolvedWarpGrid,
  deformWarpGrid,
  transformGridPoints,
  warpRigidFrame,
} from "./warp-grid";

/** Resolved TRS + opacity from a transform + bindings at current parameter values. */
export interface ResolvedTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
}

const IDENTITY_TRANSFORM: Required<IkiTransform> = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
};

/**
 * Shared transform evaluator: resolves the effective TRS + opacity from a
 * (possibly absent) base transform plus bindings at current parameter values.
 *
 * - Part callers pass `IkiTransform` (which may include opacity) and use all 6
 *   fields including `opacity`.
 * - Deformer callers pass `IkiDeformerTransform` (no opacity field) and
 *   `IkiDeformerBinding[]` (no opacity channel); the returned `opacity` is
 *   always 1 on the deformer path and should be ignored by the caller.
 */
export function evaluateTransform(
  transform: IkiTransform | IkiDeformerTransform | undefined,
  bindings: IkiBinding[] | IkiDeformerBinding[] | undefined,
  params: ParameterStore,
): ResolvedTransform {
  const base = transform ?? IDENTITY_TRANSFORM;
  const result: ResolvedTransform = {
    x: base.x,
    y: base.y,
    rotation: base.rotation ?? 0,
    scaleX: base.scaleX ?? 1,
    scaleY: base.scaleY ?? 1,
    opacity: (base as IkiTransform).opacity ?? 1,
  };

  for (const binding of bindings ?? []) {
    const t = params.normalized(binding.parameter);
    const value = binding.from + (binding.to - binding.from) * t;
    switch (binding.channel) {
      case "translateX":
        result.x += value;
        break;
      case "translateY":
        result.y += value;
        break;
      case "rotate":
        result.rotation += value;
        break;
      case "scaleX":
        result.scaleX += value;
        break;
      case "scaleY":
        result.scaleY += value;
        break;
      case "opacity":
        result.opacity *= value;
        break;
    }
  }

  return result;
}

/**
 * Build the local deformer matrix about its pivot:
 *   translate(pivot) · TRS · translate(-pivot)
 */
function deformerLocalMatrix(
  d: IkiMatrixDeformer,
  params: ParameterStore,
): Affine {
  const t = evaluateTransform(d.transform, d.bindings, params);
  const trs: Affine = multiply(
    multiply(translate(t.x, t.y), rotate(t.rotation)),
    scale(t.scaleX, t.scaleY),
  );
  return multiply(
    multiply(translate(d.pivot.x, d.pivot.y), trs),
    translate(-d.pivot.x, -d.pivot.y),
  );
}

/** Every deformer of a model resolved for one frame. */
export interface ResolvedDeformers {
  /** Matrix deformer id → world affine. */
  worlds: Map<string, Affine>;
  /** Warp deformer id → deformed control grid, model space. */
  grids: Map<string, ResolvedWarpGrid>;
}

/**
 * A warp's grid before its parent affine, and that affine (absent at a root)
 * — what a matrix child of the warp reads its rigid frame from.
 */
interface LocalWarp {
  localGrid: Float32Array;
  parentWorld: Affine | undefined;
}

/**
 * Resolve every deformer — matrix worlds and warp grids — in topological
 * order, regardless of array ordering.
 *
 * The validator guarantees the hierarchy is acyclic, that every `parent` id
 * exists and that no warp hangs from a warp; the engine resolves on-demand
 * with memoization so any valid array order is handled correctly.
 *
 * Throws a clear internal Error if a parent is unexpectedly absent or a warp
 * hangs from a warp (defense-in-depth — indicates an unvalidated model was
 * passed to the engine).
 */
export function resolveDeformers(
  deformers: IkiDeformer[],
  params: ParameterStore,
): ResolvedDeformers {
  const byId = new Map<string, IkiDeformer>(deformers.map((d) => [d.id, d]));
  const worlds = new Map<string, Affine>();
  const grids = new Map<string, ResolvedWarpGrid>();
  const localWarps = new Map<string, LocalWarp>();

  function parentOf(d: IkiDeformer): IkiDeformer | undefined {
    if (d.parent === undefined) return undefined;
    const parent = byId.get(d.parent);
    if (!parent) {
      throw new Error(
        `unresolved deformer parent "${d.parent}" — model not validated?`,
      );
    }
    return parent;
  }

  function resolveWorld(d: IkiMatrixDeformer): Affine {
    const cached = worlds.get(d.id);
    if (cached) return cached;

    const local = deformerLocalMatrix(d, params);
    const parent = parentOf(d);
    let world: Affine;
    if (parent === undefined) {
      world = local;
    } else if (parent.kind === "warp") {
      // The frame comes off the warp's LOCAL grid and the warp's own parent
      // affine goes on top — the same order the grid itself is resolved in,
      // so a rest warp between two matrices changes nothing.
      const warp = resolveWarp(parent);
      const ridden = multiply(
        warpRigidFrame(d.pivot, parent.grid, warp.localGrid),
        local,
      );
      world = warp.parentWorld ? multiply(warp.parentWorld, ridden) : ridden;
    } else {
      world = multiply(resolveWorld(parent), local);
    }

    worlds.set(d.id, world);
    return world;
  }

  function resolveWarp(d: IkiWarpDeformer): LocalWarp {
    const cached = localWarps.get(d.id);
    if (cached) return cached;

    const parent = parentOf(d);
    if (parent?.kind === "warp") {
      throw new Error(
        `warp deformer "${d.id}" hangs from warp "${parent.id}" — model not validated?`,
      );
    }
    const parentWorld = parent && resolveWorld(parent);
    // ORDER IS CRITICAL: keyform offsets FIRST (curvature added in the rest
    // frame), parent affine SECOND — so the curvature rotates WITH the parent
    // head rather than staying pinned to world axes. The reversed order
    // (affine then offsets) pushes the bend along world-x even when the head
    // is turned (coordinate bug).
    const localGrid = deformWarpGrid(d, params);
    grids.set(d.id, {
      cols: d.grid.cols,
      rows: d.grid.rows,
      points: parentWorld
        ? transformGridPoints(localGrid, parentWorld)
        : localGrid,
    });

    const resolved = { localGrid, parentWorld };
    localWarps.set(d.id, resolved);
    return resolved;
  }

  for (const d of deformers) {
    if (d.kind === "warp") resolveWarp(d);
    else resolveWorld(d);
  }

  return { worlds, grids };
}
