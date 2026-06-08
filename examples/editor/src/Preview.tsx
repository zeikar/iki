import { IkiPlayer } from "@iki/engine";
import { useEffect, useRef, type MutableRefObject } from "react";

import { GridOverlay } from "./GridOverlay";
import { useEditorStore } from "./store";

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
      </div>

      <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
        {/* position:relative container so the overlay can sit absolutely over the canvas */}
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
          {gridEditMode && <GridOverlay canvasRef={canvasRef} />}
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
