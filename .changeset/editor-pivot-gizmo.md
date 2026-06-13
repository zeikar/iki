---
"@iki/editor-core": minor
---

Add the atomic `SetDeformerPivot` command for the editor canvas pivot gizmo: it sets a matrix deformer's pivot x/y in one step so a single canvas drag is a single undo step. `SetDeformerPivotX`/`SetDeformerPivotY` stay for the Inspector's single-axis numeric inputs.
