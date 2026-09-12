---
"@ikijs/editor": minor
---

Auto-rigged facial features slide across the face on the head turn and nod
(depth parallax) whenever the layer set has a `nose` role. The face contour
rides the pinned cylinder bake as before — its silhouette stays put and only
foreshortens — but the eye stack, lashes, brows, both mouths, blush and the
nose each carry an `AngleX` `translateX` and an `AngleY` `translateY` binding
worth their `FEATURE_DEPTH` share of the bulk slide the bake pins out: the
nose 0.08 of the cylinder radius, everything else 0.04 — so the nose leads
and the features slide across the contour, which only foreshortens. The
shares are deliberately small: the contour does not turn, so a 3/4 view's
feature layout at the 30° stop read as features sliding on a plate. The bangs
slide with the brows on the nod at the same depth; their turn lead is
unchanged. Without a `nose` layer nothing
slides: a nose painted into the face plate that stays put while the eyes and
mouth move reads worse than no parallax (a blind review ranked it below the
static rig), and `@ikijs/mcp`'s composer now cuts the nose out of the face so
generated characters get the layer. The rest pose is unchanged (the bindings
are symmetric about zero). The nod unit is now `headNodParallaxUnit` — the
bulk pinned at the nod's own half-angle bend — instead of a turn-sized scale;
`hair_back`'s nod follow is converted to it and moves the same pixels. Rigs
are regenerated, not migrated.
