import type {
  IkiBinding,
  IkiDeformer,
  IkiDeformerBinding,
  IkiDeformerTransform,
  IkiMatrixDeformer,
  IkiTransform,
} from "@iki/format";
import { type Affine, multiply, rotate, scale, translate } from "./affine";
import type { ParameterStore } from "./parameter-store";

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

/**
 * Resolve every deformer's world matrix in topological order, regardless of
 * array ordering. Returns a Map from deformer id to world-space Affine.
 *
 * The validator guarantees the hierarchy is acyclic and that every `parent`
 * id exists; the engine resolves on-demand with memoization so any valid
 * array order is handled correctly.
 *
 * Throws a clear internal Error if a parent is unexpectedly absent (defense-
 * in-depth — indicates an unvalidated model was passed to the engine).
 */
export function resolveDeformerWorlds(
  deformers: IkiDeformer[],
  params: ParameterStore,
): Map<string, Affine> {
  // Warp deformers are non-affine; filter them out so matrix-only fields
  // (pivot/transform/bindings) are accessible and warp deformers are never
  // resolved as matrix deformers (which would produce NaN pivots).
  // Task 4's resolveWarpGrids handles warp deformers separately.
  const matrixDeformers = deformers.filter(
    (d): d is IkiMatrixDeformer => d.kind === "matrix" || d.kind === undefined,
  );
  const byId = new Map<string, IkiMatrixDeformer>(
    matrixDeformers.map((d) => [d.id, d]),
  );
  const worldById = new Map<string, Affine>();

  function resolve(d: IkiMatrixDeformer): Affine {
    const cached = worldById.get(d.id);
    if (cached) return cached;

    const local = deformerLocalMatrix(d, params);
    let world: Affine;
    if (d.parent === undefined) {
      world = local;
    } else {
      const parentDef = byId.get(d.parent);
      if (!parentDef) {
        throw new Error(
          `unresolved deformer parent "${d.parent}" — model not validated?`,
        );
      }
      world = multiply(resolve(parentDef), local);
    }

    worldById.set(d.id, world);
    return world;
  }

  for (const d of matrixDeformers) {
    resolve(d);
  }

  return worldById;
}
