import {
  EditorDocument,
  AddDeformer,
  AddPart,
  DeleteDeformer,
  DeletePart,
  SetPartBindings,
  SetDeformerBindings,
  captureBindingEndpoint,
  createDefaultMatrixDeformer,
  createDefaultPart,
  createDefaultWarpDeformer,
  packAtlas,
  uvRectFor,
  type AtlasSource,
  type AtlasAssignment,
  type EditCommand,
  type EditTransformChannel,
  type DeformerTransformChannel,
} from "@iki/editor-core";
import type {
  IkiTransform,
  IkiDeformerTransform,
  IkiTransformChannel,
  IkiBinding,
  IkiDeformerBinding,
} from "@iki/format";
import { create } from "zustand";

import { renderAtlas, type DecodedSource } from "./atlas-image";
import { sampleModel } from "./sample-model";

function toAtlasSource(s: DecodedSource): AtlasSource {
  return { id: s.id, width: s.width, height: s.height };
}

/**
 * Maps IkiTransformChannel (binding vocabulary) → keyof IkiTransform (transform
 * field name). Used ONLY by captureEndpoint to read the posed/rest value from a
 * transform object via the binding's channel.
 */
const CHANNEL_TO_FIELD: Record<IkiTransformChannel, keyof IkiTransform> = {
  translateX: "x",
  translateY: "y",
  rotate: "rotation",
  scaleX: "scaleX",
  scaleY: "scaleY",
  opacity: "opacity",
};

/**
 * Read a transform field value applying engine defaults when the field is
 * absent. `transform` may be `undefined` (absent deformer transform → all
 * defaults). Defaults: x/y → 0, rotation → 0, scaleX/scaleY → 1, opacity → 1.
 */
function baseChannelValue(
  transform: IkiTransform | IkiDeformerTransform | undefined,
  field: keyof IkiTransform,
): number {
  if (transform === undefined) {
    return field === "scaleX" || field === "scaleY" || field === "opacity"
      ? 1
      : 0;
  }
  const raw = (transform as IkiTransform)[field];
  if (raw !== undefined) return raw;
  return field === "scaleX" || field === "scaleY" || field === "opacity"
    ? 1
    : 0;
}

/**
 * App state. The {@link EditorDocument} is mutable and lives OUTSIDE React's
 * structural sharing — `revision` is the explicit re-render trigger for the
 * tree/inspector (which re-read via `doc.getModel()` in revision-keyed
 * selectors). `loaded` flips the parameter sliders on once the first
 * `player.load()` resolves (parameters are not editable in 5a, so the slider
 * descriptors only need to build once — no per-edit rebuild).
 */
interface EditorState {
  doc: EditorDocument;
  selectedPartId: string | null;
  selectedDeformerId: string | null;
  /** Live parameter pose, mirrored from the sliders (survives reloads — Task 7). */
  params: Record<string, number>;
  exportError: string | null;
  /** Visible banner for failed (validate-throwing) commands. Cleared on success. */
  editError: string | null;
  /** Bumped on every edit/undo/redo to drive tree/inspector re-renders. */
  revision: number;
  /** True after the first successful `player.load()` (set by useReloadPreview). */
  loaded: boolean;
  /** Editor-only UI toggle: when true, the grid-edit overlay mounts over the preview. */
  gridEditMode: boolean;

  /**
   * Editor-only per-part texture side-table — NEVER serialized. One optional
   * decoded image per partId. The model already carries the committed atlas
   * (textures + per-part UVs) via {@link EditorDocument.applyAtlas}; this holds
   * the source material the editor needs to re-pack on the next op. The packed
   * layout + data URI are NOT stored (recomputed on each operation).
   *
   * DEFINITIVE subset invariant: keys are ALWAYS a subset of live part ids —
   * no dormant state. On every undo/redo, entries whose part no longer exists
   * are pruned (bitmap closed, key removed). Consequence (accepted): undoing an
   * AddPart for a textured part DROPS that editor-only texture; redoing brings
   * the part back UNTEXTURED (the command's original snapshot) — the side-table
   * never claims a texture the model lacks. Removed elsewhere only by the
   * live-part paths: clearPartTexture / setPartTexture replace.
   *
   * NOTE: deletePart refuses ANY textured part (imported OR model-committed).
   * Clear it first: imported side-table textures via clearPartTexture (re-packs
   * atlas from partTextures); model-committed textures with no side-table entry
   * (e.g. loaded badges) via clearModelTexture (delegates to
   * doc.clearPartTextureRef; no atlas re-pack needed). Both paths are non-undoable.
   */
  partTextures: Record<string, DecodedSource>;
  /** Visible banner for atlas-operation failures. */
  atlasError: string | null;

