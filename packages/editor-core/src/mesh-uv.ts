import type { IkiUvRect } from "@iki/format";

/**
 * Affinely map a mesh's BASE local UVs into an atlas sub-rectangle.
 *
 * Per the `@iki/format` UV convention (top-left origin, +y down, 0..1; see
 * {@link IkiUvRect}/{@link IkiMesh}), the input is the part's BASE local uvs and
 * the output places each component into `rect` with NO flip — base UV space and
 * `rect` share the same orientation:
 *   out[2i]   = rect.x + baseUvs[2i]   * rect.width
 *   out[2i+1] = rect.y + baseUvs[2i+1] * rect.height
 *
 * The caller guarantees `rect` is inset/clamped (via `uvRectFor`) so every
 * output component stays within 0..1 and passes the format validator.
 *
 * Returns a fresh array; `baseUvs` is never mutated.
 */
export function remapMeshUvsToRect(
  baseUvs: number[],
  rect: IkiUvRect,
): number[] {
  if (baseUvs.length % 2 !== 0) {
    throw new Error(
      `remapMeshUvsToRect: baseUvs must have an even length (u,v pairs), got ${baseUvs.length}`,
    );
  }

  const out = new Array<number>(baseUvs.length);
  for (let i = 0; i < baseUvs.length; i += 2) {
    out[i] = rect.x + baseUvs[i] * rect.width;
    out[i + 1] = rect.y + baseUvs[i + 1] * rect.height;
  }
  return out;
}
