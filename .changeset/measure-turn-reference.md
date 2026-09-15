---
"@ikijs/mcp": minor
---

New `measure_turn_reference` tool: measures how far a head turns between two
images of the same character — one facing front, one turned — and reports it as
three ratios, so a rigged turn can be compared against a reference turn (or an
earlier rig) without registering the images. The pair must already share the
same scale and framing: crop and position cancel, but scale does not, and a
yaw never changes iris height, so a pair whose mean iris heights differ by more
than 10% is refused rather than measured as if it were a turn. `farEyeRatio` is the
turned far/near iris width over that same ratio at rest, `eyeShift` is how far
the eye pair slides across the head in units of the FRONT head half-width
(negative = toward the image's left), and `silhouetteRatio` is the head
half-width turned over front; the raw per-image numbers come back alongside
them, and `debugDir` writes an overlay per image with the iris boxes and head
edges drawn. The irises are found through a colour window (violet by default,
overridable through `iris`), and the head silhouette through one of two
foreground rules picked per image: alpha alone for an engine render, a
colour-keyed backdrop for opaque reference art.

`auto_rig_from_layers` now takes those numbers. An optional `turnTargets`
(`eyeShift`, `farEyeRatio`, `silhouetteRatio`, and the usually-derived
`noseShift`/`mouthShift`) fits the rig's head turn to a measured reference, and
the head half-width those shifts are fractions of is measured off the layers
themselves — their opaque union at the eye row, under the same alpha rule and
row band `measure_turn_reference` spans a render with, so the rig's own rest
render measures that span back. The result carries that `headHalfWidth` and a
`turn` report (`radius`, `holdBase`, `depths`, `achieved`, `clamped`) of what
the solve settled on, plus a `headHalfWidthApplied` flag: a layer set whose head
is not wider than its own face plate (a hairless one, say), or whose art is
translucent below the opaque-union threshold (so `headHalfWidth` itself comes
back absent), measures a head the generator will not take, so the plate stands
in for it and a rig still comes out — the defaults always produce a model. When
`headHalfWidth` is applied, the result also carries `headEdges`: every layer
with an opaque pixel in that same eye-row band, per side, each with its own
rest x there, passed to the generator's own `options.headEdges` so it can land
each candidate through its OWN part's deformation (the bangs, the back hair, a
face-plate or body edge move very differently on the turn) and take the
outermost result, not just whichever one drew furthest out at rest. An omitted
target falls back to a
default that is clamped to what the layer set can do — `turn.clamped` names the
ones that were — while a target the caller passed and the layer set cannot reach
comes back as `INVALID: …` naming the field and the attainable range.
