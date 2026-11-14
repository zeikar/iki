---
"@ikijs/mcp": minor
---

`render_poses` takes a `roll` sweep preset in `sweeps` (`ParamAngleZ` on the turn's eased curve, 0 to -30 to +30 to 0 over 3 s, physics running, idle off; a nine-frame sheet labelled by angle and time, no kymograph; it adds no `SWEEP` line and changes none) and `hideParts`, part ids left out of the drawn frames of the call while the fold, physics and sweep reports still read the whole model. An id the model lacks, or one that is the clip mask of a part that stays, is `INVALID: hideParts[i] …`. `sweep` stays `turn` only.