  /**
   * Editor-only ephemeral capture session state — NEVER serialized. Non-null
   * while the user is posing for a binding endpoint capture. The base transform
   * is restored to `restTransform` on exit so the authored base is unchanged
   * after capture; the motion lives in the committed binding from/to values.
   *
   * `restTransform === undefined` means a deformer that had no transform before
   * capture began (distinct from `capture === null` which means no session).
   * Each endpoint carries `value` (committed number) and `captured` (whether the
   * user captured it this session — drives status text + no-op-commit skip).
   * `value` is initialised from the row's current from/to so an uncaptured
   * endpoint is preserved on commit.
   */
  capture: {
    target: { kind: "part" | "deformer"; id: string };
    rowIndex: number;
    restTransform: IkiTransform | IkiDeformerTransform | undefined;
    from: { value: number; captured: boolean };
    to: { value: number; captured: boolean };
  } | null;

  runCommand: (cmd: EditCommand) => void;
  undo: () => void;
  redo: () => void;
  select: (partId: string | null) => void;
  selectDeformer: (id: string | null) => void;
  setParam: (id: string, value: number) => void;
  setExportError: (msg: string | null) => void;
  setAtlasError: (msg: string | null) => void;
  setLoaded: () => void;
  setGridEditMode: (on: boolean) => void;

  /** Add a new default part and select it. */
  addPart: () => void;
  /** Add a new default matrix deformer and select it. */
  addMatrixDeformer: () => void;
  /** Add a new default warp deformer and select it. */
  addWarpDeformer: () => void;
  /** Delete the part by id, clearing the selection. Refused if the part has any texture
   *  (imported OR model-committed). Clear it first: clearPartTexture for an imported
   *  image; clearModelTexture for a model-committed texture. Both are non-undoable. */
  deletePart: (id: string) => void;
  /** Delete the deformer by id, clearing the selection. */
  deleteDeformer: (id: string) => void;

  setPartTexture: (partId: string, decoded: DecodedSource) => void;
  clearPartTexture: (partId: string) => void;
  /** Non-undoably clear a model-committed texture reference (no imported image).
   *  Mirrors clearPartTexture's non-undoable boundary but skips atlas re-pack
   *  (no imported side-table entry to rebuild from). */
  clearModelTexture: (partId: string) => void;

