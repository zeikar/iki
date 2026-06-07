import type { IkiMesh, IkiUvRect, IkiWarp } from "@iki/format";

/**
 * Generate a regular grid mesh in part LOCAL space (±0.5 unit frame).
 *
 * Vertices span x ∈ [-0.5, 0.5] and y ∈ [-0.5, 0.5] (+y up, matching the
 * engine's model space convention). UVs are linearly interpolated across the
 * supplied uv rect with the TOP row of the grid (highest y) mapping to v=uv.y
 * (the top edge of the rect) — so y and v move in opposite directions (y is
 * +up, v is top-down), which keeps the texture upright without any flip.
 *
 * Index winding follows [0,1,2, 2,1,3] (BL,BR,TL / TL,BR,TR per cell) to
 * match the engine's implicit-quad convention.
 */
export function generateGridMesh(
  cols: number,
  rows: number,
  uv: IkiUvRect,
): IkiMesh {
  const colVerts = cols + 1;
  const rowVerts = rows + 1;

  const vertices: number[] = [];
  const uvs: number[] = [];

  // Row 0 is the TOP of the grid (y = +0.5). Row `rows` is the BOTTOM (y = -0.5).
  // Column 0 is left (x = -0.5). Column `cols` is right (x = +0.5).
  for (let row = 0; row < rowVerts; row++) {
    // t runs 0..1 top→bottom across rows
    const t = row / rows;
    const y = 0.5 - t; // +0.5 at row 0, -0.5 at row `rows`
    // v maps top of grid to uv.y (top of the rect), bottom to uv.y+uv.height
    const v = uv.y + t * uv.height;

    for (let col = 0; col < colVerts; col++) {
      const s = col / cols;
      const x = -0.5 + s; // -0.5 at col 0, +0.5 at col `cols`
      const u = uv.x + s * uv.width;

      vertices.push(x, y);
      uvs.push(u, v);
    }
  }

  // Two triangles per cell following [0,1,2, 2,1,3] winding (BL,BR,TL / TL,BR,TR).
  // For each cell: TL=top-left, TR=top-right, BL=bottom-left, BR=bottom-right.
  const indices: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tl = row * colVerts + col;
      const tr = row * colVerts + col + 1;
      const bl = (row + 1) * colVerts + col;
      const br = (row + 1) * colVerts + col + 1;

      // [BL, BR, TL] — first triangle
      indices.push(bl, br, tl);
      // [TL, BR, TR] — second triangle
      indices.push(tl, br, tr);
    }
  }

  return { vertices, uvs, indices };
}

/**
 * Bake a head-turn cylinder-bend warp for ParamAngleX.
 *
 * WHY a cylinder: turning a flat face mesh by the rigid deformer rotation looks
 * correct from the front but the face doesn't narrow at the sides. Projecting
 * each vertex onto a cylinder and rotating it makes the silhouette foreshorten
 * naturally — the face appears to gain depth as it turns.
 *
 * HOW: each vertex at rest x sits on a cylinder of radius RADIUS. Its angular
 * position on the cylinder is α = asin(x/RADIUS). When the head turns by angle
 * θ (degrees), the vertex's cylinder angle becomes α+θ, giving new x' =
 * RADIUS*sin(α+θ). The delta is dx = x' − x; dy = 0 (no vertical deformation).
 * At θ=0 the center keyform has all-zero offsets because x' = x.
 *
 * NOTE: the rigid part of the turn (translate + rotate) lives on the
 * headDeformer and must NOT be duplicated here — this warp adds only the BEND.
 */
export function bakeHeadTurnWarp(mesh: IkiMesh, parameter: string): IkiWarp {
  // Keyform stops (degrees) match ParamAngleX's −30..30 range.
  const ANGLES = [-30, 0, 30] as const;
  // Cylinder radius in ±0.5 local units. At 0.5 the max x (±0.5) sits at
  // exactly ±90° — use a slightly larger radius so asin stays well clear of ±1.
  const RADIUS = 0.6;

  const vertexCount = mesh.vertices.length / 2;
  const DEG_TO_RAD = Math.PI / 180;

  const keyforms = ANGLES.map((angleDeg) => {
    const theta = angleDeg * DEG_TO_RAD;
    const offsets: number[] = [];

    for (let i = 0; i < vertexCount; i++) {
      const x = mesh.vertices[i * 2];
      // Clamp x/RADIUS to [-1,1] to keep asin defined even at boundary verts.
      const alpha = Math.asin(Math.max(-1, Math.min(1, x / RADIUS)));
      const xPrime = RADIUS * Math.sin(alpha + theta);
      const dx = xPrime - x;
      // dy is zero — cylinder bend only deforms horizontal position.
      offsets.push(dx, 0);
    }

    return { value: angleDeg, offsets };
  });

  // keyforms are sorted ascending by construction (ANGLES = [-30, 0, 30]).
  return { parameter, keyforms };
}
