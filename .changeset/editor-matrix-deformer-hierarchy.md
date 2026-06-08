---
"@iki/editor-core": minor
---

editor-core: matrix-deformer hierarchy authoring (editor 5e). Adds DOM-free, undoable commands to author the deformer rig numerically — `SetDeformerPivotX` / `SetDeformerPivotY` / `SetDeformerTransform` (whole-transform capture; an identity `{x,y}` base is created when editing a transform-less deformer, since `IkiDeformerTransform` requires finite `x`/`y`) / `SetDeformerBindings` (whole-array replace with deep-copy capture/invert) / `SetDeformerParent` / `SetPartDeformer`. Adds the `findMatrixDeformer` / `findDeformer` document accessors and the pure `validateDeformerReparent` / `validatePartAttach` helpers, which fail fast (path-qualified `Error`) on a self-reference, a cycle, a non-matrix parent, an undeclared id, or attaching a meshless part to a warp deformer — so a bad reparent never mutates the model or reaches `parseIkiModel`. Format and engine are unchanged; no `IKI_FORMAT_VERSION` bump.
