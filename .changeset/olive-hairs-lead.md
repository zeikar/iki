---
"@ikijs/editor": minor
---

Auto-rig the head turn with depth parallax. `hair_front` and `hair_back` no
longer track the face plane exactly: each gets an `AngleX` `translateX` sized by
its depth from the head cylinder's axis, so the bangs lead the face and the back
hair follows it at a distance. The back hair also bends on the turn through its
own part warp (`bakeHairBackTurnWarp`, exported): the near side tucks behind the
face and the far side comes into view, at a far flatter radius than the face's.
Without these both layers were glued flat to the face and a turn read as a
cutout sliding sideways.

Adds the exported `headTurnParallaxUnit(gridHalfWidth)`, the shared unit both the
warp bake and the hair bindings derive from. `bindingsForRole` takes it through a
new `parallaxUnit` option and emits no parallax without it, so existing callers
are unaffected.

Also fixes a latent bug this surfaced: parts with no mesh dropped their bindings
during assembly. Only `hair_back` and `body` take that path and neither had any
until now, so no released model changed.
