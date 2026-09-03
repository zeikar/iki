---
"@ikijs/editor-core": minor
---

Export `detectAlphaBbox` (plus `ALPHA_BBOX_THRESHOLD` and the `AlphaBbox` type): the alpha bounding-box scan every auto-rig ingestion path needs. It was implemented twice — once over canvas `ImageData` in the editor, once over a `sharp` buffer in `@ikijs/mcp`, with a comment on each asking the other to stay byte-identical by hand. The scan only needs indexable RGBA bytes, so both now call this and only the decode differs.

`DeleteDeformer.invert` no longer fabricates a missing `deformers` array; `apply` only captures after `validateDeformerDelete` passes, so the defensive `??=` could only ever mask a broken undo stack.
