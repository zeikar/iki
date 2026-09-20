---
"@ikijs/editor": minor
---

Every model rigged from this release on turns differently: the head no longer
travels sideways as a block. The hair silhouette holds still and everything
inside it moves — the face plate foreshortens and slides, and its features and
the bangs slide with it — which is what the 30° reference the turn is fitted to
actually shows, and what a real head does. Already-rigged models are untouched;
they change only when they are rigged again.

That travel now rides the face warp's own turn map instead of the head's rigid
translate, so only the parts on that grid carry it — the turn bake and the
column map the silhouette hold is built on both take it as an input, and the
head deformer has no turn translate left. It is a fraction of the face plate's
own half-width rather than a fixed number of pixels, so it scales with the
character, and when `turnTargets.headHalfWidth` was measured the solve caps it
to the room the held silhouette actually has on the side the face slides toward
— each side's own room, when `options.headEdges` measured a shell that does not
sit centred on the face. `hair_back` goes static on the
turn to BE that silhouette: its depth counter-shift and its turn bend and bulge
are gone, and it holds the head's outline while the face slides inside it. Its
nod tuck and the hair-sway warps are unchanged, and the torso still follows the
turn at its own light share of the travel.

A face that moves against a silhouette that does not reaches those cues far
better, so `turnTargets.eyeShift` now reaches much further than it could: on the
playground hero the eye pair lands at -0.22 head half-widths at -30°, the cue
the reference measures, where the rig that shipped before clamped at -0.10. Two
things follow for a caller fitting its own targets. The floor under the shift
cues is that slide rather than the bend's own drift, so a target asking for LESS
shift than the slide already produces is out of reach the same way one asking
for more than the plate allows is. And `turnTargets.silhouetteRatio` is now a
measurement of the RENDER — the outermost edge on each side, which is the static
hair shell wherever that shell owns it — rather than of the destination the
bangs' hold is sent to. The two are different numbers whenever a part that does
not move with the hold draws an edge, or the bangs' own turn lead carries the
edge that does, so the solve FITS the hold until a render of the rig measures
the ratio asked for, defaulted and measured alike: the rigs this ships hold a
silhouette a reference can check rather than one only the hold's own
destinations agree with. A measured ratio the layer set cannot render is
refused, and the refusal message names the ratios a render of it can show
(`attainable a…b`), both ends included and both inside the range the field
itself accepts — with an explicit refusal of its own when nothing inside that
range renders at all. A DEFAULTED one is never refused: it is fitted where it can be, and cut to
the nearest ratio a render can show where it cannot, which `onTurnSolved`
reports in `clamped`. The playground hero holds its silhouette exactly now,
where the rig that shipped before measured 0.977 and said nothing.

The head-turn report keeps its shape and `auto_rig_from_layers` takes the same
arguments, so `@ikijs/mcp` has no release of its own here. The plugin's role
text and its version bump ride this change's own commits (it is not an npm
package), and the playground hero was re-rigged as an example.
