import type {
  IkiGrid2DWarp,
  IkiGridWarp,
  IkiMesh,
  IkiUvRect,
  IkiWarp,
  IkiWarpGrid,
} from "@iki/format";

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

/**
 * Formula-bake a head-turn grid warp for ParamAngleX: applies the same
 * cylinder-bend (asin/sin) as bakeHeadTurnWarp to the grid control points.
 * Grid points are MODEL space, so RADIUS is in model units (not ±0.5 local).
 * Center keyform (θ=0) is all-zero. Children auto-bind to the rest grid.
 */
export function bakeHeadTurnGridWarp(
  grid: IkiWarpGrid,
  parameter: string,
): IkiGridWarp {
  // Keyform stops (degrees) match ParamAngleX's −30..30 range.
  const ANGLES = [-30, 0, 30] as const;
  // Cylinder radius in MODEL units. The grid spans roughly x ∈ [-260, 260], so
  // half-width ≈ 260. Use a slightly larger radius so asin stays well clear of
  // ±1 — mirrors the local version's 0.6 vs 0.5 margin.
  const halfWidth = (grid.points[grid.cols * 2] - grid.points[0]) / 2;
  const RADIUS = halfWidth * (0.6 / 0.5); // same margin ratio as bakeHeadTurnWarp

  const pointCount = grid.points.length / 2;
  const DEG_TO_RAD = Math.PI / 180;

  const keyforms = ANGLES.map((angleDeg) => {
    const theta = angleDeg * DEG_TO_RAD;
    const offsets: number[] = [];

    for (let i = 0; i < pointCount; i++) {
      const x = grid.points[i * 2];
      // Clamp x/RADIUS to [-1,1] to keep asin defined even at boundary points.
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

/**
 * Formula-bake a 2D head-turn grid warp driven by two parameters (AngleX, AngleY).
 *
 * WHY 2D: to capture both horizontal cylinder-bend (AngleX) and vertical
 * cylinder-bend (AngleY) simultaneously via bilinear interpolation of a 3×3
 * lattice of keyforms. The rigid portion (rotate + translate) stays on the
 * matrix parent (headDeformer) — this warp adds curvature only, same split
 * contract as the 1D version.
 *
 * LAYOUT (row-major, k(i,j) = j * valuesX.length + i):
 *   i indexes valuesX (AngleX axis), j indexes valuesY (AngleY axis).
 *   Center entry k(1,1) is AngleX=0,AngleY=0 → all-zero offsets (rest pose).
 *
 * +AngleX = head turns right → positive dx (xPrime moves right).
 * +AngleY = head tilts up    → positive dy (yPrime moves up).
 */
export function bakeHeadTurnGridWarp2D(
  grid: IkiWarpGrid,
  parameter: string,
  parameterY: string,
): IkiGrid2DWarp {
  const valuesX = [-30, 0, 30];
  const valuesY = [-30, 0, 30];

  // Cylinder radii in MODEL units. Same margin ratio (0.6/0.5) as bakeHeadTurnGridWarp.
  const halfWidth2d = (grid.points[grid.cols * 2] - grid.points[0]) / 2;
  const RADIUS_X = halfWidth2d * (0.6 / 0.5);

  // For vertical bend, derive half-height from the grid's y extent.
  // points[1] is the top-left y (row=0, col=0).
  // The bottom-left point is at row=rows, col=0: index rows*(cols+1), y at [index*2+1].
  const firstY = grid.points[1];
  const lastY = grid.points[grid.rows * (grid.cols + 1) * 2 + 1];
  const halfHeight = Math.abs(firstY - lastY) / 2;
  const RADIUS_Y = halfHeight * (0.6 / 0.5);

  const pointCount = grid.points.length / 2;
  const DEG_TO_RAD = Math.PI / 180;

  const keyforms2d: { offsets: number[] }[] = [];
  // Outer loop: j over valuesY; inner loop: i over valuesX.
  // Row-major: k(i,j) = j * valuesX.length + i.
  for (let j = 0; j < valuesY.length; j++) {
    const angleYDeg = valuesY[j];
    const thetaY = angleYDeg * DEG_TO_RAD;

    for (let i = 0; i < valuesX.length; i++) {
      const angleXDeg = valuesX[i];
      const thetaX = angleXDeg * DEG_TO_RAD;

      const offsets: number[] = [];
      for (let p = 0; p < pointCount; p++) {
        const x = grid.points[p * 2];
        const y = grid.points[p * 2 + 1];

        // Horizontal cylinder bend (AngleX): same as bakeHeadTurnGridWarp.
        const alphaX = Math.asin(Math.max(-1, Math.min(1, x / RADIUS_X)));
        const xPrime = RADIUS_X * Math.sin(alphaX + thetaX);
        const dx = xPrime - x;

        // Vertical cylinder bend (AngleY): symmetric formula applied to y.
        // +thetaY → the point arcs upward (+y direction).
        const alphaY = Math.asin(Math.max(-1, Math.min(1, y / RADIUS_Y)));
        const yPrime = RADIUS_Y * Math.sin(alphaY + thetaY);
        const dy = yPrime - y;

        offsets.push(dx, dy);
      }

      // Center entry k(1,1): angleX=0, angleY=0 → thetaX=thetaY=0 → dx=dy=0 for all points.
      keyforms2d.push({ offsets });
    }
  }

  return { parameter, parameterY, valuesX, valuesY, keyforms2d };
}
