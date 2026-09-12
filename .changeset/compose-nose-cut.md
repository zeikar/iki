---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` cuts the nose out of the face into its own
`nose.png` layer: within the gap between the eyes, from the eye line down to
the mouth, every pixel that is not the face's skin colour (line art and
shadow, judged row by row so shading across the face is not ink) moves to the
nose layer and the face gets skin filled in behind it, so the two composite
back to the original drawing at rest. A cut that would take a large share of
the window, or one holding half-transparent pixels, is declined and the face
stays whole. `auto_rig_from_layers`
keys the new feature depth parallax on that layer — the nose leads the head
turn, the mouth and eyes follow at their own depths — which a nose painted into
the face plate cannot do. A face with no drawn nose composes as before and
reports `nose` under `skipped`; a stale `nose.png` from an earlier compose is
removed then, as for a skipped optional role.
