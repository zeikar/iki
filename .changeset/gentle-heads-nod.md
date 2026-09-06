---
"@ikijs/editor": minor
---

Auto-rigged models can now nod. `generateIkiFromLayerSet` declares
`ParamAngleY` and drives `faceWarp` with one 2D grid warp over AngleX × AngleY
(the new exported `bakeHeadTurnGridWarp2DCentered`), so the face foreshortens
vertically as the head pitches; `headDeformer` gains a symmetric `AngleY`
`translateY`, and `hair_back` an `AngleY` `translateY` that keeps its crown
tucked under the bent front hair. The AngleY = 0 row of the 2D bake is exactly
the old 1D turn bake, so the head turn is unchanged, and the rest pose renders
identically.

The nod is deliberately gentler than the turn (`NOD_BEND` = 0.5): the face-warp
grid reaches the hair crown, where a full 30° bend dropped the bangs ~140px and
exposed the rigid back hair above them as a second silhouette.

`bindingsForRole` takes a new `parallaxUnitY` option alongside `parallaxUnit`.

Because a warp deformer carries either `warps` or `warp2d`, auto-rigged models
now emit `warp2d` and no `warps`. Anything that reads `faceWarp.warps[0]`
directly — the example editor's grid-keyform drag authoring and its grid
overlay — sees no 1D warp on these models until it learns `warp2d`; the engine
plays them unchanged.
