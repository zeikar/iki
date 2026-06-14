---
"@iki/editor-core": patch
---

`DeletePart` now refuses to delete a part that is used as another part's clip mask (`clip.masks`), mirroring the existing texture-reference guard. Clip masks are the first part→part reference in the model contract; without this guard, deleting a mask part would leave dangling references that fail `toIkiModel()` and break preview/export.