  /** Abandon any active capture session, restoring the ephemeral base. */
  abandonCapture: () => void;
  /**
   * Enter a new capture session for the given target and binding row. If a
   * session is already active it is abandoned first (restoring the prior base).
   * Switching rows = calling enterCapture(target, newRowIndex).
   */
  enterCapture: (
    target: { kind: "part" | "deformer"; id: string },
    rowIndex: number,
  ) => void;
  /**
   * Apply a transform pose during capture. `channel` is a transform-field key
   * (EditTransformChannel | DeformerTransformChannel) written directly onto the
   * ephemeral transform. No-op when capture === null.
   */
  poseCapture: (
    channel: EditTransformChannel | DeformerTransformChannel,
    value: number,
  ) => void;
  /**
   * Capture the current posed value as the "from" or "to" endpoint. Sets
   * editError on degenerate cases (out-of-range row, opacity-zero base,
   * non-finite result).
   */
  captureEndpoint: (endpoint: "from" | "to") => void;
  /**
   * Commit the captured endpoints as a binding row update, restore the ephemeral
   * base, and clear the session. No-op skip (restore+clear without undo step)
   * when neither endpoint was captured this session.
   */
  commitCapture: () => void;
  /**
   * Abandon any active capture session before export. App's handleExport calls
   * this before doc.serialize() so the capture pose never reaches the file.
   */
  prepareForExport: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => {
  /**
   * Atomically derive the next atlas state, pack, render, and apply it to the
   * model, THEN commit the editor-only side-table — all in one try/catch.
   *
   * Reads ONLY the local `nextPartTextures` arg (never the live side-table).
   * Each part's image is its OWN atlas source (no dedup). On ANY thrown error
   * the live state stays untouched: it sets `atlasError` and returns false,
   * committing NOTHING. On success it writes `partTextures`, clears the error,
   * and bumps `revision` in ONE `set`, then returns true. Bitmaps are NOT closed
   * here — callers own bitmap cleanup based on the returned success flag.
   */
  const commitAtlas = (
    nextPartTextures: Record<string, DecodedSource>,
  ): boolean => {
    try {
      const entries = Object.entries(nextPartTextures);
      let input: {
        textures: { source: string }[];
        partTextureAssignments: AtlasAssignment[];
      };
      if (entries.length === 0) {
        // Store owns the empty case — renderAtlas is never called with no sources.
        input = { textures: [], partTextureAssignments: [] };
      } else {
        const decodedList = entries.map(([, decoded]) => decoded);
        const layout = packAtlas(decodedList.map(toAtlasSource));
        const dataUri = renderAtlas(decodedList, layout);
        const partTextureAssignments: AtlasAssignment[] = [];
        for (const [partId, decoded] of entries) {
          const placement = layout.placements.find((p) => p.id === decoded.id);
          if (placement === undefined) {
            throw new Error(
              `commitAtlas: no placement for source "${decoded.id}" in packed layout`,
            );
          }
          const uv = uvRectFor(placement, {
            width: layout.pageWidth,
            height: layout.pageHeight,
          });
          partTextureAssignments.push({ partId, uv });
        }
        input = {
          textures: [{ source: dataUri }],
          partTextureAssignments,
        };
      }
      get().doc.applyAtlas(input);
    } catch (err) {
      set({ atlasError: err instanceof Error ? err.message : String(err) });
      return false;
    }
    set((s) => ({
      partTextures: nextPartTextures,
      atlasError: null,
      revision: s.revision + 1,
    }));
    return true;
  };

  /**
   * Return a NEW partTextures table containing only the entries whose partId is
   * still in `liveIds`, closing the bitmap of every pruned entry.
   *
   * Called after every undo/redo (BOTH directions) to enforce the subset
   * invariant: partTextures keys must always be a subset of live part ids.
   * The undo of an AddPart (or redo of a DeletePart) removes a part, so its
   * side-table entry must be pruned rather than left as dormant state that could
   * later resurrect with a stale id. Texture ops are non-undoable, so the sweep
   * must run on both undo and redo paths.
   *
   * Does NOT call commitAtlas — that would repack and re-render the atlas, which
   * is unnecessary here (the pruned part is gone; the remaining entries are
   * already committed). The atlas may retain an unreferenced stale region after
   * a prune; that is accepted and harmless (a later atlas op re-packs).
   */
  const prunePartTextures = (
    partTextures: Record<string, DecodedSource>,
    liveIds: Set<string>,
  ): Record<string, DecodedSource> => {
    const pruned: Record<string, DecodedSource> = {};
    for (const [partId, decoded] of Object.entries(partTextures)) {
      if (liveIds.has(partId)) {
        pruned[partId] = decoded;
      } else {
        decoded.bitmap.close();
      }
    }
    return pruned;
  };

  /**
   * Restore the ephemeral base transform to the snapshot taken at enterCapture,
   * then clear the capture session. This is the SINGLE restore+clear path —
   * every abandonment (explicit, implicit on runCommand, selection change, etc.)
   * routes through here so the model is always left in a authored-base state
   * after a capture session ends without commit.
   *
   * General rule: any store action that mutates/reloads the doc while NOT part
   * of the capture flow MUST abandon an active capture session first via
   * clearCapture(). The capture-flow actions are exempt: poseCapture,
   * captureEndpoint, commitCapture, abandonCapture, enterCapture.
   */
  const clearCapture = (): void => {
    const capture = get().capture;
    if (capture === null) return;
    const { target, restTransform } = capture;
    if (target.kind === "part") {
      // restTransform is always IkiTransform for parts (never undefined).
      get().doc.setPartTransformEphemeral(
        target.id,
        restTransform as IkiTransform,
      );
    } else {
      // undefined is valid: deformer had no transform before capture began.
      get().doc.setDeformerTransformEphemeral(
        target.id,
        restTransform as IkiDeformerTransform | undefined,
      );
    }
    set((s) => ({ capture: null, revision: s.revision + 1, editError: null }));
  };

  return {
    doc: new EditorDocument(sampleModel),
    selectedPartId: null,
    selectedDeformerId: null,
    params: {},
    exportError: null,
    editError: null,
    revision: 0,
    loaded: false,
    gridEditMode: false,
    partTextures: {},
    atlasError: null,
    capture: null,

    runCommand: (cmd) => {
      // Any ordinary editor command abandons an active capture session first —
      // the capture pose must never be present when a new undo step is recorded.
      if (get().capture !== null) clearCapture();
      try {
        get().doc.execute(cmd);
        set((s) => ({ revision: s.revision + 1, editError: null }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },
    undo: () => {
      clearCapture();
      get().doc.undo();
      const liveIds = new Set(
        get()
          .doc.getModel()
          .parts.map((p) => p.id),
      );
      set((s) => ({
        revision: s.revision + 1,
        editError: null,
        partTextures: prunePartTextures(s.partTextures, liveIds),
      }));
    },
    redo: () => {
      clearCapture();
      get().doc.redo();
      const liveIds = new Set(
        get()
          .doc.getModel()
          .parts.map((p) => p.id),
      );
      set((s) => ({
        revision: s.revision + 1,
        editError: null,
        partTextures: prunePartTextures(s.partTextures, liveIds),
      }));
    },
    select: (partId) => {
      clearCapture();
      set({
        selectedPartId: partId,
        selectedDeformerId: null,
        editError: null,
      });
    },
    selectDeformer: (id) => {
      clearCapture();
      set({ selectedDeformerId: id, selectedPartId: null, editError: null });
    },
    setParam: (id, value) =>
      set((s) => ({ params: { ...s.params, [id]: value } })),
    setExportError: (msg) => set({ exportError: msg }),
    setAtlasError: (msg) => set({ atlasError: msg }),
    setLoaded: () => set({ loaded: true }),
    setGridEditMode: (on) => set({ gridEditMode: on }),

    addPart: () => {
      clearCapture();
      const part = createDefaultPart(get().doc.getModel());
      const newId = part.id;
      try {
        get().doc.execute(new AddPart(part));
        set((s) => ({
          revision: s.revision + 1,
          editError: null,
          selectedPartId: newId,
          selectedDeformerId: null,
        }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },

    addMatrixDeformer: () => {
      clearCapture();
      const deformer = createDefaultMatrixDeformer(get().doc.getModel());
      const newId = deformer.id;
      try {
        get().doc.execute(new AddDeformer(deformer));
        set((s) => ({
          revision: s.revision + 1,
          editError: null,
          selectedDeformerId: newId,
          selectedPartId: null,
        }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },

    addWarpDeformer: () => {
      clearCapture();
      const deformer = createDefaultWarpDeformer(get().doc.getModel());
      const newId = deformer.id;
      try {
        get().doc.execute(new AddDeformer(deformer));
        set((s) => ({
          revision: s.revision + 1,
          editError: null,
          selectedDeformerId: newId,
          selectedPartId: null,
        }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },

    deletePart: (id) => {
      clearCapture();
      // UX pre-check: refuse with a friendly message before constructing a throwing
      // command. DeletePart.apply enforces the same texture guard at the editor-core
      // boundary, so this check is belt-and-suspenders — the real invariant lives in
      // the command. Both clear paths are NON-undoable: clearPartTexture for imported
      // images; clearModelTexture for model-committed textures. The prune sweep in
      // undo/redo covers those directions, which cannot refuse.
      const hasImportedTexture = get().partTextures[id] !== undefined;
      const liveModelPart = get()
        .doc.getModel()
        .parts.find((p) => p.id === id);
      const hasModelTexture = liveModelPart?.texture !== undefined;
      if (hasImportedTexture || hasModelTexture) {
        set({
          editError: `Cannot delete part "${id}" while it has a texture — clear the part's texture first.`,
        });
        return;
      }
      try {
        get().doc.execute(new DeletePart(id));
        set((s) => ({
          revision: s.revision + 1,
          editError: null,
          selectedPartId: null,
          selectedDeformerId: null,
        }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },

    deleteDeformer: (id) => {
      clearCapture();
      try {
        get().doc.execute(new DeleteDeformer(id));
        set((s) => ({
          revision: s.revision + 1,
          editError: null,
          selectedPartId: null,
          selectedDeformerId: null,
        }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },

    setPartTexture: (partId, decoded) => {
      clearCapture();
      // Validate VISIBLY before deriving — never a silent no-op.
      const part = get()
        .doc.getModel()
        .parts.find((p) => p.id === partId);
      if (part === undefined) {
        // The new bitmap will never be committed — free it here so it can't leak.
        set({ atlasError: `setPartTexture: no part with id "${partId}"` });
        decoded.bitmap.close();
        return;
      }
      // Capture the OLD image so we can free it AFTER a successful replace.
      const old = get().partTextures[partId];
      const nextPartTextures = { ...get().partTextures, [partId]: decoded };
      const ok = commitAtlas(nextPartTextures);
      if (ok) {
        // Replace cleanup AFTER success: the old image is no longer referenced.
        if (old !== undefined) old.bitmap.close();
      } else {
        // Commit failed — the uncommitted new bitmap leaks unless freed; the old
        // image stays live (still referenced by the unchanged side-table).
        decoded.bitmap.close();
      }
    },

    clearPartTexture: (partId) => {
      clearCapture();
      const removed = get().partTextures[partId];
      const { [partId]: _omit, ...rest } = get().partTextures;
      const ok = commitAtlas(rest);
      // Close the removed bitmap ONLY after a successful commit, so a failed
      // commit rolls back with the bitmap still valid for the live state.
      if (ok && removed !== undefined) removed.bitmap.close();
    },

    clearModelTexture: (partId) => {
      clearCapture();
      try {
        get().doc.clearPartTextureRef(partId);
        set((s) => ({ revision: s.revision + 1, editError: null }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },

    abandonCapture: () => {
      clearCapture();
    },

    enterCapture: (target, rowIndex) => {
      // Always abandon any active session first — row-switch safety, ensures
      // a new row never inherits a prior row's ephemeral pose.
      clearCapture();

      const { id, kind } = target;
      let base: IkiTransform | IkiDeformerTransform | undefined;
      let currentBindings: IkiBinding[] | IkiDeformerBinding[] | undefined;

      if (kind === "part") {
        const part = get()
          .doc.getModel()
          .parts.find((p) => p.id === id);
        base = part?.transform;
        currentBindings = part?.bindings;
      } else {
        const deformer = get().doc.findMatrixDeformer(id);
        // Preserve undefined for absent deformer transform — do NOT clone undefined.
        base = deformer.transform;
        currentBindings = deformer.bindings;
      }

      // Fresh snapshot; preserve undefined for absent deformer transform.
      const restTransform =
        base !== undefined ? structuredClone(base) : undefined;

      // Read current from/to from the row; default 0 if row or array is missing.
      const row = currentBindings?.[rowIndex];
      const rowFrom = row?.from ?? 0;
      const rowTo = row?.to ?? 0;

      set({
        capture: {
          target,
          rowIndex,
          restTransform,
          from: { value: rowFrom, captured: false },
          to: { value: rowTo, captured: false },
        },
      });
      // No revision bump: entering doesn't change the doc; clearCapture above
      // already bumped if it restored a prior base.
    },

    poseCapture: (channel, value) => {
      const { capture } = get();
      if (capture === null) return;
      const { target } = capture;
      const { id, kind } = target;
      if (kind === "part") {
        const part = get()
          .doc.getModel()
          .parts.find((p) => p.id === id);
        const next: IkiTransform = {
          ...(part?.transform ?? { x: 0, y: 0 }),
          [channel]: value,
        };
        get().doc.setPartTransformEphemeral(id, next);
      } else {
        const deformer = get().doc.findMatrixDeformer(id);
        const next: IkiDeformerTransform = {
          ...(deformer.transform ?? { x: 0, y: 0 }),
          [channel]: value,
        };
        get().doc.setDeformerTransformEphemeral(id, next);
      }
      set((s) => ({ revision: s.revision + 1 }));
    },

    captureEndpoint: (endpoint) => {
      const { capture } = get();
      if (capture === null) {
        set({ editError: "No active capture session" });
        return;
      }
      const { target, rowIndex } = capture;
      const { id, kind } = target;

      // Resolve the binding row from the LIVE target bindings.
      let binding: IkiBinding | IkiDeformerBinding | undefined;
      if (kind === "part") {
        binding = get()
          .doc.getModel()
          .parts.find((p) => p.id === id)?.bindings?.[rowIndex];
      } else {
        binding = get().doc.findMatrixDeformer(id).bindings?.[rowIndex];
      }
      if (binding === undefined) {
        set({
          editError: `captureEndpoint: binding row ${rowIndex} is out of range`,
        });
        return;
      }

      const channel = binding.channel as IkiTransformChannel;
      const field = CHANNEL_TO_FIELD[channel];

      const restValue = baseChannelValue(capture.restTransform, field);

      // Read the live base transform for the posed value.
      let liveTransform: IkiTransform | IkiDeformerTransform | undefined;
      if (kind === "part") {
        liveTransform = get()
          .doc.getModel()
          .parts.find((p) => p.id === id)?.transform;
      } else {
        liveTransform = get().doc.findMatrixDeformer(id).transform;
      }
      const posedValue = baseChannelValue(liveTransform, field);

      // Opacity-zero guard: cannot capture multiplicatively with a zero base.
      if (channel === "opacity" && restValue === 0) {
        set({
          editError:
            "Cannot capture opacity: base opacity is 0 (set a non-zero base opacity first)",
        });
        return;
      }

      const value = captureBindingEndpoint(channel, restValue, posedValue);

      // Finite guard: non-finite results cannot be stored in the model.
      if (!Number.isFinite(value)) {
        set({
          editError: `Cannot capture: pose a finite ${channel} value first`,
        });
        return;
      }

      set((s) => ({
        capture: {
          ...s.capture!,
          [endpoint]: { value, captured: true },
        },
        editError: null,
      }));
    },

    commitCapture: () => {
      const { capture } = get();
      if (capture === null) return;

      // No-op skip: if neither endpoint was captured this session, abandon
      // without creating an undo step.
      if (!capture.from.captured && !capture.to.captured) {
        clearCapture();
        return;
      }

      const { target, rowIndex } = capture;
      const { id, kind } = target;

      // Build the next bindings array: clone current rows, patch the row at rowIndex.
      let currentBindings: IkiBinding[] | IkiDeformerBinding[];
      if (kind === "part") {
        currentBindings = [
          ...(get()
            .doc.getModel()
            .parts.find((p) => p.id === id)?.bindings ?? []),
        ];
      } else {
        currentBindings = [
          ...(get().doc.findMatrixDeformer(id).bindings ?? []),
        ];
      }

      const existingRow = currentBindings[rowIndex];
      if (existingRow === undefined) {
        set({
          editError: `commitCapture: binding row ${rowIndex} is out of range`,
        });
        return;
      }

      const nextRow = {
        ...existingRow,
        from: capture.from.value,
        to: capture.to.value,
      };
      const next = currentBindings.slice() as IkiBinding[] &
        IkiDeformerBinding[];
      (next as (IkiBinding | IkiDeformerBinding)[])[rowIndex] = nextRow;

      // commitCapture has its OWN try/catch — does NOT use runCommand.
      try {
        if (kind === "part") {
          get().doc.execute(new SetPartBindings(id, next as IkiBinding[]));
        } else {
          get().doc.execute(
            new SetDeformerBindings(id, next as IkiDeformerBinding[]),
          );
        }
      } catch (e) {
        // On throw: session stays active so the user can retry.
        set({ editError: e instanceof Error ? e.message : String(e) });
        return;
      }

      // Commit succeeded: restore the ephemeral base, then single revision bump + clear.
      const { restTransform } = capture;
      if (kind === "part") {
        get().doc.setPartTransformEphemeral(id, restTransform as IkiTransform);
      } else {
        get().doc.setDeformerTransformEphemeral(
          id,
          restTransform as IkiDeformerTransform | undefined,
        );
      }
      set((s) => ({
        revision: s.revision + 1,
        editError: null,
        capture: null,
      }));
    },

    prepareForExport: () => {
      clearCapture();
    },
  };
});
