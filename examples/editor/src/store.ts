import {
  EditorDocument,
  packAtlas,
  uvRectFor,
  type AtlasSource,
  type AtlasAssignment,
  type EditCommand,
} from "@iki/editor-core";
import { create } from "zustand";

import { renderAtlas, type DecodedSource } from "./atlas-image";
import { sampleModel } from "./sample-model";

/** Dedupe DecodedSources by id, keeping the FIRST occurrence of each id. */
function dedupeById(sources: DecodedSource[]): DecodedSource[] {
  const seen = new Set<string>();
  const out: DecodedSource[] = [];
  for (const s of sources) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

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
  /** Live parameter pose, mirrored from the sliders (survives reloads — Task 7). */
  params: Record<string, number>;
  exportError: string | null;
  /** Bumped on every edit/undo/redo to drive tree/inspector re-renders. */
  revision: number;
  /** True after the first successful `player.load()` (set by useReloadPreview). */
  loaded: boolean;

  /**
   * Editor-only atlas side-table — NEVER serialized. The model already carries
   * the committed atlas (textures + per-part UVs) via {@link EditorDocument.applyAtlas};
   * these hold the source material the editor needs to re-pack on the next op.
   * The packed layout + data URI are NOT stored (recomputed on each operation).
   */
  atlasSources: DecodedSource[];
  /** Editor-only map partId → sourceId. NEVER serialized. */
  partAssignments: Record<string, string>;
  /** Visible banner for atlas-operation failures. */
  atlasError: string | null;

  runCommand: (cmd: EditCommand) => void;
  undo: () => void;
  redo: () => void;
  select: (partId: string | null) => void;
  setParam: (id: string, value: number) => void;
  setExportError: (msg: string | null) => void;
  setAtlasError: (msg: string | null) => void;
  setLoaded: () => void;

  importAtlasSources: (sources: DecodedSource[]) => boolean;
  assignPartTexture: (partId: string, sourceId: string | null) => void;
  removeAtlasSource: (id: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => {
  /**
   * Atomically derive the next atlas state, pack, render, and apply it to the
   * model, THEN commit the editor-only side-table — all in one try/catch.
   *
   * Reads ONLY the local `nextSources`/`nextAssignments` args (never the live
   * side-table). On ANY thrown error the live state stays untouched: it sets
   * `atlasError` and returns false, committing NOTHING. On success it writes
   * sources, assignments, clears the error, and bumps `revision` in ONE `set`,
   * then returns true. Bitmaps are NOT closed here — callers own bitmap cleanup
   * based on the returned success flag.
   */
  const commitAtlas = (
    nextSources: DecodedSource[],
    nextAssignments: Record<string, string>,
  ): boolean => {
    try {
      let input: {
        textures: { source: string }[];
        partTextureAssignments: AtlasAssignment[];
      };
      if (nextSources.length === 0) {
        // Store owns the empty case — renderAtlas is never called with no sources.
        input = { textures: [], partTextureAssignments: [] };
      } else {
        const layout = packAtlas(nextSources.map(toAtlasSource));
        const dataUri = renderAtlas(nextSources, layout);
        const sourceIds = new Set(nextSources.map((s) => s.id));
        const partTextureAssignments: AtlasAssignment[] = [];
        for (const [partId, sourceId] of Object.entries(nextAssignments)) {
          if (!sourceIds.has(sourceId)) continue;
          const placement = layout.placements.find((p) => p.id === sourceId);
          if (placement === undefined) {
            throw new Error(
              `commitAtlas: no placement for source "${sourceId}" in packed layout`,
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
      atlasSources: nextSources,
      partAssignments: nextAssignments,
      atlasError: null,
      revision: s.revision + 1,
    }));
    return true;
  };

  return {
    doc: new EditorDocument(sampleModel),
    selectedPartId: null,
    params: {},
    exportError: null,
    revision: 0,
    loaded: false,
    atlasSources: [],
    partAssignments: {},
    atlasError: null,

    runCommand: (cmd) => {
      get().doc.execute(cmd);
      set((s) => ({ revision: s.revision + 1 }));
    },
    undo: () => {
      get().doc.undo();
      set((s) => ({ revision: s.revision + 1 }));
    },
    redo: () => {
      get().doc.redo();
      set((s) => ({ revision: s.revision + 1 }));
    },
    select: (partId) => set({ selectedPartId: partId }),
    setParam: (id, value) =>
      set((s) => ({ params: { ...s.params, [id]: value } })),
    setExportError: (msg) => set({ exportError: msg }),
    setAtlasError: (msg) => set({ atlasError: msg }),
    setLoaded: () => set({ loaded: true }),

    importAtlasSources: (sources) => {
      // Derive in a LOCAL; leave the live side-table untouched until commit.
      const nextSources = dedupeById([...get().atlasSources, ...sources]);
      const ok = commitAtlas(nextSources, get().partAssignments);
      if (!ok) {
        // An all-decode-then-render/apply failure committed nothing — free the
        // newly decoded bitmaps so they don't leak. dedupe-by-id guarantees we
        // only close the new `sources` arg, never bitmaps already in the store.
        for (const s of sources) s.bitmap.close();
      }
      return ok;
    },

    assignPartTexture: (partId, sourceId) => {
      // Validate VISIBLY before deriving — never a silent no-op.
      const part = get()
        .doc.getModel()
        .parts.find((p) => p.id === partId);
      if (part === undefined) {
        set({ atlasError: `assignPartTexture: no part with id "${partId}"` });
        return;
      }
      if (part.mesh !== undefined) {
        set({
          atlasError: `assignPartTexture: part "${partId}" is a mesh part; mesh parts carry per-vertex UVs and cannot be assigned an atlas source`,
        });
        return;
      }
      if (
        sourceId !== null &&
        !get().atlasSources.some((s) => s.id === sourceId)
      ) {
        set({
          atlasError: `assignPartTexture: unknown atlas source "${sourceId}"`,
        });
        return;
      }
      // Derive LOCALLY: omit the key for "none" (null), else set it.
      const current = get().partAssignments;
      let nextAssignments: Record<string, string>;
      if (sourceId === null) {
        const { [partId]: _removed, ...rest } = current;
        nextAssignments = rest;
      } else {
        nextAssignments = { ...current, [partId]: sourceId };
      }
      commitAtlas(get().atlasSources, nextAssignments);
    },

    removeAtlasSource: (id) => {
      const current = get();
      const removed = current.atlasSources.find((s) => s.id === id);
      const nextSources = current.atlasSources.filter((s) => s.id !== id);
      const nextAssignments: Record<string, string> = {};
      for (const [partId, sourceId] of Object.entries(
        current.partAssignments,
      )) {
        if (sourceId === id) continue;
        nextAssignments[partId] = sourceId;
      }
      const ok = commitAtlas(nextSources, nextAssignments);
      // Close the removed bitmap ONLY after a successful commit, so a failed
      // commit rolls back with the bitmap still valid for the live state.
      if (ok && removed !== undefined) removed.bitmap.close();
    },
  };
});
