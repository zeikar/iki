---
"@ikijs/editor": minor
"@ikijs/mcp": minor
---

Every model rigged from this release with a `nose` layer turns its nose
differently: at full turn the nose tilts 6° about its bridge top, tip toward
the far side, and foreshortens as the face does at its own rest position — the
mouth's rule since 0.7. Already-rigged models are untouched; they change only
when they are rigged again.

The optional `LayerInput.denseCore` — the tight box of the layer's pixels at
alpha ≥ 128 — becomes the nose's landmark and pivot; the crop stands in when it is
absent.

Unchanged: `DEFAULT_TURN_TARGETS`, `TurnSolveReport`'s fields, the iris–strand
bound, the mouth, and every render at AngleX 0.

`compose_layers_from_parts` now sizes and places the nose by its dense core
instead of its trimmed crop. `layout.nose.w`/`h` size the core (default 40 px
wide), and `cx`/`cy` place its centre; with `cy` omitted, the tip lands 0.86 of
the way from the eye row to the mouth. A LAYOUT TUNED AGAINST 0.10 MOVES ITS
NOSE.

`auto_rig_from_layers` hands the nose's dense core to the rig and reports it
as `noseCore`. With `quantizeColors`, the nose lands on a second, lossless
atlas page instead of the shared quantized one: the model carries two
`textures`, and `atlasBytes` counts both. The nose's own lossless page adds a
content-dependent amount to the model's size, since removing the nose from
page 0 also changes how that page re-quantizes — on the playground hero the
split model came to 1.28MB, about the same as the all-quantized 1.29MB and
well under the 3.18MB lossless model. Because the 256-colour page is now
chosen without the nose, the other parts' edge pixels can shift slightly
against a 0.10 rig of the same layers.

On the playground hero (before → after): the nose depth moves 0.1679 →
0.1442, with `noseCore` measuring {x 530, y 549, w 39, h 63}; the tilt against
the untilted rig reads −6.2° at AngleX −30 and +6.0° at +30; the nose's
feather-ring rim metric reads 0.181 against a lossless render, where an
all-quantized atlas reads 2.819; and the model grows from 1 276 713 to
1 279 354 bytes for its second page. The turn report's other fields — radius
351.397, holdBase 262, eye/mouth depths 0.0928/0.1363, achieved
eyeShift/farEyeRatio/silhouetteRatio 0.1803/0.670/1.000, `clamped:
["eyeShift"]`, headEdges and strandEdges — and the eye and silhouette cues at
±30 are unchanged.
