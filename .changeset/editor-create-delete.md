---
"@iki/editor-core": minor
---

Add undoable create/delete commands for parts and deformers (AddPart, AddDeformer, DeletePart, DeleteDeformer). Add commands validate the full candidate model through the format validator before mutating, so the working model stays parseable after every op. Includes default part/deformer factories and a deformer-delete structural validator. The editor can now clear model-committed textures (e.g. sample badges) via a non-undoable document method, consistent with the atlas layer.
