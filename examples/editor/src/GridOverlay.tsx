import {
  CaptureGridKeyform,
  computeGridOffsets,
  interpolateGridOffsets,
} from "@iki/editor-core";
import { type Affine } from "@iki/engine";
import type { IkiMatrixDeformer, IkiWarpDeformer } from "@iki/format";
import { useEffect, useRef, useState } from "react";

import {
  invertAffinePoint,
  matrixWorldAffine,
  modelToScreen,
  screenToModel,
} from "./overlay-math";
import { useEditorStore } from "./store";

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface GridOverlayProps {
  /** The canvas element the overlay covers (used for sizing via ResizeObserver). */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

/** Live drag state for a single in-flight handle drag. */
interface DragState {
  /** Index into the grid's control-point array (0-based). */
  index: number;
  /** Current dragged handle position in overlay-local CSS px. */
  sx: number;
  sy: number;
}

export function GridOverlay({ canvasRef }: GridOverlayProps) {
  // revision-keyed subscription mirrors the Inspector pattern: single-value
  // selectors only. Returning a fresh `{ model, params }` object from one
  // selector makes useSyncExternalStore see a new snapshot every render → an
  // infinite update loop. `revision` (a number) re-renders on in-place model
  // edits; `params` (a new ref per setParam) re-renders on slider changes.
  const doc = useEditorStore((s) => s.doc);
  const params = useEditorStore((s) => s.params);
  const revision = useEditorStore((s) => s.revision);
  void revision;
  const model = doc.getModel();
  const runCommand = useEditorStore((s) => s.runCommand);
  const setExportError = useEditorStore((s) => s.setExportError);

  // Track canvas client size so handles stay aligned after layout changes.
  const [canvasSize, setCanvasSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Live drag state: null when no drag in progress.
  const [drag, setDrag] = useState<DragState | null>(null);
  // Ref-based drag info set synchronously in onPointerDown so onPointerMove and
  // onPointerUp never depend on possibly-stale React state for the index or drag
  // liveness check. null when no drag is in progress.
  const draggingRef = useRef<{ index: number } | null>(null);

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

  // All matrix deformers (warp deformers have no pivot/TRS so they are excluded).
  const matrixDeformers = deformers.filter(
    (d): d is IkiMatrixDeformer => d.kind === "matrix" || d.kind === undefined,
  );

  // Compute parent world affine by composing the FULL ancestor chain.
  const affine: Affine = matrixWorldAffine(
    faceWarp.parent,
    matrixDeformers,
    params,
    model.parameters,
  );

  // Resolve AngleX for grid offset interpolation.
  const angleXParamId = faceWarp.warps?.[0]?.parameter;
  let interpolatedOffsets: number[];
  let safeAngleXValue = 0;
  const warps = faceWarp.warps;
  if (!warps || warps.length === 0 || !angleXParamId) {
    // No warps — draw rest grid (all-zero offsets).
    interpolatedOffsets = new Array(faceWarp.grid.points.length).fill(0);
  } else {
    const descriptor = model.parameters.find((p) => p.id === angleXParamId);
    if (descriptor) {
      const raw = params[angleXParamId] ?? descriptor.default;
      safeAngleXValue = Math.max(descriptor.min, Math.min(descriptor.max, raw));
    }
    interpolatedOffsets = interpolateGridOffsets(
      warps[0].keyforms,
      safeAngleXValue,
    );
  }

  // corrupted keyform → draw rest grid, not NaN handles
  const safeOffsets =
    interpolatedOffsets.length === faceWarp.grid.points.length
      ? interpolatedOffsets
      : (new Array(faceWarp.grid.points.length).fill(0) as number[]);
  const deformed = deformedGridPoints(
    faceWarp.grid.points,
    safeOffsets,
    affine,
  );

  const { width: clientWidth, height: clientHeight } = canvasSize;
  const { width: modelW, height: modelH } = model.canvas;

  // Convert all deformed model-space points to overlay-local screen px.
  const screenPts: { sx: number; sy: number }[] = [];
  for (let i = 0; i < deformed.length; i += 2) {
    screenPts.push(
      modelToScreen(
        deformed[i],
        deformed[i + 1],
        clientWidth,
        clientHeight,
        modelW,
        modelH,
      ),
    );
  }

  const cols = faceWarp.grid.cols;
  const rows = faceWarp.grid.rows;

  // Apply live drag preview before building lines so lines track the dragged handle.
  const displayPts = screenPts.map((pt, idx) => {
    if (drag !== null && drag.index === idx) {
      return { sx: drag.sx, sy: drag.sy };
    }
    return pt;
  });

  // Build grid line segments from displayPts so drag deformation is previewed live.
  const lines: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    row: number;
    col: number;
    dir: "h" | "v";
  }[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * (cols + 1) + col;
      const j = i + 1;
      lines.push({
        x1: displayPts[i].sx,
        y1: displayPts[i].sy,
        x2: displayPts[j].sx,
        y2: displayPts[j].sy,
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
        x1: displayPts[i].sx,
        y1: displayPts[i].sy,
        x2: displayPts[j].sx,
        y2: displayPts[j].sy,
        row,
        col,
        dir: "v",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Pointer drag handlers
  // ---------------------------------------------------------------------------

  /**
   * Shared teardown: resets drag state and releases pointer capture.
   * Called from pointerup (success or error) and pointercancel/lostpointercapture.
   */
  function endDrag(e: React.PointerEvent<SVGCircleElement>) {
    draggingRef.current = null;
    setDrag(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // lostpointercapture already released it; cancel/up may double-release — both safe to ignore.
    }
  }

  function onPointerDown(
    e: React.PointerEvent<SVGCircleElement>,
    index: number,
  ) {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    draggingRef.current = { index };
    setDrag({ index, sx, sy });
  }

  function onPointerMove(e: React.PointerEvent<SVGCircleElement>) {
    if (draggingRef.current === null) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // Update ONLY local drag preview — no doc mutation, no reload.
    setDrag((prev) => (prev === null ? null : { ...prev, sx, sy }));
  }

  function onPointerUp(e: React.PointerEvent<SVGCircleElement>) {
    // Use the synchronous ref for the drag index — never stale React state.
    const activeDrag = draggingRef.current;
    if (activeDrag === null) return;
    try {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) throw new Error("GridOverlay: SVG ref not available on drop");
      // faceWarp guaranteed non-null by the early return above.

      // Verify the driving parameter descriptor is present before capturing.
      if (
        angleXParamId &&
        !model.parameters.find((p) => p.id === angleXParamId)
      ) {
        throw new Error(
          `Cannot capture keyform: parameter "${angleXParamId}" is not declared`,
        );
      }

      // Derive drop position from the event's OWN coordinates, not from
      // React state (which may be one pointermove behind due to batching).
      const dropSx = e.clientX - rect.left;
      const dropSy = e.clientY - rect.top;

      // Convert overlay-local px → model space → rest frame.
      const { mx, my } = screenToModel(
        dropSx,
        dropSy,
        clientWidth,
        clientHeight,
        modelW,
        modelH,
      );
      // invertAffinePoint throws on non-invertible affine.
      const restTarget = invertAffinePoint(affine, mx, my);

      // Assemble full rest-frame target array: non-dragged = rest_i + interpolatedOffset_i.
      // faceWarp! — guaranteed non-null by the early return above.
      const restPoints = faceWarp!.grid.points;
      const restFrameDraggedPoints: number[] = [];
      for (let i = 0; i < restPoints.length; i += 2) {
        const ptIndex = i / 2;
        if (ptIndex === activeDrag.index) {
          restFrameDraggedPoints.push(restTarget.x, restTarget.y);
        } else {
          restFrameDraggedPoints.push(
            restPoints[i] + safeOffsets[i],
            restPoints[i + 1] + safeOffsets[i + 1],
          );
        }
      }

      const offsets = computeGridOffsets(restPoints, restFrameDraggedPoints);
      runCommand(new CaptureGridKeyform("faceWarp", safeAngleXValue, offsets));
      // Clear any prior grid-capture error on success.
      setExportError(null);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      // No keyform written — abort capture.
    } finally {
      endDrag(e);
    }
  }

  function onPointerCancel(e: React.PointerEvent<SVGCircleElement>) {
    // Discard in-progress drag without committing a keyform.
    endDrag(e);
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
      {displayPts.map((pt, idx) => (
        <circle
          key={`p-${idx}`}
          cx={pt.sx}
          cy={pt.sy}
          r={4}
          fill={
            drag?.index === idx
              ? "rgba(255,220,80,0.95)"
              : "rgba(100,180,255,0.85)"
          }
          stroke="rgba(255,255,255,0.7)"
          strokeWidth={1}
          style={{ pointerEvents: "auto", cursor: "grab" }}
          onPointerDown={(e) => onPointerDown(e, idx)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
        />
      ))}
    </svg>
  );
}
