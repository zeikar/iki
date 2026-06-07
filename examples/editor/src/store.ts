import { EditorDocument, type EditCommand } from "@iki/editor-core";
import { create } from "zustand";

import { sampleModel } from "./sample-model";

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

  runCommand: (cmd: EditCommand) => void;
  undo: () => void;
  redo: () => void;
  select: (partId: string | null) => void;
  setParam: (id: string, value: number) => void;
  setExportError: (msg: string | null) => void;
  setLoaded: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  doc: new EditorDocument(sampleModel),
  selectedPartId: null,
  params: {},
  exportError: null,
  revision: 0,
  loaded: false,

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
  setLoaded: () => set({ loaded: true }),
}));
