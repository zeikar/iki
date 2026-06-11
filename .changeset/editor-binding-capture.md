---
"@iki/editor-core": minor
---

Add `SetPartBindings` command (whole-array replace; validates written bindings against declared parameters via a narrow synthetic `parseIkiModel` candidate; absent-vs-empty key discipline), the pure `captureBindingEndpoint` capture-math helper (additive delta; multiplicative opacity ratio with a documented base-opacity-0 degenerate case), and non-undoable ephemeral transform setters (`setPartTransformEphemeral` / `setDeformerTransformEphemeral`) for the editor's transient capture pose.
