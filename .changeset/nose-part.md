---
"@ikijs/mcp": minor
---

The nose is a part like the eyes and the mouth: `compose_layers_from_parts`
places an optional `nose.png` from the parts dir (default centre between the
eyes and above the mouth, 40 px wide, tunable through `layout.nose`) and no
longer cuts a nose out of `face.png`. A parts dir without one composes as
before and reports `nose` under `skipped`; `measure_layers` now warns that
without a nose layer nothing on the face slides on the head turn. The face
part should therefore be drawn without a nose.
