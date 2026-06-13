// Second canvas gizmo: pivot handle for the selected matrix deformer.
// Distinct from GridOverlay (warp grid). Reuses overlay-math for coordinate math.

import { SetDeformerPivot } from "@iki/editor-core";
import type { IkiMatrixDeformer } from "@iki/format";
import { useEffect, useRef, useState } from "react";

import {
  invertAffinePoint,
  matrixWorldAffine,
  modelToScreen,
  screenToModel,
} from "./overlay-math";
import { useEditorStore } from "./store";

// Crosshair arm half-length in CSS px.
const ARM = 10;

interface PivotOverlayProps {
  /** The canvas element the overlay covers (used for sizing via ResizeObserver). */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

export function PivotOverlay({ canvasRef }: PivotOverlayProps) {
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
  const selectedDeformerId = useEditorStore((s) => s.selectedDeformerId);
  const runCommand = useEditorStore((s) => s.runCommand);
  const setExportError = useEditorStore((s) => s.setExportError);

  // Track canvas client size so the handle stays aligned after layout changes.
  const [canvasSize, setCanvasSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Live drag state: null when no drag in progress.
  const [drag, setDrag] = useState<{ sx: number; sy: number } | null>(null);
  // Ref-based liveness flag set synchronously in onPointerDown so onPointerMove
  // and onPointerUp never depend on possibly-stale React state.
  // Boolean suffices here (single handle); GridOverlay uses `{ index } | null` because it tracks which of many grid handles is active.
  const draggingRef = useRef<boolean>(false);

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

  // Scope the gizmo to matrix deformers only (warp deformers have no pivot).
  const matrixDeformers = (model.deformers ?? []).filter(
    (d): d is IkiMatrixDeformer => d.kind === "matrix" || d.kind === undefined,
  );
  const deformer = matrixDeformers.find((d) => d.id === selectedDeformerId);

  if (selectedDeformerId === null || !deformer) {
    return null;
  }
  // Non-null alias used inside closures so TypeScript retains the narrowing.
  const activeDeformer: IkiMatrixDeformer = deformer;

  // The pivot is positioned in the PARENT's world space: the deformer's own
  // local affine is pivot-centered, so the pivot point itself maps through parentWorld.
  const parentWorld = matrixWorldAffine(
    deformer.parent,
    matrixDeformers,
    params,
    model.parameters,
  );

  // Apply the flat affine [a b c d e f] (CSS/SVG matrix convention) to the pivot point.
  const [a, b, c, d, e, f] = parentWorld;
  const { x: px, y: py } = deformer.pivot;
  const wx = a * px + c * py + e;
  const wy = b * px + d * py + f;

  const { width: clientWidth, height: clientHeight } = canvasSize;
  const { width: modelW, height: modelH } = model.canvas;

  // Convert the pivot world position to overlay-local CSS px.
  const handlePx = modelToScreen(
    wx,
    wy,
    clientWidth,
    clientHeight,
    modelW,
    modelH,
  );

  // Use live drag position when dragging, otherwise the computed handle position.
  const displayPx = drag !== null ? drag : handlePx;

  // ---------------------------------------------------------------------------
  // Pointer drag handlers
  // ---------------------------------------------------------------------------

  /**
   * Shared teardown: resets drag state and releases pointer capture.
   * Called from pointerup (success or error) and pointercancel/lostpointercapture.
   */
  function endDrag(e: React.PointerEvent<SVGCircleElement>) {
    draggingRef.current = false;
    setDrag(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // lostpointercapture already released it; cancel/up may double-release — both safe to ignore.
    }
  }

  function onPointerDown(e: React.PointerEvent<SVGCircleElement>) {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDrag({ sx: e.clientX - rect.left, sy: e.clientY - rect.top });
  }

  function onPointerMove(e: React.PointerEvent<SVGCircleElement>) {
    if (!draggingRef.current) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Update ONLY local drag preview — no doc mutation, no reload.
    setDrag({ sx: e.clientX - rect.left, sy: e.clientY - rect.top });
  }

  function onPointerUp(e: React.PointerEvent<SVGCircleElement>) {
    if (!draggingRef.current) return;
    try {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) throw new Error("PivotOverlay: SVG ref not available on drop");

      // Derive drop position from the event's OWN coordinates, not from
      // React state (which may be one pointermove behind due to batching).
      const dropSx = e.clientX - rect.left;
      const dropSy = e.clientY - rect.top;

      const { mx, my } = screenToModel(
        dropSx,
        dropSy,
        clientWidth,
        clientHeight,
        modelW,
        modelH,
      );
      // invertAffinePoint throws on non-invertible affine (degenerate scale).
      const newPivot = invertAffinePoint(parentWorld, mx, my);

      // runCommand never throws here; command-level failures surface via editError.
      runCommand(
        new SetDeformerPivot(activeDeformer.id, {
          x: newPivot.x,
          y: newPivot.y,
        }),
      );
      // Clear any prior geometry-error banner on success.
      setExportError(null);
    } catch (err) {
      // Surfaces ONLY geometry errors (ref-missing / non-invertible affine).
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      endDrag(e);
    }
  }

  function onPointerCancel(e: React.PointerEvent<SVGCircleElement>) {
    // Discard in-progress drag without committing a pivot change.
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
      {/* Crosshair lines — decorative, no pointer events. */}
      <line
        x1={displayPx.sx - ARM}
        y1={displayPx.sy}
        x2={displayPx.sx + ARM}
        y2={displayPx.sy}
        stroke="rgba(255,140,80,0.9)"
        strokeWidth={1.5}
      />
      <line
        x1={displayPx.sx}
        y1={displayPx.sy - ARM}
        x2={displayPx.sx}
        y2={displayPx.sy + ARM}
        stroke="rgba(255,140,80,0.9)"
        strokeWidth={1.5}
      />
      {/* Interactive handle circle — warm orange, visually distinct from grid handles. */}
      <circle
        cx={displayPx.sx}
        cy={displayPx.sy}
        r={6}
        fill="rgba(255,140,80,0.9)"
        stroke="rgba(255,255,255,0.8)"
        strokeWidth={1.5}
        style={{ pointerEvents: "auto", cursor: "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
      />
    </svg>
  );
}
