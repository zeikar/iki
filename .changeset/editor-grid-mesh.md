---
"@iki/editor-core": minor
---

Add the `createGridMesh` factory and `SetPartMesh` command (add / regenerate / remove a regular grid mesh on a part), unblocking warp-deformer attachment for from-scratch parts. `SetPartMesh` validates the new mesh against the format before mutating, keeps the `applyAtlas` base-UV side-table consistent across undo/redo, and fails fast (rather than silently invalidating warps) when removing or regenerating a mesh under authored per-vertex warps or a warp-deformer attachment.
