---
"@ikijs/editor": minor
"@ikijs/mcp": patch
---

Every model rigged from this release on turns differently: the head no longer
turns on one grid. The face plate and each feature family ride a warp deformer
of their own under `headDeformer` — `faceWarp` keeps its id and carries the
plate alone, and the features get `eyeWarp_L/R`, `mouthWarp`, `noseWarp`,
`browWarp_L/R` and `blushWarp_L/R` — every one of them baked from the same head
surface at its own grid's resolution, so each part bends where it actually is
instead of on the chords of a lattice sized for the whole head. Already-rigged
models are untouched; they change only when they are rigged again.

Each family's solved depth is grid geometry now rather than an `AngleX`
translate on its parts (`bodyDeformer`'s is the model's only turn binding
left), and the solve reads every cue — the eye pair's shift, the far eye's
foreshortening, the silhouette — through the very grid and mesh those parts
render with, so `onTurnSolved` reports the landings the engine will compute
rather than those of a surface the parts only approximately sit on.
`hair_front` comes off the shared grid entirely: it rides the head on its own
per-vertex hold, lead and nod warps.

Three renders move with the carrier, all of them declared. The nod is the same
cylinder, sampled where each part is instead of on a six-row grid's chords, so
the nod RENDER MOVES by that grid's chord error — on the playground hero ≈ 4–5
px at the bangs' crown and tips and ≈ 2 px at the plate's top and chin rows.
The far eye's rendered width ratio moves by about one pixel of iris for the
same reason, the per-vertex eye grid replacing the shared grid's chord: the
hero's -30° render reads farEyeRatio 0.591 where it read 0.579, toward the 0.67
the reference measures rather than away from it. And bang tips swayed past the
old shared grid's edge are no longer clamped flat, because the bangs bind to no
grid at all now.

A rig with no `nose` layer has no feature slide to fit and so no solve behind
its cylinder; it falls back to a radius read off the turn lattice, and that
lattice is the group grids' own reach now rather than the union of every turn
layer's extent. The bangs no longer widen it, so a nose-less layer set turns on
a tighter cylinder than 0.5 gave it.

The new optional `LayerInput.rowHalfWidths` — one entry per crop row, half that
row's opaque span in canvas px — gives the FACE plate a radius that varies by
row and a small swing at the chin, so a jaw narrower than the cheekbones turns
in rather than sweeping around the cylinder the eyes turn on; absent, the plate
turns on the one constant radius it always did. `@ikijs/mcp` measures it: for
the face layer only, `auto_rig_from_layers` hands the generator the per-row
opaque half-widths it already decodes. Its schema, its arguments and its result
are unchanged, and it inherits the editor's new turn.

What stays: `TurnSolveReport` and `onTurnSolved` keep their shape,
`DEFAULT_TURN_TARGETS` its values, `hair_back` static through the turn, and the
tilt, the blink, the mouth and the rest-pose sway render as they did. On the
playground hero the report reads eyeShift 0.2200 / farEyeRatio 0.670 /
silhouetteRatio 1.000 on a 361 px radius — the eye shift reaching the default
target now instead of clamping just under it — and a render of that rig at -30°
measures farEyeRatio 0.591, eyeShift -0.210 and the silhouette holding at
1.000, with the near jaw in and the chin ≈ 17–18 px toward the near side over a
cranium that does not move. The extra grids cost bytes: the hero's model goes
1.09 MB → 1.27 MB.
