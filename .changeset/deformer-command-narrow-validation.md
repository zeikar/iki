---
"@ikijs/editor-core": patch
---

`SetDeformerBindings` and `SetDeformerParent` no longer validate the whole document before mutating. The editor commits `NaN` into the document by design — `NumberField` is a controlled input, so clearing a numeric box must write a non-finite value or React would re-render the old number straight back — which meant a blank width box on any unrelated part refused every deformer edit, and reported it against that other part rather than the binding being edited.

`SetDeformerBindings` now validates a narrow synthetic candidate the way `SetPartBindings` already did, so an undeclared parameter, a non-finite endpoint, or a non-matrix channel is still rejected up front with the deformer's own id in the message. Physics-chain feedback needs the whole hierarchy to detect, so it stays an export-time error in `toIkiModel()` rather than being reproduced over a sanitized model that would have to be kept in step with the validator by hand.
