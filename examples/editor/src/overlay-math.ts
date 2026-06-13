import { type Affine, multiply, rotate, scale, translate } from "@iki/engine";
import type {
  IkiDeformerBinding,
  IkiMatrixDeformer,
  IkiParameter,
} from "@iki/format";

// ---------------------------------------------------------------------------
// Overlay coordinate math — affine composition + model↔screen mapping.
// Shared DOM-free helpers used by GridOverlay and PivotOverlay.
// ---------------------------------------------------------------------------

/**
 * Compute the LOCAL affine for a single matrix deformer:
 *   translate(pivot) · TRS · translate(-pivot)
 *
 * Safe param reads: every binding resolves via `params[id] ?? descriptor.default`,
 * clamped to `[min,max]`. Normalization: max===min → 0.
 */
export function deformerLocalAffine(
  deformer: IkiMatrixDeformer,
  params: Record<string, number>,
  parameters: IkiParameter[],
): Affine {
  const base = deformer.transform;
  let tx = base?.x ?? 0;
  let ty = base?.y ?? 0;
  let r = base?.rotation ?? 0;
  let sx = base?.scaleX ?? 1;
  let sy = base?.scaleY ?? 1;

  for (const binding of (deformer.bindings as
    | IkiDeformerBinding[]
    | undefined) ?? []) {
    const descriptor = parameters.find((p) => p.id === binding.parameter);
    if (!descriptor) continue;
    const raw = params[binding.parameter] ?? descriptor.default;
    const clamped = Math.max(descriptor.min, Math.min(descriptor.max, raw));
    const t =
      descriptor.max === descriptor.min
        ? 0
        : (clamped - descriptor.min) / (descriptor.max - descriptor.min);
    const contribution = binding.from + (binding.to - binding.from) * t;
    switch (binding.channel) {
      case "translateX":
        tx += contribution;
        break;
      case "translateY":
        ty += contribution;
        break;
      case "rotate":
        r += contribution;
        break;
      case "scaleX":
        sx += contribution;
        break;
      case "scaleY":
        sy += contribution;
        break;
    }
  }

  const trs: Affine = multiply(
    multiply(translate(tx, ty), rotate(r)),
    scale(sx, sy),
  );
  const { x: px, y: py } = deformer.pivot;
  return multiply(multiply(translate(px, py), trs), translate(-px, -py));
}

/**
 * Compute the world-space affine for a matrix deformer by composing the FULL
 * ancestor chain, mirroring the engine's `resolveDeformerWorlds`.
 *
 *   world = parentWorld · localAffine
 *
 * Guards against cyclic/self parent references (bounded walk) so a malformed
 * model can't infinite-loop. Returns identity for an absent deformer id.
 */
export function matrixWorldAffine(
  deformerId: string | undefined,
  deformers: IkiMatrixDeformer[],
  params: Record<string, number>,
  parameters: IkiParameter[],
): Affine {
  const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
  if (deformerId === undefined) return IDENTITY;

  const byId = new Map<string, IkiMatrixDeformer>(
    deformers.map((d) => [d.id, d]),
  );
  const cache = new Map<string, Affine>();

  function resolve(id: string, visited: Set<string>): Affine {
    const cached = cache.get(id);
    if (cached) return cached;

    // Cycle guard: if we've already started resolving this id in this chain, bail.
    if (visited.has(id)) return IDENTITY;
    visited.add(id);

    const deformer = byId.get(id);
    if (!deformer) return IDENTITY;

    const local = deformerLocalAffine(deformer, params, parameters);
    const world =
      deformer.parent === undefined
        ? local
        : multiply(resolve(deformer.parent, new Set(visited)), local);

    cache.set(id, world);
    return world;
  }

  return resolve(deformerId, new Set());
}

/** Model-space → overlay-local CSS px. +y-up flip is the `−my` term. */
export function modelToScreen(
  mx: number,
  my: number,
  clientWidth: number,
  clientHeight: number,
  modelW: number,
  modelH: number,
): { sx: number; sy: number } {
  const cx = clientWidth / 2;
  const cy = clientHeight / 2;
  const fitCss = Math.min(clientWidth / modelW, clientHeight / modelH);
  return { sx: cx + mx * fitCss, sy: cy - my * fitCss };
}

/**
 * Overlay-local CSS px → model space. Exported for Task 3 drag wiring.
 * (clientX/clientY from pointer events must first be converted:
 *  sx = clientX - rect.left,  sy = clientY - rect.top)
 */
export function screenToModel(
  sx: number,
  sy: number,
  clientWidth: number,
  clientHeight: number,
  modelW: number,
  modelH: number,
): { mx: number; my: number } {
  const cx = clientWidth / 2;
  const cy = clientHeight / 2;
  const fitCss = Math.min(clientWidth / modelW, clientHeight / modelH);
  return { mx: (sx - cx) / fitCss, my: (cy - sy) / fitCss };
}

/**
 * Invert the parent-affine transform, mapping a model-space point back to
 * the space BEFORE the affine (the warp-deformer's local rest space).
 * Exported for Task 3 drag capture.
 * Throws on near-zero determinant (non-invertible affine — degenerate scale).
 */
export function invertAffinePoint(
  affine: Affine,
  x: number,
  y: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = affine;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) {
    throw new Error(
      "invertAffinePoint: non-invertible affine (degenerate scale)",
    );
  }
  const invA = d / det;
  const invB = -b / det;
  const invC = -c / det;
  const invD = a / det;
  const tx = x - e;
  const ty = y - f;
  return { x: invA * tx + invC * ty, y: invB * tx + invD * ty };
}
