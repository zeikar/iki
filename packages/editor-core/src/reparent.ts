import type { IkiDeformer, IkiPart } from "@iki/format";

/**
 * Pure, DOM-free validation helpers for deformer reparenting and part attachment.
 * Each function throws a path-qualified plain Error on rejection and returns void
 * on success. Neither function mutates the input arrays or objects.
 */

function kindOf(d: IkiDeformer): "warp" | "matrix" {
  return d.kind === "warp" ? "warp" : "matrix";
}

/**
 * Validate that reparenting `deformerId` under `newParentId` keeps the deformer
 * hierarchy valid. Pass `newParentId === undefined` to move to root (always legal).
 * Checks: existence, self-reference, undeclared parent, kind constraint (warp
 * deformers cannot be parents), and cycle detection via the proposed edge.
 */
export function validateDeformerReparent(
  deformers: IkiDeformer[],
  deformerId: string,
  newParentId: string | undefined,
): void {
  // (1) Target deformer must exist.
  const target = deformers.find((d) => d.id === deformerId);
  if (target === undefined) {
    throw new Error(`deformers: no deformer with id "${deformerId}"`);
  }

  // (2) Root is always legal.
  if (newParentId === undefined) return;

  // (3) Self-reference.
  if (newParentId === deformerId) {
    throw new Error(
      `deformers."${deformerId}".parent "${newParentId}" is a self-reference`,
    );
  }

  // (4) Parent must be declared.
  const parent = deformers.find((d) => d.id === newParentId);
  if (parent === undefined) {
    throw new Error(
      `deformers."${deformerId}".parent "${newParentId}" is not a declared deformer`,
    );
  }

  // (5) Parent must be a matrix deformer.
  if (kindOf(parent) === "warp") {
    throw new Error(
      `deformers."${deformerId}".parent "${newParentId}" must be a matrix deformer (warp deformers cannot be parents)`,
    );
  }

  // (6) Cycle detection: build parentOf from current state, then override with
  //     the proposed edge, and walk from deformerId following the chain.
  const parentOf = new Map<string, string>();
  for (const d of deformers) {
    if (d.parent !== undefined) parentOf.set(d.id, d.parent);
  }
  // Override with the proposed edge.
  parentOf.set(deformerId, newParentId);

  const visited = new Set<string>();
  let cur: string | undefined = deformerId;
  while (cur !== undefined) {
    if (visited.has(cur)) {
      throw new Error(
        `deformers: reparenting "${deformerId}" under "${newParentId}" would create a cycle`,
      );
    }
    visited.add(cur);
    cur = parentOf.get(cur);
  }
}

/**
 * Validate that attaching part `partId` to deformer `newDeformerId` is valid.
 * Pass `newDeformerId === undefined` to detach (always legal).
 * Checks: part existence, undeclared deformer, and mesh-required-for-warp.
 */
export function validatePartAttach(
  deformers: IkiDeformer[],
  partId: string,
  parts: IkiPart[],
  newDeformerId: string | undefined,
): void {
  // (1) Part must exist.
  const part = parts.find((p) => p.id === partId);
  if (part === undefined) {
    throw new Error(`parts: no part with id "${partId}"`);
  }

  // (2) Detach is always legal.
  if (newDeformerId === undefined) return;

  // (3) Deformer must be declared.
  const deformer = deformers.find((d) => d.id === newDeformerId);
  if (deformer === undefined) {
    throw new Error(
      `parts."${partId}".deformer "${newDeformerId}" is not a declared deformer`,
    );
  }

  // (4) Warp deformer requires a mesh on the part.
  if (kindOf(deformer) === "warp" && part.mesh === undefined) {
    throw new Error(
      `parts."${partId}".deformer "${newDeformerId}" is a warp deformer and requires a mesh`,
    );
  }
}
