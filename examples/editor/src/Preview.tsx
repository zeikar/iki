import { IkiPlayer, IdleMotion, PhysicsMotion } from "@iki/engine";
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
  // revision bumps on every in-place doc mutation (undo/redo/add/delete).
  // Subscribing here ensures idleBlocked recomputes from the live model after
  // any mutation — mirrors the pattern used by Inspector.tsx and GridOverlay.tsx.
  const revision = useEditorStore((s) => s.revision);
  void revision;
  // Idle is ephemeral PREVIEW state — never the store. It drives the player
  // directly and must leave authoring `params` untouched.
  const [idleOn, setIdleOn] = useState(false);

  // True when idle must be blocked: grid-edit mode OR a matrix deformer is
  // selected (matrix deformer needs stable pose for the pivot gizmo; warp does
  // not — PivotOverlay no-ops for warp, so idle stays allowed there).
  const selectedDeformer = doc
    .getModel()
    .deformers?.find((x) => x.id === selectedDeformerId);
  const idleBlocked =
    gridEditMode ||
    (selectedDeformer !== undefined &&
      (selectedDeformer.kind === "matrix" ||
        selectedDeformer.kind === undefined));

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

  // Force idle off whenever the stable-pose requirement kicks in (grid-edit or
  // matrix deformer selected). Mirrors the grid-edit precedent: idle is forced
  // off AND the checkbox is disabled so the user can't re-enable it.
  // revision is included so this re-evaluates after in-place doc mutations
  // (e.g. a selected deformer removed via undo must stop holding idle off).
  useEffect(() => {
    if (idleBlocked) setIdleOn(false);
  }, [idleBlocked, revision]);

  // Idle loop, owned entirely by the preview. Never writes the store: the loop
  // calls `player.setParameter` directly, and cleanup restores the authored
  // pose by reading `params` imperatively (no `params` subscription so slider
  // edits don't re-arm this effect).
  useEffect(() => {
    const player = playerRef.current;
    if (!idleOn || gridEditMode || !player) return;

    const descriptors = player.getParameters();
    const byId = new Map(descriptors.map((p) => [p.id, p]));
    const clampParam = (id: string, v: number): number => {
      const p = byId.get(id);
      return p ? Math.max(p.min, Math.min(p.max, v)) : v;
    };

    const idle = new IdleMotion(player.setParameter.bind(player));

    // Secondary-motion spring (the playground's peer). Reads its input from the
    // LIVE authoring pose (store params, clamped like ParameterStore) and writes
    // its output param through the player. A model without physics rigs is a
    // no-op. Output params are restored on cleanup alongside the idle params.
    const rigs = useEditorStore.getState().doc.getModel().physics ?? [];
    const physics = new PhysicsMotion(
      rigs,
      descriptors,
      (id) => {
        const v = useEditorStore.getState().params[id];
        return v !== undefined
          ? clampParam(id, v)
          : clampParam(id, byId.get(id)?.default ?? 0);
      },
      player.setParameter.bind(player),
    );

    let frame = requestAnimationFrame(function tick() {
      const now = performance.now();
      idle.update(now);
      physics.update(now);
      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frame);
      // Restore the authored pose on the SAME player the loop drove — both the
      // idle params and the physics OUTPUT params the spring overwrote. Only
      // touch ids the loaded model declares — never `.default` on an absent one.
      const { params } = useEditorStore.getState();
      const restoreIds = new Set<string>([
        ...IDLE_PARAM_IDS,
        ...rigs.map((r) => r.output.parameter),
      ]);
      for (const id of restoreIds) {
        if (byId.has(id)) {
          player.setParameter(id, params[id] ?? byId.get(id)!.default);
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
            disabled={idleBlocked}
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
