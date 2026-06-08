import { interpolateGridOffsets } from "@iki/editor-core";
import {
  type Affine,
  multiply,
  rotate,
  scale,
  translate,
} from "@iki/engine";
import type {
  IkiDeformerBinding,
  IkiMatrixDeformer,
  IkiParameter,
  IkiWarpDeformer,
} from "@iki/format";
import { useEffect, useRef, useState } from "react";

import { useEditorStore } from "./store";

// ---------------------------------------------------------------------------
// Inline DOM-layer math — affine composition + model↔screen mapping
// ---------------------------------------------------------------------------

/**
 * Mirror engine's `evaluateTransform` + `deformerLocalMatrix` using the PUBLIC
 * affine helpers from `@iki/engine`. Starts from `deformer.transform ?? identity`,
 * then adds each binding's contribution, then composes:
 *   translate(pivot) · TRS · translate(-pivot)
 *
 * Safe param reads: every binding resolves via `params[id] ?? descriptor.default`,
 * clamped to `[min,max]`. Normalization: max===min → 0.
 */
function headDeformerAffine(
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

  for (const binding of (deformer.bindings as IkiDeformerBinding[] | undefined) ?? []) {
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
 * Apply affine to each `(rest_i + offset_i)` point, returning flat model-space
 * [x0,y0, x1,y1, ...].
 */
function deformedGridPoints(
  restPoints: number[],
  interpolatedOffsets: number[],
  affine: Affine,
): number[] {
  const out: number[] = [];
  const [a, b, c, d, e, f] = affine;
  for (let i = 0; i < restPoints.length; i += 2) {
    const mx = restPoints[i] + interpolatedOffsets[i];
    const my = restPoints[i + 1] + interpolatedOffsets[i + 1];
    out.push(a * mx + c * my + e, b * mx + d * my + f);
  }
  return out;
}

/** Model-space → overlay-local CSS px. +y-up flip is the `−my` term. */
function modelToScreen(
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
    throw new Error("invertAffinePoint: non-invertible affine (degenerate scale)");
  }
  const invA = d / det;
  const invB = -b / det;
  const invC = -c / det;
  const invD = a / det;
  const tx = x - e;
  const ty = y - f;
  return { x: invA * tx + invC * ty, y: invB * tx + invD * ty };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface GridOverlayProps {
  /** The canvas element the overlay covers (used for sizing via ResizeObserver). */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

export function GridOverlay({ canvasRef }: GridOverlayProps) {
  // revision-keyed subscription mirrors the Inspector pattern
  const { model, params } = useEditorStore((s) => {
    void s.revision;
    return { model: s.doc.getModel(), params: s.params };
  });

  // Track canvas client size so handles stay aligned after layout changes.
  const [canvasSize, setCanvasSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const update = () => {
      setCanvasSize({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      });
    };
    update();

    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef]);

  if (!canvasSize || canvasSize.width === 0 || canvasSize.height === 0) {
    return null;
  }

  // Resolve faceWarp (IkiWarpDeformer) and its parent headDeformer (IkiMatrixDeformer).
  const deformers = model.deformers ?? [];
  const faceWarp = deformers.find(
    (d): d is IkiWarpDeformer => d.kind === "warp" && d.id === "faceWarp",
  );
  if (!faceWarp) return null;

  const headDeformer = deformers.find(
    (d): d is IkiMatrixDeformer =>
      (d.kind === "matrix" || d.kind === undefined) &&
      d.id === faceWarp.parent,
  );

  // Compute parent affine (identity if no parent deformer).
  const affine: Affine =
    headDeformer !== undefined
      ? headDeformerAffine(headDeformer, params, model.parameters)
      : [1, 0, 0, 1, 0, 0];

  // Resolve AngleX for grid offset interpolation.
  const angleXParamId = faceWarp.warps?.[0]?.parameter;
  let interpolatedOffsets: number[];
  const warps = faceWarp.warps;
  if (!warps || warps.length === 0 || !angleXParamId) {
    // No warps — draw rest grid (all-zero offsets).
    interpolatedOffsets = new Array(faceWarp.grid.points.length).fill(0);
  } else {
    const descriptor = model.parameters.find((p) => p.id === angleXParamId);
    let angleXValue = 0;
    if (descriptor) {
      const raw = params[angleXParamId] ?? descriptor.default;
      angleXValue = Math.max(descriptor.min, Math.min(descriptor.max, raw));
    }
    interpolatedOffsets = interpolateGridOffsets(warps[0].keyforms, angleXValue);
  }

  // corrupted keyform → draw rest grid, not NaN handles
  const safeOffsets =
    interpolatedOffsets.length === faceWarp.grid.points.length
      ? interpolatedOffsets
      : new Array(faceWarp.grid.points.length).fill(0) as number[];
  const deformed = deformedGridPoints(faceWarp.grid.points, safeOffsets, affine);

  const { width: clientWidth, height: clientHeight } = canvasSize;
  const { width: modelW, height: modelH } = model.canvas;

  // Convert all deformed model-space points to overlay-local screen px.
  const screenPts: { sx: number; sy: number }[] = [];
  for (let i = 0; i < deformed.length; i += 2) {
    screenPts.push(
      modelToScreen(deformed[i], deformed[i + 1], clientWidth, clientHeight, modelW, modelH),
    );
  }

  const cols = faceWarp.grid.cols;
  const rows = faceWarp.grid.rows;

  // Build grid line segments: horizontal (along rows) + vertical (along cols).
  const lines: { x1: number; y1: number; x2: number; y2: number; row: number; col: number; dir: "h" | "v" }[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * (cols + 1) + col;
      const j = i + 1;
      lines.push({
        x1: screenPts[i].sx,
        y1: screenPts[i].sy,
        x2: screenPts[j].sx,
        y2: screenPts[j].sy,
        row,
        col,
        dir: "h",
      });
    }
  }
  for (let col = 0; col <= cols; col++) {
    for (let row = 0; row < rows; row++) {
      const i = row * (cols + 1) + col;
      const j = i + (cols + 1);
      lines.push({
        x1: screenPts[i].sx,
        y1: screenPts[i].sy,
        x2: screenPts[j].sx,
        y2: screenPts[j].sy,
        row,
        col,
        dir: "v",
      });
    }
  }

  return (
    <svg
      ref={svgRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
      }}
      viewBox={`0 0 ${clientWidth} ${clientHeight}`}
    >
      {lines.map((ln) => (
        <line
          key={`${ln.dir}-${ln.row}-${ln.col}`}
          x1={ln.x1}
          y1={ln.y1}
          x2={ln.x2}
          y2={ln.y2}
          stroke="rgba(100,160,255,0.55)"
          strokeWidth={1}
        />
      ))}
      {screenPts.map((pt, idx) => (
        <circle
          key={`p-${idx}`}
          cx={pt.sx}
          cy={pt.sy}
          r={4}
          fill="rgba(100,180,255,0.85)"
          stroke="rgba(255,255,255,0.7)"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}
