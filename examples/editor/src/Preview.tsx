import { IkiPlayer, IdleMotion } from "@iki/engine";
import { StandardParameter } from "@iki/format";
import { useEffect, useRef, useState, type MutableRefObject } from "react";

import { GridOverlay } from "./GridOverlay";
import { PivotOverlay } from "./PivotOverlay";
import { useEditorStore } from "./store";

// The five "life" parameters the idle driver writes. Restore touches only ids
// the loaded model actually declares.
const IDLE_PARAM_IDS = [
  StandardParameter.EyeOpenLeft,
  StandardParameter.EyeOpenRight,
  StandardParameter.Breath,
  StandardParameter.EyeballX,
  StandardParameter.EyeballY,
] as const;

interface PreviewProps {
  playerRef: MutableRefObject<IkiPlayer | null>;
}

/**
 * Owns the imperative WebGL preview: a `<canvas>` plus the {@link IkiPlayer}
 * lifecycle. It does NOT call `player.load()` — `useReloadPreview` is the
 * single load owner (including the initial load). Parameter sliders are folded
 * in here (no separate component); they appear once the first load resolves.
 */
export function Preview({ playerRef }: PreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridEditMode = useEditorStore((s) => s.gridEditMode);
  const setGridEditMode = useEditorStore((s) => s.setGridEditMode);
  const selectedDeformerId = useEditorStore((s) => s.selectedDeformerId);
  const doc = useEditorStore((s) => s.doc);
  // Idle is ephemeral PREVIEW state — never the store. It drives the player
  // directly and must leave authoring `params` untouched.
  const [idleOn, setIdleOn] = useState(false);

  useEffect(() => {
    // Exactly ONE player per effect run, destroyed in this run's cleanup.
    // `IkiPlayer.destroy()` is NOT idempotent and a destroyed player cannot be
    // reused, so we must NOT carry a player across a StrictMode remount: under
    // React 18 dev double-mount the first effect creates+destroys a player and
    // the second effect creates a FRESH one.
    const player = new IkiPlayer(canvasRef.current!);
    playerRef.current = player;
    player.start();

    return () => {
      player.destroy();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [playerRef]);

  // Entering grid-edit OR selecting a matrix deformer forces idle off — both
  // need a stable pose (grid dragging; pivot handle must align with canvas).
  // Warp deformer selection does NOT disable idle: PivotOverlay no-ops for warp.
  useEffect(() => {
    if (gridEditMode) {
      setIdleOn(false);
      return;
    }
    const d = doc.getModel().deformers?.find((x) => x.id === selectedDeformerId);
    const isMatrix = d !== undefined && (d.kind === "matrix" || d.kind === undefined);
    if (isMatrix) setIdleOn(false);
  }, [gridEditMode, selectedDeformerId, doc]);

  // Idle loop, owned entirely by the preview. Never writes the store: the loop
  // calls `player.setParameter` directly, and cleanup restores the authored
  // pose by reading `params` imperatively (no `params` subscription so slider
  // edits don't re-arm this effect).
  useEffect(() => {
    const player = playerRef.current;
    if (!idleOn || gridEditMode || !player) return;

    const idle = new IdleMotion(player.setParameter.bind(player));
    let frame = requestAnimationFrame(function tick() {
      idle.update(performance.now());
      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frame);
      // Restore the authored pose on the SAME player the loop drove. Only touch
      // ids the loaded model declares — never `.default` on an absent descriptor.
      const descriptors = new Map(player.getParameters().map((p) => [p.id, p]));
      const { params } = useEditorStore.getState();
      for (const id of IDLE_PARAM_IDS) {
        if (descriptors.has(id)) {
          player.setParameter(id, params[id] ?? descriptors.get(id)!.default);
        }
      }
    };
  }, [idleOn, gridEditMode, playerRef]);

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: "#14151a",
        minWidth: 0,
      }}
    >
      {/* Controls bar above the preview canvas */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid #2a2b33",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={gridEditMode}
            onChange={(e) => setGridEditMode(e.currentTarget.checked)}
          />
          <span style={{ fontSize: 12, color: "#9a9aa5" }}>Edit grid</span>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={idleOn}
            disabled={gridEditMode}
            onChange={(e) => setIdleOn(e.currentTarget.checked)}
          />
          <span style={{ fontSize: 12, color: "#9a9aa5" }}>Idle</span>
        </label>
      </div>

      <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
        {/* position:relative container so the overlay can sit absolutely over the canvas */}
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
          {gridEditMode && <GridOverlay canvasRef={canvasRef} />}
          {!gridEditMode && !idleOn && selectedDeformerId !== null && (
            <PivotOverlay canvasRef={canvasRef} />
          )}
        </div>
      </div>
      <ParamSliders playerRef={playerRef} />
    </main>
  );
}

function ParamSliders({ playerRef }: PreviewProps) {
  // Parameters are not editable in 5a, so the descriptors are stable once the
  // first load resolves — `loaded` is the only re-render trigger needed.
  const loaded = useEditorStore((s) => s.loaded);
  const params = useEditorStore((s) => s.params);
  const setParam = useEditorStore((s) => s.setParam);

  if (!loaded) return null;

  const descriptors = playerRef.current?.getParameters() ?? [];

  return (
    <div
      style={{
        borderTop: "1px solid #2a2b33",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        overflowY: "auto",
        maxHeight: "40%",
      }}
    >
      {descriptors.map((param) => {
        const value = params[param.id] ?? param.default;
        return (
          <label
            key={param.id}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ width: 90, fontSize: 12, color: "#9a9aa5" }}>
              {param.name ?? param.id}
            </span>
            <input
              type="range"
              min={param.min}
              max={param.max}
              step={(param.max - param.min) / 100}
              value={value}
              onChange={(e) => {
                const next = Number(e.target.value);
                // loaded === true guarantees playerRef.current is the loaded player.
                playerRef.current!.setParameter(param.id, next);
                setParam(param.id, next);
              }}
              style={{ flex: 1 }}
            />
            <span style={{ width: 40, fontSize: 12, textAlign: "right" }}>
              {value.toFixed(2)}
            </span>
          </label>
        );
      })}
    </div>
  );
}
