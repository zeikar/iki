---
"@ikijs/editor": minor
---

Deformer commands no longer strand a document in a state `toIkiModel()` refuses.

- `validateDeformerDelete` takes a new `physicsChains` argument (positional, before `deformerId`) and rejects deleting a deformer a chain still anchors to. The format validator rejects a dangling `anchorDeformer`, so such a delete previously succeeded and only failed later, at export.
- `SetDeformerBindings` validates a narrow synthetic candidate before mutating, the way `SetPartBindings` and `SetPartMesh` already do, so an undeclared parameter, a non-finite endpoint, or a non-matrix channel is rejected up front with the deformer's own id in the message. The candidate is deliberately narrow rather than a clone of the whole document: a host editor UI may hold a non-finite value in an unrelated part while a numeric field is being edited, and validating that would refuse the edit and report it against the wrong object.
- A binding or reparent that feeds a physics chain's output into its own anchor stays an export-time error in `toIkiModel()`. Detecting it needs the whole deformer hierarchy, which cannot be checked without also validating the unrelated parts above.

`DeleteDeformer.invert` no longer fabricates a missing `deformers` array; `apply` only captures after `validateDeformerDelete` passes, so the defensive `??=` could only ever mask a broken undo stack.
