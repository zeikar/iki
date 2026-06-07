---
"@iki/editor-core": minor
---

`EditorDocument.applyAtlas` now textures MESH parts (editor 5c): for an assigned mesh part it remaps each per-vertex `mesh.uvs` into the part's atlas UV-rect (and sets `texture`), and restores the original UVs + clears `texture` when a part is untextured. The remap derives from a base-UV snapshot captured at construction, so re-texturing/repacking never compounds. The public `applyAtlas` input shape is unchanged (`{ partId, uv }`) — the mesh remap is internal; no new barrel export.
