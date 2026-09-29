---
"@ikijs/mcp": patch
---

`compose_layers_from_parts` now sizes and places a nose whose dense core is a
speck — under a quarter of its trimmed part's width or height, such as a lone
nostril mark — as a whole part, instead of blowing that speck up to
`layout.nose.w`, and its inline report warns with that source-part verdict;
`layout.nose`'s `w`/`h` then size the whole part, feather included. Its report also warns when the composed layer's own core is a speck of
its crop even though the source part's was not. `measure_layers` flags a
composed nose layer whose core is a speck of its crop — the layer
`auto_rig_from_layers` acts on.

`auto_rig_from_layers` hands the rig no such core: the crop stands in for the
nose's turn landmark and tilt pivot, and `noseCore` is absent. The rig always
succeeds. Noses whose core is not a speck — opaque line/dot noses, soft
shaded noses — compose and rig exactly as in 0.11.0.

The `turnTargets` description now states when a `silhouetteRatio` refusal
offers no range: when no ratio in [0.5, 1.5] renders on the layer set, the
refusal names the whole range rather than a narrower one, so leave the field
out — a defaulted one clamps.

The ~1-level edge difference a nose sees from sampling its own lossless atlas
page (engine texture sampling that depends on a texture's position on its
page, measured at ≤ 1.2 premultiplied levels on a few feather pixels) is
deferred by the user's ruling; no change ships for it here.

The playground hero is unchanged: re-rigged on this release it is
byte-identical, with `noseCore` still measuring {x 530, y 549, w 39, h 63} —
the guard does not fire on it.
