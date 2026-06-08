---
"@iki/editor-core": minor
---

editor-core: warp-deformer grid keyform authoring helpers + command (editor 5d). Adds three DOM-free, grid-size-agnostic pure helpers — `interpolateGridOffsets` (clamp + linear interpolation of grid offsets between the bracketing keyforms at a parameter value), `computeGridOffsets` (derive offsets from a dragged-point array relative to its rest positions), and `upsertGridKeyform` (replace-or-insert a keyform at a parameter value, maintaining strictly ascending order) — plus the undoable `CaptureGridKeyform` command and `EditorDocument.findWarpDeformer`. `CaptureGridKeyform.apply` validates that `offsets.length === deformer.grid.points.length` (fail fast) and that the captured `value` is within the driving parameter's min/max range (fail fast). Format and engine are unchanged; no `IKI_FORMAT_VERSION` bump.
