import type { IkiPlayer } from "@iki/engine";
import { IkiFormatError } from "@iki/format";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import { useEditorStore } from "./store";

/** No-further-change quiet window before an edit triggers a reload (Task 7). */
const RELOAD_DEBOUNCE_MS = 200;

/**
 * The SINGLE owner of `player.load()` (B8). `Preview` only creates/destroys the
 * player; it never loads. This hook performs the INITIAL load on mount and
 * every edit-driven reload through the SAME `reload()` routine (debounced on the
 * store `revision`).
 *
 * `reload()` is parameterless and always derives the model via
 * `doc.toIkiModel()` inside its own try/catch (B9 — never accept a pre-parsed
 * model). An `IkiFormatError` (or any export failure) is surfaced via
 * `setExportError` and the load is skipped.
 *
 * A generation counter guards against a superseded reload racing a newer one
 * (B5): only the latest in-flight reload re-applies the pose and flips
 * `loaded`. The engine also bails stale GL loads internally; this keeps the
 * app-side pose-reapply from racing too.
 */
export function useReloadPreview(
  playerRef: MutableRefObject<IkiPlayer | null>,
): void {
  // Incrementing generation: a reload is "latest" only while it matches.
  const generationRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const player = playerRef.current;
    if (!player) return;

    const store = useEditorStore.getState();

    // Advance the generation BEFORE validation so that an invalid edit
    // (toIkiModel throws) still supersedes any older in-flight valid load.
    // Only the no-player guard above is allowed to return without bumping.
    const generation = ++generationRef.current;

    let model;
    try {
      model = store.doc.toIkiModel();
    } catch (e) {
      store.setExportError(e instanceof IkiFormatError ? e.message : String(e));
      return;
    }
    store.setExportError(null);

    await player.load(model);

    // A newer reload (or unmount) superseded us, or the player was replaced
    // by a StrictMode remount — skip the app-side pose-reapply + setLoaded.
    if (generation !== generationRef.current) return;
    if (playerRef.current !== player) return;

    // On the first successful load seed the pose from the model's parameter
    // defaults if nothing has been posed yet.
    const afterGuard = useEditorStore.getState();
    if (Object.keys(afterGuard.params).length === 0) {
      for (const param of player.getParameters())
        afterGuard.setParam(param.id, param.default);
    }

    // One getState() at reapply time — intentionally reads the latest live
    // pose after the await, since load() reset params to defaults.
    const { params, setLoaded } = useEditorStore.getState();
    for (const [id, value] of Object.entries(params))
      player.setParameter(id, value);

    setLoaded();
  }, [playerRef]);

  // Initial load: the player is created in Preview's effect, which may run after
  // this one on the first tick. Poll on animation frames until the player exists
  // (or this effect is cleaned up), then load exactly once.
  useEffect(() => {
    let cancelled = false;
    let rafId = 0;

    const waitForPlayer = (): void => {
      if (cancelled) return;
      if (playerRef.current) {
        void reload();
        return;
      }
      rafId = requestAnimationFrame(waitForPlayer);
    };
    waitForPlayer();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      // Invalidate any in-flight reload's app-side work.
      ++generationRef.current;
    };
  }, [playerRef, reload]);

  // Edit-driven reload: keyed on the store `revision` (bumped by every
  // edit/undo/redo). Each change (re)arms a debounce timer; the timer's cleanup
  // cancels it if another edit lands inside the quiet window, so `reload()` runs
  // only after ~RELOAD_DEBOUNCE_MS of no further change. The run for the initial
  // `revision` is skipped (and re-skipped on a StrictMode remount, since the
  // value is unchanged) so it never duplicates the initial load above.
  const revision = useEditorStore((s) => s.revision);
  const lastReloadedRevisionRef = useRef(revision);
  useEffect(() => {
    if (revision === lastReloadedRevisionRef.current) return;
    const timeoutId = setTimeout(() => {
      lastReloadedRevisionRef.current = revision;
      void reload();
    }, RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [revision, reload]);
}
