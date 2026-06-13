import {
  EditorDocument,
  AddDeformer,
  AddPart,
  DeleteDeformer,
  DeletePart,
  SetPartBindings,
  SetDeformerBindings,
  SetPartMesh,
  captureBindingEndpoint,
  createDefaultMatrixDeformer,
  createDefaultPart,
  createDefaultWarpDeformer,
  createGridMesh,
  generateIkiFromLayerSet,
  packAtlas,
  uvRectFor,
  type AtlasPlacement,
  type AtlasSource,
  type AtlasAssignment,
  type EditCommand,
  type EditTransformChannel,
  type DeformerTransformChannel,
  type LayerInput,
} from "@iki/editor-core";
import type {
  IkiTransform,
  IkiDeformerTransform,
  IkiTransformChannel,
  IkiBinding,
  IkiDeformerBinding,
} from "@iki/format";
import { create } from "zustand";

import {
  decodeImageFile,
  renderAtlas,
  type DecodedSource,
} from "./atlas-image";
import { buildLayerInputs, cropBitmap } from "./auto-rig-image";
import { decodePsdLayers } from "./psd-import";
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
  /** Visible banner for auto-rig import failures. */
  generatorError: string | null;
  /** True while importLayerSet is in flight — used to disable the import button. */
  importing: boolean;
  /**
   * Monotonically increasing import sequence counter. Incremented at the START of
   * each importLayerSet call; checked immediately before the atomic commit so a
   * superseded (stale) import never overwrites a newer one.
   */
  importSeq: number;

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
    /**
     * Immutable snapshot of the row's from/to at the moment capture began.
     * Used by clearCapture/commitCapture to restore the original binding so
     * abandoning or committing does not corrupt the pre-capture values.
     */
    rowRest: { from: number; to: number };
  } | null;

  runCommand: (cmd: EditCommand) => void;
  undo: () => void;
  redo: () => void;
  select: (partId: string | null) => void;
  selectDeformer: (id: string | null) => void;
  setParam: (id: string, value: number) => void;
  setExportError: (msg: string | null) => void;
  setAtlasError: (msg: string | null) => void;
  setGeneratorError: (msg: string | null) => void;
  setLoaded: () => void;
  setGridEditMode: (on: boolean) => void;

  /** Add a new default part and select it. */
  addPart: () => void;
  /** Add a new default matrix deformer and select it. */
  addMatrixDeformer: () => void;
  /** Add a new default warp deformer and select it. */
  addWarpDeformer: () => void;
  /** Replace the part's mesh with a grid of the given dimensions, or surface a range
   *  error as editError when cols/rows are out of range. */
  setPartGridMesh: (partId: string, cols: number, rows: number) => void;
  /** Remove the mesh from a part (SetPartMesh with undefined). */
  removePartMesh: (partId: string) => void;
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

  /**
   * Import a set of PNG layer files as a new auto-rigged EditorDocument.
   * Fail-fast: sets generatorError and returns on empty input or non-PNG files.
   * On success atomically replaces doc + partTextures and resets all banners.
   * On failure sets generatorError; existing doc is untouched.
   * A generation guard (importSeq) ensures a stale import never overwrites a
   * newer one when multiple imports are initiated before the first completes.
   */
  importLayerSet: (files: File[]) => Promise<void>;

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
    const { target, restTransform, rowIndex, rowRest } = capture;

    // Restore the captured row's binding to its pre-capture values BEFORE
    // restoring the base transform, so any renderer that reads both during
    // the revision bump sees a fully consistent authored state.
    if (target.kind === "part") {
      const liveBindings: IkiBinding[] = [
        ...(get()
          .doc.getModel()
          .parts.find((p) => p.id === target.id)?.bindings ?? []),
      ];
      const row = liveBindings[rowIndex];
      if (row !== undefined) {
        liveBindings[rowIndex] = { ...row, from: rowRest.from, to: rowRest.to };
      }
      get().doc.setPartBindingsEphemeral(target.id, liveBindings);
      // restTransform is always IkiTransform for parts (never undefined).
      get().doc.setPartTransformEphemeral(
        target.id,
        restTransform as IkiTransform,
      );
    } else {
      const liveBindings: IkiDeformerBinding[] = [
        ...(get().doc.findMatrixDeformer(target.id).bindings ?? []),
      ];
      const row = liveBindings[rowIndex];
      if (row !== undefined) {
        liveBindings[rowIndex] = { ...row, from: rowRest.from, to: rowRest.to };
      }
      get().doc.setDeformerBindingsEphemeral(target.id, liveBindings);
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
    generatorError: null,
    importing: false,
    importSeq: 0,
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
    setGeneratorError: (msg) => set({ generatorError: msg }),
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

    setPartGridMesh: (partId, cols, rows) => {
      clearCapture();
      // createGridMesh can throw a plain range Error OUTSIDE the command, so it
      // must be caught here rather than delegated to runCommand (which only wraps
      // doc.execute). One try/catch covers both the factory call and the execute.
      try {
        const mesh = createGridMesh(cols, rows);
        get().doc.execute(new SetPartMesh(partId, mesh));
        set((s) => ({ revision: s.revision + 1, editError: null }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },

    removePartMesh: (partId) => {
      get().runCommand(new SetPartMesh(partId, undefined));
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

    importLayerSet: async (files) => {
      // Fail-fast: boundary checks before any decode.
      if (files.length === 0) {
        set({
          generatorError: "auto-rig: select at least one PNG layer",
          atlasError: null,
          editError: null,
        });
        return;
      }
      // Detect PSD by EXTENSION — file.type is unreliable for .psd. A single
      // .psd routes through decodePsdLayers; any PNG count (0 .psd) takes the
      // existing PNG path. Anything else (mixed, or >1 .psd) is rejected.
      const psdFiles = files.filter((f) =>
        f.name.toLowerCase().endsWith(".psd"),
      );
      const isPsd = psdFiles.length === files.length && files.length === 1;
      if (!isPsd && psdFiles.length > 0) {
        set({
          generatorError:
            "psd import: select exactly one .psd file or one or more PNG files (mixed input is not supported)",
          atlasError: null,
          editError: null,
        });
        return;
      }
      // PNG type check applies ONLY to the PNG path so a .psd never hits it.
      if (!isPsd) {
        for (const file of files) {
          if (file.type !== "image/png") {
            set({
              generatorError: `auto-rig: "${file.name}" is not a PNG`,
              atlasError: null,
              editError: null,
            });
            return;
          }
        }
      }

      // Claim a new sequence number and mark the import as in-flight so the UI
      // can disable the import button while work is pending.
      const seq = get().importSeq + 1;
      set({ importSeq: seq, importing: true });

      // Abandon any in-flight capture before swapping the whole document — a
      // capture session pointing at an OLD-document part/deformer would corrupt
      // later capture cleanup.
      if (get().capture !== null) clearCapture();

      // Bitmap ownership: decoded source bitmaps are ALWAYS closed in finally
      // (they are NEVER transferred to partTextures). Crop bitmaps are closed
      // only on failure (committed === false); on success they transfer to the
      // side-table. committed is set to true immediately after the atomic set,
      // BEFORE old-bitmap cleanup, so finally never double-closes live crops.
      const decodedBitmaps: ImageBitmap[] = [];
      const cropBitmaps: ImageBitmap[] = [];
      let committed = false;

      try {
        // Decode into a flat ARRAY (not a Map) so duplicate top-level names
        // survive to parseLayerRoles, which fail-fasts on collisions. Building
        // a name→bitmap Map here would silently collapse duplicates.
        const decodedList: { fileName: string; bitmap: ImageBitmap }[] = [];
        if (isPsd) {
          // decodePsdLayers returns a fully-owned array (it freed partials on
          // throw); every returned bitmap enters decodedBitmaps so the shared
          // finally owns it, exactly like the PNG decodes.
          const decoded = await decodePsdLayers(psdFiles[0]);
          for (const d of decoded) decodedBitmaps.push(d.bitmap);
          decodedList.push(...decoded);
        } else {
          for (const file of files) {
            const decoded = await decodeImageFile(file, {
              premultiplyAlpha: "none",
              imageOrientation: "none",
            });
            decodedBitmaps.push(decoded.bitmap);
            decodedList.push({ fileName: file.name, bitmap: decoded.bitmap });
          }
        }

        // Build LayerInput[] — reads pixels only, creates NO ImageBitmaps.
        // parseLayerRoles throws on duplicate names BEFORE we build the Map.
        const layers: LayerInput[] = buildLayerInputs(decodedList);

        // Now that duplicates have been rejected, the name→bitmap Map is
        // collision-free for the crop loop's decodedByName.get lookups.
        const decodedByName = new Map(
          decodedList.map((d) => [d.fileName, d.bitmap]),
        );

        // Crop each layer; push to cropBitmaps BEFORE the next await so a
        // throw on a later layer leaves prior crops in finally's reach.
        const crops: DecodedSource[] = [];
        for (const layer of layers) {
          // Unreachable: layers were derived from decodedByName entries; TS requires the guard.
          const src = decodedByName.get(layer.fileName);
          if (src === undefined) {
            throw new Error(
              `auto-rig: no decoded bitmap for "${layer.fileName}"`,
            );
          }
          const cropped = await cropBitmap(src, layer.bbox);
          cropBitmaps.push(cropped);
          crops.push({
            id: layer.role,
            name: layer.fileName,
            bitmap: cropped,
            width: layer.cropW,
            height: layer.cropH,
          });
        }

        // Generate model and create a fresh document.
        const model = generateIkiFromLayerSet(layers, {
          width: layers[0].canvasW,
          height: layers[0].canvasH,
        });
        const doc = new EditorDocument(model);

        // Pack + render atlas from crops.
        const layout = packAtlas(crops.map(toAtlasSource));
        const dataUri = renderAtlas(crops, layout);

        // Build UV assignments — guard Array.find (strict TS: returns
        // AtlasPlacement | undefined).
        const partTextureAssignments: AtlasAssignment[] = [];
        for (const crop of crops) {
          const placement: AtlasPlacement | undefined = layout.placements.find(
            (p) => p.id === crop.id,
          );
          if (placement === undefined) {
            throw new Error(`auto-rig: no atlas placement for "${crop.id}"`);
          }
          partTextureAssignments.push({
            partId: crop.id,
            uv: uvRectFor(placement, {
              width: layout.pageWidth,
              height: layout.pageHeight,
            }),
          });
        }

        // Apply to the fresh LOCAL doc — not the live store doc; import isn't committed yet.
        doc.applyAtlas({
          textures: [{ source: dataUri }],
          partTextureAssignments,
        });

        // Build new side-table keyed by generated part id (subset invariant).
        const nextPartTextures: Record<string, DecodedSource> = {};
        for (const crop of crops) {
          nextPartTextures[crop.id] = crop;
        }

        // Close any capture session started during the async work — awaits above
        // create a window where UI actions could start a new session; re-running
        // clearCapture() here ensures the ephemeral base is restored before swap.
        if (get().capture !== null) clearCapture();

        // Generation guard: if a newer import started while we were awaiting,
        // this result is stale — abandon without committing. The finally block
        // still frees all bitmaps (committed stays false).
        if (get().importSeq !== seq) return;

        // Atomic commit: snapshot old side-table bitmaps before overwriting.
        const oldPartTextures = get().partTextures;
        set((s) => ({
          doc,
          partTextures: nextPartTextures,
          generatorError: null,
          atlasError: null,
          editError: null,
          selectedPartId: null,
          selectedDeformerId: null,
          capture: null,
          params: Object.fromEntries(
            model.parameters.map((p) => [p.id, p.default]),
          ),
          revision: s.revision + 1,
        }));

        // Mark success immediately after the swap — BEFORE closing old bitmaps.
        // If bitmap.close() ever threw, committed must already be true so that
        // finally does not double-close the crop bitmaps now live in partTextures.
        committed = true;

        // Close old side-table bitmaps now that the new ones are committed.
        for (const t of Object.values(oldPartTextures)) {
          t.bitmap.close();
        }
      } catch (e) {
        // Only surface the error if this import is still the current one; a
        // superseded import should not overwrite a newer result or its error.
        if (get().importSeq === seq) {
          set({
            generatorError: e instanceof Error ? e.message : String(e),
          });
        }
        // committed stays false → finally closes decoded (i) + crops (ii).
      } finally {
        // (i) ALWAYS close source decode bitmaps — never transferred anywhere.
        for (const b of decodedBitmaps) b.close();
        // (ii) Close crop bitmaps ONLY on failure — on success they transferred
        // to partTextures and must NOT be closed here.
        if (!committed) {
          for (const b of cropBitmaps) b.close();
        }
        // Clear the in-flight flag only if this import is still the current one.
        // A superseded import must not clear the flag set by the newer import.
        if (get().importSeq === seq) {
          set({ importing: false });
        }
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
          rowRest: { from: rowFrom, to: rowTo },
        },
      });

      // Zero the captured row's contribution so the preview reflects base-only
      // during posing. Without this, an existing non-zero binding is still
      // summed into the deformed result while the user poses the base transform,
      // causing captureEndpoint to record a value that diverges from the pose.
      if (row !== undefined) {
        // Multiplicative identity for opacity is 1 (×1 = no change); additive
        // identity for all other channels is 0 (+0 = no change).
        const neutral =
          row.channel === "opacity" ? { from: 1, to: 1 } : { from: 0, to: 0 };
        const neutralized = [
          ...(currentBindings as (IkiBinding | IkiDeformerBinding)[]),
        ];
        neutralized[rowIndex] = { ...row, ...neutral };
        if (kind === "part") {
          get().doc.setPartBindingsEphemeral(id, neutralized as IkiBinding[]);
        } else {
          get().doc.setDeformerBindingsEphemeral(
            id,
            neutralized as IkiDeformerBinding[],
          );
        }
        // Bump revision so the preview reloads with the zeroed row.
        set((s) => ({ revision: s.revision + 1 }));
      }
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

      const { target, rowIndex, rowRest } = capture;
      const { id, kind } = target;

      // Un-zero the captured row back to its ORIGINAL from/to BEFORE reading
      // the live bindings for the command. This ensures the command's prevBindings
      // snapshot (captured on first apply) records the original values, so Undo
      // restores {from: rowRest.from, to: rowRest.to} rather than {from: 0, to: 0}.
      if (kind === "part") {
        const liveForRestore: IkiBinding[] = [
          ...(get()
            .doc.getModel()
            .parts.find((p) => p.id === id)?.bindings ?? []),
        ];
        const restoreRow = liveForRestore[rowIndex];
        if (restoreRow !== undefined) {
          liveForRestore[rowIndex] = {
            ...restoreRow,
            from: rowRest.from,
            to: rowRest.to,
          };
          get().doc.setPartBindingsEphemeral(id, liveForRestore);
        }
      } else {
        const liveForRestore: IkiDeformerBinding[] = [
          ...(get().doc.findMatrixDeformer(id).bindings ?? []),
        ];
        const restoreRow = liveForRestore[rowIndex];
        if (restoreRow !== undefined) {
          liveForRestore[rowIndex] = {
            ...restoreRow,
            from: rowRest.from,
            to: rowRest.to,
          };
          get().doc.setDeformerBindingsEphemeral(id, liveForRestore);
        }
      }

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
