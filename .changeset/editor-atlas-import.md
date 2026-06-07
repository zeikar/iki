---
"@iki/editor-core": minor
---

editor-core: atlas layout/UV helpers + non-undoable applyAtlas for editor 5b. Adds DOM-free `packAtlas`/`uvRectFor` + `AtlasSource`/`AtlasPlacement`/`AtlasLayout` types and `ATLAS_PADDING`/`UV_INSET_PX` constants, plus a non-undoable `EditorDocument.applyAtlas({ textures, partTextureAssignments })` method (validate-all-then-apply: replaces the texture table and sets/clears each part's `texture` atomically) with `AtlasAssignment`/`ApplyAtlasInput` types.
