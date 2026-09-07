---
"@ikijs/editor": minor
---

The torso (`body`) now rides a `bodyDeformer` that follows the turn at 30 % of
the head's travel and its breath bob at half amplitude — no more shoulders bolted
to the canvas while the head breathes; the head's own motion is unchanged
(sibling deformers, as in the hand-authored sample). Turn/nod bakes key
at 15° stops (five per axis): the engine blends linearly between stops and
the cylinder bend is sin-based, so the old ±30-only lattice over-bent the
far columns by up to 15 px at 15° on the hero — now under 4 px at any
angle. Meshes are
sized to their art (`meshCellsFor`: 64 px cells, 4–8 per axis) and the
face-warp grid is 6×6, so the bend renders as a curve instead of ~4
facets across the head. Rigs are regenerated, not migrated: an existing
`.iki` is untouched until re-rigged.
