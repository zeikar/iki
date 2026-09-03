---
"@ikijs/editor": minor
---

Deformer commands no longer strand a document in a state `toIkiModel()` refuses.

- `validateDeformerDelete` takes a new `physicsChains` argument (positional, before `deformerId`) and rejects deleting a deformer a chain still anchors to. The format validator rejects a dangling `anchorDeformer`, so such a delete previously succeeded and only failed later, at export.
- `SetDeformerBindings` and `SetDeformerParent` now validate a candidate model with `parseIkiModel` before mutating, the rule `AddPart` and `SetPartMesh` already followed. The Inspector offers every parameter in the model, so an undeclared id, a non-finite endpoint, or a reparent that puts a physics chain's own output on an ancestor could enter the document unchecked.

`DeleteDeformer.invert` no longer fabricates a missing `deformers` array; `apply` only captures after `validateDeformerDelete` passes, so the defensive `??=` could only ever mask a broken undo stack.
