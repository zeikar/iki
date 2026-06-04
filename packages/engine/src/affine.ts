// --- 2D affine helpers ------------------------------------------------------
// Affine stored as [a, b, c, d, e, f] => | a c e |
//                                        | b d f |
//                                        | 0 0 1 |
export type Affine = [number, number, number, number, number, number];

export function translate(tx: number, ty: number): Affine {
  return [1, 0, 0, 1, tx, ty];
}

export function scale(sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotate(degrees: number): Affine {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export function multiply(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Expand a 2D affine into a column-major mat3 for `uniformMatrix3fv`. */
export function toMat3(a: Affine): Float32Array {
  return new Float32Array([a[0], a[1], 0, a[2], a[3], 0, a[4], a[5], 1]);
}
