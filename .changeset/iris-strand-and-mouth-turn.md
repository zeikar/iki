---
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

Every model rigged from this release turns its mouth differently, and its eyes
too wherever `strandEdges` is passed; already-rigged models are untouched.

The mouth now slides across the face by its solved depth but foreshortens as
the face does at its own rest position (≈ cos 30° on the face axis, since it
sits centred there), and tilts up to 5° near end down at full turn — a style
prior read off the 3/4 reference, since `measure_turn_reference` reads no
mouth.

A new option, `generateIkiFromLayerSet`'s `options.strandEdges` (type
`IrisStrand`), gives each side's iris span and the bangs' side strand as real
pixel edges on the iris row. When present, the turn keeps the far iris from
sliding any further under that strand than it is painted — best effort, never
a refusal: the fit prefers radii where some eye depth holds the bound, and
where none does (including a fringe spanning the face, `runFace: null`) the
rig is still built with the eyes' depth at 0. The new
`TurnSolveReport.strandOverlap` (`StrandOverlap = { deg, px, hh, restPx, held }`)
reports, per side, how much of the far iris the bangs cover at its worst stop
in px and head half-widths, next to the painted coverage at rest, and whether
the bound held. The option is always validated when passed, but has no effect
on the rig without a `nose` layer — only the turn solve reads it.

A CALLER `eyeShift` past the room the art leaves the far eye — the face
plate's edge, or now the strand — is CLAMPED and listed in `clamped`, exactly
like a defaulted one, where an earlier 0.x release refused it with
`TurnTargetError`: THIS CHANGES WHICH MEASURED TARGETS RIG. Still refused: a
caller `eyeShift` below the slide the face's own turn already gives the eyes,
every other field (`farEyeRatio`, `silhouetteRatio`, `noseShift`,
`mouthShift`, `headHalfWidth`), and `resolveTurnTargets`'s own range checks. A
caller shift also no longer steers which radius the far/near ratio is fitted
at — the radius is fitted across the same radii a defaulted shift allows, and
the shift is cut to that radius's own room only where it has to be.

Follow-on: the derived nose and mouth shares follow the lower achieved eye
shift, and a refitted radius moves the bangs' lead. Unchanged:
`TurnSolveReport`'s existing fields, `DEFAULT_TURN_TARGETS`, and the rest,
nod, tilt, blink, mouth-open and sway renders.

On the playground hero (before → after): the report reads eyeShift 0.22
unclamped → 0.180 clamped (`clamped: ["eyeShift"]`) on a 360.99 → 351.40 px
radius; a −30° render reads farEyeRatio / eyeShift / silhouetteRatio 0.591 /
−0.210 / 1.000 → 0.658 / −0.176 / 1.002, and a +30° render 0.658 / +0.209 /
1.000 → 0.640 / +0.168 / 1.000 (declared, not a regression: whole-pixel
rounding, the turned far/near iris is 48/74 px on both sides, and the rest
widths differ by 1 px that a wisp hides). The far iris's coverage moves from
all hair covering 20.6% / 10.1% of it at −30° / +30° to the strand alone
covering 0.15% / 0%; thin wisps still cross the iris edge, covering 8.4% /
3.3% counting all hair. The mouth at −30° now spans ×0.853 of its rest width
(was ×0.76) and tilts 3.6° near end down measured against its own rest line
(5.0° at +30°; was −1.1°). The model's size moves from 1 274 307 to
1 276 713 bytes. Rest, tilt, blink, mouth-open, sway and nod renders are
pixel-identical.

`auto_rig_from_layers` now measures each iris's opaque span and the bangs run
it would slide under on the iris's own row, hands them to the generator as
`strandEdges`, and returns them in the result. A bangs-covered iris is measured,
not dropped — except that a `hair_front` run narrower than half of that iris's
painted width on the row is treated as hair detail and skipped — a
thin wisp crossing the iris on the turn is intended, not the strand meant to
hold it clear — and the run taken is the next wide one. Its `turn` report now
carries `strandOverlap` through, and a passed `eyeShift` past the art's room
comes back clamped in `turn.clamped` instead of `INVALID`.
