---
"@ikijs/mcp": minor
---

`compose_layers_from_parts` now gives an eye its lower lid. The dark pixels in the lower part of `eyewhite.png` were recolored white in the sclera and dropped, so a composed eye lost its lower lid line, and a lash drawn hanging below the white showed as a white flick. Those pixels now become their own layers, `lash_lower_L` / `lash_lower_R`, which draw over the iris. They are placed on the sclera's frame by the `eye_*` layout and have no `layout` key of their own. The sclera keeps those pixels as drawn, so its shape, and every placement and measurement read off it, is unchanged. An eyewhite with no dark lower lid writes no lower-lash layers and lists them in `skipped`. Recomposing an existing parts dir adds the two layers and recolors the sclera's lower edge; `auto_rig_from_layers` rigs them through the new `@ikijs/editor`.
