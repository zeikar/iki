import {
  EditorDocument,
  AddDeformer,
  AddPart,
  DeleteDeformer,
  DeletePart,
  createDefaultMatrixDeformer,
  createDefaultPart,
  createDefaultWarpDeformer,
  packAtlas,
  uvRectFor,
  type AtlasSource,
  type AtlasAssignment,
  type EditCommand,
} from "@iki/editor-core";
import { create } from "zustand";

import { renderAtlas, type DecodedSource } from "./atlas-image";
import { sampleModel } from "./sample-model";

function toAtlasSource(s: DecodedSource): AtlasSource {
  return { id: s.id, width: s.width, height: s.height };
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
   * never claims a texture the model lacks. Model-only committed textures (e.g.
   * the sample badges) are allowed and unaffected. Removed elsewhere only by the
   * live-part paths: clearPartTexture / setPartTexture replace.
   */
  partTextures: Record<string, DecodedSource>;
  /** Visible banner for atlas-operation failures. */
  atlasError: string | null;

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
  /** Delete the part by id, clearing the selection. Refused if the part has an imported texture. */
  deletePart: (id: string) => void;
  /** Delete the deformer by id, clearing the selection. */
  deleteDeformer: (id: string) => void;

  setPartTexture: (partId: string, decoded: DecodedSource) => void;
  clearPartTexture: (partId: string) => void;
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

    runCommand: (cmd) => {
      try {
        get().doc.execute(cmd);
        set((s) => ({ revision: s.revision + 1, editError: null }));
      } catch (e) {
        set({ editError: e instanceof Error ? e.message : String(e) });
      }
    },
    undo: () => {
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
    select: (partId) =>
      set({
        selectedPartId: partId,
        selectedDeformerId: null,
        editError: null,
      }),
    selectDeformer: (id) =>
      set({ selectedDeformerId: id, selectedPartId: null, editError: null }),
    setParam: (id, value) =>
      set((s) => ({ params: { ...s.params, [id]: value } })),
    setExportError: (msg) => set({ exportError: msg }),
    setAtlasError: (msg) => set({ atlasError: msg }),
    setLoaded: () => set({ loaded: true }),
    setGridEditMode: (on) => set({ gridEditMode: on }),

    addPart: () => {
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
      // Refuse if the part carries an imported texture: deleting it here would
      // force an immediate bitmap close to keep the subset invariant, silently
      // destroying the imported texture despite the model command being undoable.
      // Refusing keeps it lossless — clear the texture first, then delete.
      // (The prune sweep in undo/redo covers those directions, which cannot refuse.)
      if (get().partTextures[id] !== undefined) {
        set({
          editError: `Cannot delete part "${id}" while it has an imported texture — clear the part's texture first.`,
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
      const removed = get().partTextures[partId];
      const { [partId]: _omit, ...rest } = get().partTextures;
      const ok = commitAtlas(rest);
      // Close the removed bitmap ONLY after a successful commit, so a failed
      // commit rolls back with the bitmap still valid for the live state.
      if (ok && removed !== undefined) removed.bitmap.close();
    },
  };
});
