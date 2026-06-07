---
"@iki/editor-core": minor
---

Introduce `@iki/editor-core` (lean 5a editor foundation): a DOM-free editing core that depends only on `@iki/format`. Provides `EditorDocument` (wraps an `IkiModel`, structured-cloned on construction), invertible part-edit commands with an undo/redo stack (`SetPartColor`/`SetPartWidth`/`SetPartHeight`/`SetPartOrder`/`SetPartTransform`, capture-once prior values, RGBA tuple cloning, optional-channel delete-on-undo), and `toIkiModel()`/`serialize()` round-trip validation via `parseIkiModel` (path-qualified `IkiFormatError` propagates unchanged). No gizmos, mesh, atlas, or deformer authoring yet.
