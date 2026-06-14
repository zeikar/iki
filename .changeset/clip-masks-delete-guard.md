---
"@iki/editor-core": patch
---

`DeletePart` and `SetPartMesh` now refuse to invalidate a part that is used as another part's clip mask (`clip.masks`): `DeletePart` won't delete the mask part, and `SetPartMesh` won't strip its mesh (masks must be mesh parts). Both mirror the existing texture-reference guard. Clip masks are the first part→part reference in the model contract; without these guards, deleting a mask part or removing its mesh would leave dangling references that fail `toIkiModel()` and break preview/export.
