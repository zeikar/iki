---
"@ikijs/editor": minor
---

Add undoable create/delete commands for parts and deformers (AddPart, AddDeformer, DeletePart, DeleteDeformer). Add commands validate the full candidate model through the format validator before mutating, so the working model stays parseable after every op. Includes default part/deformer factories and a deformer-delete structural validator. `EditorDocument` gains a non-undoable method to clear model-committed textures, consistent with the atlas layer.
